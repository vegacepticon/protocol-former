import { beforeEach, describe, expect, it, vi } from 'vitest';

const hostState = vi.hoisted(() => ({
  mountResult: true,
  requestCloseDuringMount: false,
  /** Mirrors the real host: true = keymap consumed, false = host declined. */
  handleKeydownResult: true,
  instances: [] as Array<{
    options: Record<string, any>;
    root: unknown;
    disposed: boolean;
    disposeCalls: number;
    handleKeydown: ReturnType<typeof vi.fn>;
    dirty: boolean;
    requestClose: ReturnType<typeof vi.fn<() => void>>;
  }>,
}));

vi.mock('../../views/runner-session-host', () => ({
  RunnerSessionHost: class {
    private readonly instance: (typeof hostState.instances)[number];

    constructor(options: Record<string, any>) {
      this.instance = {
        options,
        root: null,
        disposed: false,
        disposeCalls: 0,
        handleKeydown: vi.fn(() => true),
        dirty: false,
        requestClose: vi.fn(),
      };
      hostState.instances.push(this.instance);
    }

    async mount(root: unknown): Promise<boolean> {
      this.instance.root = root;
      if (hostState.requestCloseDuringMount) this.instance.options.onRequestClose();
      return hostState.mountResult;
    }

    dispose(): void {
      if (this.instance.disposed) return;
      this.instance.disposed = true;
      this.instance.disposeCalls += 1;
    }

    hasUninsertedDraft(): boolean { return this.instance.dirty; }
    requestClose(): void { this.instance.requestClose(); }

    handleKeydown(event: KeyboardEvent): boolean {
      Reflect.apply(
        this.instance.handleKeydown as unknown as (...args: unknown[]) => unknown,
        undefined,
        [event],
      );
      return hostState.handleKeydownResult;
    }
  },
}));

import { TFile, WorkspaceLeaf } from 'obsidian';
import {
  SidebarRunnerView,
  SIDEBAR_RUNNER_LAUNCH_MARKER,
  createSidebarRunnerEphemeralState,
} from '../../views/sidebar-runner-view';

type TestLeaf = any;

/**
 * Real Obsidian delegates WorkspaceLeaf.getEphemeralState()/setEphemeralState()
 * to the CURRENT view instance (base View is a no-op). The shared mock stores
 * leaf-side state instead, which masks the launch-marker handoff bug. This
 * subclass reproduces the real delegation semantics for the sidebar suite.
 */
class DelegatingLeaf extends (WorkspaceLeaf as any) {
  constructor(app: any) {
    super(app);
  }

  getEphemeralState(): Record<string, unknown> {
    const viewState = this.view?.getEphemeralState?.();
    return viewState !== undefined && viewState !== null
      ? viewState
      : {};
  }

  setEphemeralState(state: unknown): void {
    this.view?.setEphemeralState?.(state);
  }
}

type WorkspaceEventRef = {
  event: string;
  handler: (...args: any[]) => void;
};

function translator(key: string, params?: Record<string, string>): string {
  const copy: Record<string, string> = {
    'sidebarRunner.title': 'Protocol runner',
    'sidebarRunner.boundNote': `Bound note: ${params?.path ?? ''}`,
    'sidebarRunner.activeNoteMismatch': 'The active note differs.',
    'sidebarRunner.focusNote': 'Focus note',
    'sidebarRunner.initializing': 'Initializing protocol runner',
  };
  return copy[key] ?? key;
}

function makeEnvironment(initialActivePath = 'notes/target.md') {
  let activeFile: TFile | null = new (TFile as any)(initialActivePath);
  const handlers = new Map<string, Array<(...args: any[]) => void>>();
  const vaultHandlers = new Map<string, Array<(...args: any[]) => void>>();
  const allLeaves: TestLeaf[] = [];
  const activated: TestLeaf[] = [];
  const revealed: TestLeaf[] = [];
  const openedLeaves: TestLeaf[] = [];

  const app: any = {
    vault: {
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        vaultHandlers.set(event, [...(vaultHandlers.get(event) ?? []), handler]);
        return { event, handler } satisfies WorkspaceEventRef;
      }),
      offref: vi.fn((ref: WorkspaceEventRef) => {
        vaultHandlers.set(
          ref.event,
          (vaultHandlers.get(ref.event) ?? []).filter(handler => handler !== ref.handler),
        );
      }),
    },
    workspace: {
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
        return { event, handler } satisfies WorkspaceEventRef;
      }),
      offref: vi.fn((ref: WorkspaceEventRef) => {
        handlers.set(
          ref.event,
          (handlers.get(ref.event) ?? []).filter(handler => handler !== ref.handler),
        );
      }),
      getActiveFile: vi.fn(() => activeFile),
      iterateAllLeaves: vi.fn((callback: (leaf: TestLeaf) => void) => {
        for (const leaf of allLeaves) callback(leaf);
      }),
      getLeaf: vi.fn(() => {
        const leaf = new (WorkspaceLeaf as any)(app) as TestLeaf;
        openedLeaves.push(leaf);
        allLeaves.push(leaf);
        return leaf;
      }),
      setActiveLeaf: vi.fn((leaf: TestLeaf) => {
        activated.push(leaf);
        const file = (leaf.view as { file?: TFile }).file;
        if (file instanceof TFile) activeFile = file;
      }),
      revealLeaf: vi.fn(async (leaf: WorkspaceLeaf) => {
        revealed.push(leaf);
      }),
    },
  };
  const plugin: any = {
    app,
    i18n: { t: translator },
    settings: {
      textSeparator: 'newline',
      snippetFolderPath: 'Snippets',
    },
    protocolDocumentStore: {},
    protocolDocumentParser: {},
    snippetService: {},
    insertMutex: { runExclusive: vi.fn(async (_path: string, operation: () => Promise<void>) => operation()) },
    sidebarRunnersByNote: new Map<string, WorkspaceLeaf>(),
    unregisterSidebarRunnerLeaf(notePath: string, leaf: WorkspaceLeaf): void {
      if (plugin.sidebarRunnersByNote.get(notePath) === leaf) plugin.sidebarRunnersByNote.delete(notePath);
    },
  };

  return {
    app,
    plugin,
    allLeaves,
    activated,
    revealed,
    openedLeaves,
    setActiveFile(file: TFile | null): void {
      activeFile = file;
    },
    emit(event: string): void {
      for (const handler of handlers.get(event) ?? []) handler(null);
    },
    emitVault(event: string, ...args: unknown[]): void {
      for (const handler of vaultHandlers.get(event) ?? []) handler(...args);
    },
    handlerCount(event: string): number {
      return handlers.get(event)?.length ?? 0;
    },
    vaultHandlerCount(event: string): number {
      return vaultHandlers.get(event)?.length ?? 0;
    },
  };
}

async function openMarkedView(
  environment = makeEnvironment(),
  context: {
    protocolPath: string;
    targetNote: TFile;
    startNodeId?: string;
  } = {
    protocolPath: 'Protocols/test.rp.json',
    targetNote: new (TFile as any)('notes/target.md'),
  },
) {
  const leaf = new DelegatingLeaf(environment.app) as TestLeaf;
  const view = new SidebarRunnerView(leaf, environment.plugin);
  leaf.view = view;
  environment.allLeaves.push(leaf);
  // Real Obsidian ordering: onOpen runs while setViewState creates the view,
  // THEN the eState argument is applied to the view, then main.ts calls
  // initialize(). Mirror that here so the marker handoff is exercised.
  await view.onOpen();
  leaf.setEphemeralState(createSidebarRunnerEphemeralState());
  const initialized = await view.initialize(context);
  return { environment, leaf, view, context, initialized };
}

function keyboardEvent(
  key: string,
  target: { tagName: string } | null = null,
): KeyboardEvent {
  return {
    type: 'keydown',
    key,
    target,
    ctrlKey: key === 'ArrowLeft' || key === 'ArrowRight',
    altKey: false,
    preventDefault: vi.fn(),
  } as unknown as KeyboardEvent;
}

beforeEach(() => {
  hostState.mountResult = true;
  hostState.requestCloseDuringMount = false;
  hostState.handleKeydownResult = true;
  hostState.instances.length = 0;
});

describe('SidebarRunnerView transient initialization', () => {
  it('consumes a marked launch, keeps durable state empty, and mounts one approved host', async () => {
    const context = {
      protocolPath: 'Protocols/chest.rp.json',
      targetNote: new (TFile as any)('reports/chest.md'),
      startNodeId: 'question-2',
    };
    const harness = await openMarkedView(makeEnvironment(context.targetNote.path), context);

    expect(harness.initialized).toBe(true);
    expect(harness.view.getState()).toEqual({});
    expect(harness.leaf.getEphemeralState()).toEqual({});
    expect(hostState.instances).toHaveLength(1);
    expect(hostState.instances[0]!.options).toMatchObject(context);
    expect(hostState.instances[0]!.root).toBe(
      harness.view.contentEl.querySelector('.rp-sidebar-runner-session'),
    );
  });

  it('accepts the launch marker handed off through the view after onOpen (real Obsidian delegation)', async () => {
    // Real Obsidian: WorkspaceLeaf.setViewState(state, eState) creates the
    // view (onOpen runs), then applies eState via view.setEphemeralState, then
    // main.ts calls initialize(). With the view-side ephemeral store, the
    // marker must be visible to initialize even though onOpen never saw it.
    const environment = makeEnvironment();
    const leaf = new DelegatingLeaf(environment.app) as TestLeaf;
    const view = new SidebarRunnerView(leaf, environment.plugin);
    leaf.view = view;

    await view.onOpen();
    expect(view.getEphemeralState()).toEqual({});

    // setViewState tail: eState reaches the view instance.
    leaf.setEphemeralState(createSidebarRunnerEphemeralState());
    expect(view.getEphemeralState()).toEqual({ [SIDEBAR_RUNNER_LAUNCH_MARKER]: true });

    const context = {
      protocolPath: 'Protocols/chest.rp.json',
      targetNote: new (TFile as any)('reports/chest.md'),
    };
    const initialized = await view.initialize(context);
    expect(initialized).toBe(true);
    // The one-shot marker was consumed and is no longer visible anywhere.
    expect(view.getEphemeralState()).toEqual({});
    expect(hostState.instances).toHaveLength(1);
    expect(hostState.instances[0]!.options).toMatchObject(context);
  });

  it('detaches an unmarked restored view on the scheduled turn', async () => {
    vi.useFakeTimers();
    try {
      const environment = makeEnvironment();
      const leaf = new (WorkspaceLeaf as any)(environment.app) as TestLeaf;
      const view = new SidebarRunnerView(leaf, environment.plugin);
      leaf.view = view;

      await view.onOpen();
      expect(leaf.detachCalls).toBe(0);
      vi.advanceTimersByTime(0);

      expect(leaf.detachCalls).toBe(1);
      expect(hostState.instances).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SidebarRunnerView bound-note chrome and focus policy', () => {
  it('shows bound-note chrome only while focus is off the bound note', async () => {
    const harness = await openMarkedView();
    const chrome = harness.view.contentEl.querySelector('.rp-sidebar-runner-chrome')!;
    const bound = harness.view.contentEl.querySelector('.rp-sidebar-runner-bound-note')!;
    const mismatch = harness.view.contentEl.querySelector('.rp-sidebar-runner-mismatch')!;
    const focusButton = harness.view.contentEl.querySelector('.rp-sidebar-runner-focus-note')!;

    expect(bound.textContent).toBe('Bound note: notes/target.md');
    expect(mismatch.getAttribute('role')).toBe('status');
    expect(mismatch.getAttribute('aria-live')).toBe('polite');
    // Launched from the bound note: label, warning, and jump button stay quiet.
    expect(chrome.hasClass('is-hidden')).toBe(true);
    expect(mismatch.hasClass('is-hidden')).toBe(true);

    harness.environment.setActiveFile(new (TFile as any)('notes/other.md'));
    harness.environment.emit('active-leaf-change');
    expect(chrome.hasClass('is-hidden')).toBe(false);
    expect(mismatch.hasClass('is-hidden')).toBe(false);
    expect(focusButton.hasClass('is-hidden')).toBe(false);
    expect(hostState.instances).toHaveLength(1);
    expect(hostState.instances[0]!.disposed).toBe(false);

    harness.environment.setActiveFile(harness.context.targetNote);
    harness.environment.emit('active-leaf-change');
    expect(chrome.hasClass('is-hidden')).toBe(true);
    expect(mismatch.hasClass('is-hidden')).toBe(true);
  });

  it('updates the bound-note path on rename even while the chrome is hidden', async () => {
    const harness = await openMarkedView();
    const bound = harness.view.contentEl.querySelector('.rp-sidebar-runner-bound-note')!;

    const oldPath = harness.context.targetNote.path;
    harness.context.targetNote.path = 'notes/renamed.md';
    harness.environment.emitVault('rename', harness.context.targetNote, oldPath);
    expect(bound.textContent).toBe('Bound note: notes/renamed.md');
    expect(hostState.instances[0]!.options.targetNote).toBe(harness.context.targetNote);
  });

  it('focuses an existing file leaf without retargeting the runner', async () => {
    const harness = await openMarkedView(makeEnvironment('notes/other.md'));
    const noteLeaf = new (WorkspaceLeaf as any)(harness.environment.app) as TestLeaf;
    noteLeaf.view = { file: harness.context.targetNote };
    harness.environment.allLeaves.push(noteLeaf);

    (harness.view.contentEl.querySelector('.rp-sidebar-runner-focus-note') as any).click();
    await Promise.resolve();

    expect(harness.environment.app.workspace.getLeaf).not.toHaveBeenCalled();
    expect(harness.environment.activated).toEqual([noteLeaf]);
    expect(harness.environment.revealed).toEqual([noteLeaf]);
    expect(hostState.instances[0]!.options.targetNote).toBe(harness.context.targetNote);
  });

  it('suppresses post-open focus effects when the sidebar closes during openFile', async () => {
    const harness = await openMarkedView(makeEnvironment('notes/other.md'));
    let resolveOpen!: () => void;
    const pendingOpen = new Promise<void>((resolve) => { resolveOpen = resolve; });
    const openingLeaf = new (WorkspaceLeaf as any)(harness.environment.app) as TestLeaf;
    openingLeaf.openFile = vi.fn(() => pendingOpen);
    harness.environment.app.workspace.getLeaf.mockReturnValueOnce(openingLeaf);

    (harness.view.contentEl.querySelector('.rp-sidebar-runner-focus-note') as any).click();
    await Promise.resolve();
    await harness.view.onClose();
    resolveOpen();
    await Promise.resolve();
    await Promise.resolve();

    expect(openingLeaf.openFile).toHaveBeenCalledWith(harness.context.targetNote);
    expect(harness.environment.activated).toEqual([]);
    expect(harness.environment.revealed).toEqual([]);
  });

  it('opens the bound file in a normal leaf when no existing file leaf matches', async () => {
    const harness = await openMarkedView(makeEnvironment('notes/other.md'));

    (harness.view.contentEl.querySelector('.rp-sidebar-runner-focus-note') as any).click();
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.environment.openedLeaves).toHaveLength(1);
    const opened = harness.environment.openedLeaves[0]!;
    expect(opened.openedFile).toBe(harness.context.targetNote);
    expect(harness.environment.activated).toEqual([opened]);
    expect(harness.environment.revealed).toEqual([opened]);
    expect(hostState.instances[0]!.options.targetNote).toBe(harness.context.targetNote);
  });
});

describe('SidebarRunnerView close and keyboard policy', () => {
  it('routes dirty Escape to confirmation and detaches only after the host approves', async () => {
    const harness = await openMarkedView();
    const host = hostState.instances[0]!;
    host.dirty = true;
    // The shell fallback runs when the shared host declines the key (for
    // example before its first render); the closed-loop path is covered by the
    // "host handles Escape" case below.
    hostState.handleKeydownResult = false;
    harness.view.contentEl.dispatchEvent(keyboardEvent('Escape') as any);
    expect(host.requestClose).toHaveBeenCalledOnce();
    expect(harness.leaf.detachCalls).toBe(0);
    host.options.onRequestClose();
    expect(harness.leaf.detachCalls).toBe(1);
    expect(host.disposeCalls).toBe(1);
  });

  it.each(['completion', 'target deletion'])(
    'detaches exactly once when the host requests close for %s',
    async () => {
      const harness = await openMarkedView();
      const requestClose = hostState.instances[0]!.options.onRequestClose as () => void;

      requestClose();
      requestClose();

      expect(harness.leaf.detachCalls).toBe(1);
      expect(hostState.instances[0]!.disposeCalls).toBe(1);
    },
  );

  it('detaches once when bootstrap requests close and mount reports failure', async () => {
    hostState.mountResult = false;
    hostState.requestCloseDuringMount = true;

    const harness = await openMarkedView();

    expect(harness.initialized).toBe(false);
    expect(harness.leaf.detachCalls).toBe(1);
    expect(hostState.instances[0]!.disposeCalls).toBe(1);
  });

  it('delegates Back/Redo keys, detaches on non-input Escape, and ignores input Escape', async () => {
    const harness = await openMarkedView();
    hostState.handleKeydownResult = false;
    const back = keyboardEvent('ArrowLeft');
    const redo = keyboardEvent('ArrowRight');
    harness.view.contentEl.dispatchEvent(back as any);
    harness.view.contentEl.dispatchEvent(redo as any);
    expect(hostState.instances[0]!.handleKeydown).toHaveBeenNthCalledWith(1, back);
    expect(hostState.instances[0]!.handleKeydown).toHaveBeenNthCalledWith(2, redo);

    const inputEscape = keyboardEvent('Escape', { tagName: 'TEXTAREA' });
    harness.view.contentEl.dispatchEvent(inputEscape as any);
    expect(harness.leaf.detachCalls).toBe(0);

    const escape = keyboardEvent('Escape');
    harness.view.contentEl.dispatchEvent(escape as any);
    expect(escape.preventDefault).toHaveBeenCalledTimes(1);
    expect(harness.leaf.detachCalls).toBe(1);
  });

  it('leaves Escape entirely to the host when the shared keymap consumes it', async () => {
    const harness = await openMarkedView();
    const escape = keyboardEvent('Escape');
    harness.view.contentEl.dispatchEvent(escape as any);

    expect(hostState.instances[0]!.handleKeydown).toHaveBeenCalledWith(escape);
    // The host owns requestClose() -> onRequestClose() -> leaf detach, so the
    // shell must neither preventDefault nor detach on its own.
    expect(escape.preventDefault).not.toHaveBeenCalled();
    expect(harness.leaf.detachCalls).toBe(0);
  });

  it('cleans host, timer, event, keyboard, marker, DOM, and context idempotently', async () => {
    const harness = await openMarkedView();
    expect(harness.environment.handlerCount('active-leaf-change')).toBe(1);
    expect(harness.environment.vaultHandlerCount('rename')).toBe(1);

    await harness.view.onClose();
    await harness.view.onClose();

    expect(hostState.instances[0]!.disposeCalls).toBe(1);
    expect(harness.environment.handlerCount('active-leaf-change')).toBe(0);
    expect(harness.environment.vaultHandlerCount('rename')).toBe(0);
    expect(harness.view.contentEl.children).toHaveLength(0);
    expect(harness.view.contentEl.hasClass('rp-sidebar-runner-view')).toBe(false);
    expect((harness.view as any).launchContext).toBeNull();
    expect((harness.view as any).restoreDetachTimer).toBeNull();
    expect(harness.leaf.getEphemeralState()).toEqual({});

    const afterClose = keyboardEvent('ArrowLeft');
    harness.view.contentEl.dispatchEvent(afterClose as any);
    expect(hostState.instances[0]!.handleKeydown).not.toHaveBeenCalled();
  });

  it('keeps two leaf/view contexts and hosts isolated', async () => {
    const environment = makeEnvironment('notes/one.md');
    const firstContext = {
      protocolPath: 'Protocols/one.rp.json',
      targetNote: new (TFile as any)('notes/one.md'),
      startNodeId: 'one-start',
    };
    const secondContext = {
      protocolPath: 'Protocols/two.rp.json',
      targetNote: new (TFile as any)('notes/two.md'),
      startNodeId: 'two-start',
    };

    const first = await openMarkedView(environment, firstContext);
    const second = await openMarkedView(environment, secondContext);

    expect(first.leaf).not.toBe(second.leaf);
    expect(hostState.instances).toHaveLength(2);
    expect(hostState.instances[0]!.options).toMatchObject(firstContext);
    expect(hostState.instances[1]!.options).toMatchObject(secondContext);
    expect(hostState.instances[0]!.root).not.toBe(hostState.instances[1]!.root);

    hostState.instances[0]!.options.onRequestClose();
    expect(first.leaf.detachCalls).toBe(1);
    expect(second.leaf.detachCalls).toBe(0);
    expect(hostState.instances[1]!.disposed).toBe(false);
  });
});
