// src/views/library-import-modal.ts
// Import-from-file modal for the moderation review flow: paste/pick a vault path to a
// release bundle JSON (the byte-identical plugin export format), preview the manifest
// identity, then install through the SAME transactional installer as registry installs.
// Typed Promise-modal result; completion settles even when dismissed mid-install.

import { Modal, Notice, type App } from 'obsidian';
import type RadiProtocolPlugin from '../main';
import type { LibraryInstallResult } from '../library/library-service';
import { isReleaseResponse } from '../library/registry-model';

type LibraryImportResult = { kind: 'dismissed' } | { kind: 'done' };

export class LibraryImportModal extends Modal {
  readonly result: Promise<LibraryImportResult>;
  /** Settles after install plus Vault-index readiness, even if the modal was dismissed. */
  readonly completion: Promise<LibraryInstallResult | null>;
  private resolve!: (value: LibraryImportResult) => void;
  private resolveCompletion!: (value: LibraryInstallResult | null) => void;
  private resolved = false;
  private completionResolved = false;

  private readonly plugin: RadiProtocolPlugin;
  private filePath = '';
  private importBtn!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private busy = false;

  constructor(app: App, plugin: RadiProtocolPlugin) {
    super(app);
    this.plugin = plugin;
    this.result = new Promise<LibraryImportResult>((res) => { this.resolve = res; });
    this.completion = new Promise<LibraryInstallResult | null>((res) => { this.resolveCompletion = res; });
  }

  async onOpen(): Promise<void> {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const { contentEl, modalEl } = this;
    contentEl.empty();
    modalEl.addClass('radi-library-import');
    this.titleEl.setText(t('library.importTitle'));

    const hint = contentEl.createDiv({ cls: 'radi-library-section-hint' });
    hint.setText(t('library.importHint'));

    // Path row: editable text input (accepts any vault-relative path). A file picker
    // would need an Electron seam — the typed path keeps the modal testable and works
    // on mobile too.
    const row = contentEl.createDiv({ cls: 'radi-library-import-field' });
    row.createEl('label', { text: t('library.importPathLabel'), attr: { for: 'radi-library-import-path' } });
    const input = row.createEl('input', {
      cls: 'radi-library-import-path',
      attr: { type: 'text', id: 'radi-library-import-path', spellcheck: false },
    });
    input.placeholder = t('library.importPathPlaceholder');
    input.addEventListener('input', () => {
      this.filePath = input.value.trim();
      this.statusEl.empty();
    });

    // Manifest preview (identity only) once a readable bundle is at the given path.
    const previewEl = contentEl.createDiv({ cls: 'radi-library-import-preview' });
    input.addEventListener('change', () => { void this.updatePreview(previewEl); });
    input.addEventListener('input', () => { previewEl.empty(); });

    this.statusEl = contentEl.createDiv({
      cls: 'radi-library-banner is-hidden',
      attr: { role: 'status', 'aria-live': 'polite' },
    });

    const actions = contentEl.createDiv({ cls: 'radi-library-export-actions' });
    this.importBtn = actions.createEl('button', { cls: 'radi-library-detail-install mod-cta' });
    this.importBtn.setText(t('library.importActionLabel'));
    this.importBtn.addEventListener('click', () => { void this.handleImport(); });

    const cancelBtn = actions.createEl('button');
    cancelBtn.setText(t('library.cancel'));
    cancelBtn.addEventListener('click', () => this.finish({ kind: 'dismissed' }));
  }

  /** Read the bundle at the current path and show package identity if it parses. */
  private async updatePreview(previewEl: HTMLElement): Promise<void> {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    previewEl.empty();
    if (this.filePath === '') return;
    try {
      const raw = await this.app.vault.adapter.read(this.filePath);
      const parsed: unknown = JSON.parse(raw);
      if (!isReleaseResponse(parsed)) {
        previewEl.setText(t('library.importPreviewInvalid'));
        return;
      }
      previewEl.setText(t('library.importPreviewIdentity', {
        packageId: parsed.manifest.packageId,
        version: parsed.manifest.releaseVersion,
        title: parsed.manifest.protocolDoc.title ?? '',
      }));
    } catch {
      previewEl.setText(t('library.importPreviewUnreadable'));
    }
  }

  private async handleImport(): Promise<void> {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    if (this.busy) return;
    if (this.filePath === '') {
      this.showStatus(t('library.importErrorNoPath'));
      return;
    }
    this.busy = true;
    this.importBtn.disabled = true;

    const installResult = await this.plugin.libraryService.installFromFile(this.filePath);

    // Settle completion FIRST so awaiting code proceeds even if the modal was closed.
    this.resolveCompletion(installResult);
    this.completionResolved = true;
    this.busy = false;

    if (installResult.status === 'ok') {
      this.finish({ kind: 'done' });
      new Notice(t('library.importedNotice', {
        packageId: installResult.packageId,
        version: installResult.releaseVersion,
      }));
    } else {
      this.importBtn.disabled = false;
      this.showStatus(t('library.importError', { reason: installResult.reason }));
    }
  }

  private showStatus(message: string): void {
    this.statusEl.empty();
    this.statusEl.addClass('mod-warning');
    this.statusEl.removeClass('is-hidden');
    this.statusEl.setText(message);
  }

  private finish(value: LibraryImportResult): void {
    if (!this.completionResolved) {
      this.resolveCompletion(null);
      this.completionResolved = true;
    }
    if (!this.resolved) {
      this.resolved = true;
      this.resolve(value);
    }
    this.close();
  }

  onClose(): void {
    this.safeResolve();
    this.contentEl.empty();
  }

  private safeResolve(): void {
    if (!this.completionResolved) {
      this.resolveCompletion(null);
      this.completionResolved = true;
    }
    if (!this.resolved) {
      this.resolved = true;
      this.resolve({ kind: 'dismissed' });
    }
  }
}
