// src/library/registry-client.ts
// Network client for the official library catalog + release downloads.
// Obsidian-touching ONLY via the injected requestUrl (D2) — imports
// `requestUrl` from 'obsidian' as the production default but never touches the
// vault. `obsidian` is esbuild-external (esbuild.config.mjs) so the import
// resolves at runtime inside the app. Tests inject a vi.fn() stub.

import { requestUrl as obsidianRequestUrl } from 'obsidian';
import {
  CATALOG_SNAPSHOT_SCHEMA, CATALOG_SNAPSHOT_VERSION,
  isPackageManifest,
  type CatalogFetchResult, type CatalogSnapshot, type ReleaseBundle,
} from './library-model';
import { isCatalogResponse, isReleaseResponse, type ReleaseFetchResult, type ReleaseManifestFetchResult } from './registry-model';

/**
 * Bundled registry endpoints, tried in order. The custom domain is primary
 * (*.pages.dev is ISP-blocked in some regions, e.g. RU); the pages.dev origin
 * remains a working alias everywhere else. An explicit settings override
 * (libraryRegistryUrl) replaces the whole list.
 */
export const REGISTRY_URLS = [
  'https://library.radiprotocol.pro',
  'https://radiprotocol.pages.dev',
] as const;

/** Bundled default registry endpoint (the production Community Library).
 *  Users can override it in settings (libraryRegistryUrl) for a
 *  self-hosted/alternative registry. */
export const DEFAULT_REGISTRY_URL: string = REGISTRY_URLS[0];

/** Extract a message from an unknown rejection WITHOUT ever throwing. Captures
 *  `e.message` with a SINGLE read (a stateful getter cannot TOCTOU between a
 *  typeof check and a return). Returns a string on every path. */
function safeErrorMessage(e: unknown): string {
  try {
    if (e instanceof Error) {
      const m = e.message;
      if (typeof m === 'string') return m;
    }
    return String(e);
  } catch {
    return 'unknown error';
  }
}

interface RegistryClientOptions {
  /** Injectable network transport (D2). Defaults to the real Obsidian requestUrl. */
  requestUrl?: typeof obsidianRequestUrl;
  /** Base URL of the registry. Empty/undefined → bundled mirror list;
   *  an invalid/non-HTTPS override yields no endpoints. */
  baseUrl?: string;
  /** Require https: scheme in production. Defaults true. */
  httpsOnly?: boolean;
}

/**
 * Normalize + validate a registry base URL. Returns '' when no endpoint is
 * configured (empty), the URL is invalid, or (in production) the scheme is not
 * https. Strips trailing slashes for clean path composition.
 */
export function normalizeRegistryUrl(url: string | undefined, httpsOnly = true): string {
  const trimmed = (url ?? '').trim();
  if (trimmed === '') return '';
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return '';
  }
  if (httpsOnly && parsed.protocol !== 'https:') return '';
  return trimmed.replace(/\/+$/, '');
}

export class RegistryClient {
  private readonly requestUrl: typeof obsidianRequestUrl;
  /** Endpoints to try in order. An explicit valid settings override collapses
   *  this to a single entry; no override → all bundled mirrors (first OK wins,
   *  network-level failures fall through to the next mirror). */
  private readonly baseUrls: readonly string[];

  constructor(options: RegistryClientOptions = {}) {
    this.requestUrl = options.requestUrl ?? obsidianRequestUrl;
    const httpsOnly = options.httpsOnly ?? true;
    const rawOverride = options.baseUrl;
    if (rawOverride === undefined || rawOverride.trim() === '') {
      // No user override → bundled mirror list (custom domain first).
      this.baseUrls = REGISTRY_URLS.map((u) => normalizeRegistryUrl(u, httpsOnly)).filter((u) => u !== '');
    } else {
      const normalized = normalizeRegistryUrl(rawOverride, httpsOnly);
      this.baseUrls = normalized === '' ? [] : [normalized];
    }
  }

  /** True when no usable endpoint is configured. */
  isUnavailable(): boolean {
    return this.baseUrls.length === 0;
  }

  /**
   * Fetch the catalog. Returns an explicit `unavailable` state (never a throw)
   * when no endpoint is configured, every mirror fails at the network level, or
   * the response is malformed. Non-2xx from any mirror is returned as-is (the
   * server answered — mirroring cannot help). `cachedSnapshot` is always null
   * here — the caller (LibraryService) merges with the cached snapshot from the
   * cache store.
   */
  async fetchCatalog(): Promise<CatalogFetchResult> {
    if (this.isUnavailable()) {
      return { status: 'unavailable', reason: 'no registry endpoint configured', cachedSnapshot: null };
    }
    let lastReason = '';
    for (const base of this.baseUrls) {
      try {
        const res = await this.requestUrl({ url: `${base}/catalog`, method: 'GET', throw: false });
        if (res.status < 200 || res.status >= 300) {
          return { status: 'unavailable', reason: `catalog fetch returned status ${res.status}`, cachedSnapshot: null };
        }
        const body = res.json;
        if (!isCatalogResponse(body)) {
          return { status: 'unavailable', reason: 'malformed catalog response', cachedSnapshot: null };
        }
        const snapshot: CatalogSnapshot = {
          schema: CATALOG_SNAPSHOT_SCHEMA,
          version: CATALOG_SNAPSHOT_VERSION,
          fetchedAt: new Date().toISOString(),
          entries: body.entries,
        };
        return { status: 'ok', snapshot };
      } catch (e) {
        lastReason = `catalog fetch failed: ${safeErrorMessage(e)}`;
      }
    }
    return { status: 'unavailable', reason: lastReason, cachedSnapshot: null };
  }

  /**
   * Fetch a specific release bundle. Returns `ok`, `not-found`, or `unavailable`
   * (never a throw). 404 → not-found; network error → unavailable; malformed → unavailable.
   * packageId and version are URL-encoded per path segment (precedent: e14c5c1 —
   * raw.githubusercontent rejects unencoded non-ASCII). URL composition lives
   * inside the try so a lone-surrogate URIError is caught, not thrown.
   */
  async fetchRelease(packageId: string, version: string): Promise<ReleaseFetchResult> {
    if (this.isUnavailable()) {
      return { status: 'unavailable', reason: 'no registry endpoint configured' };
    }
    try {
      const url = `${this.baseUrls[0]}/packages/${encodeURIComponent(packageId)}/releases/${encodeURIComponent(version)}`;
      const res = await this.requestUrl({ url, method: 'GET', throw: false });
      if (res.status === 404) {
        return { status: 'not-found', reason: `release ${packageId}@${version} not found` };
      }
      if (res.status < 200 || res.status >= 300) {
        return { status: 'unavailable', reason: `release fetch returned status ${res.status}` };
      }
      const body = res.json;
      if (!isReleaseResponse(body)) {
        return { status: 'unavailable', reason: 'malformed release response' };
      }
      if (body.manifest.packageId !== packageId || body.manifest.releaseVersion !== version) {
        return { status: 'unavailable', reason: `release identity mismatch: requested ${packageId}@${version} but manifest carries ${body.manifest.packageId}@${body.manifest.releaseVersion}` };
      }
      const bundle: ReleaseBundle = { manifest: body.manifest, snippetContents: body.snippetContents };
      return { status: 'ok', bundle };
    } catch (e) {
      return { status: 'unavailable', reason: `release fetch failed: ${safeErrorMessage(e)}` };
    }
  }

  /**
   * Fetch a release MANIFEST only (Step 5 C8 — the trust preview does not need
   *  snippet contents). Returns `ok`, `not-found`, or `unavailable` (never a
   *  throw). Hits a `/manifest` subpath so the server can omit snippet bytes;
   *  falls back to unavailable if the server doesn't support it. Verifies the
   *  manifest identity matches the request (C2) and requires 2xx (C1).
   */
  async fetchReleaseManifest(packageId: string, version: string): Promise<ReleaseManifestFetchResult> {
    if (this.isUnavailable()) {
      return { status: 'unavailable', reason: 'no registry endpoint configured' };
    }
    try {
      const url = `${this.baseUrls[0]}/packages/${encodeURIComponent(packageId)}/releases/${encodeURIComponent(version)}/manifest`;
      const res = await this.requestUrl({ url, method: 'GET', throw: false });
      if (res.status === 404) {
        return { status: 'not-found', reason: `release ${packageId}@${version} not found` };
      }
      if (res.status < 200 || res.status >= 300) {
        return { status: 'unavailable', reason: `manifest fetch returned status ${res.status}` };
      }
      const body = res.json as { manifest?: unknown };
      if (!isPackageManifest(body?.manifest)) {
        return { status: 'unavailable', reason: 'malformed manifest response' };
      }
      if (body.manifest.packageId !== packageId || body.manifest.releaseVersion !== version) {
        return { status: 'unavailable', reason: `release identity mismatch: requested ${packageId}@${version} but manifest carries ${body.manifest.packageId}@${body.manifest.releaseVersion}` };
      }
      return { status: 'ok', manifest: body.manifest };
    } catch (e) {
      return { status: 'unavailable', reason: `manifest fetch failed: ${safeErrorMessage(e)}` };
    }
  }
}
