// src/library/library-model.ts
// Pure package/release/catalog model for the community library.
// Zero Obsidian imports (NFR-01). The package manifest WRAPS ProtocolDocumentV1
// as a value (isProtocolDocumentV1 rejects extra sentinels — see
// src/protocol/protocol-document.ts:163-183), never extends it.

import { isProtocolDocumentV1, type ProtocolDocumentV1 } from '../protocol/protocol-document';

/** Canonical schema identifier for a library package manifest. */
export const PACKAGE_MANIFEST_SCHEMA = 'radiprotocol.package' as const;
/** Current package manifest schema version. */
export const PACKAGE_MANIFEST_VERSION = 1 as const;

/** Canonical schema identifier for an installed-release record (per-release document — D15).
 *  One record file per installed release at
 *  `.radiprotocol/library/installed/<packageIdSlug>/<versionSlug>.json`; the
 *  record file's presence + validity IS the install commit marker (D7). */
export const INSTALLED_RECORD_SCHEMA = 'radiprotocol.installed-record' as const;
export const INSTALLED_RECORD_VERSION = 1 as const;

/** Canonical schema identifier for a cached catalog snapshot. */
export const CATALOG_SNAPSHOT_SCHEMA = 'radiprotocol.catalog' as const;
export const CATALOG_SNAPSHOT_VERSION = 1 as const;

/**
 * A snippet file carried by a package, with its integrity hash. `relPath` is
 * relative to the package's snippet namespace (extension-preserving, matching
 * the stored .rp.json reference format — see src/views/snippet-manager-view.ts:41-46).
 */
export interface PackageSnippetFile {
  /** Snippet-root-relative path, extension kept (e.g. 'folder/snippet.md'). */
  relPath: string;
  /** SHA-256 hex of the snippet file's UTF-8 bytes. */
  sha256: string;
}

/**
 * A library package release manifest. WRAPS ProtocolDocumentV1 as a value
 * (D14) — the manifest carries identity/release/provenance/hashes that
 * ProtocolDocumentV1 has no slot for. Forward-compatible with submission,
 * upgrade, and signature features, but contains NO speculative fields for
 * them (developer refinement).
 */
export interface PackageManifest {
  readonly schema: typeof PACKAGE_MANIFEST_SCHEMA;
  readonly version: typeof PACKAGE_MANIFEST_VERSION;
  /** Server-controlled opaque package identifier. */
  packageId: string;
  /** Server-controlled immutable release tag (e.g. '1.0.0'). */
  releaseVersion: string;
  /** The wrapped protocol document (validated by isProtocolDocumentV1 in isPackageManifest). */
  protocolDoc: ProtocolDocumentV1;
  /** SHA-256 hex of the canonical JSON of `protocolDoc` (pretty + trailing newline). */
  protocolSha256: string;
  /** Snippet files included in the package, with integrity hashes. */
  snippetFiles: PackageSnippetFile[];
  /** Catalog entry id this release belongs to. */
  catalogEntryId: string;
  /** Author display info (no auth identity in foundation scope). */
  author?: { displayName: string };
  /** ISO 8601 timestamp the release was published server-side. */
  publishedAt: string;
}

/** A catalog list entry (search/discovery surface). */
export interface CatalogEntry {
  packageId: string;
  title: string;
  description: string;
  author: { displayName: string };
  /** Latest immutable release tag available. */
  latestVersion: string;
  categories: string[];
  /** ISO 8601 of the latest release. */
  updatedAt: string;
  summary?: string;
}

/**
 * Cached catalog snapshot. Persisted under .radiprotocol/library/ so offline
 * use serves the last-good list.
 */
export interface CatalogSnapshot {
  readonly schema: typeof CATALOG_SNAPSHOT_SCHEMA;
  readonly version: typeof CATALOG_SNAPSHOT_VERSION;
  /** ISO 8601 timestamp the snapshot was fetched. */
  fetchedAt: string;
  entries: CatalogEntry[];
}

/**
 * Result of fetching the catalog. `unavailable` is the explicit "catalog
 * unavailable" state (no endpoint configured, network failure, non-https
 * rejected) — NEVER a throw (D6). `cachedSnapshot` carries the last-good
 * snapshot when one exists.
 */
export type CatalogFetchResult =
  | { status: 'ok'; snapshot: CatalogSnapshot }
  | { status: 'unavailable'; reason: string; cachedSnapshot: CatalogSnapshot | null };

/**
 * An installed release record — persisted as a per-release schema-versioned
 * document (D15). One file per installed release at
 * `.radiprotocol/library/installed/<packageIdSlug>/<versionSlug>.json`; the
 * file's presence + validity IS the install commit marker (D7 — written LAST
 * by the installer; absence after an interrupt = incomplete install =
 * rollback/cleanup trigger on next load). `snippetFiles`/`protocolPath` are
 * the ONLY paths uninstall/rollback may delete (D5 — delete only owned paths).
 */
export interface InstalledRecord {
  readonly schema: typeof INSTALLED_RECORD_SCHEMA;
  readonly version: typeof INSTALLED_RECORD_VERSION;
  packageId: string;
  releaseVersion: string;
  /** ISO 8601 install timestamp. */
  installedAt: string;
  /** Vault-relative path of the installed protocol file. */
  protocolPath: string;
  /** Vault-relative root of the installed snippet namespace. */
  snippetNamespace: string;
  /** Snippet files owned by this install (namespace-relative + hash). */
  snippetFiles: PackageSnippetFile[];
  /** SHA-256 of the installed protocol document. */
  protocolSha256: string;
  author?: { displayName: string };
}

/**
 * A downloaded release bundle ready to stage. The manifest carries the
 * protocol document and all hashes; `snippetContents` carries the bytes.
 */
export interface ReleaseBundle {
  manifest: PackageManifest;
  /** Snippet file contents keyed by `PackageSnippetFile.relPath`. */
  snippetContents: Array<{ relPath: string; content: string }>;
}

/**
 * Explicit recoverable store error (D3 — malformed files produce an explicit
 * error, never a silent reset). Thrown by the library stores on parse/schema
 * failure; missing files are an empty initial state, NOT this error.
 */
export class LibraryStoreError extends Error {
  readonly kind: 'malformed' | 'write-failed' | 'read-failed';
  readonly path: string;
  constructor(kind: LibraryStoreError['kind'], path: string, message: string) {
    super(`[Protocol Former] library store ${kind} at ${path}: ${message}`);
    this.name = 'LibraryStoreError';
    this.kind = kind;
    this.path = path;
  }
}

/** Shape guard for a PackageSnippetFile entry. */
function isPackageSnippetFile(value: unknown): value is PackageSnippetFile {
  if (typeof value !== 'object' || value === null) return false;
  const f = value as Record<string, unknown>;
  return typeof f['relPath'] === 'string' && typeof f['sha256'] === 'string';
}

/** Validate an optional author display object. */
function isOptionalAuthor(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== 'object' || value === null) return false;
  return typeof (value as Record<string, unknown>)['displayName'] === 'string';
}

/** Validate an optional string field. */
function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

/** Shape guard for PackageManifest (sentinel + structural + wrapped-doc validity + element soundness). */
export function isPackageManifest(value: unknown): value is PackageManifest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v['schema'] === PACKAGE_MANIFEST_SCHEMA &&
    v['version'] === PACKAGE_MANIFEST_VERSION &&
    typeof v['packageId'] === 'string' &&
    typeof v['releaseVersion'] === 'string' &&
    isProtocolDocumentV1(v['protocolDoc']) &&
    typeof v['protocolSha256'] === 'string' &&
    Array.isArray(v['snippetFiles']) &&
    v['snippetFiles'].every((f) => isPackageSnippetFile(f)) &&
    typeof v['catalogEntryId'] === 'string' &&
    typeof v['publishedAt'] === 'string' &&
    isOptionalAuthor(v['author'])
  );
}

/** Shape guard for CatalogEntry (author required; categories + summary element-validated). */
export function isCatalogEntry(value: unknown): value is CatalogEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const author = v['author'];
  const authorOk =
    typeof author === 'object' &&
    author !== null &&
    typeof (author as Record<string, unknown>)['displayName'] === 'string';
  return (
    typeof v['packageId'] === 'string' &&
    typeof v['title'] === 'string' &&
    typeof v['description'] === 'string' &&
    typeof v['latestVersion'] === 'string' &&
    Array.isArray(v['categories']) &&
    v['categories'].every((c) => typeof c === 'string') &&
    typeof v['updatedAt'] === 'string' &&
    isOptionalString(v['summary']) &&
    authorOk
  );
}

/** Shape guard for an InstalledRecord (per-release document — D15). Validates the
 *  schema + version sentinels, all required fields, snippetFiles elements, and
 *  the optional author. Used by InstalledRecordStore.read/list and by the
 *  Slice 4 installer to confirm a commit marker is valid during recovery. */
export function isInstalledRecord(value: unknown): value is InstalledRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    r['schema'] === INSTALLED_RECORD_SCHEMA &&
    r['version'] === INSTALLED_RECORD_VERSION &&
    typeof r['packageId'] === 'string' &&
    typeof r['releaseVersion'] === 'string' &&
    typeof r['installedAt'] === 'string' &&
    typeof r['protocolPath'] === 'string' &&
    typeof r['snippetNamespace'] === 'string' &&
    Array.isArray(r['snippetFiles']) &&
    r['snippetFiles'].every((f) => isPackageSnippetFile(f)) &&
    typeof r['protocolSha256'] === 'string' &&
    isOptionalAuthor(r['author'])
  );
}

/** Shape guard for CatalogSnapshot (entries element-validated via isCatalogEntry). */
export function isCatalogSnapshot(value: unknown): value is CatalogSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v['schema'] === CATALOG_SNAPSHOT_SCHEMA &&
    v['version'] === CATALOG_SNAPSHOT_VERSION &&
    typeof v['fetchedAt'] === 'string' &&
    Array.isArray(v['entries']) &&
    v['entries'].every((e) => isCatalogEntry(e))
  );
}
