// src/views/library-item-detail-modal.ts
// Trust-preview modal for a catalog entry (Slice 7). Promise-based Modal
// modeled after SnippetEditorModal (src/views/snippet-editor-modal.ts:151-154,
// 644-649): discriminated-union result, safeResolve double-guard, onClose
// resolves the cancel result. Shows the catalog metadata + the release
// manifest's file list + SHA-256 hashes with an "integrity verified" framing
// (D11 — publisher authenticity is deferred; the framing never implies
// authenticity). The Install button is DISABLED until the manifest loads
// (trust preview before download); it resolves { install: true } and the
// caller (LibraryView) opens the install-progress modal. The manifest is
// fetched via LibraryService.getReleaseManifest (D2 — views consume the
// service, never RegistryClient).

import { App, Modal } from 'obsidian';
import type RadiProtocolPlugin from '../main';
import type { CatalogEntry, PackageManifest } from '../library/library-model';
import type { ReleaseManifestResult } from '../library/library-service';

type LibraryItemDetailResult =
  | { install: true; packageId: string; version: string }
  | { install: false };

export class LibraryItemDetailModal extends Modal {
  readonly result: Promise<LibraryItemDetailResult>;
  private resolve!: (value: LibraryItemDetailResult) => void;
  private resolved = false;

  private readonly plugin: RadiProtocolPlugin;
  private readonly entry: CatalogEntry;
  private fileListEl!: HTMLElement;
  private installBtn!: HTMLButtonElement;

  constructor(app: App, plugin: RadiProtocolPlugin, entry: CatalogEntry) {
    super(app);
    this.plugin = plugin;
    this.entry = entry;
    this.result = new Promise<LibraryItemDetailResult>((res) => { this.resolve = res; });
  }

  async onOpen(): Promise<void> {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const { contentEl, modalEl } = this;
    contentEl.empty();
    modalEl.addClass('radi-library-detail');

    this.titleEl.setText(t('library.detailTitle'));

    const titleEl = contentEl.createEl('h2', { cls: 'radi-library-detail-title' });
    titleEl.setText(this.entry.title); // user-authored — never t()
    this.renderMeta(contentEl);

    const filesHeading = contentEl.createEl('h3', { text: t('library.detailFiles') });
    filesHeading.addClass('radi-library-detail-files-heading');
    this.fileListEl = contentEl.createDiv({ cls: 'radi-library-detail-files' });
    this.fileListEl.createEl('p', { cls: 'radi-library-empty', text: t('library.detailLoading') });

    // Integrity framing (D11) — a process statement; publisher authenticity
    // is NOT verified (signatures deferred), so the framing never implies
    // authenticity.
    contentEl.createEl('p', { cls: 'radi-library-detail-integrity', text: t('library.detailIntegrity') });

    const actions = contentEl.createDiv({ cls: 'radi-library-detail-actions' });
    // Buttons carry visible text; no aria-label — Obsidian would surface it
    // as a duplicate hover tooltip.
    this.installBtn = actions.createEl('button', {
      cls: 'radi-library-detail-install mod-cta',
    });
    this.installBtn.setText(t('library.installLabel'));
    this.installBtn.disabled = true; // enabled once the manifest loads (trust preview before download)
    this.installBtn.addEventListener('click', () => {
      this.safeResolve({ install: true, packageId: this.entry.packageId, version: this.entry.latestVersion });
      this.close();
    });
    const cancelBtn = actions.createEl('button', {
      cls: 'radi-library-detail-cancel',
    });
    cancelBtn.setText(t('library.cancel'));
    cancelBtn.addEventListener('click', () => {
      this.safeResolve({ install: false });
      this.close();
    });

    void this.loadManifest();
  }

  onClose(): void {
    this.safeResolve({ install: false });
    this.contentEl.empty();
  }

  private safeResolve(value: LibraryItemDetailResult): void {
    if (!this.resolved) { this.resolved = true; this.resolve(value); }
  }

  private renderMeta(container: HTMLElement): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const meta = container.createDiv({ cls: 'radi-library-detail-meta' });
    meta.createEl('div', { cls: 'radi-library-detail-author', text: `${t('library.authorLabel')}: ${this.entry.author.displayName}` });
    meta.createEl('div', { cls: 'radi-library-detail-version', text: `${t('library.versionLabel')}: ${this.entry.latestVersion}` });
    meta.createEl('div', { cls: 'radi-library-detail-updated', text: `${t('library.updatedLabel')}: ${formatDate(this.entry.updatedAt)}` });
    if (this.entry.categories.length > 0) {
      meta.createEl('div', { cls: 'radi-library-detail-categories', text: `${t('library.categoriesLabel')}: ${this.entry.categories.join(', ')}` });
    }
    if (this.entry.description !== '') {
      container.createEl('p', { cls: 'radi-library-detail-description', text: this.entry.description });
    }
    if (this.entry.summary !== undefined && this.entry.summary !== '') {
      container.createEl('p', { cls: 'radi-library-detail-summary', text: this.entry.summary });
    }
  }

  private async loadManifest(): Promise<void> {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    let result: ReleaseManifestResult;
    try {
      result = await this.plugin.libraryService.getReleaseManifest(this.entry.packageId, this.entry.latestVersion);
    } catch (e) {
      result = { status: 'unavailable', reason: (e as Error)?.message ?? String(e) };
    }
    if (this.resolved) return;
    this.fileListEl.empty();
    if (result.status === 'ok') {
      this.renderFileList(result.manifest);
      this.installBtn.disabled = false; // trust preview ready — enable Install
    } else if (result.status === 'not-found') {
      this.fileListEl.createEl('p', { cls: 'radi-library-empty', text: t('library.detailNotFound') });
    } else {
      this.fileListEl.createEl('p', { cls: 'radi-library-empty', text: t('library.detailLoadFailed', { reason: result.reason }) });
    }
  }

  private renderFileList(manifest: PackageManifest): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const proto = this.fileListEl.createDiv({ cls: 'radi-library-detail-file' });
    proto.createEl('span', { cls: 'radi-library-detail-file-name', text: manifest.protocolDoc.title });
    const protoHash = proto.createEl('span', { cls: 'radi-library-detail-file-hash' });
    protoHash.setText(`${t('library.detailProtocolHash')}: ${shortHash(manifest.protocolSha256)}`);
    for (const f of manifest.snippetFiles) {
      const row = this.fileListEl.createDiv({ cls: 'radi-library-detail-file' });
      row.createEl('span', { cls: 'radi-library-detail-file-name', text: f.relPath });
      const hash = row.createEl('span', { cls: 'radi-library-detail-file-hash' });
      hash.setText(shortHash(f.sha256));
    }
  }
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString();
  } catch {
    return iso;
  }
}

function shortHash(sha: string): string {
  return sha.slice(0, 12);
}
