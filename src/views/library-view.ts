// src/views/library-view.ts — Phase 6 SHELL (Step 5 B3 plan-local split)
// First-class ItemView for the community library (D4). Catalog discovery
// (search + category filter + list) + installed list. Modeled after
// SnippetManagerView (src/views/snippet-manager-view.ts:50,185-253):
// generation-guarded async refresh, 120ms-debounced vault watchers scoped to
// the library-managed subtrees + the installed-records dir, full dispose in
// onClose. The view consumes LibraryService (this.plugin.libraryService,
// wired in Slice 9); the item-detail modal + install-progress modal + the
// click→detail wiring are added in Slice 7 (MODIFY merge into this file).
//
// Fetch discipline: refresh() fetches the FULL catalog once (listCatalog()
// with no query — the service returns all entries when query is undefined)
// and stores it; search and category-filter changes re-filter the loaded
// catalog CLIENT-SIDE via renderModel() (no network round-trip — Performance
// Considerations). Only open / explicit Refresh button / watcher events
// trigger a fetch.
//
// Watcher scope: the catalog cache is the view's OWN write (Slice 5's
// listCatalog writes the cache on every successful fetch) — watching it
// would self-trigger an infinite refresh cycle, so it is excluded. The
// installer's transient pre-commit journal (Slice 4, written before the
// commit marker) is also excluded — watching it would churn refreshes
// before an install completes. The watcher covers only the library-managed
// subtrees + the installed-records dir; the per-release marker there
// (written LAST by the installer) is the meaningful "install completed"
// signal that warrants a refresh.
//
// All user-visible strings use t('library.*'); user-authored content
// (package titles, author names, categories) is NEVER wrapped in t().
// Integrity is shown as "integrity verified" (D11) — publisher authenticity
// is deferred, so the badge never implies authenticity. The
// catalog-unavailable state is explicit, never a throw (D6).
//
// PLAN-LOCAL SPLIT (Step 5 B3): this shell does NOT import the modals or
// define openDetail/openInstall — Phase 7 MODIFY adds them so this phase
// type-checks standalone (the modals are created in Phase 7).

import { ItemView, Notice, WorkspaceLeaf, type EventRef } from 'obsidian';
import type RadiProtocolPlugin from '../main';
import { isLibraryManagedPath } from '../library/library-paths';
import type { CatalogEntry, InstalledRecord } from '../library/library-model';
import type { CatalogListResult } from '../library/library-service';
import type { SubmissionRecord } from '../library/submission-model';
import type { ReconcileResult } from '../library/submission-service';
import { LibraryItemDetailModal } from './library-item-detail-modal';
import { LibraryImportModal } from './library-import-modal';
import { LibraryInstallProgressModal } from './library-install-progress-modal';
import { ConfirmModal } from './confirm-modal';

export const LIBRARY_VIEW_TYPE = 'radiprotocol-library';

/** Installed-records dir watched for install/uninstall changes (mirrors
 *  INSTALLED_DIR in src/library/installed-record-store.ts — D15/D16; not
 *  exported by the store). The catalog cache (the view's own write via
 *  Slice 5 listCatalog) and the installer's pre-commit journal (Slice 4)
 *  are deliberately NOT watched — the former would self-cycle, the latter
 *  churns before the marker lands. */
const LIBRARY_INSTALLED_DIR = '.radiprotocol/library/installed';

/** Submissions dir watched for new/removed submission receipts (mirrors
 *  SUBMISSIONS_DIR in src/library/submission-store.ts). Writing a receipt is
 *  the "submission attempt recorded" signal that warrants a refresh. */
const LIBRARY_SUBMISSIONS_DIR = '.radiprotocol/library/submissions';

interface LibraryViewModel {
  catalog: CatalogListResult;
  installed: InstalledRecord[];
  /** Local submission attempts («Мои заявки»), newest first. */
  submissions: SubmissionRecord[];
}

export class LibraryView extends ItemView {
  private plugin: RadiProtocolPlugin;

  private mounted = false;
  /** Single invalidation generation — open, explicit refresh, and watcher
   *  refreshes increment it; post-await commits require both `mounted` and
   *  generation equality so stale work is rejected. Search/filter changes
   *  do NOT bump the generation (they re-filter synchronously). */
  private generation = 0;

  private query = '';
  private filter = '';
  private redrawTimer: number | null = null;

  private model: LibraryViewModel | null = null;

  // DOM refs rebuilt on every render (filterSelect options repopulated).
  private bannerEl!: HTMLElement;
  private catalogListEl!: HTMLElement;
  private installedListEl!: HTMLElement;
  private submissionsListEl!: HTMLElement;
  private filterSelect!: HTMLSelectElement;

  constructor(leaf: WorkspaceLeaf, plugin: RadiProtocolPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return LIBRARY_VIEW_TYPE; }
  getDisplayText(): string { return this.plugin.i18n.t('library.viewTitle'); }
  getIcon(): string { return 'library'; }

  // --- Lifecycle -----------------------------------------------------------

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('radi-library-root');
    this.mounted = true;

    const t = this.plugin.i18n.t.bind(this.plugin.i18n);

    // Header: title + refresh button (the explicit refresh action —
    // Performance Considerations accepts "or explicit refresh action").
    const header = contentEl.createDiv({ cls: 'radi-library-header' });
    header.createEl('h2', { text: t('library.viewTitle') });
    const refreshBtn = header.createEl('button', {
      cls: 'radi-library-refresh',
    });
    refreshBtn.setText(t('library.refreshLabel'));
    this.registerDomEvent(refreshBtn, 'click', () => { void this.refresh(); });

    // Import-from-file (moderation review flow): install a release bundle JSON from
    // the vault without going through the registry.
    const importBtn = header.createEl('button', { cls: 'radi-library-import' });
    importBtn.setText(t('library.importOpenLabel'));
    this.registerDomEvent(importBtn, 'click', () => { void this.openImport(); });

    // Search + category filter row. Both re-filter the loaded catalog
    // synchronously (no fetch).
    const searchWrap = contentEl.createDiv({ cls: 'radi-library-search' });
    const searchInput = searchWrap.createEl('input', {
      cls: 'radi-library-search-input',
      attr: { type: 'text', 'aria-label': t('library.searchPlaceholder') },
    });
    searchInput.placeholder = t('library.searchPlaceholder');
    this.registerDomEvent(searchInput, 'input', () => {
      this.query = searchInput.value;
      this.renderModel();
    });

    this.filterSelect = searchWrap.createEl('select', {
      cls: 'radi-library-filter',
      attr: { 'aria-label': t('library.filterLabel') },
    });
    this.filterSelect.createEl('option', { value: '', text: t('library.filterAll') });
    this.registerDomEvent(this.filterSelect, 'change', () => {
      this.filter = this.filterSelect.value;
      this.renderModel();
    });

    // Unavailable banner (hidden until a refresh sets it). role=status +
    // aria-live=polite so the unavailable state is announced.
    this.bannerEl = contentEl.createDiv({
      cls: 'radi-library-banner is-hidden',
      attr: { role: 'status', 'aria-live': 'polite' },
    });

    // Catalog section.
    const catalogSection = contentEl.createDiv({ cls: 'radi-library-section' });
    catalogSection.createEl('h3', { text: t('library.catalogSection') });
    this.catalogListEl = catalogSection.createDiv({ cls: 'radi-library-list' });
    this.catalogListEl.setAttr('role', 'list');
    this.catalogListEl.setAttr('aria-label', t('library.catalogSection'));

    // Installed section.
    const installedSection = contentEl.createDiv({ cls: 'radi-library-section' });
    installedSection.createEl('h3', { text: t('library.installedSection') });
    this.installedListEl = installedSection.createDiv({ cls: 'radi-library-list' });
    this.installedListEl.setAttr('role', 'list');
    this.installedListEl.setAttr('aria-label', t('library.installedSection'));

    // «Мои заявки» section (Stage E): local submission attempts for this vault.
    // NOT account sync — only what this vault has sent (plan §7 Этап E).
    const submissionsSection = contentEl.createDiv({ cls: 'radi-library-section' });
    submissionsSection.createEl('h3', { text: t('library.submissionsSection') });
    this.submissionsListEl = submissionsSection.createDiv({ cls: 'radi-library-list' });
    this.submissionsListEl.setAttr('role', 'list');
    this.submissionsListEl.setAttr('aria-label', t('library.submissionsSection'));

    // Initial loading state.
    this.renderLoading();

    await this.refresh();
    if (!this.mounted) return;

    // Vault watchers — scoped to library-managed subtrees + the
    // installed-records dir ONLY (NOT the catalog cache or the installer's
    // pre-commit journal — see the file header for rationale). 120ms
    // debounce coalesces rapid events.
    this.registerEvent(
      this.app.vault.on('create', (file) => { if (this.shouldHandle(file.path)) this.scheduleRedraw(); }) as EventRef,
    );
    this.registerEvent(
      this.app.vault.on('delete', (file) => { if (this.shouldHandle(file.path)) this.scheduleRedraw(); }) as EventRef,
    );
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (this.shouldHandle(file.path) || this.shouldHandle(oldPath)) this.scheduleRedraw();
      }) as EventRef,
    );
    this.registerEvent(
      this.app.vault.on('modify', (file) => { if (this.shouldHandle(file.path)) this.scheduleRedraw(); }) as EventRef,
    );
  }

  async onClose(): Promise<void> {
    this.mounted = false;
    this.generation++;
    this.query = '';
    this.filter = '';
    this.model = null;
    if (this.redrawTimer !== null) { window.clearTimeout(this.redrawTimer); this.redrawTimer = null; }
    this.contentEl.empty();
    // Vault event refs auto-detach via registerEvent; nothing else to release.
  }

  // --- Vault watcher scope -------------------------------------------------

  private shouldHandle(filePath: string): boolean {
    const protocolRoot = this.plugin.settings.protocolFolderPath;
    const snippetRoot = this.plugin.settings.snippetFolderPath;
    return (
      isLibraryManagedPath(filePath, protocolRoot) ||
      isLibraryManagedPath(filePath, snippetRoot) ||
      filePath === LIBRARY_INSTALLED_DIR ||
      filePath.startsWith(LIBRARY_INSTALLED_DIR + '/') ||
      filePath === LIBRARY_SUBMISSIONS_DIR ||
      filePath.startsWith(LIBRARY_SUBMISSIONS_DIR + '/')
    );
  }

  private scheduleRedraw(): void {
    if (this.redrawTimer !== null) window.clearTimeout(this.redrawTimer);
    this.redrawTimer = window.setTimeout(() => {
      this.redrawTimer = null;
      void this.refresh();
    }, 120);
  }

  // --- Refresh (generation-guarded; fetch path) ---------------------------

  private async refresh(): Promise<boolean> {
    if (!this.mounted) return false;
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const generation = ++this.generation;
    this.contentEl.addClass('is-scanning');
    try {
      // Fetch the FULL catalog (no query) so the category dropdown can be
      // populated from the unfiltered set; display filtering is client-side.
      const catalog = await this.plugin.libraryService.listCatalog();
      if (!this.owns(generation)) return false;
      const installed = await this.plugin.libraryService.listInstalled();
      if (!this.owns(generation)) return false;
      const submissions = await this.plugin.librarySubmissionService.records.list();
      if (!this.owns(generation)) return false;
      this.model = { catalog, installed, submissions };
      this.renderModel();
      return true;
    } catch (e) {
      if (!this.owns(generation)) return false;
      new Notice(t('library.refreshError'));
      console.error('[Protocol Former] library refresh failed', e);
      return false;
    } finally {
      if (this.owns(generation)) this.contentEl.removeClass('is-scanning');
    }
  }

  private owns(generation: number): boolean {
    return this.mounted && generation === this.generation;
  }

  // --- Render -------------------------------------------------------------

  private renderLoading(): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    this.catalogListEl.empty();
    this.catalogListEl.createEl('p', { cls: 'radi-library-empty', text: t('library.loading') });
    this.installedListEl.empty();
    this.installedListEl.createEl('p', { cls: 'radi-library-empty', text: t('library.loading') });
    this.submissionsListEl.empty();
    this.submissionsListEl.createEl('p', { cls: 'radi-library-empty', text: t('library.loading') });
  }

  private renderModel(): void {
    const model = this.model;
    if (model === null) return;
    this.populateFilter(model.catalog.entries);
    this.renderBanner(model.catalog);
    this.renderCatalog(this.applyLocalFilter(model.catalog.entries));
    this.renderInstalled(model.installed);
    this.renderSubmissions(model.submissions);
  }

  /** Rebuild the category filter options from the UNFILTERED loaded entries,
   *  preserving the current selection. Categories are user-authored content
   *  (never wrapped in t()). Because `entries` is the full catalog, every
   *  category is always an option — an active filter never strands the
   *  dropdown with only the selected category. */
  private populateFilter(entries: CatalogEntry[]): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const cats = new Set<string>();
    for (const e of entries) for (const c of e.categories) cats.add(c);
    const sorted = [...cats].sort((a, b) => a.localeCompare(b));
    const current = this.filter;
    this.filterSelect.empty();
    this.filterSelect.createEl('option', { value: '', text: t('library.filterAll') });
    for (const c of sorted) {
      this.filterSelect.createEl('option', { value: c, text: c });
    }
    // Preserve the selection if still present; reset to "all" only if the
    // category disappeared from the catalog (legitimate).
    this.filterSelect.value = sorted.includes(current) ? current : '';
    this.filter = this.filterSelect.value;
  }

  /** Client-side display filter. Mirrors filterEntries in
   *  library-service.ts (title/description/author/categories/summary,
   *  case-insensitive includes; exact category match). Duplicated here so
   *  the category dropdown can be populated from the UNFILTERED catalog (one
   *  fetch, correct options) and search/filter changes re-filter without a
   *  network round-trip — without modifying the locked Slice 5 service. */
  private applyLocalFilter(entries: CatalogEntry[]): CatalogEntry[] {
    const q = this.query.trim().toLowerCase();
    const f = this.filter.trim();
    if (q === '' && f === '') return entries;
    return entries.filter((e) => {
      if (f !== '' && !e.categories.includes(f)) return false;
      if (q !== '') {
        const hay = [e.title, e.description, e.author.displayName, ...e.categories, e.summary ?? ''].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  private renderBanner(catalog: CatalogListResult): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    if (catalog.available) {
      this.bannerEl.addClass('is-hidden');
      this.bannerEl.empty();
      return;
    }
    this.bannerEl.removeClass('is-hidden');
    this.bannerEl.empty();
    const reason = catalog.reason ?? '';
    // A cached snapshot exists iff `fetchedAt` is set (the cache records the
    // snapshot's fetchedAt; the unavailable path leaves it undefined when no
    // cache exists). Branching on fetchedAt — NOT on entries.length — avoids
    // mislabeling a zero-match filtered cache as "no cache" (D6).
    if (catalog.fetchedAt !== undefined) {
      this.bannerEl.setText(t('library.unavailableBanner', { reason }));
    } else {
      this.bannerEl.setText(t('library.unavailableNoCache', { reason }));
    }
  }

  private renderCatalog(entries: CatalogEntry[]): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    this.catalogListEl.empty();
    if (entries.length === 0) {
      this.catalogListEl.createEl('p', { cls: 'radi-library-empty', text: t('library.noEntries') });
      return;
    }
    for (const entry of entries) {
      this.renderCatalogEntry(entry);
    }
  }

  private renderCatalogEntry(entry: CatalogEntry): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const row = this.catalogListEl.createDiv({ cls: 'radi-library-entry', attr: { role: 'listitem' } });
    row.setAttr('aria-label', t('library.catalogEntryAria', { title: entry.title }));
    row.addClass('is-clickable');
    row.setAttr('tabindex', '0');
    // Phase 7 MODIFY wires these handlers to openDetail(entry) (the trust-preview
    // modal). The Phase 6 shell keeps them INERT so it type-checks standalone
    // (Step 5 B3 plan-local split — openDetail is added by Phase 7).
    row.addEventListener('click', () => { void this.openDetail(entry); });
    row.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        void this.openDetail(entry);
      }
    });

    const titleEl = row.createDiv({ cls: 'radi-library-entry-title' });
    titleEl.setText(entry.title); // user-authored content — never wrapped in t()

    const metaEl = row.createDiv({ cls: 'radi-library-entry-meta' });
    metaEl.createEl('span', { cls: 'radi-library-entry-author', text: `${t('library.authorLabel')}: ${entry.author.displayName}` });
    metaEl.createEl('span', { cls: 'radi-library-entry-version', text: t('library.latestLabel', { version: entry.latestVersion }) });
    metaEl.createEl('span', { cls: 'radi-library-entry-updated', text: `${t('library.updatedLabel')}: ${formatDate(entry.updatedAt)}` });

    if (entry.categories.length > 0) {
      const cats = row.createDiv({ cls: 'radi-library-entry-categories' });
      cats.createEl('span', { cls: 'radi-library-entry-categories-label', text: `${t('library.categoriesLabel')}:` });
      cats.createEl('span', { cls: 'radi-library-entry-categories-value', text: entry.categories.join(', ') });
    }

    if (entry.summary !== undefined && entry.summary !== '') {
      row.createDiv({ cls: 'radi-library-entry-summary', text: entry.summary });
    }
  }

  private renderInstalled(records: InstalledRecord[]): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    this.installedListEl.empty();
    if (records.length === 0) {
      this.installedListEl.createEl('p', { cls: 'radi-library-empty', text: t('library.noInstalled') });
      return;
    }
    // Sort by installedAt descending (most recent first); localeCompare is
    // stable for ISO 8601 UTC strings.
    const sorted = [...records].sort((a, b) => b.installedAt.localeCompare(a.installedAt));
    for (const record of sorted) {
      this.renderInstalledRecord(record);
    }
  }

  private renderInstalledRecord(record: InstalledRecord): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const row = this.installedListEl.createDiv({ cls: 'radi-library-installed', attr: { role: 'listitem' } });
    row.setAttr('aria-label', t('library.installedEntryAria', { packageId: record.packageId, version: record.releaseVersion }));

    const titleEl = row.createDiv({ cls: 'radi-library-installed-title' });
    titleEl.setText(record.packageId); // server-controlled opaque id

    const metaEl = row.createDiv({ cls: 'radi-library-installed-meta' });
    metaEl.createEl('span', { cls: 'radi-library-installed-version', text: `${t('library.versionLabel')}: ${record.releaseVersion}` });
    if (record.author !== undefined) {
      metaEl.createEl('span', { cls: 'radi-library-installed-author', text: `${t('library.authorLabel')}: ${record.author.displayName}` });
    }
    metaEl.createEl('span', { cls: 'radi-library-installed-date', text: `${t('library.installedAtLabel')}: ${formatDate(record.installedAt)}` });

    // Integrity-verified indicator (D11); publisher authenticity/signatures
    // are deferred, so the badge never implies authenticity. The record's
    // presence + validity IS the integrity commit marker (D7/D15).
    const badge = row.createDiv({ cls: 'radi-library-integrity-badge' });
    badge.createEl('span', { cls: 'radi-library-integrity-icon', attr: { 'aria-hidden': 'true' } });
    badge.createEl('span', { cls: 'radi-library-integrity-text', text: t('library.integrityVerified') });

    // FR-8: Uninstall button (wires the existing LibraryService.uninstall).
    const uninstallBtn = row.createEl('button', {
      cls: 'radi-library-uninstall-btn',
      attr: { 'aria-label': t('library.uninstallLabel') },
    });
    uninstallBtn.setText(t('library.uninstallLabel'));
    uninstallBtn.addEventListener('click', () => { void this.handleUninstall(record); });
  }

  /** «Мои заявки»: local submission attempts, newest first (store already
   *  sorts by createdAt desc). Refresh + retry/reconcile per §7 Этап E. */
  private renderSubmissions(records: SubmissionRecord[]): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    this.submissionsListEl.empty();
    if (records.length === 0) {
      this.submissionsListEl.createEl('p', { cls: 'radi-library-empty', text: t('library.submissionsEmpty') });
      return;
    }
    for (const record of records) {
      this.renderSubmissionRecord(record);
    }
  }

  private renderSubmissionRecord(record: SubmissionRecord): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const row = this.submissionsListEl.createDiv({ cls: 'radi-library-submission', attr: { role: 'listitem' } });
    row.setAttr('aria-label', t('library.submissionEntryAria', { packageId: record.packageId, version: record.releaseVersion }));

    const titleEl = row.createDiv({ cls: 'radi-library-submission-title' });
    titleEl.setText(record.payload.meta.title || record.packageId); // user-authored content — never t()

    const metaEl = row.createDiv({ cls: 'radi-library-submission-meta' });
    metaEl.createEl('span', { cls: 'radi-library-submission-version', text: `${t('library.versionLabel')}: ${record.releaseVersion}` });
    metaEl.createEl('span', { cls: 'radi-library-submission-state', text: t(submissionStateLabelKey(record.state)) });
    metaEl.createEl('span', { cls: 'radi-library-submission-date', text: `${t('library.updatedLabel')}: ${formatDate(record.updatedAt)}` });

    // Last error, when present (safe service-produced text, no raw dumps).
    if (record.lastError !== null) {
      row.createDiv({ cls: 'radi-library-submission-error', text: record.lastError.message });
    }

    const actionsEl = row.createDiv({ cls: 'radi-library-submission-actions' });

    // PR link (https-validated at receipt time by the client).
    if (record.receipt !== null) {
      const prBtn = actionsEl.createEl('button', { cls: 'radi-library-submission-pr' });
      prBtn.setText(t('library.submissionOpenPr'));
      prBtn.addEventListener('click', () => { window.open(record.receipt!.prUrl, '_blank'); });
    }

    // Reconcile / check status — for anything not terminal and not in-flight.
    if (record.state !== 'sending' && record.state !== 'published') {
      const checkBtn = actionsEl.createEl('button', { cls: 'radi-library-submission-check' });
      checkBtn.setText(t('library.submissionCheckStatus'));
      checkBtn.addEventListener('click', () => { void this.handleReconcile(record.requestId); });
    }

    // Retry — only for attempts that never produced a PR (draft/failed/
    // outcome_unknown). The service rejects invalid retries by contract.
    if (record.state === 'failed' || record.state === 'outcome_unknown' || record.state === 'draft') {
      const retryBtn = actionsEl.createEl('button', { cls: 'radi-library-submission-retry' });
      retryBtn.setText(t('library.submissionRetry'));
      retryBtn.addEventListener('click', () => { void this.handleRetry(record.requestId); });
    }

    // Explicit local retention action (plan §7 Этап E: удаление — явное действие).
    const deleteBtn = actionsEl.createEl('button', {
      cls: 'radi-library-submission-delete',
      attr: { 'aria-label': t('library.submissionDelete') },
    });
    deleteBtn.setText(t('library.submissionDelete'));
    deleteBtn.addEventListener('click', () => { void this.handleDeleteSubmission(record.requestId); });
  }

  /** Reconcile one attempt against the registry (read-only) and refresh. */
  private async handleReconcile(requestId: string): Promise<void> {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const result: ReconcileResult = await this.plugin.librarySubmissionService.reconcile(requestId);
    if (result.status === 'ok' && result.changed) {
      new Notice(t('library.submissionStatusChanged'));
    } else if (result.status === 'check-failed') {
      new Notice(t('library.submissionCheckFailed', { reason: result.message }));
    } else if (result.status === 'invalid-input' || result.status === 'persist-failed') {
      new Notice(t('library.submissionCheckFailed', { reason: result.reason }));
    }
    await this.refresh();
  }

  /** Retry a frozen attempt with the SAME payload + requestId (§6.2.2). */
  private async handleRetry(requestId: string): Promise<void> {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const result = await this.plugin.librarySubmissionService.retry(requestId);
    if (result.status === 'ok') {
      new Notice(t('library.submittedNotice'));
    } else if (result.status === 'failed') {
      new Notice(t('library.submitError', { reason: result.message }));
    } else {
      new Notice(t('library.submitError', { reason: result.reason }));
    }
    await this.refresh();
  }

  /** Explicit local deletion of a submission record (retention action). */
  private async handleDeleteSubmission(requestId: string): Promise<void> {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const modal = new ConfirmModal(this.app, {
      title: t('library.submissionDeleteTitle'),
      body: t('library.submissionDeleteBody'),
      confirmLabel: t('library.submissionDelete'),
      cancelLabel: t('library.cancel'),
      destructive: true,
    });
    modal.open();
    const result = await modal.result;
    if (result !== 'confirm') return;
    await this.plugin.librarySubmissionService.records.delete(requestId);
    await this.refresh();
  }

  private async openDetail(entry: CatalogEntry): Promise<void> {
    const modal = new LibraryItemDetailModal(this.app, this.plugin, entry);
    modal.open();
    const result = await modal.result;
    if (result.install) {
      await this.openInstall(result.packageId, result.version);
    }
  }

  /** Import-from-file (moderation review): open the import modal, install the bundle,
   *  and refresh the installed list when the modal settles with a result. */
  private async openImport(): Promise<void> {
    const modal = new LibraryImportModal(this.app, this.plugin);
    modal.open();
    const result = await modal.completion;
    if (result !== null && result.status === 'ok') await this.refresh();
  }

  private async openInstall(packageId: string, version: string): Promise<void> {
    const modal = new LibraryInstallProgressModal(this.app, this.plugin, packageId, version);
    modal.open();
    const result = await modal.completion;
    // Adapter events remain useful invalidation hints, but are not the success
    // signal. Completion settles even when the modal was dismissed mid-install.
    if (result.status === 'ok') await this.refresh();
  }

  /** FR-8: uninstall an installed package — ConfirmModal → facade (status check,
   *  not try/catch — the facade never throws) → Notice → explicit refresh (the
   *  installer deletes the marker via adapter.remove on a dotfolder file, which
   *  does not reliably fire vault.on('delete')). Mirrors handleDeleteSnippet. */
  private async handleUninstall(record: InstalledRecord): Promise<void> {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const modal = new ConfirmModal(this.app, {
      title: t('library.uninstallTitle'),
      body: t('library.uninstallBody', { packageId: record.packageId, version: record.releaseVersion }),
      confirmLabel: t('library.uninstallConfirm'),
      cancelLabel: t('library.cancel'),
      destructive: true,
    });
    modal.open();
    const result = await modal.result;
    if (result !== 'confirm') return;
    const uninstallResult = await this.plugin.libraryService.uninstall(record.packageId, record.releaseVersion);
    if (uninstallResult.status === 'ok') {
      new Notice(t('library.uninstalledNotice', { packageId: record.packageId }));
    } else if (uninstallResult.status === 'not-installed') {
      new Notice(t('library.notInstalledNotice', { packageId: record.packageId }));
    } else {
      new Notice(t('library.uninstallError', { reason: uninstallResult.reason }));
    }
    await this.refresh();
  }
}

/** Format an ISO 8601 timestamp as a locale date string. Returns the raw
 *  value on parse failure (never throws). */
function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString();
  } catch {
    return iso;
  }
}

/** i18n key for a submission transport/review state badge. */
function submissionStateLabelKey(state: SubmissionRecord['state']): string {
  switch (state) {
    case 'draft': return 'library.submissionStateDraft';
    case 'sending': return 'library.submissionStateSending';
    case 'outcome_unknown': return 'library.submissionStateUnknown';
    case 'pending': return 'library.submissionStatePending';
    case 'failed': return 'library.submissionStateFailed';
    case 'rejected': return 'library.submissionStateRejected';
    case 'approved_pending_publish': return 'library.submissionStateApproved';
    case 'published': return 'library.submissionStatePublished';
  }
}
