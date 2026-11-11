// src/library/library-installer.ts
// Transactional stage→verify→commit→rollback installer for library packages (D7).
// Stages a protocol-plus-snippet bundle into immutable isolated namespaces
// (`library/<packageId>/<version>/`) under the existing protocol/snippet roots,
// verifies SHA-256 integrity + graph validity + path safety ENTIRELY in memory
// before any final-path write, then commits atomically (journal first, per-release
// marker LAST). All I/O via app.vault/adapter under a single module-level
// installMutex (5th lock domain, one fixed synthetic key — D7/D16), NEVER through
// InstalledRecordStore.write()/SnippetService.save() mid-transaction.
//
// Recovery on load: enumerate in-flight journals; marker present+valid+identity
// → committed, remove journal only; marker absent/invalid → remove every journal
// entry path deepest-first, then the journal.

import type { App } from 'obsidian';
import { WriteMutex } from '../utils/write-mutex';
import { ensureFolderPath } from '../utils/vault-utils';
import { defaultT, type Translator } from '../i18n';
import { isProtocolDocumentV1, type ProtocolDocumentV1 } from '../protocol/protocol-document';
import { ProtocolDocumentParser } from '../protocol/protocol-document-parser';
import { GraphValidator } from '../graph/graph-validator';
import {
  LIBRARY_SUBROOT, assertNoTraversal, buildReferenceMapping, findInstalledRecordForPath,
  libraryProtocolFilePath, librarySnippetFilePath, librarySnippetNamespace,
  packageNamespaceSegment, rewriteSnippetRef, slugifyPackageId, validPackageSlug,
} from './library-paths';
import { sha256String, verifyIntegrity } from './integrity';
import { writeJsonFile, safeErrorMessage } from './library-json-io';
import {
  INSTALLED_RECORD_SCHEMA, INSTALLED_RECORD_VERSION,
  isInstalledRecord, type InstalledRecord, type ReleaseBundle,
} from './library-model';
import {
  TransactionJournalIO, TRANSACTIONS_SCHEMA, TRANSACTIONS_VERSION,
  type JournalEntry, type TransactionJournal,
} from './transaction-journal';
import { installedRecordPath } from './installed-record-store';
import { planRecordMigration } from './library-migration';

/** Single global install lock (D7 — one fixed synthetic key for every
 *  transaction, strictly serializing installs; avoids the ensureFolderPath
 *  shared-parent-folder check-then-create race a per-package key would
 *  reintroduce — see D7). */
const installMutex = new WriteMutex();
const INSTALL_LOCK_KEY = 'library-install';

/** Result of an install attempt. Never throws — failures return `failed`. */
export type InstallResult =
  | { status: 'ok'; packageId: string; releaseVersion: string }
  | { status: 'failed'; packageId: string; releaseVersion: string; reason: string };

/** Result of an uninstall attempt. Never throws — `not-installed` if no valid marker. */
export type UninstallResult =
  | { status: 'ok'; packageId: string; releaseVersion: string }
  | { status: 'not-installed'; packageId: string; releaseVersion: string }
  | { status: 'failed'; packageId: string; releaseVersion: string; reason: string };

/** Result of recovery-on-load. The `*Failed` fields (A0) are additive — older
 *  consumers reading only committed/rolledBack/orphansCleaned keep working. */
export interface RecoveryReport {
  committed: Array<{ packageId: string; releaseVersion: string }>;
  rolledBack: Array<{ packageId: string; releaseVersion: string }>;
  /** Namespace folders cleaned by the FR-4 destination-folder orphan scan
   *  (journal-less interrupt leftovers with no valid marker). */
  orphansCleaned: Array<{ namespace: string }>;
  /** A0: journals whose rollback did NOT fully succeed (deletion failure or
   *  a suspicious/forged shape) — the journal file is preserved for inspection. */
  rollbackFailed?: Array<{ packageId: string; releaseVersion: string; reason: string }>;
  /** A0: orphan namespaces whose cleanup did not complete (deletion failure). */
  orphanCleanupFailed?: Array<{ namespace: string; reason: string }>;
}

/** Result of the one-time slug→slug+hash migration (FR-2). Never throws. */
interface MigrationReport {
  migrated: Array<{ packageId: string; releaseVersion: string }>;
  skipped: Array<{ packageId: string; releaseVersion: string }>;
  failed: Array<{ packageId: string; releaseVersion: string; reason: string }>;
}

export interface LibraryInstallerSettings {
  protocolFolderPath: string;
  snippetFolderPath: string;
}

/** A0: canonical expected paths for a release, derived independently from the
 *  committed identity (packageId, version) via the pure path helpers. */
interface ExpectedPaths {
  pkgSegment: string;
  versionSlug: string;
  markerPath: string;
  protoNs: string;
  snipNs: string;
}

interface LibraryInstallerOptions {
  /** Injectable journal IO (tests pass a stub; production constructs one). */
  journalIO?: TransactionJournalIO;
  /** Injectable translator (defaults to defaultT for pure-test sites). */
  t?: Translator;
  /** Injectable lister for collision detection in the install preflight (D4).
   *  Read-only — the installer never writes to the record store. Undefined in
   *  pure-test sites → collision detection degrades to dirty-slot messaging. */
  listInstalled?: () => Promise<InstalledRecord[]>;
}

export class LibraryInstaller {
  private readonly app: App;
  private readonly settings: LibraryInstallerSettings;
  private readonly t: Translator;
  private readonly journalIO: TransactionJournalIO;
  private readonly listInstalled?: () => Promise<InstalledRecord[]>;

  constructor(app: App, settings: LibraryInstallerSettings, options: LibraryInstallerOptions = {}) {
    this.app = app;
    this.settings = settings;
    this.t = options.t ?? defaultT;
    this.journalIO = options.journalIO ?? new TransactionJournalIO(app);
    this.listInstalled = options.listInstalled;
  }

  /**
   * Install a release bundle transactionally. All validation happens in memory
   * first; the journal is written before any final-path write; the per-release
   * marker is written LAST. NEVER throws — returns `failed` on any error
   * (including an unexpected throw from planInstall, e.g. Web Crypto
   * unavailable). The post-commit journal removal is best-effort: the install is
   * committed once the marker is written, so a failed removal does NOT roll back
   * (recovery-on-load cleans a stale journal when the marker is present+valid).
   */
  async install(bundle: ReleaseBundle): Promise<InstallResult> {
    return installMutex.runExclusive(INSTALL_LOCK_KEY, async () => {
      try {
        const { packageId, releaseVersion: version } = bundle.manifest;
        // 1. Validate entirely in memory (no final-path I/O).
        const plan = await this.planInstall(bundle);
        if ('error' in plan) {
          return { status: 'failed', packageId, releaseVersion: version, reason: plan.error };
        }
        // 2. Write the journal BEFORE any final-path write (D7).
        try {
          await this.journalIO.write(plan.journal, installMutex);
        } catch (e) {
          return { status: 'failed', packageId, releaseVersion: version, reason: `failed to write journal: ${safeErrorMessage(e)}` };
        }
        // 3. Commit; rollback on any failure.
        try {
          const vault = this.app.vault;
          for (const w of plan.snippetWrites) {
            await ensureFolderPath(vault, parentDirOf(w.path));
            await vault.adapter.write(w.path, w.content);
          }
          await writeJsonFile(vault, installMutex, plan.protocolPath, parentDirOf(plan.protocolPath), plan.rewrittenDoc);
          // Per-release marker LAST (D15/D7 — presence+validity = commit signal).
          await writeJsonFile(vault, installMutex, plan.markerPath, parentDirOf(plan.markerPath), plan.record);
        } catch (e) {
          await this.rollbackTransaction(plan.journal);
          return { status: 'failed', packageId, releaseVersion: version, reason: `commit failed: ${safeErrorMessage(e)}` };
        }
        // 4. Commit complete — best-effort journal removal (install is committed;
        //    a stale journal is cleaned by recovery-on-load when the marker is valid).
        try {
          await this.journalIO.remove(packageId, version);
        } catch {
          // best-effort — install is already committed
        }
        return { status: 'ok', packageId, releaseVersion: version };
      } catch (e) {
        // Unexpected throw (e.g. Web Crypto unavailable in verifyIntegrity, a
        // malformed bundle.manifest, or a planInstall throw) — no final-path write
        // happened (planInstall does no final-path I/O), so no rollback is needed.
        const pkg = bundle?.manifest?.packageId ?? '';
        const ver = bundle?.manifest?.releaseVersion ?? '';
        return { status: 'failed', packageId: pkg, releaseVersion: ver, reason: safeErrorMessage(e) };
      }
    });
  }

  /** Recovery on load: enumerate in-flight journals and finalize each. NEVER
   *  throws — a listAll failure (e.g. unreadable transactions dir) returns an
   *  empty report (best-effort; the service may surface a warning). */
  async recoverInterrupted(): Promise<RecoveryReport> {
    return installMutex.runExclusive(INSTALL_LOCK_KEY, async () => {
      let journals: { valid: TransactionJournal[]; quarantined: Array<{ packageId: string; releaseVersion: string; path: string }> };
      try {
        journals = await this.journalIO.listAll();
      } catch {
        return { committed: [], rolledBack: [], orphansCleaned: [] };
      }
      const committed: RecoveryReport['committed'] = [];
      const rolledBack: RecoveryReport['rolledBack'] = [];
      const rollbackFailed: NonNullable<RecoveryReport['rollbackFailed']> = [];
      // A0: quarantined (shape-invalid) journals are surfaced with a reason and
      // left untouched — they must never be silently deleted nor rolled back from.
      for (const q of journals.quarantined) {
        rollbackFailed.push({
          packageId: q.packageId, releaseVersion: q.releaseVersion,
          reason: `corrupted or forged journal shape (quarantined at ${q.path}) — inspect manually; no deletions were performed`,
        });
      }
      for (const journal of journals.valid) {
        try {
          // A0: derive expected paths independently from the journal's
          // identity (packageId/releaseVersion) via the same pure helpers the
          // installer uses — journal entry paths are DATA to verify, never the
          // deletion source of truth.
          const expected = await this.deriveExpectedPaths(journal.packageId, journal.releaseVersion);
          const markerEntry = journal.entries[journal.entries.length - 1]!;
          const markerValid = markerEntry.kind === 'marker'
            && markerEntry.path === expected.markerPath
            ? await this.isMarkerCommitted(markerEntry.path, journal.packageId, journal.releaseVersion)
            : false;
          if (markerValid) {
            await this.journalIO.remove(journal.packageId, journal.releaseVersion);
            committed.push({ packageId: journal.packageId, releaseVersion: journal.releaseVersion });
          } else {
            const outcome = await this.rollbackTransaction(journal, expected);
            if (outcome.status === 'ok') {
              rolledBack.push({ packageId: journal.packageId, releaseVersion: journal.releaseVersion });
            } else {
              rollbackFailed.push({ packageId: journal.packageId, releaseVersion: journal.releaseVersion, reason: outcome.reason });
            }
          }
        } catch (e) {
          rollbackFailed.push({ packageId: journal.packageId, releaseVersion: journal.releaseVersion, reason: safeErrorMessage(e) });
        }
      }
      // Second phase (FR-4): scan destination folders for journal-less orphans.
      const orphansCleaned: RecoveryReport['orphansCleaned'] = [];
      const orphanCleanupFailed: NonNullable<RecoveryReport['orphanCleanupFailed']> = [];
      try {
        const records = this.listInstalled ? await this.listInstalled() : [];
        const orphanNamespaces = await this.findOrphanedNamespaces(records);
        for (const ns of orphanNamespaces) {
          try {
            if (await this.cleanOrphanedNamespace(ns)) orphansCleaned.push({ namespace: ns });
            else orphanCleanupFailed.push({ namespace: ns, reason: 'cleanup skipped or incomplete' });
          } catch (e) {
            orphanCleanupFailed.push({ namespace: ns, reason: safeErrorMessage(e) });
          }
        }
      } catch {
        // best-effort — a scan failure must not abort recovery (committed/rolledBack stand)
      }
      return { committed, rolledBack, orphansCleaned, rollbackFailed, orphanCleanupFailed };
    });
  }

  /** A0: expected owned paths + marker for (packageId, version), derived
   *  INDEPENDENTLY from the committed identity via the pure path helpers —
  *  never from journal entries or stored record paths (those are verified
   *  against this, not trusted). `expectedPaths` are the canonical final
   *  paths a well-formed install of this release may own. */
  private async deriveExpectedPaths(packageId: string, version: string): Promise<ExpectedPaths> {
    const pkgSegment = await packageNamespaceSegment(packageId);
    const versionSlug = slugifyPackageId(version);
    const protocolRoot = this.settings.protocolFolderPath;
    const snippetRoot = this.settings.snippetFolderPath;
    const markerPath = installedRecordPath(pkgSegment, versionSlug);
    const protoNs = `${protocolRoot === '' ? LIBRARY_SUBROOT : protocolRoot}/${LIBRARY_SUBROOT}/${pkgSegment}/${versionSlug}`;
    const snipNs = `${snippetRoot === '' ? LIBRARY_SUBROOT : snippetRoot}/${LIBRARY_SUBROOT}/${pkgSegment}/${versionSlug}`;
    return { pkgSegment, versionSlug, markerPath, protoNs, snipNs };
  }

  /** One-time slug-only → slug+hash migration of installed records (FR-2). Runs
   *  under the global installMutex (D7), per-record try/catch continue, marker
   *  rewrite LAST. Uses the existing transaction journal for interrupt atomicity:
   *  an interrupted migration leaves a journal at the new slot — recoverInterrupted
   *  (next load) rolls back the partial new files before this re-runs. Idempotent
   *  (D2 — path-shape discriminator skips already-migrated records). Never throws. */
  async migrateInstalledRecords(): Promise<MigrationReport> {
    return installMutex.runExclusive(INSTALL_LOCK_KEY, async () => {
      if (!this.listInstalled) return { migrated: [], skipped: [], failed: [] };
      let records: InstalledRecord[];
      try { records = await this.listInstalled(); }
      catch { return { migrated: [], skipped: [], failed: [] }; }
      const migrated: MigrationReport['migrated'] = [];
      const skipped: MigrationReport['skipped'] = [];
      const failed: MigrationReport['failed'] = [];
      for (const record of records) {
        try {
          const pkgSegment = await packageNamespaceSegment(record.packageId);
          const versionSlug = slugifyPackageId(record.releaseVersion);
          let raw: string;
          try { raw = await this.app.vault.adapter.read(record.protocolPath); }
          catch { skipped.push({ packageId: record.packageId, releaseVersion: record.releaseVersion }); continue; }
          const protocolDoc: unknown = JSON.parse(raw);
          if (!isProtocolDocumentV1(protocolDoc)) { failed.push({ packageId: record.packageId, releaseVersion: record.releaseVersion, reason: 'protocol file is not a valid ProtocolDocumentV1' }); continue; }
          const result = planRecordMigration(record, protocolDoc, pkgSegment, versionSlug, this.settings.protocolFolderPath, this.settings.snippetFolderPath);
          if ('error' in result) { failed.push({ packageId: record.packageId, releaseVersion: record.releaseVersion, reason: result.error }); continue; }
          if (!result.changed) { skipped.push({ packageId: record.packageId, releaseVersion: record.releaseVersion }); continue; }
          const plan = result.plan;
          // Migration journal (new paths, marker LAST) — for interrupt recovery.
          const entries: JournalEntry[] = [
            ...plan.snippetMoves.map((m) => ({ path: m.newPath, kind: 'owned' as const })),
            { path: plan.newProtocolPath, kind: 'owned' as const },
            { path: plan.newMarkerPath, kind: 'marker' as const },
          ];
          await this.journalIO.write({
            schema: TRANSACTIONS_SCHEMA, version: TRANSACTIONS_VERSION,
            packageId: record.packageId, releaseVersion: record.releaseVersion,
            startedAt: new Date().toISOString(), entries,
          }, installMutex);
          for (const move of plan.snippetMoves) {
            const content = await this.app.vault.adapter.read(move.oldPath);
            await ensureFolderPath(this.app.vault, parentDirOf(move.newPath));
            await this.app.vault.adapter.write(move.newPath, content);
          }
          await writeJsonFile(this.app.vault, installMutex, plan.newProtocolPath, parentDirOf(plan.newProtocolPath), plan.rewrittenDoc);
          // C5: recompute the record's protocolSha256 to match the MIGRATED on-disk doc
          // (the rewrite changed the snippet refs → the old installed hash no longer matches).
          plan.record.protocolSha256 = await sha256String(JSON.stringify(plan.rewrittenDoc, null, 2) + '\n');
          // New marker LAST (commit signal).
          await writeJsonFile(this.app.vault, installMutex, plan.newMarkerPath, parentDirOf(plan.newMarkerPath), plan.record);
          // Remove old files (legacy protocol + snippets + marker).
          await this.removeOwnedPaths(
            [plan.oldProtocolPath, ...plan.snippetMoves.map((m) => m.oldPath), plan.oldMarkerPath],
            plan.oldMarkerPath, parentDirOf(plan.oldProtocolPath), plan.oldSnippetNamespace,
          );
          try { await this.journalIO.remove(record.packageId, record.releaseVersion); } catch { /* best-effort */ }
          migrated.push({ packageId: record.packageId, releaseVersion: record.releaseVersion });
        } catch (e) {
          failed.push({ packageId: record.packageId, releaseVersion: record.releaseVersion, reason: safeErrorMessage(e) });
        }
      }
      return { migrated, skipped, failed };
    });
  }

  /** Plan an install: validate everything in memory and compute the journal +
   *  ordered writes. Returns `{error}` on any validation failure, else the plan. */
  private async planInstall(bundle: ReleaseBundle): Promise<InstallPlan | { error: string }> {
    const { manifest } = bundle;
    const { packageId, releaseVersion: version } = manifest;
    const protocolRoot = this.settings.protocolFolderPath;
    const snippetRoot = this.settings.snippetFolderPath;

    // 1a. Nonempty slugs (validPackageSlug rejects all-punctuation ids).
    if (validPackageSlug(packageId) === null) return { error: `invalid package id "${packageId}": slugifies to empty` };
    if (validPackageSlug(version) === null) return { error: `invalid release version "${version}": slugifies to empty` };

    // Collision-resistant namespace segment (slug + shortHash of the RAW packageId),
    // computed ONCE and threaded through every synchronous derivation helper (D1).
    const pkgSegment = await packageNamespaceSegment(packageId);
    const versionSlug = slugifyPackageId(version);

    // 1b. Occupied-destination preflight — already installed (valid+identity
    // marker) OR a foreign package owning the slot (collision) OR leftover final
    // paths with no valid marker (dirty slot). A collision names BOTH packageIds
    // (FR-3); a dirty slot is an unrecovered interrupt (run recovery first). ANY
    // existing final path without a valid marker = dirty slot — refuse to clobber.
    if (await this.readMarker(packageId, version) !== null) {
      return { error: `package ${packageId}@${version} is already installed` };
    }
    const records = this.listInstalled ? await this.listInstalled() : [];
    const occupiedDestPaths = [
      libraryProtocolFilePath(protocolRoot, pkgSegment, versionSlug),
      installedRecordPath(pkgSegment, versionSlug),
      ...manifest.snippetFiles.map((f) => librarySnippetFilePath(snippetRoot, pkgSegment, versionSlug, f.relPath)),
    ];
    for (const destPath of occupiedDestPaths) {
      if (!(await this.app.vault.adapter.exists(destPath))) continue;
      const c = await this.classifyOccupiedPath(destPath, packageId, records);
      if (c.collision) {
        return { error: this.t('library.collisionError', { incoming: packageId, existing: c.existing }) };
      }
      return { error: this.t('library.dirtySlotError', { packageId, version, path: destPath }) };
    }

    // 1c. Manifest/content closure + .md-only + safe paths.
    const contentMap = new Map(bundle.snippetContents.map((s) => [s.relPath, s.content]));
    if (contentMap.size !== bundle.snippetContents.length) return { error: 'duplicate relPath in snippetContents' };
    for (const f of manifest.snippetFiles) {
      if (!f.relPath.endsWith('.md')) return { error: `snippet file "${f.relPath}" is not .md` };
      if (assertNoTraversal(f.relPath) === null) return { error: `snippet file "${f.relPath}" has an unsafe path` };
      if (!contentMap.has(f.relPath)) return { error: `manifest references snippet "${f.relPath}" but no content was provided` };
    }
    for (const s of bundle.snippetContents) {
      if (!manifest.snippetFiles.some((f) => f.relPath === s.relPath)) {
        return { error: `snippet content "${s.relPath}" is not declared in the manifest` };
      }
    }

    // 1d. Source hashes (SHA-256 integrity — D11).
    for (const f of manifest.snippetFiles) {
      if (!(await verifyIntegrity(contentMap.get(f.relPath)!, f.sha256))) {
        return { error: `integrity check failed for snippet "${f.relPath}"` };
      }
    }
    // 1e. Protocol hash (canonical pretty JSON + trailing newline = stored format).
    const protocolJson = JSON.stringify(manifest.protocolDoc, null, 2) + '\n';
    if (!(await verifyIntegrity(protocolJson, manifest.protocolSha256))) {
      return { error: 'integrity check failed for protocol document' };
    }

    // 1f. Parser success (deep node validation — never throws).
    const parser = new ProtocolDocumentParser(this.t);
    const protocolPath = libraryProtocolFilePath(protocolRoot, pkgSegment, versionSlug);
    const parsed = parser.parse(protocolJson, protocolPath);
    if (!parsed.success) return { error: `protocol document failed to parse: ${parsed.error}` };

    // 1g. Build reference mapping from the parsed snippet nodes (extension-preserving).
    const snippetNodes = [...parsed.graph.nodes.values()].filter((n) => n.kind === 'snippet');
    const mappingResult = buildReferenceMapping(pkgSegment, versionSlug, snippetNodes);
    if ('error' in mappingResult) return { error: mappingResult.error };
    const mapping = mappingResult.mapping;

    // 1g-bis. Subfolder closure: each subfolderPath-only snippet node must reference
    // a directory that has at least one declared descendant in manifest.snippetFiles.
    // GraphValidator only probes file-bound snippetPath nodes (D-04), so a
    // subfolderPath with no declared content would install an empty directory and
    // silently fail at runtime. (File-bound nodes are covered by the staged probe.)
    for (const node of snippetNodes) {
      const sfp = node.subfolderPath;
      const sp = node.radiprotocol_snippetPath;
      if (typeof sfp === 'string' && sfp !== '' && (sp === undefined || sp === '')) {
        const prefix = sfp.endsWith('/') ? sfp : sfp + '/';
        if (!manifest.snippetFiles.some((f) => f.relPath.startsWith(prefix))) {
          return { error: `snippet node "${node.id}" references subfolder "${sfp}" but no declared snippet file descends into it` };
        }
      }
    }

    // 1h. Rewrite the cloned stored doc's snippet-node fields (extension-preserving).
    // snippetPath and subfolderPath are mutually exclusive on a snippet node (see
    // src/graph/graph-model.ts SnippetNode comment); a manifest carrying both is
    // rejected. The rewritten value is re-gated through assertNoTraversal (D8
    // chokepoint before D-04 composition + staged write — defense-in-depth even
    // though the value is a deterministic transform of an already-safe path).
    const rewrittenDoc = cloneDoc(manifest.protocolDoc);
    for (const node of rewrittenDoc.nodes) {
      if (node.kind !== 'snippet') continue;
      const sp = node.fields['snippetPath'];
      const sfp = node.fields['subfolderPath'];
      const spSet = typeof sp === 'string' && sp !== '';
      const sfpSet = typeof sfp === 'string' && sfp !== '';
      if (spSet && sfpSet) {
        return { error: `snippet node "${node.id}" has both snippetPath and subfolderPath (mutually exclusive)` };
      }
      if (spSet) {
        const rewritten = rewriteSnippetRef(sp, mapping);
        if (rewritten === null) return { error: `cannot rewrite snippetPath "${sp}" for snippet node "${node.id}"` };
        if (assertNoTraversal(rewritten) === null) return { error: `rewritten snippetPath is unsafe for snippet node "${node.id}"` };
        node.fields['snippetPath'] = rewritten;
      } else if (sfpSet) {
        const rewritten = rewriteSnippetRef(sfp, mapping);
        if (rewritten === null) return { error: `cannot rewrite subfolderPath "${sfp}" for snippet node "${node.id}"` };
        if (assertNoTraversal(rewritten) === null) return { error: `rewritten subfolderPath is unsafe for snippet node "${node.id}"` };
        node.fields['subfolderPath'] = rewritten;
      }
    }

    // 1i. Re-parse the rewritten doc and validate with a staged probe (D10).
    const reparsed = parser.parseDocument(rewrittenDoc, protocolPath);
    if (!reparsed.success) return { error: `rewritten protocol document failed to parse: ${reparsed.error}` };
    const plannedFinalPaths = new Set(
      manifest.snippetFiles.map((f) => librarySnippetFilePath(snippetRoot, pkgSegment, versionSlug, f.relPath)),
    );
    const validator = new GraphValidator({
      snippetFileProbe: (abs) => plannedFinalPaths.has(abs),
      snippetFolderPath: snippetRoot,
      t: this.t,
    });
    const errors = validator.validate(reparsed.graph);
    if (errors.length > 0) return { error: `rewritten graph is invalid: ${errors.join('; ')}` };

    // Compute the plan: journal entries (owned snippets+protocol, marker LAST),
    // the ordered snippet writes, and the per-release commit-marker record.
    const markerPath = installedRecordPath(pkgSegment, versionSlug);
    const snippetNamespace = librarySnippetNamespace(snippetRoot, pkgSegment, versionSlug);
    const entries: JournalEntry[] = [];
    const snippetWrites: Array<{ path: string; content: string }> = [];
    for (const f of manifest.snippetFiles) {
      const path = librarySnippetFilePath(snippetRoot, pkgSegment, versionSlug, f.relPath);
      entries.push({ path, kind: 'owned' });
      snippetWrites.push({ path, content: contentMap.get(f.relPath)! });
    }
    entries.push({ path: protocolPath, kind: 'owned' });
    entries.push({ path: markerPath, kind: 'marker' }); // LAST

    // The recorded protocolSha256 is the hash of the INSTALLED (rewritten) doc as
    // written to disk (canonical pretty JSON + trailing newline, matching
    // writeJsonFile). The manifest's protocolSha256 verified the SOURCE doc's
    // integrity; the installed doc is a transformed copy whose hash must match
    // the on-disk file so the record's protocolSha256 is verifiable later.
    const installedProtocolSha256 = await sha256String(JSON.stringify(rewrittenDoc, null, 2) + '\n');
    const record: InstalledRecord = {
      schema: INSTALLED_RECORD_SCHEMA, version: INSTALLED_RECORD_VERSION,
      packageId, releaseVersion: version,
      installedAt: new Date().toISOString(),
      protocolPath, snippetNamespace,
      snippetFiles: manifest.snippetFiles,
      protocolSha256: installedProtocolSha256,
      author: manifest.author,
    };

    return {
      journal: {
        schema: TRANSACTIONS_SCHEMA, version: TRANSACTIONS_VERSION,
        packageId, releaseVersion: version, startedAt: new Date().toISOString(), entries,
      },
      rewrittenDoc, protocolPath, markerPath, snippetWrites, record,
    };
  }

  /** Read the marker for (packageId, version). Missing/malformed/identity-mismatch
   *  → null (treated as not-installed during install preflight). */
  private async readMarker(packageId: string, version: string): Promise<InstalledRecord | null> {
    const pkgSegment = await packageNamespaceSegment(packageId);
    const versionSlug = slugifyPackageId(version);
    try {
      const raw = await this.app.vault.adapter.read(installedRecordPath(pkgSegment, versionSlug));
      const parsed: unknown = JSON.parse(raw);
      if (isInstalledRecord(parsed) && parsed.packageId === packageId && parsed.releaseVersion === version) return parsed;
      return null;
    } catch {
      return null;
    }
  }

  /** Classify an occupied destination path as a collision (a different package
   *  owns it) or a dirty slot (leftover files, no owner). `findInstalledRecordForPath`
   *  matches protocol/snippet paths against installed records; the marker path is
   *  not matched by it, so a raw read detects a foreign marker at the slot. */
  private async classifyOccupiedPath(
    path: string, incomingPackageId: string, records: InstalledRecord[],
  ): Promise<{ collision: true; existing: string } | { collision: false }> {
    const owner = findInstalledRecordForPath(records, path);
    if (owner !== null && owner.packageId !== incomingPackageId) {
      return { collision: true, existing: owner.packageId };
    }
    if (owner === null) {
      try {
        const raw = await this.app.vault.adapter.read(path);
        const parsed: unknown = JSON.parse(raw);
        if (isInstalledRecord(parsed) && parsed.packageId !== incomingPackageId) {
          return { collision: true, existing: parsed.packageId };
        }
      } catch { /* not a valid record — dirty slot */ }
    }
    return { collision: false };
  }

  /** True if the marker at `path` is a valid InstalledRecord with matching
   *  identity → install committed. Absent/malformed/identity-mismatch → rollback. */
  private async isMarkerCommitted(markerPath: string, packageId: string, version: string): Promise<boolean> {
    try {
      const raw = await this.app.vault.adapter.read(markerPath);
      const parsed: unknown = JSON.parse(raw);
      return isInstalledRecord(parsed) && parsed.packageId === packageId && parsed.releaseVersion === version;
    } catch {
      return false;
    }
  }

  /** Uninstall a release: read the per-release marker, delete its owned paths
   *  (protocol + snippet files + marker) derived from the RECORD's stored
   *  protocolPath/snippetNamespace (Step 5 C6 — independent of current folder
   *  settings so changing a configured root after install doesn't orphan
   *  files), then clean now-empty namespace folders. Under the global
   *  installMutex (D7). Never throws — `not-installed` if no valid+identity
   *  marker exists for (packageId, version); `failed` (Step 5 C5) if any owned
   *  path couldn't be deleted. */
  /** A0: uninstall validates the record's stored paths against the namespace
   *  derived from its own (packageId, version) BEFORE deleting anything. A
   *  forged/corrupted record (paths outside the derived namespace) → explicit
   *  `failed` with no deletions and a manual-recovery instruction. Owned files
   *  are deleted first; the marker is deleted LAST and only on full success —
   *  a partial failure keeps the marker and returns an idempotent `failed` so
   *  a retry can complete. */
  async uninstall(packageId: string, version: string): Promise<UninstallResult> {
    return installMutex.runExclusive(INSTALL_LOCK_KEY, async () => {
      const record = await this.readMarker(packageId, version);
      if (record === null) return { status: 'not-installed', packageId, releaseVersion: version };
      const pkgSegment = await packageNamespaceSegment(packageId);
      const versionSlug = slugifyPackageId(version);
      const markerPath = installedRecordPath(pkgSegment, versionSlug);
      // A0: the record's protocolPath/snippetNamespace are DATA, not a path
      // source. Verify them against the independently derived expected slot;
      // on mismatch refuse every deletion (manual recovery instruction).
      const expected = await this.deriveExpectedPaths(packageId, version);
      const expectedProtocolPath = `${expected.protoNs}/${pkgSegment}.rp.json`;
      if (record.protocolPath !== expectedProtocolPath || record.snippetNamespace !== expected.snipNs) {
        return {
          status: 'failed', packageId, releaseVersion: version,
          reason: `installed record paths do not match the expected namespace for ${packageId}@${version} `
            + `(record: ${record.protocolPath}, ${record.snippetNamespace}; expected: ${expectedProtocolPath}, ${expected.snipNs}) `
            + `— no files were deleted; please resolve manually`,
        };
      }
      const protoNs = expected.protoNs;
      const snipNs = expected.snipNs;
      const paths = [record.protocolPath];
      for (const f of record.snippetFiles) {
        paths.push(`${snipNs}/${f.relPath}`);
      }
      // Owned files FIRST; the marker is deleted LAST and only on full success.
      let allRemoved = true;
      try {
        allRemoved = await this.removeOwnedPaths(paths, markerPath, protoNs, snipNs);
      } catch (e) {
        return { status: 'failed', packageId, releaseVersion: version, reason: `uninstall failed: ${safeErrorMessage(e)}` };
      }
      if (!allRemoved) {
        return { status: 'failed', packageId, releaseVersion: version, reason: 'uninstall could not remove all owned paths (see console)' };
      }
      try {
        if (await this.app.vault.adapter.exists(markerPath)) await this.app.vault.adapter.remove(markerPath);
      } catch (e) {
        return { status: 'failed', packageId, releaseVersion: version, reason: `uninstall failed to remove the marker: ${safeErrorMessage(e)}` };
      }
      return { status: 'ok', packageId, releaseVersion: version };
    });
  }

  /** Delete a set of owned paths (deepest-first) that pass the namespace-safety
   *  gate, then remove now-empty parent directories (with an emptiness check).
   *  Shared by rollbackTransaction (paths from journal entries; namespaces
   *  derived from current settings — the journal was created under them) and
   *  uninstall (paths/namespaces derived from the InstalledRecord so changing a
   *  configured root after install doesn't orphan files — Step 5 C6). Does NOT
   *  remove the journal — callers handle that. Called under the global installMutex.
   *
   *  Returns true when every owned path was removed (or already absent); false
   *  when at least one owned path existed but could not be deleted — callers
   *  (rollbackTransaction / uninstall) use this to decide whether to preserve
   *  the journal / report failure (Step 5 C4/C5).
   *
   *  Safety gate (D5): only delete paths that pass `assertNoTraversal` AND fall
   *  within the caller-supplied expected namespaces or are the expected marker
   *  path — a corrupted journal/record cannot sneak an arbitrary or
   *  traversal-bearing path (e.g. `protoNs/../../user-file.md`) past this gate. */
  private async removeOwnedPaths(
    paths: string[],
    markerPath: string,
    protoNs: string,
    snipNs: string,
  ): Promise<boolean> {
    const adapter = this.app.vault.adapter;
    const isOwned = (p: string): boolean =>
      assertNoTraversal(p) !== null &&
      (p === markerPath || p.startsWith(protoNs + '/') || p.startsWith(snipNs + '/'));

    let allRemoved = true;
    const removedPaths: string[] = [];
    const owned = paths.filter(isOwned);
    owned.sort((a, b) => b.length - a.length); // deepest-first → remove children before parents
    for (const path of owned) {
      try {
        if (await adapter.exists(path)) {
          await adapter.remove(path);
          removedPaths.push(path);
        }
      } catch {
        // best-effort — continue removing remaining paths, but flag incomplete removal
        allRemoved = false;
      }
    }

    // Empty-folder cleanup: walk each removed file's ancestors (stopping at the
    // configured roots / .radiprotocol/library so we never remove a vault root),
    // and remove a directory ONLY when adapter.list confirms it is empty. This
    // prevents recursive deletion of a non-empty folder that still holds other
    // packages' files (adapter.remove on a folder would otherwise recurse).
    const stopDirs = new Set([
      this.settings.protocolFolderPath, this.settings.snippetFolderPath,
      '.radiprotocol/library', '.radiprotocol',
    ]);
    const dirs = new Set<string>();
    for (const path of removedPaths) {
      let dir = parentDirOf(path);
      while (dir !== '' && !stopDirs.has(dir) && !dirs.has(dir)) {
        dirs.add(dir);
        const parent = parentDirOf(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
    const sortedDirs = [...dirs].sort((a, b) => b.length - a.length);
    for (const dir of sortedDirs) {
      try {
        const listing = await adapter.list(dir);
        if (listing.files.length === 0 && listing.folders.length === 0) await adapter.remove(dir);
      } catch {
        // best-effort
      }
    }
    return allRemoved;
  }

  /** Roll back a transaction (A0): every deletion path must be inside the
   *  independently derived expected namespaces (`expected`) — journal entry
   *  paths are verified, not trusted; a forged journal with paths outside any
   *  Library namespace deletes NOTHING and is quarantined (journal kept).
   *  Preserves the journal when any owned path could not be removed —
   *  recovery-on-load will retry. Returns the explicit outcome so recovery
   *  reports only CONFIRMED successes as rolledBack. Called under the global
   *  installMutex. */
  private async rollbackTransaction(
    journal: TransactionJournal,
    expected?: ExpectedPaths,
  ): Promise<{ status: 'ok' } | { status: 'failed'; reason: string }> {
    const exp = expected ?? await this.deriveExpectedPaths(journal.packageId, journal.releaseVersion);
    const markerPath = exp.markerPath;
    const isSafe = (p: string): boolean =>
      p === markerPath || p.startsWith(exp.protoNs + '/') || p.startsWith(exp.snipNs + '/');
    const journalPaths = journal.entries.map((e) => e.path);
    if (!journalPaths.every(isSafe)) {
      // Quarantine: a shape-valid journal naming paths outside this release's
      // expected namespaces must not cause ANY deletion.
      return { status: 'failed', reason: 'journal contains paths outside the expected package namespace — quarantined, no deletions' };
    }
    const allRemoved = await this.removeOwnedPaths(journalPaths, markerPath, exp.protoNs, exp.snipNs);
    if (!allRemoved) return { status: 'failed', reason: 'could not remove all journal-owned paths — journal preserved for retry' };
    try {
      await this.journalIO.remove(journal.packageId, journal.releaseVersion);
    } catch {
      return { status: 'failed', reason: 'owned paths removed but the journal file could not be deleted' };
    }
    return { status: 'ok' };
  }

  /** Discover namespace folders under ${root}/library/ that are NOT owned by any
   *  valid installed record (FR-4). A namespace folder is <root>/library/<pkgSegment>/<versionSlug>. */
  private async findOrphanedNamespaces(records: InstalledRecord[]): Promise<string[]> {
    const orphans = new Set<string>();
    for (const root of [this.settings.protocolFolderPath, this.settings.snippetFolderPath]) {
      if (root === '') continue;
      const libraryFolder = `${root}/${LIBRARY_SUBROOT}`;
      if (!(await this.app.vault.adapter.exists(libraryFolder))) continue;
      const pkgFolders = await this.listChildrenFolders(libraryFolder);
      for (const pkgFolder of pkgFolders) {
        const versionFolders = await this.listChildrenFolders(pkgFolder);
        for (const versionFolder of versionFolders) {
          const files = await this.listFilesRecursive(versionFolder);
          if (files.length === 0) continue;
          const owned = files.some((f) => findInstalledRecordForPath(records, f) !== null);
          if (!owned) orphans.add(versionFolder);
        }
      }
    }
    // A0: roots may CHANGE after installs (user moves protocol/snippet folders).
    // Version namespaces recorded under OLD roots are invisible to the scan above
    // but are still owned by their installed records — the record itself knows its
    // old protocol/snippet namespaces, so scan those too (the marker-file safety
    // check in cleanOrphanedNamespace still guards every deletion).
    for (const record of records) {
      const namespaces = [record.snippetNamespace, parentDirOf(record.protocolPath)];
      for (const ns of namespaces) {
        if (ns === '' || orphans.has(ns)) continue;
        // only namespace-shaped paths: <root>/library/<pkg>/<ver> (4+ segments)
        if (ns.split('/').length < 4) continue;
        if (!(await this.app.vault.adapter.exists(ns))) continue;
        const files = await this.listFilesRecursive(ns);
        if (files.length === 0) continue;
        const owned = files.some((f) => findInstalledRecordForPath(records, f) !== null);
        if (!owned) orphans.add(ns);
      }
    }
    return [...orphans];
  }

  /** Delete an orphaned namespace folder's files, guarded by the marker-file-exists
   *  safety check (D6). Returns true only when every file was confirmed removed;
   *  false when skipped (marker present) or the cleanup was incomplete (A0 — the
   *  caller reports the namespace as NOT cleaned). */
  private async cleanOrphanedNamespace(namespace: string): Promise<boolean> {
    const parts = namespace.split('/');
    const versionSlug = parts[parts.length - 1]!;
    const pkgSegment = parts[parts.length - 2]!;
    // D6 safety: skip if the marker .json is present at the installed slot — a
    // present-but-corrupt marker means a valid package might own this namespace.
    const markerSlot = installedRecordPath(pkgSegment, versionSlug);
    try {
      if (await this.app.vault.adapter.exists(markerSlot)) return false;
    } catch { return false; }
    const files = await this.listFilesRecursive(namespace);
    // A0: cleanup is confirmed only when ALL files were removed (not skipped
    // via a '' marker path that would let anything through the gate — the
    // namespace itself is the gate here, and removeOwnedPaths still returns
    // the honest all-removed boolean).
    return this.removeOwnedPaths(files, `${namespace}/__none__.json`, namespace, namespace);
  }

  private async listChildrenFolders(dir: string): Promise<string[]> {
    try { return (await this.app.vault.adapter.list(dir)).folders; }
    catch { return []; }
  }

  private async listFilesRecursive(dir: string): Promise<string[]> {
    const out: string[] = [];
    const queue: string[] = [dir];
    while (queue.length > 0) {
      const current = queue.shift()!;
      let listing: { files: string[]; folders: string[] };
      try { listing = await this.app.vault.adapter.list(current); }
      catch { continue; }
      out.push(...listing.files);
      queue.push(...listing.folders);
    }
    return out;
  }
}


/** Install plan produced by planInstall on successful in-memory validation. */
interface InstallPlan {
  journal: TransactionJournal;
  rewrittenDoc: ProtocolDocumentV1;
  protocolPath: string;
  markerPath: string;
  snippetWrites: Array<{ path: string; content: string }>;
  record: InstalledRecord;
}

function parentDirOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/'));
}

/** Deep-clone the stored protocol document for in-memory rewriting (the manifest
 *  is immutable; the installer rewrites a copy). */
function cloneDoc(doc: ProtocolDocumentV1): ProtocolDocumentV1 {
  return JSON.parse(JSON.stringify(doc)) as ProtocolDocumentV1;
}
