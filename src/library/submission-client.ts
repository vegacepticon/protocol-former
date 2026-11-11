// src/library/submission-client.ts
// Typed HTTP adapter for /api/submit (Stage D client side of the Stage B
// backend contract). Wraps the injected SubmitTransport seam (same D2 pattern
// as RegistryClient): never throws, returns explicit typed outcomes, validates
// the response shape, and maps HTTP status + backend error codes to
// SubmissionErrorCode. Transport errors and non-JSON bodies are failures with
// safe messages — never raw dumps.
import type { SubmissionPayload, SubmissionErrorCode } from './submission-model';
import { isRequestUuid } from './submission-model';
import { requestUrl } from 'obsidian';

/** Production transport over Obsidian's requestUrl. STATIC import (NOT
 *  `await import('obsidian')`): esbuild leaves dynamic imports unresolved in
 *  the bundle, and the virtual 'obsidian' module only resolves for static
 *  imports — a dynamic one throws "Failed to resolve module specifier".
 *  Lives here (not in the view) so the service is constructible without views;
 *  tests inject their own transport and never exercise this path. */
export const requestUrlSubmitTransport: SubmitHttpTransport = async (url, body) => {
  const res = await requestUrl({ url, method: 'POST', contentType: 'application/json', body });
  return { status: res.status, bodyText: res.text };
};

/** Injectable transport seam (mirrors library-submit-modal.ts). Returns the
 *  raw status + body text; never throws. */
export type SubmitHttpTransport = (
  url: string,
  body: string,
) => Promise<{ status: number; bodyText: string }>;

/** Read-only transport seam for GET status checks (Stage E). Separate from the
 *  POST transport: different method, no body, distinct failure domain — a
 *  status outage must never be entangled with submission mutations. */
export type StatusHttpTransport = (url: string) => Promise<{ status: number; bodyText: string }>;

/** Production status transport over Obsidian's requestUrl. STATIC import (same
 *  esbuild constraint as requestUrlSubmitTransport). */
const requestUrlStatusTransport: StatusHttpTransport = async (url) => {
  const res = await requestUrl({ url, method: 'GET' });
  return { status: res.status, bodyText: res.text };
};

/** One typed submit attempt outcome. */
export type SubmitClientResult =
  | { ok: true; requestId: string; prUrl: string; prNumber: number | null; branch: string | null; reused: boolean; degraded: boolean }
  | { ok: false; code: SubmissionErrorCode; message: string; httpStatus: number | null };

/** Codes the Stage B backend returns in the `error` field of failure bodies. */
const KNOWN_ERROR_CODES = new Set<string>([
  'CLIENT_UPDATE_REQUIRED',
  'INVALID_REQUEST_ID',
  'VERSION_ALREADY_PUBLISHED',
  'REQUEST_ID_DIGEST_MISMATCH',
  'SUBMISSION_STATE_UNKNOWN',
]);

/** Raw moderation facts returned by GET /api/submissions/:requestId (Stage E).
 *  The route reports GitHub facts only; the SERVICE maps them onto review
 *  states (closed-vs-superseded needs a moderator decision, plan §6.3). */
export type SubmissionRemoteStatus =
  | 'pending'      // open PR
  | 'closed'       // PR closed, unmerged (rejected OR superseded — not distinguishable remotely)
  | 'merged'       // PR merged (approved_pending_publish; published flag adds the rest)
  | 'no_pr'        // branch+commit exist, no PR (crash between ref and PR)
  | 'not_found'    // branch absent — nothing was ever sent under this requestId
  | 'unverifiable';// branch facts verified but PR lookup failed (degraded:true)

export interface SubmissionStatusResult {
  status: 'ok' | 'failed';
  remote?: SubmissionRemoteStatus;
  prUrl?: string;
  prNumber?: number;
  prState?: 'open' | 'closed';
  merged?: boolean;
  published?: boolean;
  /** PR lookup failed upstream — facts are partial (§6.3: не маскировать). */
  degraded?: boolean;
  /** Failure path only: typed code + safe message + HTTP status. */
  code?: SubmissionErrorCode;
  message?: string;
  httpStatus?: number | null;
}

export class SubmissionClient {
  private readonly transport: SubmitHttpTransport;
  private readonly statusTransport: StatusHttpTransport;
  constructor(transport: SubmitHttpTransport, statusTransport: StatusHttpTransport = requestUrlStatusTransport) {
    this.transport = transport;
    this.statusTransport = statusTransport;
  }

  /**
   * POST the frozen payload to `<registryKey>/api/submit`. Never throws.
   * The payload is serialized with the same canonical form the digest was
   * computed over (JSON.stringify(..., null, 2)); the transport receives the
   * exact string a retry would re-send.
   */
  async submit(registryBaseUrl: string, payload: SubmissionPayload): Promise<SubmitClientResult> {
    const base = normalizeSubmitBase(registryBaseUrl);
    if (base === '') {
      return { ok: false, code: 'server_error', message: 'no registry endpoint configured', httpStatus: null };
    }
    const url = `${base}/api/submit`;
    const body = JSON.stringify({ requestId: payload.requestId, release: payload.release, meta: payload.meta }, null, 2);
    let res: { status: number; bodyText: string };
    try {
      res = await this.transport(url, body);
    } catch (e) {
      return { ok: false, code: 'network_error', message: safeMessage(e), httpStatus: null };
    }
    return parseSubmitResponse(res);
  }

  /**
   * GET the moderation status for one requestId (Stage E reconcile). Read-only
   * on both ends. Never throws; failures carry typed codes. A GitHub-side
   * failure (403/429/5xx on the route) surfaces as 'server_error'/'rate_limited'
   * — it is NEVER mapped to a confident not-found (§6.3).
   */
  async fetchStatus(registryBaseUrl: string, requestId: string): Promise<SubmissionStatusResult> {
    if (!isRequestUuid(requestId)) {
      return { status: 'failed', code: 'unknown_error', message: 'invalid request id', httpStatus: null };
    }
    const base = normalizeSubmitBase(registryBaseUrl);
    if (base === '') {
      return { status: 'failed', code: 'server_error', message: 'no registry endpoint configured', httpStatus: null };
    }
    let res: { status: number; bodyText: string };
    try {
      res = await this.statusTransport(`${base}/api/submissions/${encodeURIComponent(requestId)}`);
    } catch (e) {
      return { status: 'failed', code: 'network_error', message: safeMessage(e), httpStatus: null };
    }
    return parseStatusResponse(res);
  }
}

/** Parse a GET /api/submissions/:requestId response. Exported for tests. */
export function parseStatusResponse(res: { status: number; bodyText: string }): SubmissionStatusResult {
  let parsed: Record<string, unknown> = {};
  const trimmed = res.bodyText.trim();
  if (trimmed !== '') {
    try { parsed = JSON.parse(trimmed) as Record<string, unknown>; } catch { /* non-JSON body below */ }
  }
  if (res.status === 200 && parsed['ok'] === true) {
    const remote = parsed['status'];
    if (typeof remote !== 'string' || !isRemoteStatus(remote)) {
      return { status: 'failed', code: 'unknown_error', message: 'status response has unexpected shape', httpStatus: res.status };
    }
    return {
      status: 'ok',
      remote,
      prUrl: typeof parsed['prUrl'] === 'string' ? parsed['prUrl'] : undefined,
      prNumber: typeof parsed['prNumber'] === 'number' ? parsed['prNumber'] : undefined,
      prState: parsed['prState'] === 'open' || parsed['prState'] === 'closed' ? parsed['prState'] : undefined,
      merged: parsed['merged'] === true,
      published: parsed['published'] === true,
      degraded: parsed['degraded'] === true,
    };
  }
  if (res.status === 404) {
    // The route returns a genuine 404 only for an absent branch (nothing was
    // ever sent under this requestId on this registry).
    return { status: 'ok', remote: 'not_found', published: false };
  }
  // Failure mapping — same discipline as the POST path: typed codes, no
  // guessing, GitHub-side errors stay server/rate-limit failures.
  if (res.status === 429) return { status: 'failed', code: 'rate_limited', message: describeRateLimit(parsed), httpStatus: res.status };
  if (res.status >= 500 && res.status < 600) return { status: 'failed', code: 'server_error', message: `status check failed: HTTP ${res.status}`, httpStatus: res.status };
  if (res.status === 400) return { status: 'failed', code: 'unknown_error', message: 'status check rejected the request id', httpStatus: res.status };
  if (res.status === 409) return { status: 'failed', code: 'REQUEST_ID_DIGEST_MISMATCH', message: describeKnownCode('REQUEST_ID_DIGEST_MISMATCH'), httpStatus: res.status };
  return { status: 'failed', code: 'unknown_error', message: `unexpected status response: HTTP ${res.status}`, httpStatus: res.status };
}

function isRemoteStatus(value: string): value is NonNullable<SubmissionStatusResult['remote']> {
  return value === 'pending' || value === 'closed' || value === 'merged'
    || value === 'no_pr' || value === 'not_found' || value === 'unverifiable';
}

/** Parse a transport response into a typed outcome. Exported for tests. */
export function parseSubmitResponse(res: { status: number; bodyText: string }): SubmitClientResult {
  let parsed: Record<string, unknown> = {};
  const trimmed = res.bodyText.trim();
  if (trimmed !== '') {
    try { parsed = JSON.parse(trimmed) as Record<string, unknown>; } catch { /* non-JSON body below */ }
  }
  if (res.status === 200 && parsed['ok'] === true && typeof parsed['prUrl'] === 'string' && isHttpsUrl(parsed['prUrl'])) {
    const requestId = typeof parsed['requestId'] === 'string' ? parsed['requestId'] : '';
    if (requestId === '') {
      return { ok: false, code: 'unknown_error', message: 'submission response missing requestId', httpStatus: res.status };
    }
    return {
      ok: true,
      requestId,
      prUrl: parsed['prUrl'],
      prNumber: typeof parsed['prNumber'] === 'number' ? parsed['prNumber'] : parsePrNumber(parsed['prUrl']),
      branch: typeof parsed['branch'] === 'string' ? parsed['branch'] : null,
      reused: parsed['reused'] === true,
      degraded: parsed['degraded'] === true,
    };
  }
  return { ok: false, ...failureFrom(parsed, res.status) };
}

function failureFrom(parsed: Record<string, unknown>, status: number): { code: SubmissionErrorCode; message: string; httpStatus: number } {
  const backendCode = typeof parsed['error'] === 'string' ? parsed['error'] : '';
  const requestId = typeof parsed['requestId'] === 'string' ? parsed['requestId'] : '';
  const suffix = requestId !== '' ? ` (request ${requestId})` : '';
  if (KNOWN_ERROR_CODES.has(backendCode)) {
    return { code: backendCode as SubmissionErrorCode, message: describeKnownCode(backendCode) + suffix, httpStatus: status };
  }
  if (status === 413) return { code: 'oversize', message: describeOversize() + suffix, httpStatus: status };
  if (status === 429) return { code: 'rate_limited', message: describeRateLimit(parsed) + suffix, httpStatus: status };
  if (status >= 500 && status < 600) {
    // A 5xx with the Stage B unknown-outcome marker stays distinguished from a
    // plain server error: the attempt MAY have mutated the backend.
    if (backendCode === '') return { code: 'server_error', message: `submission failed: HTTP ${status}${suffix}`, httpStatus: status };
    return { code: 'server_error', message: `${backendCode}${suffix}`, httpStatus: status };
  }
  if (status >= 400) {
    const msg = backendCode !== '' ? backendCode : `submission rejected: HTTP ${status}`;
    return { code: 'unknown_error', message: msg + suffix, httpStatus: status };
  }
  return { code: 'unknown_error', message: `unexpected submission response: HTTP ${status}${suffix}`, httpStatus: status };
}

/** Human-facing, i18n-key-mappable descriptions (safe, no raw dumps). */
function describeKnownCode(code: string): string {
  switch (code) {
    case 'CLIENT_UPDATE_REQUIRED': return 'submission requires a newer plugin version (consent fields missing)';
    case 'INVALID_REQUEST_ID': return 'submission request id is invalid';
    case 'VERSION_ALREADY_PUBLISHED': return 'this package version is already published';
    case 'REQUEST_ID_DIGEST_MISMATCH': return 'this request id was already used with different content';
    case 'SUBMISSION_STATE_UNKNOWN': return 'submission state is unknown — check status before retrying';
    default: return code;
  }
}
function describeOversize(): string { return 'submission is too large'; }
function describeRateLimit(parsed: Record<string, unknown>): string {
  const retry = typeof parsed['retryAfterSeconds'] === 'number' ? ` — retry in ~${parsed['retryAfterSeconds']}s` : '';
  return `submission rate limit reached${retry}`;
}

/** Only https PR links are accepted (server-controlled string → no arbitrary scheme). */
function isHttpsUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'https:';
  } catch {
    return false;
  }
}

function parsePrNumber(prUrl: string): number | null {
  try {
    const n = parseInt(new URL(prUrl).pathname.split('/').pop() ?? '', 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function safeMessage(e: unknown): string {
  try {
    if (e instanceof Error && typeof e.message === 'string') return e.message;
    return String(e);
  } catch {
    return 'network error';
  }
}

/** Trim trailing slashes; reject non-https bases. Empty → submit unavailable. */
export function normalizeSubmitBase(registryBaseUrl: string): string {
  const trimmed = registryBaseUrl.trim().replace(/\/+$/, '');
  if (trimmed === '') return '';
  try {
    const u = new URL(trimmed);
    if (u.protocol !== 'https:') return '';
  } catch {
    return '';
  }
  return trimmed;
}
