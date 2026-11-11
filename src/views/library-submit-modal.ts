// src/views/library-submit-modal.ts
// Submit-to-Community-Library modal (Stage D): takes an already-built
// ReleaseBundle and submission metadata, requires TWO explicit consents
// (public sharing + rights) before any POST, and delegates the attempt to
// LibrarySubmissionService — the frozen payload (requestId + digest) is
// persisted BEFORE the network call, so a window closed mid-POST leaves the
// attempt recorded (outcome_unknown), never silently lost (F05).
//
// Transport: the service owns the typed SubmissionClient over the injected
// SubmitHttpTransport seam (D2 pattern) so tests never touch the network.
// Backend error codes map to typed, human-readable results — never raw dumps.
// Promise-based Modal with safeResolve double-guard.

import { App, Modal, Notice } from 'obsidian';
import type RadiProtocolPlugin from '../main';
import type { ReleaseBundle } from '../library/library-model';
import { normalizeRegistryUrl } from '../library/registry-client';
import { LIBRARY_SUBMISSION_CATEGORIES } from '../library/package-metadata';
import type { LibrarySubmissionService, SubmissionResult } from '../library/submission-service';
import type { SubmissionErrorCode } from '../library/submission-model';
import type { SubmitHttpTransport } from '../library/submission-client';

type LibrarySubmitResult =
  | { submitted: true; requestId: string; prUrl: string; reused: boolean }
  | { submitted: false };

interface LibrarySubmitModalOptions {
  /** Registry base URL (settings override or bundled default). '' → submit unavailable. */
  registryBaseUrl: string;
  /** Stable document id of the source protocol (binding identity, NOT the path). */
  sourceDocumentId: string;
  sourceProtocolPath: string;
  /** Injected transport override (tests). Production uses the service default. */
  transport?: SubmitHttpTransport;
  /** Injected service override (tests). Production: plugin.librarySubmissionService. */
  submissionService?: LibrarySubmissionService;
}

export class LibrarySubmitModal extends Modal {
  readonly result: Promise<LibrarySubmitResult>;
  private resolve!: (value: LibrarySubmitResult) => void;
  private resolved = false;

  private readonly plugin: RadiProtocolPlugin;
  private readonly bundle: ReleaseBundle;
  private readonly options: LibrarySubmitModalOptions;
  private title = '';
  private description = '';
  private readonly selectedCategories = new Set<string>();
  private note = '';
  private publicConfirmed = false;
  private rightsConfirmed = false;
  private submitBtn!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private inFlight = false;
  /** Set once the POST has been handed to the service; closing after this must
   *  NOT resolve `submitted:false` as if nothing was sent — the attempt is
   *  recorded by the service and surfaces in «Мои заявки» (Stage E). */
  private postStarted = false;

  constructor(
    app: App,
    plugin: RadiProtocolPlugin,
    bundle: ReleaseBundle,
    options: LibrarySubmitModalOptions,
  ) {
    super(app);
    this.plugin = plugin;
    this.bundle = bundle;
    this.options = options;
    this.result = new Promise<LibrarySubmitResult>((res) => { this.resolve = res; });
  }

  async onOpen(): Promise<void> {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const { contentEl, modalEl } = this;
    contentEl.empty();
    modalEl.addClass('radi-library-submit');
    this.titleEl.setText(t('library.submitTitle'));

    const manifest = this.bundle.manifest;

    // Summary block — what is being submitted (package id/version/snippet count).
    const summary = contentEl.createDiv({ cls: 'radi-library-submit-summary' });
    summary.createDiv({ cls: 'radi-library-submit-summary-row', text: t('library.submitSummaryPackage', { packageId: manifest.packageId, version: manifest.releaseVersion }) });
    summary.createDiv({ cls: 'radi-library-submit-summary-row', text: t('library.submitSummarySnippets', { count: String(manifest.snippetFiles.length) }) });

    // Patient-data warning (the registry is PUBLIC).
    const warning = contentEl.createDiv({ cls: 'radi-library-submit-warning' });
    warning.setText(t('library.submitWarning'));

    const titleRow = contentEl.createDiv({ cls: 'radi-library-submit-field' });
    titleRow.createEl('label', { text: t('library.submitCatalogTitle'), attr: { for: 'radi-library-submit-title' } });
    const titleInput = titleRow.createEl('input', { cls: 'radi-library-submit-title', attr: { type: 'text' } });
    this.title = manifest.protocolDoc.title;
    titleInput.value = this.title;
    titleInput.addEventListener('input', () => { this.title = titleInput.value; });

    const descRow = contentEl.createDiv({ cls: 'radi-library-submit-field' });
    descRow.createEl('label', { text: t('library.submitDescription'), attr: { for: 'radi-library-submit-desc' } });
    const descInput = descRow.createEl('textarea', { cls: 'radi-library-submit-desc' });
    descInput.rows = 2;
    descInput.addEventListener('input', () => { this.description = descInput.value; });

    // Categories — fixed taxonomy as checkboxes (one or more required).
    const catRow = contentEl.createDiv({ cls: 'radi-library-submit-field' });
    catRow.createEl('label', { text: t('library.submitCategories') });
    const catList = catRow.createDiv({ cls: 'radi-library-submit-categories' });
    for (const categoryId of LIBRARY_SUBMISSION_CATEGORIES) {
      const optionRow = catList.createEl('label', { cls: 'radi-library-submit-category-option' });
      const checkbox = optionRow.createEl('input', { attr: { type: 'checkbox' } });
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) this.selectedCategories.add(categoryId);
        else this.selectedCategories.delete(categoryId);
        this.updateSubmitEnabled();
      });
      // Localized display label; the stable id goes to the API.
      const labelKey = `library.category.${categoryId}`;
      optionRow.createEl('span', { text: t(labelKey, undefined, categoryId) });
    }

    const noteRow = contentEl.createDiv({ cls: 'radi-library-submit-field' });
    noteRow.createEl('label', { text: t('library.submitNote'), attr: { for: 'radi-library-submit-note' } });
    const noteInput = noteRow.createEl('textarea', { cls: 'radi-library-submit-note' });
    noteInput.rows = 2;
    noteInput.placeholder = t('library.submitNotePlaceholder');
    noteInput.setCssProps({ height: 'auto' });
    noteInput.addEventListener('input', () => { this.note = noteInput.value; });

    // Consent gate (Stage D): both checkboxes required before ANY POST. A
    // checked box is the user's explicit confirmation — never a DLP guarantee.
    const consentDiv = contentEl.createDiv({ cls: 'radi-library-submit-consents' });
    this.buildConsent(consentDiv, t('library.submitConsentPublic'), (v) => { this.publicConfirmed = v; });
    this.buildConsent(consentDiv, t('library.submitConsentRights'), (v) => { this.rightsConfirmed = v; });

    this.statusEl = contentEl.createDiv({ cls: 'radi-library-submit-status' });

    // Buttons carry visible text; no aria-label — Obsidian would surface it
    // as a duplicate hover tooltip.
    const actions = contentEl.createDiv({ cls: 'radi-library-submit-actions' });
    this.submitBtn = actions.createEl('button', { cls: 'radi-library-detail-install mod-cta' });
    this.submitBtn.setText(t('library.submitLabel'));
    this.submitBtn.disabled = !this.endpointAvailable() || !this.canSubmit();
    if (!this.endpointAvailable()) this.statusEl.setText(t('library.submitUnavailable'));
    this.submitBtn.addEventListener('click', () => { void this.handleSubmit(); });
    const cancelBtn = actions.createEl('button', { cls: 'radi-library-detail-cancel' });
    cancelBtn.setText(t('library.cancel'));
    cancelBtn.addEventListener('click', () => { this.safeResolve({ submitted: false }); this.close(); });
  }

  onClose(): void {
    // Post not started → a plain dismissal. Post started → do NOT claim
    // "nothing was sent": the attempt lives in the service's receipt store.
    if (!this.postStarted) this.safeResolve({ submitted: false });
    this.contentEl.empty();
  }

  private buildConsent(container: HTMLElement, label: string, set: (v: boolean) => void): void {
    const row = container.createEl('label', { cls: 'radi-library-submit-consent-option' });
    const checkbox = row.createEl('input', { attr: { type: 'checkbox' } });
    checkbox.addEventListener('change', () => { set(checkbox.checked); this.updateSubmitEnabled(); });
    row.createEl('span', { text: label });
  }

  private safeResolve(value: LibrarySubmitResult): void {
    if (!this.resolved) { this.resolved = true; this.resolve(value); }
  }

  private endpointAvailable(): boolean {
    return normalizeRegistryUrl(this.options.registryBaseUrl) !== '';
  }

  /** Consent + category gates; at least one category must be selected and BOTH
   *  consent boxes checked before submission is allowed. */
  private canSubmit(): boolean {
    return this.selectedCategories.size > 0 && this.publicConfirmed && this.rightsConfirmed;
  }

  private updateSubmitEnabled(): void {
    if (this.submitBtn === undefined) return;
    this.submitBtn.disabled = !this.endpointAvailable() || !this.canSubmit() || this.inFlight;
  }

  private submissionService(): LibrarySubmissionService {
    if (this.options.submissionService !== undefined) return this.options.submissionService;
    return this.plugin.librarySubmissionService;
  }

  /** Stage E success screen: «Заявка отправлена на проверку» + PR number +
   *  explicit actions (open PR, My submissions). NO auto-close — the modal
   *  stays until the user dismisses it (plan §7 Этап E). */
  private renderSuccess(requestId: string, prUrl: string): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    this.contentEl.empty();
    this.contentEl.createDiv({ cls: 'radi-library-submit-success-title', text: t('library.submitSuccessTitle') });
    this.contentEl.createDiv({
      cls: 'radi-library-submit-success-text',
      text: t('library.submitSuccessBody', { packageId: this.bundle.manifest.packageId }),
    });
    const requestIdRow = this.contentEl.createDiv({ cls: 'radi-library-submit-success-request' });
    requestIdRow.setText(t('library.submitSuccessRequest', { requestId }));
    const actions = this.contentEl.createDiv({ cls: 'radi-library-submit-actions' });
    if (prUrl !== '') {
      const prBtn = actions.createEl('button', { cls: 'radi-library-detail-install' });
      prBtn.setText(t('library.submissionOpenPr'));
      prBtn.addEventListener('click', () => { window.open(prUrl, '_blank'); });
    }
    const doneBtn = actions.createEl('button', { cls: 'radi-library-detail-cancel mod-cta' });
    doneBtn.setText(t('library.submitSuccessDone'));
    doneBtn.addEventListener('click', () => { this.safeResolve({ submitted: true, requestId, prUrl, reused: false }); this.close(); });
  }

  private async handleSubmit(): Promise<void> {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    if (this.inFlight || !this.canSubmit()) return;
    const service = this.submissionService();
    if (service === undefined || service === null) {
      this.statusEl.setText(t('library.submitUnavailable'));
      return;
    }
    this.inFlight = true;
    this.submitBtn.disabled = true;
    this.statusEl.setText(t('library.submitting'));
    const authorFromBundle = this.bundle.manifest.author?.displayName ?? '';
    const meta = {
      title: this.title.trim() || this.bundle.manifest.protocolDoc.title,
      description: this.description.trim(),
      categories: LIBRARY_SUBMISSION_CATEGORIES.filter((c) => this.selectedCategories.has(c)),
      authorDisplayName: authorFromBundle,
      note: this.note.trim(),
    };
    this.postStarted = true;
    let outcome: SubmissionResult;
    try {
      outcome = await service.submitNew({
        bundle: this.bundle,
        meta,
        registryKey: normalizeRegistryUrl(this.options.registryBaseUrl),
        sourceDocumentId: this.options.sourceDocumentId,
        sourceProtocolPath: this.options.sourceProtocolPath,
      });
    } catch (e) {
      // The service never throws by contract; this is a defensive last resort.
      this.inFlight = false;
      this.submitBtn.disabled = false;
      this.statusEl.setText(t('library.submitError', { reason: (e as Error)?.message ?? String(e) }));
      return;
    }
    this.inFlight = false;
    if (outcome.status === 'ok') {
      new Notice(t('library.submittedNotice'));
      // Stage E: success screen WITHOUT auto-close (plan §7 Этап E). The user
      // explicitly acknowledges; closing resolves the promise as submitted.
      this.renderSuccess(outcome.record.requestId, outcome.record.receipt?.prUrl ?? '');
      this.safeResolve({ submitted: true, requestId: outcome.record.requestId, prUrl: outcome.record.receipt?.prUrl ?? '', reused: outcome.record.receipt?.reused ?? false });
      return;
    }
    if (outcome.status === 'persist-failed' || outcome.status === 'invalid-input') {
      // Nothing was sent (persist-before-POST contract) or the input was
      // rejected locally — the user can fix and retry in place.
      this.statusEl.setText(t('library.submitError', { reason: outcome.reason }));
      this.submitBtn.disabled = false;
      return;
    }
    this.statusEl.setText(t('library.submitError', { reason: describeFailure(this.plugin, outcome.code, outcome.message) }));
    this.submitBtn.disabled = false;
  }
}

/** Map a typed failure code to a localized message; unknown codes fall back to
 *  the service's own safe text. */
function describeFailure(plugin: RadiProtocolPlugin, code: string, fallback: string): string {
  const t = plugin.i18n.t.bind(plugin.i18n);
  const known: Partial<Record<SubmissionErrorCode, string>> = {
    'CLIENT_UPDATE_REQUIRED': t('library.submitErrClientUpdate'),
    'VERSION_ALREADY_PUBLISHED': t('library.submitErrVersionPublished'),
    'REQUEST_ID_DIGEST_MISMATCH': t('library.submitErrDigestMismatch'),
    'SUBMISSION_STATE_UNKNOWN': t('library.submitErrStateUnknown'),
    'rate_limited': t('library.submitErrRateLimited'),
    'oversize': t('library.submitErrOversize'),
    'network_error': t('library.submitErrNetwork'),
  };
  return known[code as SubmissionErrorCode] ?? fallback;
}
