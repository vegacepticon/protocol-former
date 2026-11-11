// src/library/submission-service.ts
// Submission orchestration (Stage D, plan §6.2): persist-before-POST, frozen
// payload retry, outcome_unknown semantics. The service owns the receipt store
// and outlives the submit modal — a window closed mid-POST leaves the attempt
// recorded as outcome_unknown, never silently lost (F05 partial fix; the full
// service-owned completion UI and GET-status reconciliation land in Stage E).
import type { App } from 'obsidian';
import type { ReleaseBundle } from './library-model';
import {
  generateRequestId, requestDigest,
  isRequestUuid,
  type SubmissionPayload, type SubmissionMeta, type SubmissionRecord,
  type SubmissionTransportState,
} from './submission-model';
import { SubmissionStore } from './submission-store';
import { SubmissionClient, type SubmitHttpTransport, type StatusHttpTransport, type SubmitClientResult, type SubmissionStatusResult } from './submission-client';

/** Everything needed to freeze one attempt. */
interface NewSubmissionInput {
  bundle: ReleaseBundle;
  meta: Omit<SubmissionMeta, 'requestId' | 'publicSharingConfirmed' | 'rightsConfirmed'>;
  /** Normalized registry key (e.g. DEFAULT_REGISTRY_URL or the settings override). */
  registryKey: string;
  sourceDocumentId: string;
  sourceProtocolPath: string;
}

export type SubmissionResult =
  | { status: 'ok'; record: SubmissionRecord }
  | { status: 'failed'; record: SubmissionRecord; code: string; message: string }
  | { status: 'persist-failed'; reason: string }
  | { status: 'invalid-input'; reason: string };

export class LibrarySubmissionService {
  private readonly app: App;
  private readonly store: SubmissionStore;
  private readonly client: SubmissionClient;
  constructor(app: App, transport: SubmitHttpTransport, statusTransport?: StatusHttpTransport) {
    this.app = app;
    this.store = new SubmissionStore(app);
    this.client = new SubmissionClient(transport, statusTransport);
  }

  /** Direct store access for the Stage E UI; not used by the modal in D. */
  get records(): SubmissionStore { return this.store; }

  /**
   * Freeze + persist a NEW attempt, then POST it. Per §6.2.1: if persisting
   * the attempt fails, NOTHING is sent. The consent booleans are required to
   * be true by construction (the modal gates the call; the model enforces the
   * wire shape).
   */
  async submitNew(input: NewSubmissionInput): Promise<SubmissionResult> {
    if (input.registryKey.trim() === '') return { status: 'invalid-input', reason: 'no registry endpoint configured' };
    if (input.meta.title.trim() === '') return { status: 'invalid-input', reason: 'title is required' };
    if (input.meta.categories.length === 0) return { status: 'invalid-input', reason: 'at least one category is required' };
    const requestId = generateRequestId();
    const payload: SubmissionPayload = {
      requestId,
      release: input.bundle,
      meta: {
        ...input.meta,
        requestId,
        publicSharingConfirmed: true,
        rightsConfirmed: true,
      },
    };
    const digest = await requestDigest(payload);
    const nowIso = new Date().toISOString();
    const record: SubmissionRecord = {
      schema: 'radiprotocol.submission-record',
      version: 1,
      requestId,
      createdAt: nowIso,
      updatedAt: nowIso,
      state: 'draft',
      digest,
      registryKey: input.registryKey,
      sourceDocumentId: input.sourceDocumentId,
      sourceProtocolPath: input.sourceProtocolPath,
      packageId: input.bundle.manifest.packageId,
      releaseVersion: input.bundle.manifest.releaseVersion,
      payload,
      receipt: null,
      lastError: null,
    };
    const persisted = await this.persist(record);
    if (persisted !== null) return { status: 'persist-failed', reason: persisted };
    return this.send(record);
  }

  /**
   * Retry an existing attempt with its FROZEN payload (same bytes, same
   * requestId — §6.2.2). Only meaningful from draft/outcome_unknown/failed
   * states; a pending attempt must be reconciled first (Stage E), not re-POSTed.
   */
  async retry(requestId: string): Promise<SubmissionResult> {
    const record = await this.store.read(requestId);
    if (record === null) return { status: 'invalid-input', reason: `unknown submission attempt: ${requestId}` };
    if (record.state === 'sending') return { status: 'invalid-input', reason: 'attempt is currently in flight' };
    if (record.state === 'pending') return { status: 'invalid-input', reason: 'attempt already has a PR — reconcile instead of retrying' };
    // Terminal review states: the moderation decision is final — a changed
    // protocol needs a NEW attempt (§6.4), never a re-POST of the old one.
    if (record.state === 'rejected' || record.state === 'approved_pending_publish' || record.state === 'published') {
      return { status: 'invalid-input', reason: `attempt is already ${record.state} — start a new submission instead` };
    }
    // Verify the frozen payload still matches the recorded digest before sending.
    const digest = await requestDigest(record.payload);
    if (digest !== record.digest) {
      return { status: 'invalid-input', reason: 'stored payload no longer matches its digest — refusing to send' };
    }
    return this.send(record);
  }

  private async send(record: SubmissionRecord): Promise<SubmissionResult> {
    const sentAt = new Date().toISOString();
    record.state = 'sending';
    record.updatedAt = sentAt;
    const persistErr = await this.persist(record);
    if (persistErr !== null) return { status: 'persist-failed', reason: persistErr };
    const result: SubmitClientResult = await this.client.submit(record.registryKey, record.payload);
    return this.applyOutcome(record, result);
  }

  /** Write the outcome back to the receipt store. Late responses after a modal
   *  closed still land here — the service owns the record, not the DOM. */
  private async applyOutcome(record: SubmissionRecord, result: SubmitClientResult): Promise<SubmissionResult> {
    record.updatedAt = new Date().toISOString();
    if (result.ok) {
      record.state = 'pending';
      record.receipt = {
        prUrl: result.prUrl,
        prNumber: result.prNumber,
        branch: result.branch,
        reused: result.reused,
        degraded: result.degraded,
        receivedAt: record.updatedAt,
      };
      record.lastError = null;
    } else {
      record.lastError = {
        code: result.code,
        message: result.message,
        httpStatus: result.httpStatus,
        occurredAt: record.updatedAt,
      };
      // SUBMISSION_STATE_UNKNOWN means mutations may have happened — the
      // attempt is NOT a clean failure and must be reconciled, not re-POSTed
      // blindly (a retry with the same frozen payload is still safe by
      // contract, but the state records the uncertainty).
      record.state = result.code === 'SUBMISSION_STATE_UNKNOWN' ? 'outcome_unknown' : 'failed';
    }
    const persistErr = await this.persist(record);
    if (persistErr !== null) return { status: 'persist-failed', reason: persistErr };
    return result.ok
      ? { status: 'ok', record }
      : { status: 'failed', record, code: result.code, message: result.message };
  }

  /** Persist or return a safe error reason. */
  private async persist(record: SubmissionRecord): Promise<string | null> {
    try {
      await this.store.write(record);
      return null;
    } catch (e) {
      const reason = e instanceof Error && typeof e.message === 'string' ? e.message : String(e);
      return `failed to persist submission record: ${reason}`;
    }
  }

  /**
   * Reconcile one attempt against the registry's status route (Stage E, §6.3).
   * Resolves outcome_unknown (lost response) and refreshes pending attempts.
   * Read-only: this NEVER re-POSTs. Returns the updated record plus what
   * changed, so the UI can show a meaningful result without guessing.
   */
  async reconcile(requestId: string): Promise<ReconcileResult> {
    if (!isRequestUuid(requestId)) return { status: 'invalid-input', reason: 'invalid request id' };
    const record = await this.store.read(requestId);
    if (record === null) return { status: 'invalid-input', reason: `unknown submission attempt: ${requestId}` };
    if (record.state === 'sending') return { status: 'in-flight' };
    const before: SubmissionTransportState = record.state;
    const remote: SubmissionStatusResult = await this.client.fetchStatus(record.registryKey, requestId);
    if (remote.status === 'failed') {
      // Status check itself failed — keep the record as-is, surface the error.
      // Never downgrade a pending attempt to failed because a READ failed.
      return { status: 'check-failed', record, code: remote.code ?? 'unknown_error', message: remote.message ?? 'status check failed' };
    }
    record.updatedAt = new Date().toISOString();
    switch (remote.remote) {
      case 'pending':
        // Open PR — the attempt definitely exists and is under review.
        record.state = 'pending';
        if (record.receipt === null && remote.prUrl !== undefined) {
          record.receipt = {
            prUrl: remote.prUrl,
            prNumber: remote.prNumber ?? null,
            branch: `submit/${requestId}`,
            reused: true,
            degraded: remote.degraded === true,
            receivedAt: record.updatedAt,
          };
        }
        break;
      case 'no_pr':
        // Branch+commit exist, no PR: a retry of the FROZEN payload reconciles
        // by creating the PR from the existing branch (backend recovery path).
        record.state = 'outcome_unknown';
        break;
      case 'unverifiable':
        // Branch facts verified but PR lookup degraded — keep current state,
        // mark the timestamp so the UI shows staleness instead of a guess.
        break;
      case 'closed':
        // PR closed unmerged: rejected OR superseded — the route cannot
        // distinguish, so the record shows 'rejected' with the raw facts in
        // lastError-style fields; a moderator note is the only way to upgrade
        // this to superseded (plan §6.3). Only an actual PR state change moves
        // a pending record; outcome_unknown becomes resolved-failed.
        record.state = 'rejected';
        break;
      case 'merged':
        // Merged → approved_pending_publish; published:true upgrades to
        // 'published' after the backend confirmed the release blob on HEAD.
        record.state = remote.published === true ? 'published' : 'approved_pending_publish';
        break;
      case 'not_found':
        // The registry has NOTHING under this requestId. For outcome_unknown
        // attempts this means the request never landed (persist-before-POST
        // guarantees it was created locally, so it is safe to retry as the
        // same frozen attempt). A pending attempt contradicting to not_found
        // is suspicious — leave it pending, surface the anomaly.
        if (before === 'outcome_unknown' || before === 'failed' || before === 'draft') {
          record.state = 'failed';
          record.lastError = {
            code: 'network_error',
            message: 'the registry has no record of this submission — safe to retry',
            httpStatus: null,
            occurredAt: record.updatedAt,
          };
        }
        break;
      default:
        break;
    }
    const persistErr = await this.persist(record);
    if (persistErr !== null) return { status: 'persist-failed', reason: persistErr };
    return { status: 'ok', record, before, changed: record.state !== before, remote };
  }
}

/** Result of reconciling one attempt against the registry status route.
 *  `check-failed` is a read failure, not a moderation decision. */
export type ReconcileResult =
  | { status: 'ok'; record: SubmissionRecord; before: SubmissionTransportState; changed: boolean; remote: SubmissionStatusResult }
  | { status: 'check-failed'; record: SubmissionRecord; code: string; message: string }
  | { status: 'in-flight' }
  | { status: 'invalid-input'; reason: string }
  | { status: 'persist-failed'; reason: string };
