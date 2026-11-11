// src/views/library-install-progress-modal.ts
// Install progress modal (Slice 7). Promise-based Modal. Drives the atomic
// LibraryService.install() and renders an exhaustive state dispatch + ARIA
// progressbar modeled after InlineRunnerModal
// (src/views/inline-runner-modal.ts:330-333,396-404,444-559). The atomic
// install() does NOT emit per-stage events (Slices 4-5 locked — reopening the
// load-bearing installer is out of scope), so the progressbar is indeterminate
// during 'installing' (aria-valuenow omitted per ARIA spec) and finalizes to
// 100% on 'complete' / 'indexing-pending' / 0% on 'failed' — no fake stage
// transitions. Closing during 'installing' resolves { done: false }; the
// install continues in the background under installMutex, while LibraryView
// awaits completion and refreshes deterministically.

import { App, Modal } from 'obsidian';
import type RadiProtocolPlugin from '../main';
import type { LibraryInstallResult } from '../library/library-service';

type LibraryInstallProgressResult =
  | { done: true; result: LibraryInstallResult }
  | { done: false };

type InstallProgressState = 'installing' | 'complete' | 'indexing-pending' | 'failed';

export class LibraryInstallProgressModal extends Modal {
  readonly result: Promise<LibraryInstallProgressResult>;
  /** Settles after install plus Vault-index readiness, even if the modal was dismissed. */
  readonly completion: Promise<LibraryInstallResult>;
  private resolve!: (value: LibraryInstallProgressResult) => void;
  private resolveCompletion!: (value: LibraryInstallResult) => void;
  private resolved = false;
  private completionResolved = false;

  private readonly plugin: RadiProtocolPlugin;
  private readonly packageId: string;
  private readonly version: string;

  private state: InstallProgressState = 'installing';
  private installResult: LibraryInstallResult | null = null;

  private progressEl!: HTMLElement;
  private fillEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private closeBtn!: HTMLButtonElement;

  constructor(app: App, plugin: RadiProtocolPlugin, packageId: string, version: string) {
    super(app);
    this.plugin = plugin;
    this.packageId = packageId;
    this.version = version;
    this.result = new Promise<LibraryInstallProgressResult>((res) => { this.resolve = res; });
    this.completion = new Promise<LibraryInstallResult>((res) => { this.resolveCompletion = res; });
  }

  async onOpen(): Promise<void> {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const { contentEl, modalEl } = this;
    contentEl.empty();
    modalEl.addClass('radi-library-install-progress');

    this.titleEl.setText(t('library.installProgressLabel', { packageId: this.packageId, version: this.version }));

    // ARIA progressbar (D4 a11y). Indeterminate during 'installing' —
    // aria-valuenow is OMITTED at creation (per ARIA spec, absent valuenow =
    // indeterminate); setProgress sets it to 100 on complete/indexing-pending
    // or 0 on failed.
    this.progressEl = contentEl.createDiv({
      cls: 'radi-library-progress',
      attr: {
        role: 'progressbar',
        'aria-valuemin': '0',
        'aria-valuemax': '100',
        'aria-label': t('library.installProgressLabel', { packageId: this.packageId, version: this.version }),
      },
    });
    const track = this.progressEl.createDiv({ cls: 'radi-library-progress-track' });
    this.fillEl = track.createDiv({ cls: 'radi-library-progress-fill' });
    this.statusEl = contentEl.createDiv({ cls: 'radi-library-progress-status' });

    this.renderState();

    const closeRow = contentEl.createDiv({ cls: 'radi-library-progress-actions' });
    this.closeBtn = closeRow.createEl('button', {
      cls: 'radi-library-progress-close',
      attr: { 'aria-label': t('library.close') },
    });
    this.closeBtn.setText(t('library.close'));
    this.closeBtn.disabled = true;
    this.closeBtn.addEventListener('click', () => this.close());

    void this.runInstall();
  }

  onClose(): void {
    if (!this.resolved) {
      this.safeResolve(
        this.state === 'installing'
          ? { done: false }
          : { done: true, result: this.installResult as LibraryInstallResult },
      );
    }
    this.contentEl.empty();
  }

  private safeResolve(value: LibraryInstallProgressResult): void {
    if (!this.resolved) { this.resolved = true; this.resolve(value); }
  }

  private safeResolveCompletion(value: LibraryInstallResult): void {
    if (!this.completionResolved) {
      this.completionResolved = true;
      this.resolveCompletion(value);
    }
  }

  private async runInstall(): Promise<void> {
    const result = await this.plugin.libraryService.install(this.packageId, this.version);
    this.installResult = result;
    this.safeResolveCompletion(result);
    if (this.resolved) return; // closed UI stays untouched; completion still settles
    this.state = result.status === 'failed'
      ? 'failed'
      : result.readiness.status === 'ready'
        ? 'complete'
        : 'indexing-pending';
    this.setProgress(this.state === 'failed' ? 0 : 100);
    this.renderState();
    this.closeBtn.disabled = false;
  }

  private setProgress(percent: number): void {
    this.fillEl.style.width = `${percent}%`;
    this.progressEl.setAttribute('aria-valuenow', String(percent));
  }

  private renderState(): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    this.statusEl.empty();
    switch (this.state) {
      case 'installing':
        this.statusEl.setText(t('library.installInstalling'));
        this.progressEl.setAttribute('aria-label', t('library.installProgressLabel', { packageId: this.packageId, version: this.version }));
        break;
      case 'complete':
        this.statusEl.setText(t('library.installComplete'));
        this.progressEl.setAttribute('aria-label', t('library.installComplete'));
        break;
      case 'indexing-pending': {
        const protocolPath = this.installResult?.status === 'ok'
          ? this.installResult.readiness.protocolPath
          : '';
        const message = t('library.installIndexPending', { path: protocolPath });
        this.statusEl.setText(message);
        this.progressEl.setAttribute('aria-label', message);
        break;
      }
      case 'failed': {
        const reason = this.installResult !== null && this.installResult.status === 'failed' ? this.installResult.reason : '';
        this.statusEl.setText(t('library.installFailed', { reason }));
        this.progressEl.setAttribute('aria-label', t('library.installFailed', { reason }));
        break;
      }
      default: {
        const _exhaustive: never = this.state;
        void _exhaustive;
      }
    }
  }
}
