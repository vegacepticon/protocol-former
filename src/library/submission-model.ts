// src/library/submission-model.ts
// Pure model for the Stage D submission lifecycle (plan §6.1–6.4): versioned
// local submission records, transport states, request digest, requestId
// generation. Zero Obsidian imports — fully unit-testable. The local record is
// a RECEIPT/cache, never a second server-side queue; it proves only what this
// vault attempted, not authorship or moderation outcome.

import { sha256String } from './integrity';

/** Canonical schema identifier for a stored submission record. */
export const SUBMISSION_RECORD_SCHEMA = 'radiprotocol.submission-record' as const;
/** Current submission record schema version. */
export const SUBMISSION_RECORD_VERSION = 1 as const;

/** Local transport lifecycle states (§6.3) — transport facts, kept separate
 *  from review states. Once a PR exists the record ALSO carries review states
 *  ('pending' doubles as "open PR"; rejected/approved_pending_publish/
 *  published are reconciled from the registry's status route). */
export type SubmissionTransportState =
  | 'draft'
  | 'sending'
  | 'outcome_unknown'
  | 'pending'
  | 'failed'
  | 'rejected'
  | 'approved_pending_publish'
  | 'published';

/**
 * Typed backend error codes (Stage B contract). The client maps unknown codes
 * to 'unknown_error' rather than guessing.
 */
export type SubmissionErrorCode =
  | 'CLIENT_UPDATE_REQUIRED'
  | 'INVALID_REQUEST_ID'
  | 'VERSION_ALREADY_PUBLISHED'
  | 'REQUEST_ID_DIGEST_MISMATCH'
  | 'SUBMISSION_STATE_UNKNOWN'
  | 'rate_limited'
  | 'network_error'
  | 'oversize'
  | 'server_error'
  | 'unknown_error';

/** The metadata block of a frozen submission payload (wire shape §6.1). */
export interface SubmissionMeta {
  title: string;
  description: string;
  categories: string[];
  authorDisplayName: string;
  note?: string;
  requestId: string;
  publicSharingConfirmed: true;
  rightsConfirmed: true;
}

/** Frozen wire payload — stored verbatim so a retry re-sends the same bytes. */
export interface SubmissionPayload {
  requestId: string;
  release: unknown; // ReleaseBundle, kept structural to freeze exact bytes
  meta: SubmissionMeta;
}

/** Confirmed API result of a submission attempt. */
export interface SubmissionReceipt {
  prUrl: string;
  prNumber: number | null;
  branch: string | null;
  reused: boolean;
  degraded: boolean;
  /** ISO 8601 when the receipt was recorded. */
  receivedAt: string;
}

/** Last typed error recorded for the attempt. */
export interface SubmissionError {
  code: SubmissionErrorCode;
  /** Human-readable, safe-to-display message (no raw dumps). */
  message: string;
  /** HTTP status if the error came from a completed response. */
  httpStatus: number | null;
  /** ISO 8601 when the error was recorded. */
  occurredAt: string;
}

/**
 * One persisted submission attempt. The `payload` is the frozen bytes the
 * backend's digest is computed over — a retry MUST reuse it verbatim; editing
 * the package means a NEW attempt with a NEW requestId (§6.2.2).
 */
export interface SubmissionRecord {
  readonly schema: typeof SUBMISSION_RECORD_SCHEMA;
  readonly version: typeof SUBMISSION_RECORD_VERSION;
  requestId: string;
  /** ISO 8601 attempt creation. */
  createdAt: string;
  /** ISO 8601 of the last state change. */
  updatedAt: string;
  state: SubmissionTransportState;
  /** SHA-256 hex of the canonical payload JSON (RequestDigest). */
  digest: string;
  /** Registry key the payload was sent to (normalized URL or registry id). */
  registryKey: string;
  /** Local document identity this attempt came from. */
  sourceDocumentId: string;
  sourceProtocolPath: string;
  /** Package identity proposed at attempt time. */
  packageId: string;
  releaseVersion: string;
  /** Frozen request payload (sent verbatim on retry). */
  payload: SubmissionPayload;
  /** Present after a confirmed ok response. */
  receipt: SubmissionReceipt | null;
  /** Present after the latest failure. */
  lastError: SubmissionError | null;
}

/** Shape guard for a stored submission record (mirrors library-model guards). */
export function isSubmissionRecord(value: unknown): value is SubmissionRecord {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v['schema'] !== SUBMISSION_RECORD_SCHEMA || v['version'] !== SUBMISSION_RECORD_VERSION) return false;
  if (typeof v['requestId'] !== 'string' || v['requestId'] === '') return false;
  if (typeof v['createdAt'] !== 'string' || typeof v['updatedAt'] !== 'string') return false;
  if (typeof v['state'] !== 'string') return false;
  if (!isTransportState(v['state'])) return false;
  if (typeof v['digest'] !== 'string' || v['digest'] === '') return false;
  if (typeof v['registryKey'] !== 'string' || typeof v['sourceDocumentId'] !== 'string') return false;
  if (typeof v['sourceProtocolPath'] !== 'string') return false;
  if (typeof v['packageId'] !== 'string' || v['packageId'] === '') return false;
  if (typeof v['releaseVersion'] !== 'string' || v['releaseVersion'] === '') return false;
  if (!isSubmissionPayload(v['payload'])) return false;
  if (v['receipt'] !== null && !isSubmissionReceipt(v['receipt'])) return false;
  if (v['lastError'] !== null && !isSubmissionError(v['lastError'])) return false;
  return true;
}

function isTransportState(value: unknown): value is SubmissionTransportState {
  return value === 'draft' || value === 'sending' || value === 'outcome_unknown'
    || value === 'pending' || value === 'failed'
    || value === 'rejected' || value === 'approved_pending_publish' || value === 'published';
}

function isSubmissionPayload(value: unknown): value is SubmissionPayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v['requestId'] !== 'string' || v['requestId'] === '') return false;
  if (typeof v['release'] !== 'object' || v['release'] === null) return false;
  return isSubmissionMeta(v['meta']);
}

function isSubmissionMeta(value: unknown): value is SubmissionMeta {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v['title'] !== 'string' || typeof v['description'] !== 'string') return false;
  if (!Array.isArray(v['categories']) || !v['categories'].every((c) => typeof c === 'string')) return false;
  if (typeof v['authorDisplayName'] !== 'string') return false;
  if (v['publicSharingConfirmed'] !== true || v['rightsConfirmed'] !== true) return false;
  return true;
}

function isSubmissionReceipt(value: unknown): value is SubmissionReceipt {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v['prUrl'] !== 'string' || v['prUrl'] === '') return false;
  if (v['prNumber'] !== null && typeof v['prNumber'] !== 'number') return false;
  if (v['branch'] !== null && typeof v['branch'] !== 'string') return false;
  if (typeof v['reused'] !== 'boolean' || typeof v['degraded'] !== 'boolean') return false;
  return typeof v['receivedAt'] === 'string';
}

function isSubmissionError(value: unknown): value is SubmissionError {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v['code'] !== 'string' || typeof v['message'] !== 'string') return false;
  if (v['httpStatus'] !== null && typeof v['httpStatus'] !== 'number') return false;
  return typeof v['occurredAt'] === 'string';
}

/** UUID v4 format check (the backend validates the same shape). */
export function isRequestUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Generate a request id: crypto.randomUUID when available, otherwise a
 * crypto.getRandomValues fallback with the same v4 shape. Throws only if the
 * environment provides no usable crypto source at all.
 */
export function generateRequestId(now: () => number = Date.now): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  if (typeof c?.getRandomValues !== 'function') {
    throw new Error('[Protocol Former] no crypto source for requestId generation');
  }
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  // v4 layout: version nibble 4, variant nibble 8/9/a/b
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  bytes[15] = (bytes[15]! + (now() % 2)) & 0xff; // tie-breaker never hurts
  const hex = [...bytes].map((b) => b!.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Request digest: SHA-256 of the canonical payload JSON —
 * `JSON.stringify({requestId, release, meta}, null, 2) + '\n'`. Stable across
 * processes for the same payload (§6.2 uses the digest for recovery checks;
 * the backend computes its own digest over the same canonical form).
 */
export async function requestDigest(payload: SubmissionPayload): Promise<string> {
  return sha256String(canonicalPayloadJson(payload));
}

/** The exact bytes a retry re-sends (and the digest is computed over). */
export function canonicalPayloadJson(payload: SubmissionPayload): string {
  return JSON.stringify({ requestId: payload.requestId, release: payload.release, meta: payload.meta }, null, 2) + '\n';
}
