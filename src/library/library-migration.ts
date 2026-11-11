// src/library/library-migration.ts
// Pure one-time slug-only → slug+hash path migration for installed records (D2/D5).
// Zero Obsidian imports (NFR-01). Modeled on migrateProtocolDocument
// (src/protocol/protocol-document-migration.ts): discriminator-first, idempotent,
// lossless via layered spreads. The Obsidian-touching orchestrator lives on
// LibraryInstaller (src/library/library-installer.ts); this module only plans.

import type { InstalledRecord } from './library-model';
import type { ProtocolDocumentV1 } from '../protocol/protocol-document';
import {
  LIBRARY_SUBROOT, libraryProtocolFilePath, librarySnippetNamespace,
  rewriteSnippetRef, slugifyPackageId,
} from './library-paths';
import { installedRecordPath } from './installed-record-store';

/** A planned old→new move for one installed record. */
interface MigrationPlan {
  record: InstalledRecord;
  rewrittenDoc: ProtocolDocumentV1;
  oldProtocolPath: string;
  newProtocolPath: string;
  oldSnippetNamespace: string;
  newSnippetNamespace: string;
  oldMarkerPath: string;
  newMarkerPath: string;
  snippetMoves: Array<{ relPath: string; oldPath: string; newPath: string }>;
}

/** Plan a single record's slug-only → slug+hash migration. Pure + idempotent:
 *  a record whose `protocolPath` already matches the new-scheme derivation (D2 —
 *  path-shape discriminator) returns `{ changed: false }`. Lossless — the returned
 *  record spreads the input so author/installedAt/snippetFiles/packageId/
 *  releaseVersion are preserved; only protocolPath + snippetNamespace change.
 *  `pkgSegment` is the precomputed `packageNamespaceSegment(record.packageId)`
 *  (slug + shortHash of the RAW id); `versionSlug` is `slugifyPackageId(record.releaseVersion)`. */
export function planRecordMigration(
  record: InstalledRecord,
  protocolDoc: ProtocolDocumentV1,
  pkgSegment: string,
  versionSlug: string,
  protocolRoot: string,
  snippetRoot: string,
): { changed: false } | { changed: true; plan: MigrationPlan } | { changed: false; error: string } {
  const newProtocolPath = libraryProtocolFilePath(protocolRoot, pkgSegment, versionSlug);
  if (record.protocolPath === newProtocolPath) return { changed: false }; // D2 discriminator

  const newSnippetNamespace = librarySnippetNamespace(snippetRoot, pkgSegment, versionSlug);
  const oldSnippetNamespace = record.snippetNamespace;
  // The installed doc's snippetPath/subfolderPath are namespace-RELATIVE
  // (library/<slug>/<versionSlug>/<relPath> — set at install time via rewriteSnippetRef).
  const oldNsRel = `${LIBRARY_SUBROOT}/${slugifyPackageId(record.packageId)}/${versionSlug}`;
  const newNsRel = `${LIBRARY_SUBROOT}/${pkgSegment}/${versionSlug}`;
  const mapping = new Map<string, string>([[oldNsRel, newNsRel]]);

  const rewrittenDoc: ProtocolDocumentV1 = JSON.parse(JSON.stringify(protocolDoc));
  for (const node of rewrittenDoc.nodes) {
    if (node.kind !== 'snippet') continue;
    const sp = node.fields['snippetPath'];
    const sfp = node.fields['subfolderPath'];
    if (typeof sp === 'string' && sp !== '') {
      const rewritten = rewriteSnippetRef(sp, mapping);
      // C6: fail (not silently skip) when a ref doesn't match the legacy namespace —
      // otherwise the ref dangles after removeOwnedPaths deletes the old namespace.
      if (rewritten === null) return { changed: false, error: `snippet node "${node.id}" has a snippetPath ("${sp}") not under the legacy namespace — cannot migrate` };
      node.fields['snippetPath'] = rewritten;
    } else if (typeof sfp === 'string' && sfp !== '') {
      const rewritten = rewriteSnippetRef(sfp, mapping);
      if (rewritten === null) return { changed: false, error: `snippet node "${node.id}" has a subfolderPath ("${sfp}") not under the legacy namespace — cannot migrate` };
      node.fields['subfolderPath'] = rewritten;
    }
  }

  const snippetMoves = record.snippetFiles.map((f) => ({
    relPath: f.relPath,
    oldPath: `${oldSnippetNamespace}/${f.relPath}`,
    newPath: `${newSnippetNamespace}/${f.relPath}`,
  }));

  return {
    changed: true,
    plan: {
      record: { ...record, protocolPath: newProtocolPath, snippetNamespace: newSnippetNamespace },
      rewrittenDoc,
      oldProtocolPath: record.protocolPath, newProtocolPath,
      oldSnippetNamespace, newSnippetNamespace,
      oldMarkerPath: installedRecordPath(slugifyPackageId(record.packageId), versionSlug),
      newMarkerPath: installedRecordPath(pkgSegment, versionSlug),
      snippetMoves,
    },
  };
}
