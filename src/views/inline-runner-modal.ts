// A floating, non-blocking shell around the presentation-neutral runner session host.
import { App, Notice, TFile, type EventRef } from 'obsidian';
import type RadiProtocolPlugin from '../main';
import type { InlineRunnerLayout } from '../settings';
import { InlineRunnerLayoutManager } from './inline-runner-layout';
import { RunnerSessionHost } from './runner-session-host';

// Re-export clamp functions for backward compatibility (tests import from this module).
export { clampInlineRunnerPosition, clampInlineRunnerLayout } from './inline-runner-layout';

export function inlineRunnerRegistryKey(
  protocolPath: string,
  notePath: string,
  startNodeId?: string,
): string {
  const startSuffix = startNodeId === undefined
    ? ''
    : `#start=${encodeURIComponent(startNodeId)}`;
  return `${protocolPath}#${notePath}${startSuffix}`;
}

export class InlineRunnerModal {
  private readonly app: App;
  private readonly plugin: RadiProtocolPlugin;
  private readonly protocolPath: string;
  private readonly targetNote: TFile;
  private readonly startNodeId: string | undefined;

  private containerEl: HTMLElement | null = null;
  /** Shared session header used as the floating drag handle. */
  private headerEl: HTMLElement | null = null;
  private sessionHost: RunnerSessionHost | null = null;
  private layoutManager: InlineRunnerLayoutManager | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private activeFileEventRef: EventRef | null = null;
  private workspaceLayoutRef: EventRef | null = null;
  private boundKeyHandler: ((event: KeyboardEvent) => void) | null = null;
  private isHidden = false;
  private openedSuccessfully = false;
  private closed = false;

  constructor(
    app: App,
    plugin: RadiProtocolPlugin,
    protocolPath: string,
    targetNote: TFile,
    startNodeId?: string,
  ) {
    this.app = app;
    this.plugin = plugin;
    this.protocolPath = protocolPath;
    this.targetNote = targetNote;
    this.startNodeId = startNodeId;
  }

  getCanvasFilePath(): string {
    return this.protocolPath;
  }

  getTargetNote(): TFile {
    return this.targetNote;
  }

  isOpen(): boolean {
    return this.openedSuccessfully && this.containerEl !== null;
  }

  focus(): void {
    if (this.containerEl === null) return;
    document.body.appendChild(this.containerEl);
    this.containerEl.removeClass('is-hidden');
    this.isHidden = false;
  }

  async open(): Promise<void> {
    if (this.containerEl !== null || this.closed) return;
    this.buildContainer();
    if (this.containerEl === null) return;

    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const sessionHost = new RunnerSessionHost({
      app: this.app,
      protocolPath: this.protocolPath,
      targetNote: this.targetNote,
      startNodeId: this.startNodeId,
      protocolDocumentStore: this.plugin.protocolDocumentStore,
      protocolDocumentParser: this.plugin.protocolDocumentParser,
      snippetService: this.plugin.snippetService,
      getTextSeparator: () => this.plugin.settings.textSeparator,
      getSnippetFolderPath: () => this.plugin.settings.snippetFolderPath,
      isRunnerDraftEnabled: () => this.plugin.settings.enableRunnerDraft !== false,
      withTargetNoteLock: (path, operation) =>
        this.plugin['insertMutex'].runExclusive(path, operation),
      t,
      notify: (message) => new Notice(message),
      onRequestClose: () => this.close(true),
    });
    this.sessionHost = sessionHost;

    // mount() builds the shared DOM synchronously before its first protocol read,
    // so floating drag policy can bind to the real shared header during loading.
    const mounting = sessionHost.mount(this.containerEl);
    const header = sessionHost.getHeaderElement();
    if (header !== null) {
      this.headerEl = header;
      this.layoutManager?.enableDragging(header);
    }

    const mounted = await mounting;
    if (!mounted || this.closed || this.containerEl === null) {
      this.close();
      return;
    }

    this.openedSuccessfully = true;
    this.activeFileEventRef = this.app.workspace.on('active-leaf-change', () => {
      this.handleActiveLeafChange();
    });
    this.handleActiveLeafChange();
    const container = this.containerEl;
    if (!this.openedSuccessfully || container === null || this.closed) return;

    this.layoutManager?.applyInitialLayout();
    this.workspaceLayoutRef = this.app.workspace.on('layout-change', () => {
      void this.layoutManager?.reclampCurrentPosition(true);
    });
    this.layoutManager?.startWindowResizeListener();

    this.resizeObserver = new ResizeObserver(() => this.layoutManager?.handleResizeTick());
    this.resizeObserver.observe(container);

    this.boundKeyHandler = (event) => this.handleKeydown(event);
    const mountedContainer = container as HTMLElement;
    mountedContainer.addEventListener('keydown', this.boundKeyHandler);
  }

  close(force = false): void {
    if (this.closed) return;
    if (!force && this.sessionHost?.hasUninsertedDraft()) {
      this.sessionHost.requestClose();
      return;
    }
    this.closed = true;
    this.openedSuccessfully = false;

    this.sessionHost?.dispose();
    this.sessionHost = null;

    if (this.boundKeyHandler !== null && this.containerEl !== null) {
      this.containerEl.removeEventListener('keydown', this.boundKeyHandler);
    }
    this.boundKeyHandler = null;
    if (this.activeFileEventRef !== null) {
      this.app.workspace.offref(this.activeFileEventRef);
      this.activeFileEventRef = null;
    }
    if (this.workspaceLayoutRef !== null) {
      this.app.workspace.offref(this.workspaceLayoutRef);
      this.workspaceLayoutRef = null;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.layoutManager?.destroy();
    this.layoutManager = null;

    this.plugin.unregisterInlineRunner(inlineRunnerRegistryKey(
      this.protocolPath,
      this.targetNote.path,
      this.startNodeId,
    ));
    this.containerEl?.remove();
    this.containerEl = null;
    this.headerEl = null;
  }

  getAppliedLayout(): InlineRunnerLayout | null {
    return this.layoutManager?.getAppliedLayout() ?? null;
  }

  restoreOrDefaultPosition(): void {
    this.layoutManager?.restoreOrDefaultPosition();
  }

  applyInitialLayout(): void {
    this.layoutManager?.applyInitialLayout();
  }

  async reclampCurrentPosition(persistIfChanged: boolean): Promise<void> {
    await this.layoutManager?.reclampCurrentPosition(persistIfChanged);
  }

  handleResizeTick(): void {
    this.layoutManager?.handleResizeTick();
  }

  private buildContainer(): void {
    const container = document.body.createDiv({
      cls: 'rp-inline-runner-container rp-runner-session-root',
    });
    this.containerEl = container;
    this.layoutManager = new InlineRunnerLayoutManager({
      containerEl: container,
      getSavedLayout: () => this.plugin.getInlineRunnerPosition(),
      saveLayout: (layout) => this.plugin.saveInlineRunnerPosition(layout),
      getOpenLayouts: () => this.plugin.getOpenInlineRunners().map((runner) =>
        runner.getAppliedLayout()),
    });
    // Preserve the established buildContainer()/layout test seam and make the
    // loading shell draggable before the session host replaces its contents.
    this.headerEl = container.createDiv({ cls: 'rp-runner-session-header' });
    this.layoutManager.enableDragging(this.headerEl);
  }

  private handleActiveLeafChange(): void {
    if (this.containerEl === null) return;
    if (this.sessionHost?.hasOpenChildModal() === true) return;

    const activeFile = this.app.workspace.getActiveFile();
    const isTargetActive = activeFile?.path === this.targetNote.path;
    let targetHasOpenLeaves = false;
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;
      if ('file' in view && view.file instanceof TFile && view.file.path === this.targetNote.path) {
        targetHasOpenLeaves = true;
      }
    });

    if (!targetHasOpenLeaves) {
      // A pending conclusion must remain reachable even after its note leaf closes.
      if (this.sessionHost?.hasUninsertedDraft()) {
        this.containerEl.removeClass('is-hidden');
        this.isHidden = false;
        return;
      }
      this.close();
      return;
    }
    if (isTargetActive) {
      if (this.isHidden) {
        this.containerEl.removeClass('is-hidden');
        this.isHidden = false;
      }
    } else if (!this.isHidden) {
      this.containerEl.addClass('is-hidden');
      this.isHidden = true;
    }
  }

  private handleKeydown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    // The shared host owns the whole keymap, Escape included (its close path
    // runs the uninserted-draft confirmation). The shell keeps a close fallback
    // for the window where the host is gone but the container still listens.
    if (this.sessionHost?.handleKeydown(event) === true) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
    }
  }
}
