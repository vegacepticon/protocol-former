import {
  ItemView,
  Notice,
  TFile,
  type EventRef,
  type WorkspaceLeaf,
} from 'obsidian';
import type RadiProtocolPlugin from '../main';
import { RunnerSessionHost } from './runner-session-host';
import { guardRunnerTabClose } from './runner-tab-close-guard';

export const SIDEBAR_RUNNER_VIEW_TYPE = 'radiprotocol-sidebar-runner';
export const SIDEBAR_RUNNER_LAUNCH_MARKER = 'radiprotocol-sidebar-runner-launch';

interface SidebarRunnerLaunchContext {
  protocolPath: string;
  targetNote: TFile;
  startNodeId?: string;
}

type SidebarRunnerEphemeralState = Record<string, unknown> & {
  [SIDEBAR_RUNNER_LAUNCH_MARKER]: true;
};

export function createSidebarRunnerEphemeralState(): SidebarRunnerEphemeralState {
  return { [SIDEBAR_RUNNER_LAUNCH_MARKER]: true };
}

/**
 * Transient right-sidebar shell for one RunnerSessionHost. The view owns only
 * workspace/chrome policy; protocol execution and target-note lifetime stay
 * in the shared host.
 */
export class SidebarRunnerView extends ItemView {
  private readonly plugin: RadiProtocolPlugin;

  /**
   * View-side ephemeral state store. Obsidian's WorkspaceLeaf delegates
   * getEphemeralState()/setEphemeralState() to the CURRENT view instance, and
   * the base View class implements both as no-ops (`{}` / empty). Without a
   * real override the one-shot launch marker passed to setViewState(state,
   * eState) never reaches this view, so every launch was treated as an
   * unmarked restore and the leaf detached itself. Storing the state on the
   * instance mirrors Obsidian's own views (e.g. MarkdownView).
   */
  private ephemeralState: Record<string, unknown> = {};

  private launchContext: SidebarRunnerLaunchContext | null = null;
  private sessionHost: RunnerSessionHost | null = null;
  private chromeEl: HTMLElement | null = null;
  private boundNoteEl: HTMLElement | null = null;
  private mismatchEl: HTMLElement | null = null;
  private focusNoteButtonEl: HTMLElement | null = null;
  private sessionEl: HTMLElement | null = null;
  private activeLeafEventRef: EventRef | null = null;
  private targetRenameEventRef: EventRef | null = null;
  private boundKeyHandler: ((event: KeyboardEvent) => void) | null = null;
  private restoreDetachTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private generation = 0;
  private initialized = false;
  private closeRequested = false;
  private closed = false;
  private removeTabCloseGuard: (() => void) | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: RadiProtocolPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return SIDEBAR_RUNNER_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.plugin.i18n.t('sidebarRunner.title');
  }

  getIcon(): string {
    return 'list-checks';
  }

  /** True once this view has closed (or is closing) its leaf. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** No protocol/session data is durable workspace state. */
  getState(): Record<string, unknown> {
    return {};
  }

  /**
   * Overrides of the base View no-ops. WorkspaceLeaf.getEphemeralState() /
   * WorkspaceLeaf.setEphemeralState() delegate here, so the one-shot launch
   * marker applied by setViewState(state, eState) is visible to
   * onOpen()/initialize() and can be consumed/cleared.
   */
  getEphemeralState(): Record<string, unknown> {
    return this.ephemeralState;
  }

  setEphemeralState(state: unknown): void {
    this.ephemeralState = (state ?? {}) as Record<string, unknown>;
  }

  async onOpen(): Promise<void> {
    this.closed = false;
    this.contentEl.empty();
    this.contentEl.addClass('rp-sidebar-runner-view');
    this.renderInitializing();

    if (!this.hasLaunchMarker()) {
      this.restoreDetachTimer = globalThis.setTimeout(() => {
        this.restoreDetachTimer = null;
        if (!this.initialized) this.requestClose();
      }, 0);
    }
  }

  /**
   * One-shot post-setViewState handoff. The launch marker is ephemeral and is
   * consumed before any protocol context is retained by this instance.
   */
  async initialize(context: SidebarRunnerLaunchContext): Promise<boolean> {
    if (
      this.closed
      || this.closeRequested
      || this.initialized
      || !this.hasLaunchMarker()
    ) {
      this.requestClose();
      return false;
    }

    this.consumeLaunchMarker();
    this.clearRestoreDetachTimer();
    const generation = ++this.generation;
    this.initialized = true;
    this.launchContext = context;
    this.renderShell();

    this.activeLeafEventRef = this.app.workspace.on('active-leaf-change', () => {
      this.updateMismatchChrome();
    });
    this.targetRenameEventRef = this.app.vault.on('rename', (file) => {
      if (
        file instanceof TFile
        && (file === context.targetNote || file.path === context.targetNote.path)
      ) this.updateBoundNoteChrome();
    });
    this.boundKeyHandler = (event) => this.handleKeydown(event);
    this.contentEl.addEventListener('keydown', this.boundKeyHandler);
    this.updateMismatchChrome();

    if (this.sessionEl === null) {
      this.requestClose();
      return false;
    }

    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const host = new RunnerSessionHost({
      app: this.app,
      protocolPath: context.protocolPath,
      targetNote: context.targetNote,
      startNodeId: context.startNodeId,
      protocolDocumentStore: this.plugin.protocolDocumentStore,
      protocolDocumentParser: this.plugin.protocolDocumentParser,
      snippetService: this.plugin.snippetService,
      getTextSeparator: () => this.plugin.settings.textSeparator,
      getSnippetFolderPath: () => this.plugin.settings.snippetFolderPath,
      isRunnerDraftEnabled: () => this.plugin.settings.enableRunnerDraft !== false,
      autoFocusOnMount: false,
      withTargetNoteLock: (path, operation) =>
        this.plugin['insertMutex'].runExclusive(path, operation),
      t,
      notify: (message) => new Notice(message),
      onRequestClose: () => this.requestClose(true),
    });
    this.sessionHost = host;
    const tabHeader = (this.leaf as WorkspaceLeaf & { tabHeaderEl?: HTMLElement }).tabHeaderEl;
    if (tabHeader !== undefined) {
      this.removeTabCloseGuard = guardRunnerTabClose(
        this.leaf, () => host.hasUninsertedDraft(), () => this.requestClose(), tabHeader.ownerDocument,
      );
    }

    let mounted: boolean;
    try {
      mounted = await host.mount(this.sessionEl);
    } catch (error) {
      console.error('[RadiProtocol] Sidebar runner host failed to mount', error);
      host.dispose();
      this.requestClose();
      return false;
    }
    if (!this.owns(generation) || this.sessionHost !== host) {
      host.dispose();
      return false;
    }
    if (!mounted) {
      this.requestClose();
      return false;
    }
    return true;
  }

  async onClose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.closeRequested = true;
    this.initialized = false;
    ++this.generation;

    // Free the note→runner registry slot so future launches for this note
    // create a fresh runner instead of revealing this closing leaf, and so
    // note-switch reveal no longer targets a dead view.
    if (this.launchContext !== null) {
      this.plugin.unregisterSidebarRunnerLeaf(this.launchContext.targetNote.path, this.leaf);
    }
    this.clearRestoreDetachTimer();

    this.removeTabCloseGuard?.();
    this.removeTabCloseGuard = null;
    if (this.boundKeyHandler !== null) {
      this.contentEl.removeEventListener('keydown', this.boundKeyHandler);
      this.boundKeyHandler = null;
    }
    if (this.activeLeafEventRef !== null) {
      this.app.workspace.offref(this.activeLeafEventRef);
      this.activeLeafEventRef = null;
    }
    if (this.targetRenameEventRef !== null) {
      this.app.vault.offref(this.targetRenameEventRef);
      this.targetRenameEventRef = null;
    }

    this.sessionHost?.dispose();
    this.sessionHost = null;
    this.clearLaunchMarker();
    this.launchContext = null;
    this.chromeEl = null;
    this.boundNoteEl = null;
    this.mismatchEl = null;
    this.focusNoteButtonEl = null;
    this.sessionEl = null;
    this.contentEl.removeClass('rp-sidebar-runner-view');
    this.contentEl.empty();
  }

  private renderInitializing(): void {
    this.contentEl.createEl('p', {
      cls: 'rp-sidebar-runner-initializing',
      text: this.plugin.i18n.t('sidebarRunner.initializing'),
    });
  }

  private renderShell(): void {
    this.contentEl.empty();
    const root = this.contentEl.createDiv({ cls: 'rp-sidebar-runner-shell' });
    this.chromeEl = root.createDiv({ cls: 'rp-sidebar-runner-chrome' });
    this.boundNoteEl = this.chromeEl.createDiv({ cls: 'rp-sidebar-runner-bound-note' });
    this.updateBoundNoteChrome();
    this.mismatchEl = this.chromeEl.createDiv({
      cls: 'rp-sidebar-runner-mismatch is-hidden',
      text: this.plugin.i18n.t('sidebarRunner.activeNoteMismatch'),
      attr: {
        role: 'status',
        'aria-live': 'polite',
      },
    });
    this.focusNoteButtonEl = this.chromeEl.createEl('button', {
      cls: 'rp-sidebar-runner-focus-note',
      text: this.plugin.i18n.t('sidebarRunner.focusNote'),
      attr: { type: 'button' },
    });
    this.focusNoteButtonEl.addEventListener('click', () => {
      void this.focusBoundNote();
    });

    this.sessionEl = root.createDiv({ cls: 'rp-sidebar-runner-session' });
  }

  private updateBoundNoteChrome(): void {
    if (this.boundNoteEl === null || this.launchContext === null) return;
    this.boundNoteEl.setText(this.plugin.i18n.t('sidebarRunner.boundNote', {
      path: this.launchContext.targetNote.path,
    }));
  }

  /**
   * Chrome noise policy: while the bound note itself is focused, the path
   * label, mismatch warning, and jump button carry no information, so the
   * whole chrome strip stays hidden. It reappears as soon as the active
   * note differs (or there is no active file).
   */
  private updateMismatchChrome(): void {
    if (this.mismatchEl === null || this.launchContext === null) return;
    const activeFile = this.app.workspace.getActiveFile();
    const mismatch = activeFile?.path !== this.launchContext.targetNote.path;
    this.mismatchEl.toggleClass('is-hidden', !mismatch);
    this.chromeEl?.toggleClass('is-hidden', !mismatch);
  }

  private async focusBoundNote(): Promise<void> {
    const targetNote = this.launchContext?.targetNote;
    if (targetNote === undefined) return;
    const generation = this.generation;

    const matchingLeaves: WorkspaceLeaf[] = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (matchingLeaves.length > 0) return;
      const view = leaf.view;
      if (
        'file' in view
        && view.file instanceof TFile
        && view.file.path === targetNote.path
      ) matchingLeaves.push(leaf);
    });

    const matchingLeaf = matchingLeaves[0];
    if (matchingLeaf !== undefined) {
      if (!this.owns(generation)) return;
      this.app.workspace.setActiveLeaf(matchingLeaf, { focus: true });
      await this.app.workspace.revealLeaf(matchingLeaf);
      return;
    }

    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(targetNote);
    if (!this.owns(generation)) return;
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  private owns(generation: number): boolean {
    return !this.closed
      && !this.closeRequested
      && this.initialized
      && generation === this.generation;
  }

  private handleKeydown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
      return;
    }
    // Escape and every runner shortcut resolve in the shared host; the shell
    // closes the leaf itself only when the host is missing or not mounted yet.
    if (this.sessionHost?.handleKeydown(event) === true) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.requestClose();
    }
  }

  private requestClose(force = false): void {
    if (this.closeRequested) return;
    if (!force && this.sessionHost?.hasUninsertedDraft()) {
      this.sessionHost.requestClose();
      return;
    }
    this.closeRequested = true;
    this.leaf.detach();
  }

  private hasLaunchMarker(): boolean {
    return this.leaf.getEphemeralState()?.[SIDEBAR_RUNNER_LAUNCH_MARKER] === true;
  }

  private consumeLaunchMarker(): void {
    this.clearLaunchMarker();
  }

  private clearLaunchMarker(): void {
    const state = this.leaf.getEphemeralState();
    if (state === null || typeof state !== 'object') return;
    const nextState = { ...(state as Record<string, unknown>) };
    if (nextState[SIDEBAR_RUNNER_LAUNCH_MARKER] === undefined) return;
    delete nextState[SIDEBAR_RUNNER_LAUNCH_MARKER];
    this.leaf.setEphemeralState(nextState);
  }

  private clearRestoreDetachTimer(): void {
    if (this.restoreDetachTimer === null) return;
    globalThis.clearTimeout(this.restoreDetachTimer);
    this.restoreDetachTimer = null;
  }
}
