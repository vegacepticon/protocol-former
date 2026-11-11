// src/library/library-service.ts
// Facade for the community library: catalog discovery (fetch + cache +
// filter), install (fetch release → installer), uninstall, installed-record
// listing, and recovery-on-load orchestration. Consumes RegistryClient,
// LibraryInstaller, LibraryCacheStore, InstalledRecordStore. Views consume this;
// this layer never imports views. Modeled after SnippetService
// (src/snippets/snippet-service.ts) — Obsidian-touching via injected stores.

import { TFile, type App } from 'obsidian';
import { defaultT, type Translator } from '../i18n';
import { PACKAGE_MANIFEST_SCHEMA, PACKAGE_MANIFEST_VERSION, type CatalogEntry, type CatalogFetchResult, type InstalledRecord, type PackageManifest, type PackageSnippetFile, type ReleaseBundle } from './library-model';
import { isReleaseResponse } from './registry-model';
import { RegistryClient } from './registry-client';
import { LibraryCacheStore } from './library-cache-store';
import { InstalledRecordStore } from './installed-record-store';
import {
  LibraryInstaller,
  type InstallResult, type LibraryInstallerSettings, type RecoveryReport, type UninstallResult,
} from './library-installer';
import { safeErrorMessage, writeJsonFile } from './library-json-io';
import { ProtocolDocumentParser } from '../protocol/protocol-document-parser';
import { isProtocolDocumentV1, type ProtocolDocumentV1 } from '../protocol/protocol-document';
import { sha256String } from './integrity';
import {
  assertNoTraversal, libraryProtocolFilePath, packageNamespaceSegment,
  slugifyPackageId, validPackageSlug,
} from './library-paths';
import { WriteMutex } from '../utils/write-mutex';

/** Query for catalog filtering. */
interface CatalogQuery {
  /** Free-text query matched against title/description/author/categories (case-insensitive). */
  query?: string;
  /** Category filter (exact match against entry.categories). */
  filter?: string;
}

/** Result of listing the catalog. `available=false` = the registry endpoint was
 *  unavailable (no endpoint, network failure, non-https, malformed); entries are
 *  then the cached snapshot (possibly empty) — the explicit "catalog
 *  unavailable" state (D6), never a throw. `cacheError` (Step 5 C7) is set when a
 *  cached snapshot existed but was unreadable, so the banner can distinguish
 *  "no cache" from "cache corrupt". */
export interface CatalogListResult {
  entries: CatalogEntry[];
  available: boolean;
  /** Set when `available=false`. */
  reason?: string;
  /** ISO 8601 of the snapshot being served (fetched just now, or the cached one). */
  fetchedAt?: string;
  /** Set when the cached snapshot was present but unreadable (Step 5 C7). */
  cacheError?: string;
}

/** Result of fetching a release manifest for the UI trust preview (Slice 7).
 *  Never throws. A trimmed view of ReleaseFetchResult (the manifest only —
 *  snippet contents are NOT shipped to the preview). */
export type ReleaseManifestResult =
  | { status: 'ok'; manifest: PackageManifest }
  | { status: 'not-found'; reason: string }
  | { status: 'unavailable'; reason: string };

/** Vault-index readiness after a transaction has committed successfully. */
export type InstallReadiness =
  | { status: 'ready'; protocolPath: string }
  | { status: 'timed-out'; protocolPath: string; timeoutMs: number };

/** Service-level install result. The installer remains authoritative for commit
 * truth; readiness only describes whether Obsidian indexed the committed
 * protocol within the bounded wait. */
export type LibraryInstallResult =
  | (Extract<InstallResult, { status: 'ok' }> & { readiness: InstallReadiness })
  | Extract<InstallResult, { status: 'failed' }>;

export type LibraryServiceSettings = LibraryInstallerSettings;

/** Metadata for building a local package (FR-5). */
interface PackageBuildMeta {
  packageId: string;
  releaseVersion: string;
  author?: { displayName: string };
}
/** Result of building a local package. Never throws. `collisionWith` (FR-7) is set when a
 *  package with the same slug is already installed (DATA, not an i18n string — the modal i18n's it). */
export type BuildResult =
  | { status: 'ok'; bundle: ReleaseBundle; collisionWith?: string }
  | { status: 'failed'; reason: string };

export interface LibraryServiceOptions {
  t?: Translator;
  installer?: LibraryInstaller;
  cacheStore?: LibraryCacheStore;
  recordStore?: InstalledRecordStore;
  /** Test seam only; production bounds remain fixed at 5 seconds / 100 ms. */
  readiness?: {
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  };
}

const INSTALL_READINESS_TIMEOUT_MS = 5_000;
const INSTALL_READINESS_POLL_INTERVAL_MS = 100;

export class LibraryService {
  private readonly app: App;
  private readonly registryClient: RegistryClient;
  private readonly t: Translator;
  private readonly settings: LibraryServiceSettings;
  private readonly exportMutex = new WriteMutex();
  private readonly readinessNow: () => number;
  private readonly readinessSleep: (ms: number) => Promise<void>;
  /** The transactional installer (public for main.ts recovery-on-load wiring). */
  readonly installer: LibraryInstaller;
  private readonly cacheStore: LibraryCacheStore;
  /** The installed-record store (public for Slice 8 read-only integration lookups). */
  readonly recordStore: InstalledRecordStore;

  constructor(
    app: App,
    settings: LibraryServiceSettings,
    registryClient: RegistryClient,
    options: LibraryServiceOptions = {},
  ) {
    this.app = app;
    this.settings = settings;
    this.registryClient = registryClient;
    this.t = options.t ?? defaultT;
    this.cacheStore = options.cacheStore ?? new LibraryCacheStore(app);
    this.recordStore = options.recordStore ?? new InstalledRecordStore(app);
    this.installer = options.installer ?? new LibraryInstaller(app, settings, {
      t: this.t,
      listInstalled: () => this.recordStore.list(),
    });
    this.readinessNow = options.readiness?.now ?? (() => globalThis.performance.now());
    this.readinessSleep = options.readiness?.sleep ?? ((ms) => new Promise((resolve) => {
      globalThis.setTimeout(resolve, ms);
    }));
  }

  /** List the catalog with optional filtering. Fetches from the registry; on
   *  unavailable, serves the cached snapshot (explicit unavailable state, D6).
   *  Never throws. */
  async listCatalog(query?: CatalogQuery): Promise<CatalogListResult> {
    let entries: CatalogEntry[];
    let available: boolean;
    let reason: string | undefined;
    let fetchedAt: string | undefined;
    let cacheError: string | undefined;
    try {
      const fetchResult: CatalogFetchResult = await this.registryClient.fetchCatalog();
      if (fetchResult.status === 'ok') {
        available = true;
        entries = fetchResult.snapshot.entries;
        fetchedAt = fetchResult.snapshot.fetchedAt;
        // Persist the fresh snapshot for offline / next-time use (best-effort).
        try { await this.cacheStore.writeSnapshot(fetchResult.snapshot); } catch { /* best-effort cache */ }
      } else {
        available = false;
        reason = fetchResult.reason;
        const cached = await this.readCachedSnapshot();
        if (cached !== null && 'error' in cached) { cacheError = cached.error; entries = []; fetchedAt = undefined; }
        else if (cached !== null) { entries = cached.entries; fetchedAt = cached.fetchedAt; }
        else { entries = []; fetchedAt = undefined; }
      }
    } catch (e) {
      // A registry client never throws (D2/D6), but defend-in-depth: treat any
      // unexpected throw as an unavailable catalog serving the cache.
      available = false;
      reason = `catalog fetch error: ${safeErrorMessage(e)}`;
      const cached = await this.readCachedSnapshot();
      if (cached !== null && 'error' in cached) { cacheError = cached.error; entries = []; fetchedAt = undefined; }
      else if (cached !== null) { entries = cached.entries; fetchedAt = cached.fetchedAt; }
      else { entries = []; fetchedAt = undefined; }
    }
    return { entries: filterEntries(entries, query), available, reason, fetchedAt, cacheError };
  }

  /** Fetch, transactionally install, then wait for the committed protocol to
   * become an indexed TFile. Never throws. A readiness timeout remains an ok
   * install because the marker-last transaction has already committed. */
  async install(packageId: string, version: string): Promise<LibraryInstallResult> {
    try {
      if (this.settings.protocolFolderPath === '') {
        return {
          status: 'failed', packageId, releaseVersion: version,
          reason: 'protocol folder is not configured',
        };
      }

      const release = await this.registryClient.fetchRelease(packageId, version);
      if (release.status !== 'ok') {
        const reason = release.status === 'not-found' ? release.reason : `release unavailable: ${release.reason}`;
        return { status: 'failed', packageId, releaseVersion: version, reason };
      }

      // Derive the expected indexed path before mutation. If Web Crypto/path
      // derivation fails, no install has started and returning failed is truthful.
      const pkgSegment = await packageNamespaceSegment(release.bundle.manifest.packageId);
      const versionSlug = slugifyPackageId(release.bundle.manifest.releaseVersion);
      const protocolPath = libraryProtocolFilePath(this.settings.protocolFolderPath, pkgSegment, versionSlug);

      const installResult = await this.installer.install(release.bundle);
      if (installResult.status === 'failed') return installResult;

      const readiness = await this.waitForProtocolReadiness(protocolPath);
      return { ...installResult, readiness };
    } catch (e) {
      return { status: 'failed', packageId, releaseVersion: version, reason: `install failed: ${safeErrorMessage(e)}` };
    }
  }

  /** Install a package from a LOCAL release bundle file (moderation review flow):
   *  read + validate the JSON, run the SAME transactional installer used for
   *  registry installs, then wait for vault-index readiness. Never throws. */
  async installFromFile(filePath: string): Promise<LibraryInstallResult> {
    try {
      let raw: string;
      try {
        raw = await this.app.vault.adapter.read(filePath);
      } catch {
        return { status: 'failed', packageId: '', releaseVersion: '', reason: `could not read file: ${filePath}` };
      }
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(raw);
      } catch {
        return { status: 'failed', packageId: '', releaseVersion: '', reason: 'file is not valid JSON' };
      }
      if (!isReleaseResponse(parsedJson)) {
        return { status: 'failed', packageId: '', releaseVersion: '', reason: 'file is not a valid release bundle ({ manifest, snippetContents })' };
      }
      const bundle = { manifest: parsedJson.manifest, snippetContents: parsedJson.snippetContents };
      return await this.installFromBundle(bundle);
    } catch (e) {
      return { status: 'failed', packageId: '', releaseVersion: '', reason: `import failed: ${safeErrorMessage(e)}` };
    }
  }

  /** Transactional install of an in-memory bundle + readiness wait. Never throws. */
  async installFromBundle(bundle: ReleaseBundle): Promise<LibraryInstallResult> {
    const packageId = bundle.manifest.packageId;
    const version = bundle.manifest.releaseVersion;
    try {
      if (this.settings.protocolFolderPath === '') {
        return { status: 'failed', packageId, releaseVersion: version, reason: 'protocol folder is not configured' };
      }
      // Derive the expected indexed path before mutation. If Web Crypto/path
      // derivation fails, no install has started and returning failed is truthful.
      const pkgSegment = await packageNamespaceSegment(packageId);
      const versionSlug = slugifyPackageId(version);
      const protocolPath = libraryProtocolFilePath(this.settings.protocolFolderPath, pkgSegment, versionSlug);

      const installResult = await this.installer.install(bundle);
      if (installResult.status === 'failed') return installResult;

      const readiness = await this.waitForProtocolReadiness(protocolPath);
      return { ...installResult, readiness };
    } catch (e) {
      return { status: 'failed', packageId, releaseVersion: version, reason: `install failed: ${safeErrorMessage(e)}` };
    }
  }

  private async waitForProtocolReadiness(protocolPath: string): Promise<InstallReadiness> {
    let lastError: unknown;
    try {
      const startedAt = this.readinessNow();
      let scheduledWaitMs = 0;
      while (true) {
        let indexed: unknown = null;
        try {
          indexed = this.app.vault.getAbstractFileByPath(protocolPath);
        } catch (e) {
          // Keep polling because a later Vault lookup may recover.
          lastError = e;
        }
        if (indexed instanceof TFile) return { status: 'ready', protocolPath };

        const elapsedByClock = Math.max(0, this.readinessNow() - startedAt);
        const elapsedMs = Math.max(elapsedByClock, scheduledWaitMs);
        if (elapsedMs >= INSTALL_READINESS_TIMEOUT_MS) {
          this.warnReadinessError(protocolPath, lastError);
          return {
            status: 'timed-out', protocolPath,
            timeoutMs: INSTALL_READINESS_TIMEOUT_MS,
          };
        }

        const delayMs = Math.min(
          INSTALL_READINESS_POLL_INTERVAL_MS,
          INSTALL_READINESS_TIMEOUT_MS - elapsedMs,
        );
        await this.readinessSleep(delayMs);
        scheduledWaitMs += delayMs;
      }
    } catch (e) {
      this.warnReadinessError(protocolPath, e);
      return {
        status: 'timed-out', protocolPath,
        timeoutMs: INSTALL_READINESS_TIMEOUT_MS,
      };
    }
  }

  private warnReadinessError(protocolPath: string, error: unknown): void {
    if (error === undefined) return;
    console.warn(
      `[RadiProtocol] library protocol readiness check failed for ${protocolPath}`,
      error,
    );
  }

  /** Uninstall a release by (packageId, version). Never throws. */
  async uninstall(packageId: string, version: string): Promise<UninstallResult> {
    try {
      return await this.installer.uninstall(packageId, version);
    } catch (e) {
      return { status: 'failed', packageId, releaseVersion: version, reason: `uninstall failed: ${safeErrorMessage(e)}` };
    }
  }

  /** List all installed releases. Never throws — a store read failure returns []
   *  and logs a warning (Step 5 C7: throw-safe default is intentional UI safety, but
   *  the failure is no longer silent). */
  async listInstalled(): Promise<InstalledRecord[]> {
    try {
      return await this.recordStore.list();
    } catch (e) {
      console.warn('[RadiProtocol] library listInstalled failed — serving empty list', e);
      return [];
    }
  }

  /** Read one installed record by (packageId, version) — for the UI's installed
   *  indicator (Slice 8). Missing/malformed → null. Never throws; logs a warning
   *  on store failure (Step 5 C7). */
  async getInstalledRecord(packageId: string, version: string): Promise<InstalledRecord | null> {
    try {
      return await this.recordStore.read(packageId, version);
    } catch (e) {
      console.warn(`[RadiProtocol] library getInstalledRecord(${packageId}, ${version}) failed — treating as not installed`, e);
      return null;
    }
  }

  /** Fetch a release manifest for the UI trust preview (Slice 7). Never throws.
   *  Returns the manifest (file list + SHA-256 hashes) WITHOUT snippet contents
   *  — the preview shows what will be installed and its integrity hashes before
   *  the user commits. The actual install re-fetches the full bundle.
   *  Step 5 C8: uses the manifest-only `fetchReleaseManifest` so snippet bytes
   *  are not shipped to the preview. */
  async getReleaseManifest(packageId: string, version: string): Promise<ReleaseManifestResult> {
    try {
      const result = await this.registryClient.fetchReleaseManifest(packageId, version);
      if (result.status === 'ok') return { status: 'ok', manifest: result.manifest };
      return result;
    } catch (e) {
      return { status: 'unavailable', reason: `manifest fetch error: ${safeErrorMessage(e)}` };
    }
  }

  /** Build a local package (FR-5): assemble a SOURCE (un-rewritten) ReleaseBundle from a
   *  protocol doc + its referenced snippets, with source SHA-256 hashes. Never throws. */
  async buildLocalPackage(protocolPath: string, meta: PackageBuildMeta): Promise<BuildResult> {
    try {
      if (validPackageSlug(meta.packageId) === null) return { status: 'failed', reason: `invalid package id "${meta.packageId}": slugifies to empty` };
      if (validPackageSlug(meta.releaseVersion) === null) return { status: 'failed', reason: `invalid release version "${meta.releaseVersion}": slugifies to empty` };
      const snippetRoot = this.settings.snippetFolderPath;
      let raw: string;
      try { raw = await this.app.vault.adapter.read(protocolPath); }
      catch { return { status: 'failed', reason: `could not read protocol file: ${protocolPath}` }; }
      let doc: unknown;
      try { doc = JSON.parse(raw); }
      catch { return { status: 'failed', reason: 'protocol file is not valid JSON' }; }
      if (!isProtocolDocumentV1(doc)) return { status: 'failed', reason: 'protocol file is not a valid ProtocolDocumentV1' };
      const parser = new ProtocolDocumentParser(this.t);
      const parsed = parser.parse(raw, protocolPath);
      if (!parsed.success) return { status: 'failed', reason: `protocol document failed to parse: ${parsed.error}` };
      const snippetNodes = [...parsed.graph.nodes.values()].filter((n) => n.kind === 'snippet');
      const seenRel = new Set<string>();
      const snippetFiles: PackageSnippetFile[] = [];
      const snippetContents: Array<{ relPath: string; content: string }> = [];
      const rootPrefix = snippetRoot === '' ? '' : snippetRoot + '/';
      for (const node of snippetNodes) {
        const sp = node.radiprotocol_snippetPath;
        const sfp = node.subfolderPath;
        if (typeof sp === 'string' && sp !== '') {
          if (!sp.endsWith('.md')) return { status: 'failed', reason: `snippet file "${sp}" is not .md` };
          if (assertNoTraversal(sp) === null) return { status: 'failed', reason: `snippet file "${sp}" has an unsafe path` };
          if (!seenRel.has(sp)) {
            let content: string;
            try { content = await this.app.vault.adapter.read(`${rootPrefix}${sp}`); }
            catch { return { status: 'failed', reason: `snippet file not found: ${sp}` }; }
            seenRel.add(sp);
            snippetFiles.push({ relPath: sp, sha256: await sha256String(content) });
            snippetContents.push({ relPath: sp, content });
          }
        } else if (typeof sfp === 'string' && sfp !== '') {
          if (assertNoTraversal(sfp) === null) return { status: 'failed', reason: `subfolder path "${sfp}" is unsafe` };
          let files: string[];
          try { files = await this.listFilesRecursive(`${rootPrefix}${sfp}`); }
          catch { return { status: 'failed', reason: `subfolder not found: ${sfp}` }; }
          const mdFiles = files.filter((f) => f.endsWith('.md'));
          if (mdFiles.length === 0) return { status: 'failed', reason: `snippet node "${node.id}" references subfolder "${sfp}" but it has no .md files` };
          for (const f of mdFiles) {
            const relPath = snippetRoot === '' ? f : f.slice(`${snippetRoot}/`.length);
            if (seenRel.has(relPath)) continue;
            let content: string;
            try { content = await this.app.vault.adapter.read(f); }
            catch { return { status: 'failed', reason: `snippet file not found: ${relPath}` }; }
            seenRel.add(relPath);
            snippetFiles.push({ relPath, sha256: await sha256String(content) });
            snippetContents.push({ relPath, content });
          }
        } else {
          return { status: 'failed', reason: `snippet node "${node.id}" is root-bound (no snippetPath or subfolderPath)` };
        }
      }
      const protocolSha256 = await sha256String(JSON.stringify(doc, null, 2) + '\n');
      const manifest: PackageManifest = {
        schema: PACKAGE_MANIFEST_SCHEMA, version: PACKAGE_MANIFEST_VERSION,
        packageId: meta.packageId, releaseVersion: meta.releaseVersion,
        protocolDoc: doc as ProtocolDocumentV1, protocolSha256, snippetFiles,
        catalogEntryId: meta.packageId, publishedAt: new Date().toISOString(), author: meta.author,
      };
      let collisionWith: string | undefined;
      try {
        const records = await this.listInstalled();
        const builderSlug = slugifyPackageId(meta.packageId);
        const colliding = records.find((r) => slugifyPackageId(r.packageId) === builderSlug && r.packageId !== meta.packageId);
        if (colliding) collisionWith = colliding.packageId;
      } catch { /* best-effort */ }
      return { status: 'ok', bundle: { manifest, snippetContents }, collisionWith };
    } catch (e) {
      return { status: 'failed', reason: safeErrorMessage(e) };
    }
  }

  /** Write a package bundle as a single JSON file (FR-6/D3) — round-trips through `isReleaseResponse`. */
  async writePackageExport(bundle: ReleaseBundle, destPath: string): Promise<void> {
    const parentDir = destPath.slice(0, destPath.lastIndexOf('/'));
    await writeJsonFile(this.app.vault, this.exportMutex, destPath, parentDir, bundle);
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

  /** Recovery on load: finalize any in-flight installs. Never throws. */
  async recoverInterruptedInstalls(): Promise<RecoveryReport> {
    try {
      const report = await this.installer.recoverInterrupted();
      // One-time slug→slug+hash migration AFTER recovery (in-flight legacy journals
      // are committed/rolled back first), still under the installMutex. Idempotent;
      // a failure is logged but does not surface as a recovery failure.
      try {
        const migration = await this.installer.migrateInstalledRecords();
        if (migration.failed.length > 0) {
          console.warn('[RadiProtocol] library migration completed with failures', migration.failed);
        }
      } catch (e) {
        console.warn('[RadiProtocol] library migration failed — will retry on next load', e);
      }
      return report;
    } catch {
      return { committed: [], rolledBack: [], orphansCleaned: [] };
    }
  }

  /** Read the cached snapshot (best-effort; malformed/missing → null; logs a
   *  warning on read failure — Step 5 C7). Returns `{ entries, fetchedAt }` on
   *  success, `null` when the cache is missing, or `{ error }` when the cache
   *  file exists but is unreadable (so listCatalog can populate cacheError). */
  private async readCachedSnapshot(): Promise<{ entries: CatalogEntry[]; fetchedAt: string } | { error: string } | null> {
    try {
      const snap = await this.cacheStore.readSnapshot();
      return snap ? { entries: snap.entries, fetchedAt: snap.fetchedAt } : null;
    } catch (e) {
      console.warn('[RadiProtocol] library cached snapshot unreadable', e);
      return { error: safeErrorMessage(e) };
    }
  }
}

/** Filter catalog entries by a free-text query (title/description/author/
 *  categories/summary) and an exact category filter. Pure. */
function filterEntries(entries: CatalogEntry[], query?: CatalogQuery): CatalogEntry[] {
  if (!query) return entries;
  const q = query.query?.trim().toLowerCase();
  const cat = query.filter?.trim();
  return entries.filter((e) => {
    if (cat !== undefined && cat !== '' && !e.categories.includes(cat)) return false;
    if (q !== undefined && q !== '') {
      const hay = [e.title, e.description, e.author.displayName, ...e.categories, e.summary ?? ''].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}
