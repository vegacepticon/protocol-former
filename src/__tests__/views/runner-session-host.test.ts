import { beforeEach, describe, expect, it, vi } from 'vitest';
const confirmations = vi.hoisted(() => [] as Array<{
  resolve(value: string): void;
  options: Record<string, unknown>;
  close: ReturnType<typeof vi.fn>;
}>);
vi.mock('../../views/confirm-modal', () => ({
  ConfirmModal: class {
    result: Promise<string>;
    close: ReturnType<typeof vi.fn>;
    constructor(_app: unknown, options: Record<string, unknown>) {
      let resolve!: (value: string) => void;
      this.result = new Promise((done) => { resolve = done; });
      this.close = vi.fn(() => resolve('cancel'));
      confirmations.push({ resolve, options, close: this.close });
    }
    open(): void {}
  },
}));
import {
  deferred,
  getFillModalInstances,
  getPickerMockInstances,
  makeBaseApp,
  makeBasePlugin,
  makeEl,
  resetFillModalInstances,
  resetPickerMockInstances,
  type MockEl,
} from '../runner/runner-renderer-host-fixtures';

vi.mock('obsidian', async () => {
  const fixtures = await import('../runner/runner-renderer-host-fixtures');
  return fixtures.createObsidianModuleMock();
});
vi.mock('../../views/snippet-tree-picker', async () => {
  const fixtures = await import('../runner/runner-renderer-host-fixtures');
  return fixtures.createSnippetTreePickerMock();
});
vi.mock('../../views/snippet-fill-in-modal', async () => {
  const fixtures = await import('../runner/runner-renderer-host-fixtures');
  return fixtures.createSnippetFillInModalMock();
});

import { TFile } from 'obsidian';
import type { ProtocolGraph, RPEdge, RPNode } from '../../graph/graph-model';
import { ProtocolRunner } from '../../runner/protocol-runner';
import { RunnerSessionHost, type RunnerSessionHostOptions } from '../../views/runner-session-host';
import { WriteMutex } from '../../utils/write-mutex';

function graph(nodes: RPNode[], edges: RPEdge[]): ProtocolGraph {
  const adjacency = new Map<string, string[]>();
  const reverseAdjacency = new Map<string, string[]>();
  for (const edge of edges) {
    adjacency.set(edge.fromNodeId, [...(adjacency.get(edge.fromNodeId) ?? []), edge.toNodeId]);
    reverseAdjacency.set(edge.toNodeId, [...(reverseAdjacency.get(edge.toNodeId) ?? []), edge.fromNodeId]);
  }
  return {
    canvasFilePath: 'Protocols/test.rp.json',
    nodes: new Map(nodes.map((node) => [node.id, node])),
    edges,
    adjacency,
    reverseAdjacency,
    startNodeId: 'start',
  };
}

const base = { x: 0, y: 0, width: 100, height: 60 };

function answerGraph(): ProtocolGraph {
  return graph([
    { ...base, id: 'start', kind: 'start' },
    { ...base, id: 'seed', kind: 'text-block', content: 'Seed' },
    { ...base, id: 'question', kind: 'question', questionText: 'Choose' },
    { ...base, id: 'answer', kind: 'answer', answerText: 'Finding' },
  ], [
    { id: 'start-seed', fromNodeId: 'start', toNodeId: 'seed' },
    { id: 'seed-question', fromNodeId: 'seed', toNodeId: 'question' },
    { id: 'question-answer', fromNodeId: 'question', toNodeId: 'answer' },
  ]);
}

function answerWithDownstreamTextGraph(answerText = 'Finding'): ProtocolGraph {
  return graph([
    { ...base, id: 'start', kind: 'start' },
    { ...base, id: 'question', kind: 'question', questionText: 'Choose' },
    { ...base, id: 'answer', kind: 'answer', answerText },
    { ...base, id: 'tail', kind: 'text-block', content: 'Tail' },
  ], [
    { id: 'start-question', fromNodeId: 'start', toNodeId: 'question' },
    { id: 'question-answer', fromNodeId: 'question', toNodeId: 'answer' },
    { id: 'answer-tail', fromNodeId: 'answer', toNodeId: 'tail' },
  ]);
}

function freeTextDraftGraph(includePreset = false): ProtocolGraph {
  return graph([
    { ...base, id: 'start', kind: 'start' },
    { ...base, id: 'question', kind: 'question', questionText: 'Describe' },
    {
      ...base,
      id: 'free-a',
      kind: 'answer',
      answerText: 'First free-text prompt',
      freeText: true,
    },
    {
      ...base,
      id: 'free-b',
      kind: 'answer',
      answerText: 'Second free-text prompt',
      freeText: true,
    },
    ...(includePreset
      ? [{ ...base, id: 'preset', kind: 'answer' as const, answerText: 'Preset' }]
      : []),
  ], [
    { id: 'start-question', fromNodeId: 'start', toNodeId: 'question' },
    { id: 'question-free-a', fromNodeId: 'question', toNodeId: 'free-a' },
    { id: 'question-free-b', fromNodeId: 'question', toNodeId: 'free-b' },
    ...(includePreset
      ? [{ id: 'question-preset', fromNodeId: 'question', toNodeId: 'preset' }]
      : []),
  ]);
}

function freeTextWithDownstreamGraph(): ProtocolGraph {
  return graph([
    { ...base, id: 'start', kind: 'start' },
    { ...base, id: 'question', kind: 'question', questionText: 'Describe' },
    {
      ...base,
      id: 'free',
      kind: 'answer',
      answerText: 'Authored prompt only',
      freeText: true,
      radiprotocol_separator: 'space',
    },
    { ...base, id: 'tail', kind: 'text-block', content: 'Tail' },
  ], [
    { id: 'start-question', fromNodeId: 'start', toNodeId: 'question' },
    { id: 'question-free', fromNodeId: 'question', toNodeId: 'free' },
    { id: 'free-tail', fromNodeId: 'free', toNodeId: 'tail' },
  ]);
}

function freeTextMixedGraph(): ProtocolGraph {
  return graph([
    { ...base, id: 'start', kind: 'start' },
    { ...base, id: 'question', kind: 'question', questionText: 'Describe' },
    {
      ...base,
      id: 'free',
      kind: 'answer',
      answerText: 'Free-text prompt',
      freeText: true,
    },
    { ...base, id: 'preset', kind: 'answer', answerText: 'Preset' },
  ], [
    { id: 'start-question', fromNodeId: 'start', toNodeId: 'question' },
    { id: 'question-free', fromNodeId: 'question', toNodeId: 'free' },
    { id: 'question-preset', fromNodeId: 'question', toNodeId: 'preset' },
  ]);
}

function loopGraph(): ProtocolGraph {
  return graph([
    { ...base, id: 'start', kind: 'start' },
    { ...base, id: 'loop', kind: 'question', questionText: 'Repeat?', loop: true },
    { ...base, id: 'body', kind: 'answer', answerText: 'Body' },
    { ...base, id: 'end', kind: 'text-block', content: 'End' },
  ], [
    { id: 'start-loop', fromNodeId: 'start', toNodeId: 'loop' },
    { id: 'loop-body', fromNodeId: 'loop', toNodeId: 'body' },
    { id: 'body-loop', fromNodeId: 'body', toNodeId: 'loop' },
    { id: 'loop-exit', fromNodeId: 'loop', toNodeId: 'end', label: 'Finish', isLoopExit: true },
  ]);
}

// BFS hop distances are non-monotonic on loop-authored protocols: «q3» sits at
// hop 2 (shortcut q1→q3) while the real walk reaches it AFTER «q2» (hop 3), so
// the raw percent would drop 74 → 50 mid-walk and visibly shrink the bar.
function progressShrinkGraph(): ProtocolGraph {
  return graph([
    { ...base, id: 'start', kind: 'start' },
    { ...base, id: 'q1', kind: 'question', questionText: 'First?' },
    { ...base, id: 'a1', kind: 'answer', answerText: 'A1' },
    { ...base, id: 'q2', kind: 'question', questionText: 'Second?' },
    { ...base, id: 'a2', kind: 'answer', answerText: 'A2' },
    { ...base, id: 'q3', kind: 'question', questionText: 'Last?' },
    { ...base, id: 'a3', kind: 'answer', answerText: 'A3' },
  ], [
    { id: 'start-q1', fromNodeId: 'start', toNodeId: 'q1' },
    { id: 'q1-a1', fromNodeId: 'q1', toNodeId: 'a1' },
    { id: 'a1-q2', fromNodeId: 'a1', toNodeId: 'q2' },
    { id: 'q2-a2', fromNodeId: 'q2', toNodeId: 'a2' },
    { id: 'a2-q3', fromNodeId: 'a2', toNodeId: 'q3' },
    { id: 'q1-q3', fromNodeId: 'q1', toNodeId: 'q3', label: 'shortcut' },
    { id: 'q3-a3', fromNodeId: 'q3', toNodeId: 'a3' },
  ]);
}

function snippetGraph(fileBound: boolean): ProtocolGraph {
  return graph([
    { ...base, id: 'start', kind: 'start' },
    {
      ...base,
      id: 'snippet',
      kind: 'snippet',
      ...(fileBound ? { radiprotocol_snippetPath: 'report.md' } : { subfolderPath: 'Chest' }),
    },
  ], [
    { id: 'start-snippet', fromNodeId: 'start', toNodeId: 'snippet' },
  ]);
}

interface Harness {
  host: RunnerSessionHost;
  root: MockEl;
  app: ReturnType<typeof makeBaseApp>;
  plugin: ReturnType<typeof makeBasePlugin>;
  protocolFile: TFile;
  targetNote: TFile;
  onRequestClose: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  withTargetNoteLock: ReturnType<typeof vi.fn>;
}

function makeFile(path: string): TFile {
  return Object.assign(new TFile(), { path });
}

function harness(runtimeGraph: ProtocolGraph, rawDocument = '{}', enableDraft = false): Harness {
  const plugin = makeBasePlugin();
  const app = makeBaseApp(plugin);
  const protocolFile = makeFile('Protocols/test.rp.json');
  const targetNote = makeFile('notes/target.md');
  app.vault.getAbstractFileByPath.mockImplementation((path: string) => {
    if (path === protocolFile.path) return protocolFile;
    if (path === 'Snippets/report.md') return makeFile(path);
    return null;
  });
  app.vault.read.mockImplementation(async (file: { path: string }) =>
    file.path === protocolFile.path ? rawDocument : 'Seed\n');
  plugin.protocolDocumentParser.parse.mockReturnValue({ success: true, graph: runtimeGraph });
  const onRequestClose = vi.fn();
  const notify = vi.fn();
  const withTargetNoteLock = vi.fn(async (_path: string, operation: () => Promise<void>) => operation());
  const options: RunnerSessionHostOptions = {
    app: app as any,
    protocolPath: protocolFile.path,
    targetNote,
    protocolDocumentStore: plugin.protocolDocumentStore as any,
    protocolDocumentParser: plugin.protocolDocumentParser as any,
    snippetService: plugin.snippetService as any,
    getTextSeparator: () => 'newline',
    getSnippetFolderPath: () => 'Snippets',
    isRunnerDraftEnabled: () => enableDraft,
    withTargetNoteLock,
    t: plugin.i18n.t.bind(plugin.i18n),
    notify,
    onRequestClose,
  };
  return {
    host: new RunnerSessionHost(options),
    root: makeEl('div'),
    app,
    plugin,
    protocolFile,
    targetNote,
    onRequestClose,
    notify,
    withTargetNoteLock,
  };
}

async function flushMicrotasks(turns = 8): Promise<void> {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
}

beforeEach(() => {
  confirmations.length = 0;
  resetFillModalInstances();
  resetPickerMockInstances();
});

describe('RunnerSessionHost conclusion draft', () => {
  function typeDraft(h: Harness, text: string): MockEl {
    const area = h.root.querySelector('.rp-runner-draft')!.querySelector('textarea')!;
    area.value = text;
    area.dispatchEvent({ type: 'input' });
    return area;
  }

  function bindEditor(h: Harness) {
    let text = 'ABCDEF';
    let cursor = { line: 0, ch: 3 };
    const editor = {
      getValue: () => text,
      getCursor: vi.fn(() => cursor),
      posToOffset: (pos: { line: number; ch: number }) =>
        text.split('\n').slice(0, pos.line).reduce((total, line) => total + line.length + 1, 0) + pos.ch,
      offsetToPos: (offset: number) => {
        const lines = text.slice(0, offset).split('\n');
        return { line: lines.length - 1, ch: lines.at(-1)!.length };
      },
      replaceRange: vi.fn((inserted: string, pos: { line: number; ch: number }) => {
        const offset = editor.posToOffset(pos);
        text = text.slice(0, offset) + inserted + text.slice(offset);
      }),
      setCursor: vi.fn((pos: { line: number; ch: number }) => { cursor = pos; }),
    };
    const save = vi.fn(async () => {});
    h.app.workspace.iterateAllLeaves.mockImplementation((callback: any) => callback({
      view: { file: h.targetNote, editor, getMode: () => 'source', save },
    }));
    return { editor, save, getText: () => text };
  }

  async function insert(h: Harness): Promise<void> {
    await (h.host as any).insertConclusionDraft();
  }

  it('can be disabled and stays below the answer zone when enabled', async () => {
    const disabled = harness(answerGraph());
    await disabled.host.mount(disabled.root as unknown as HTMLElement);
    expect(disabled.root.querySelector('.rp-runner-draft')).toBeNull();
    disabled.host.dispose();
    const h = harness(answerGraph(), '{}', true);
    await h.host.mount(h.root as unknown as HTMLElement);
    const draft = h.root.querySelector('.rp-runner-draft-container')!;
    expect(h.root.children.indexOf(draft)).toBeGreaterThan(h.root.children.indexOf(h.root.querySelector('.rp-runner-session-actions')!));
    expect(h.host.hasUninsertedDraft()).toBe(false);
    h.host.dispose();
  });

  it('inserts all text including pending input at the bound editor cursor, retaining it for repeat insertion', async () => {
    const h = harness(answerGraph(), '{}', true);
    const bound = bindEditor(h);
    await h.host.mount(h.root as unknown as HTMLElement);
    typeDraft(h, 'Line one\nLine two');
    expect(h.host.hasUninsertedDraft()).toBe(true);
    await insert(h);
    expect(bound.getText()).toBe('ABCLine one\nLine twoDEF');
    expect(bound.editor.replaceRange).toHaveBeenCalledWith('Line one\nLine two', { line: 0, ch: 3 });
    expect(h.withTargetNoteLock).toHaveBeenCalledWith(h.targetNote.path, expect.any(Function));
    expect(h.app.vault.modify).not.toHaveBeenCalled();
    expect(h.host.hasUninsertedDraft()).toBe(false);
    expect(h.root.querySelector('.rp-runner-draft')!.querySelector('textarea')!.value).toBe('Line one\nLine two');
    await insert(h);
    expect(bound.getText()).toBe('ABCLine one\nLine twoLine one\nLine twoDEF');
    typeDraft(h, 'Changed');
    expect(h.host.hasUninsertedDraft()).toBe(true);
    h.host.dispose();
  });

  it('preserves drafts through Back/Redo and keeps completion open', async () => {
    vi.useFakeTimers();
    try {
      const h = harness(answerGraph(), '{}', true);
      await h.host.mount(h.root as unknown as HTMLElement);
      const textarea = typeDraft(h, 'Keep conclusion');
      h.root.querySelector('.rp-answer-btn')!.dispatchEvent({ type: 'click' });
      await flushMicrotasks();
      vi.runAllTimers();
      expect(h.onRequestClose).not.toHaveBeenCalled();
      expect(h.root.querySelector('.rp-runner-draft')!.querySelector('textarea')).toBe(textarea);
      for (const key of ['ArrowLeft', 'ArrowRight']) {
        h.host.handleKeydown({ key, ctrlKey: true, target: null, preventDefault() {} } as KeyboardEvent);
        expect(textarea.value).toBe('Keep conclusion');
      }
      vi.runAllTimers();
      expect(h.onRequestClose).not.toHaveBeenCalled();
      h.host.dispose();
    } finally { vi.useRealTimers(); }
  });

  it('holds completion after self-check and preserves checked items on rerender', async () => {
    const h = harness(answerGraph(), JSON.stringify({ selfCheckEnabled: true, selfCheckItems: ['Review'] }), true);
    await h.host.mount(h.root as unknown as HTMLElement);
    typeDraft(h, 'Conclusion');
    h.root.querySelector('.rp-answer-btn')!.dispatchEvent({ type: 'click' });
    await flushMicrotasks();
    const checkbox = h.root.querySelector('input')!;
    checkbox.checked = true;
    checkbox.dispatchEvent({ type: 'change' });
    expect(h.onRequestClose).not.toHaveBeenCalled();
    (h.host as any).render();
    expect(h.root.querySelector('input')!.checked).toBe(true);
    h.host.dispose();
  });

  it('warns once on dirty close, supports cancel, and closes only on explicit discard', async () => {
    const h = harness(answerGraph(), '{}', true);
    await h.host.mount(h.root as unknown as HTMLElement);
    typeDraft(h, 'Unsaved');
    h.host.requestClose();
    h.host.requestClose();
    expect(confirmations).toHaveLength(1);
    expect(h.host.hasOpenChildModal()).toBe(true);
    confirmations[0]!.resolve('cancel');
    await flushMicrotasks();
    expect(h.onRequestClose).not.toHaveBeenCalled();
    expect(h.host.hasUninsertedDraft()).toBe(true);
    h.host.requestClose();
    confirmations[1]!.resolve('confirm');
    await flushMicrotasks();
    expect(h.onRequestClose).toHaveBeenCalledTimes(1);
    h.host.dispose();
  });

  it('does not acknowledge failed insertion or write to an unrelated note', async () => {
    const h = harness(answerGraph(), '{}', true);
    await h.host.mount(h.root as unknown as HTMLElement);
    typeDraft(h, 'Unsaved');
    await insert(h);
    expect(h.notify).toHaveBeenCalledWith(h.plugin.i18n.t('runnerDraft.noEditor'));
    expect(h.host.hasUninsertedDraft()).toBe(true);
    const bound = bindEditor(h);
    bound.editor.replaceRange.mockImplementation(() => { throw new Error('readonly'); });
    const warning = vi.spyOn(console, 'error').mockImplementation(() => {});
    await insert(h);
    warning.mockRestore();
    expect(h.host.hasUninsertedDraft()).toBe(true);
    h.host.dispose();
  });

  it('flushes the editor before allowing the next protocol append to read the note', async () => {
    const h = harness(answerGraph(), '{}', true);
    const bound = bindEditor(h);
    let disk = 'ABCDEF';
    h.app.vault.read.mockImplementation(async file => file.path === h.protocolFile.path ? '{}' : disk);
    const saving = deferred<void>();
    bound.save.mockImplementation(async () => { await saving.promise; disk = bound.getText(); });
    await h.host.mount(h.root as unknown as HTMLElement);
    typeDraft(h, 'Conclusion');
    const insertion = insert(h);
    h.root.querySelector('.rp-answer-btn')!.dispatchEvent({ type: 'click' });
    expect(h.app.vault.modify).not.toHaveBeenCalled();
    expect(h.host.hasUninsertedDraft()).toBe(true);
    saving.resolve();
    await insertion;
    expect(disk).toBe('ABCConclusionDEF');
    h.root.querySelector('.rp-answer-btn')!.dispatchEvent({ type: 'click' });
    await flushMicrotasks();
    expect(h.app.vault.modify).toHaveBeenCalledWith(h.targetNote, 'ABCConclusionDEF\nFinding');
    h.host.dispose();
  });

  it('retries a failed editor save without inserting the same text twice', async () => {
    const h = harness(answerGraph(), '{}', true);
    const bound = bindEditor(h);
    await h.host.mount(h.root as unknown as HTMLElement);
    typeDraft(h, 'Conclusion');
    bound.save.mockRejectedValueOnce(new Error('disk write failed'));
    const warning = vi.spyOn(console, 'error').mockImplementation(() => {});
    await insert(h);
    warning.mockRestore();
    expect(h.host.hasUninsertedDraft()).toBe(true);
    expect(h.host.handleKeydown({ key: 'ArrowLeft', ctrlKey: true } as KeyboardEvent)).toBe(false);
    await insert(h);
    expect(bound.getText()).toBe('ABCConclusionDEF');
    expect(bound.editor.replaceRange).toHaveBeenCalledTimes(1);
    expect(bound.save).toHaveBeenCalledTimes(2);
    expect(h.host.hasUninsertedDraft()).toBe(false);
    h.host.dispose();
  });

  it('does not lose edits made while queued and rejects duplicate/stale insertions', async () => {
    const h = harness(answerGraph(), '{}', true);
    const bound = bindEditor(h);
    await h.host.mount(h.root as unknown as HTMLElement);
    typeDraft(h, 'Snapshot');
    const gate = deferred<void>();
    h.withTargetNoteLock.mockImplementation(async (_path: string, operation: () => Promise<void>) => {
      await gate.promise;
      await operation();
    });
    const first = insert(h);
    await insert(h);
    typeDraft(h, 'New text');
    gate.resolve();
    await first;
    expect(bound.getText()).toBe('ABCSnapshotDEF');
    expect(h.host.hasUninsertedDraft()).toBe(true);
    const nextGate = deferred<void>();
    h.withTargetNoteLock.mockImplementation(async (_path: string, operation: () => Promise<void>) => {
      await nextGate.promise;
      await operation();
    });
    const stale = insert(h);
    h.host.dispose();
    nextGate.resolve();
    await stale;
    expect(bound.editor.replaceRange).toHaveBeenCalledTimes(1);
  });
});

describe('RunnerSessionHost bootstrap and projection', () => {
  it('has an inert constructor and crosses migration read before raw read and parse', async () => {
    const h = harness(answerGraph());
    const order: string[] = [];
    h.plugin.protocolDocumentStore.read.mockImplementation(async () => { order.push('store'); return {}; });
    h.app.vault.read.mockImplementation(async () => { order.push('vault'); return '{}'; });
    h.plugin.protocolDocumentParser.parse.mockImplementation(() => {
      order.push('parse');
      return { success: true, graph: answerGraph() };
    });

    expect(h.root.children).toHaveLength(0);
    expect(h.plugin.protocolDocumentStore.read).not.toHaveBeenCalled();
    expect(await h.host.mount(h.root as unknown as HTMLElement)).toBe(true);

    expect(order).toEqual(['store', 'vault', 'parse']);
    expect(h.root.hasClass('rp-runner-session-root')).toBe(true);
    expect(h.root.querySelector('.rp-question-text')?._text).toBe('Choose');
    expect(h.root.querySelector('.rp-runner-session-progress')).not.toBeNull();
  });

  it('dispatches loop and snippet-picker states into common zones', async () => {
    const loop = harness(loopGraph());
    expect(await loop.host.mount(loop.root as unknown as HTMLElement)).toBe(true);
    expect(loop.root.querySelectorAll('.rp-loop-body-btn')).toHaveLength(1);
    expect(loop.root.querySelectorAll('.rp-loop-exit-btn')).toHaveLength(1);
    loop.host.dispose();

    const snippet = harness(snippetGraph(false));
    expect(await snippet.host.mount(snippet.root as unknown as HTMLElement)).toBe(true);
    expect(getPickerMockInstances()).toHaveLength(1);
    expect(snippet.root.querySelector('.rp-stp-runner-session-host')).not.toBeNull();
    expect(snippet.root.hasClass('rp-state-content-only')).toBe(true);
  });
});

describe('RunnerSessionHost progress bar', () => {
  function progressValue(root: MockEl): string {
    const el = root.querySelector('.rp-runner-session-progress');
    return el?.getAttribute('aria-valuenow') ?? '';
  }

  function pressArrowLeft(h: Harness): void {
    const event = {
      key: 'ArrowLeft', ctrlKey: true, altKey: false, target: null,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;
    expect(h.host.handleKeydown(event)).toBe(true);
  }

  it('never shrinks mid-walk when BFS hop distance drops, and rewinds on Back', async () => {
    const h = harness(progressShrinkGraph());
    expect(await h.host.mount(h.root as unknown as HTMLElement)).toBe(true);

    // q1 at hop 1 of 4 → 25%
    expect(progressValue(h.root)).toBe('25');
    // → auto-advance lands at q2 (hop 3) → 74%
    h.root.querySelector('.rp-answer-btn')?.dispatchEvent({ type: 'click' });
    await flushMicrotasks();
    expect(progressValue(h.root)).toBe('74');
    // → q3 sits at hop 2 (shortcut edge) — raw 50% must NOT shrink the bar
    h.root.querySelector('.rp-answer-btn')?.dispatchEvent({ type: 'click' });
    await flushMicrotasks();
    expect(progressValue(h.root)).toBe('74');

    // Back rewinds the watermark: q2 recomputes to 74…
    pressArrowLeft(h);
    await flushMicrotasks();
    expect(progressValue(h.root)).toBe('74');
    // …and one more Back lands on q1 at 25% again.
    pressArrowLeft(h);
    await flushMicrotasks();
    expect(progressValue(h.root)).toBe('25');
  });
});

describe('RunnerSessionHost note deltas and snippets', () => {
  it('flushes the initial accumulator to the note when started from an explicit node', async () => {
    const h = harness(answerGraph());
    // Start at the seed text-block BEFORE the question: its content is
    // auto-appended during start() with no user action, so mount() must write it.
    (h.host as any).options.startNodeId = 'seed';
    expect(await h.host.mount(h.root as unknown as HTMLElement)).toBe(true);
    await flushMicrotasks();

    expect(h.app.vault.modify).toHaveBeenCalledWith(h.targetNote, 'Seed\nSeed');
  });

  it('does not flush an initial buffer for a regular protocol start', async () => {
    const h = harness(answerGraph());
    expect(await h.host.mount(h.root as unknown as HTMLElement)).toBe(true);
    await flushMicrotasks();
    expect(h.app.vault.modify).not.toHaveBeenCalled();
  });

  it('writes an append-only accumulator delta to the fixed note through the path mutex', async () => {
    const h = harness(answerGraph(), JSON.stringify({ selfCheckEnabled: true, selfCheckItems: ['Review'] }));
    expect(await h.host.mount(h.root as unknown as HTMLElement)).toBe(true);

    h.root.querySelector('.rp-answer-btn')?.dispatchEvent({ type: 'click' });
    await flushMicrotasks();

    expect(h.withTargetNoteLock).toHaveBeenCalledWith(h.targetNote.path, expect.any(Function));
    expect(h.app.vault.modify).toHaveBeenCalledWith(h.targetNote, 'Seed\nFinding');
    expect(h.app.vault.modify.mock.calls[0]?.[0]).toBe(h.targetNote);
    expect(h.root.querySelector('.rp-runner-session-self-check')).not.toBeNull();
  });

  it('checking mount status preserves the rendered controls', async () => {
    const h = harness(answerGraph());
    await h.host.mount(h.root as unknown as HTMLElement);
    const answer = h.root.querySelector('.rp-answer-btn');
    expect(h.host.isMounted()).toBe(true);
    expect(h.host.isMounted()).toBe(true);
    expect(h.root.querySelector('.rp-answer-btn')).toBe(answer);
  });

  it('blocks Back while an accepted delta is awaiting note acknowledgement', async () => {
    const h = harness(answerGraph(), JSON.stringify({
      selfCheckEnabled: true,
      selfCheckItems: ['Review'],
    }));
    const pendingRead = deferred<string>();
    h.app.vault.read.mockImplementation((file: { path: string }) =>
      file.path === h.protocolFile.path ? Promise.resolve('{}') : pendingRead.promise);
    expect(await h.host.mount(h.root as unknown as HTMLElement)).toBe(true);

    const answer = h.root.querySelector('.rp-answer-btn');
    const skip = h.root.querySelector('.rp-skip-btn');
    answer?.dispatchEvent({ type: 'click' });
    answer?.dispatchEvent({ type: 'click' });
    skip?.dispatchEvent({ type: 'click' });
    await flushMicrotasks(2);
    const event = {
      key: 'ArrowLeft', ctrlKey: true, altKey: false, target: null,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;
    expect(h.host.handleKeydown(event)).toBe(false);
    expect(h.root.querySelector('.rp-question-text')).toBeNull();

    pendingRead.resolve('Seed\n');
    await flushMicrotasks();

    expect(h.app.vault.modify).toHaveBeenCalledTimes(1);
    expect(h.app.vault.modify).toHaveBeenCalledWith(h.targetNote, 'Seed\nFinding');
    expect(h.root.querySelector('.rp-question-text')).toBeNull();
  });

  it('retains failed output and retries before projecting completion', async () => {
    const h = harness(answerGraph(), JSON.stringify({
      selfCheckEnabled: true,
      selfCheckItems: ['Review'],
    }));
    h.app.vault.read.mockImplementation((file: { path: string }) => {
      if (file.path === h.protocolFile.path) {
        return Promise.resolve(JSON.stringify({
          selfCheckEnabled: true,
          selfCheckItems: ['Review'],
        }));
      }
      return Promise.reject(new Error('write target unavailable'));
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await h.host.mount(h.root as unknown as HTMLElement)).toBe(true);
      h.root.querySelector('.rp-answer-btn')?.dispatchEvent({ type: 'click' });
      await flushMicrotasks();

      expect(h.notify).toHaveBeenCalledWith(
        'Не удалось записать результат протокола в связанную заметку.',
      );
      expect(h.app.vault.modify).not.toHaveBeenCalled();
      expect(h.root.querySelector('.rp-runner-session-self-check')).toBeNull();
      const retry = h.root.querySelector('.rp-answer-btn');
      expect(retry?._text).toBe('Повторить сохранение');
      h.app.vault.read.mockResolvedValue('Seed\n');
      retry?.dispatchEvent({ type: 'click' });
      await flushMicrotasks();
      expect(h.app.vault.modify).toHaveBeenCalledWith(h.targetNote, 'Seed\nFinding');
      expect(h.root.querySelector('.rp-runner-session-self-check')).not.toBeNull();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('writes Answer text and automatically traversed downstream text as one delta', async () => {
    const h = harness(answerWithDownstreamTextGraph(), JSON.stringify({
      selfCheckEnabled: true,
      selfCheckItems: ['Review'],
    }));
    h.app.vault.read.mockImplementation((file: { path: string }) =>
      Promise.resolve(file.path === h.protocolFile.path ? '{}' : ''));
    expect(await h.host.mount(h.root as unknown as HTMLElement)).toBe(true);

    h.root.querySelector('.rp-answer-btn')?.dispatchEvent({ type: 'click' });
    await flushMicrotasks();

    expect(h.app.vault.modify).toHaveBeenCalledTimes(1);
    expect(h.app.vault.modify).toHaveBeenCalledWith(h.targetNote, 'Finding\nTail');
  });

  it('writes automatically traversed output produced by Skip through the same delta sink', async () => {
    const h = harness(answerWithDownstreamTextGraph(), JSON.stringify({
      selfCheckEnabled: true,
      selfCheckItems: ['Review'],
    }));
    h.app.vault.read.mockImplementation((file: { path: string }) =>
      Promise.resolve(file.path === h.protocolFile.path ? '{}' : ''));
    expect(await h.host.mount(h.root as unknown as HTMLElement)).toBe(true);

    h.root.querySelector('.rp-skip-btn')?.dispatchEvent({ type: 'click' });
    await flushMicrotasks();

    expect(h.app.vault.modify).toHaveBeenCalledTimes(1);
    expect(h.app.vault.modify).toHaveBeenCalledWith(h.targetNote, 'Tail');
  });

  it('serializes same-path writes through a real WriteMutex', async () => {
    const raw = JSON.stringify({ selfCheckEnabled: true, selfCheckItems: ['Review'] });
    const first = harness(answerWithDownstreamTextGraph('A'), raw);
    const second = harness(answerWithDownstreamTextGraph('B'), raw);
    const mutex = new WriteMutex();
    first.withTargetNoteLock.mockImplementation((path, operation) =>
      mutex.runExclusive(path, operation));
    second.withTargetNoteLock.mockImplementation((path, operation) =>
      mutex.runExclusive(path, operation));
    expect(await first.host.mount(first.root as unknown as HTMLElement)).toBe(true);
    expect(await second.host.mount(second.root as unknown as HTMLElement)).toBe(true);

    const firstRead = deferred<string>();
    let noteContent = '';
    let targetReads = 0;
    const installVault = (h: Harness): void => {
      h.app.vault.read.mockImplementation((file: { path: string }) => {
        if (file.path === h.protocolFile.path) return Promise.resolve('{}');
        targetReads += 1;
        return targetReads === 1 ? firstRead.promise : Promise.resolve(noteContent);
      });
      h.app.vault.modify.mockImplementation(async (_file: { path: string }, content: string) => {
        noteContent = content;
      });
    };
    installVault(first);
    installVault(second);

    first.root.querySelector('.rp-answer-btn')?.dispatchEvent({ type: 'click' });
    second.root.querySelector('.rp-answer-btn')?.dispatchEvent({ type: 'click' });
    await flushMicrotasks();
    expect(targetReads).toBe(1);

    firstRead.resolve('');
    await flushMicrotasks(12);
    expect(targetReads).toBe(2);
    expect(noteContent).toBe('A\nTailB\nTail');
  });

  it('keeps picker selection on the accumulator path and preserves first-chunk behavior', async () => {
    const h = harness(snippetGraph(false), JSON.stringify({ selfCheckEnabled: true, selfCheckItems: ['Review'] }));
    h.app.vault.read.mockImplementation(async (file: { path: string }) =>
      file.path === h.protocolFile.path ? '{}' : '');
    expect(await h.host.mount(h.root as unknown as HTMLElement)).toBe(true);
    const picker = getPickerMockInstances()[0]!;
    const onSelect = picker.options.onSelect as (result: { relativePath: string }) => void;
    h.plugin.snippetService.load.mockResolvedValue({
      kind: 'md', path: 'Snippets/Chest/report.md', name: 'report', content: 'Report',
    });

    onSelect({ relativePath: 'report.md' });
    await flushMicrotasks();

    expect(h.app.vault.modify).toHaveBeenCalledWith(h.targetNote, 'Report');
    expect(picker.unmounted).toBe(true);
  });

  it('renders a recoverable error with Back when snippet resolution rejects', async () => {
    const runtimeGraph = graph([
      { ...base, id: 'start', kind: 'start' },
      { ...base, id: 'question', kind: 'question', questionText: 'Choose' },
      {
        ...base,
        id: 'snippet',
        kind: 'snippet',
        radiprotocol_snippetPath: 'report.md',
      },
    ], [
      { id: 'start-question', fromNodeId: 'start', toNodeId: 'question' },
      { id: 'question-snippet', fromNodeId: 'question', toNodeId: 'snippet' },
    ]);
    const h = harness(runtimeGraph);
    h.plugin.snippetService.resolveSnippet.mockRejectedValue(new Error('vault unavailable'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await h.host.mount(h.root as unknown as HTMLElement)).toBe(true);
      h.root.querySelector('.rp-snippet-branch-btn')?.dispatchEvent({ type: 'click' });
      await flushMicrotasks();

      expect(h.root.querySelector('.rp-error-panel')).not.toBeNull();
      expect(h.root.querySelector('.rp-step-back-btn')).not.toBeNull();
      expect(h.app.vault.modify).not.toHaveBeenCalled();
      expect(h.host.isMounted()).toBe(true);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('treats fill cancellation as completeSnippet("") without writing output', async () => {
    const h = harness(snippetGraph(true), JSON.stringify({ selfCheckEnabled: true, selfCheckItems: ['Review'] }));
    h.plugin.snippetService.resolveSnippet.mockResolvedValue({
      status: 'found',
      snippet: {
        kind: 'md-template', path: 'Snippets/report.md', name: 'report',
        template: 'Value: {{value}}', validationError: null,
        placeholders: [{ id: 'value', label: 'Value', type: 'free-text' }],
      },
    });
    expect(await h.host.mount(h.root as unknown as HTMLElement)).toBe(true);
    await flushMicrotasks();
    const modal = getFillModalInstances()[0]!;
    expect(h.host.hasOpenChildModal()).toBe(true);

    modal.__resolve(null);
    await flushMicrotasks();

    expect(h.app.vault.modify).not.toHaveBeenCalled();
    expect(h.host.hasOpenChildModal()).toBe(false);
    expect(h.root.querySelector('.rp-runner-session-self-check')).not.toBeNull();
  });
});

describe('RunnerSessionHost completion and stale async suppression', () => {
  it('closes only after timer advancement and cancels a scheduled close on dispose', async () => {
    vi.useFakeTimers();
    try {
      const immediate = harness(answerGraph());
      expect(await immediate.host.mount(immediate.root as unknown as HTMLElement)).toBe(true);
      immediate.root.querySelector('.rp-answer-btn')?.dispatchEvent({ type: 'click' });
      await flushMicrotasks();
      expect(immediate.onRequestClose).not.toHaveBeenCalled();
      vi.advanceTimersByTime(0);
      expect(immediate.onRequestClose).toHaveBeenCalledTimes(1);

      const canceled = harness(answerGraph());
      expect(await canceled.host.mount(canceled.root as unknown as HTMLElement)).toBe(true);
      canceled.root.querySelector('.rp-answer-btn')?.dispatchEvent({ type: 'click' });
      await flushMicrotasks();
      expect(canceled.onRequestClose).not.toHaveBeenCalled();
      canceled.host.dispose();
      vi.advanceTimersByTime(0);
      expect(canceled.onRequestClose).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('requests close after the final self-check item', async () => {
    const checked = harness(answerGraph(), JSON.stringify({
      selfCheckEnabled: true,
      selfCheckItems: ['One'],
    }));
    expect(await checked.host.mount(checked.root as unknown as HTMLElement)).toBe(true);
    checked.root.querySelector('.rp-answer-btn')?.dispatchEvent({ type: 'click' });
    await flushMicrotasks();
    const checkbox = checked.root.querySelector('input[type="checkbox"]')!;
    checkbox.checked = true;
    checkbox.dispatchEvent({ type: 'change' });
    expect(checked.onRequestClose).toHaveBeenCalledTimes(1);
  });

  it('suppresses bootstrap continuation after dispose', async () => {
    const h = harness(answerGraph());
    const pending = deferred<unknown>();
    h.plugin.protocolDocumentStore.read.mockReturnValue(pending.promise);
    const mounting = h.host.mount(h.root as unknown as HTMLElement);

    h.host.dispose();
    pending.resolve({});
    expect(await mounting).toBe(false);

    expect(h.app.vault.read).not.toHaveBeenCalled();
    expect(h.plugin.protocolDocumentParser.parse).not.toHaveBeenCalled();
    expect(h.root.children).toHaveLength(0);
  });

  it('suppresses a target-note modify and follow-up render when disposed during the read', async () => {
    const h = harness(answerGraph(), JSON.stringify({ selfCheckEnabled: true, selfCheckItems: ['Review'] }));
    const pendingRead = deferred<string>();
    h.app.vault.read.mockImplementation((file: { path: string }) => {
      if (file.path === h.protocolFile.path) return Promise.resolve('{}');
      return pendingRead.promise;
    });
    expect(await h.host.mount(h.root as unknown as HTMLElement)).toBe(true);
    h.root.querySelector('.rp-answer-btn')?.dispatchEvent({ type: 'click' });
    await Promise.resolve();

    h.host.dispose();
    pendingRead.resolve('Seed\n');
    await flushMicrotasks();

    expect(h.app.vault.modify).not.toHaveBeenCalled();
    expect(h.root.children).toHaveLength(0);
  });

  it('suppresses stale snippet resolution after dispose', async () => {
    const h = harness(snippetGraph(true));
    const resolution = deferred<any>();
    h.plugin.snippetService.resolveSnippet.mockReturnValue(resolution.promise);
    expect(await h.host.mount(h.root as unknown as HTMLElement)).toBe(true);
    h.host.dispose();
    resolution.resolve({
      status: 'found',
      snippet: {
        kind: 'md-template', path: 'Snippets/report.md', name: 'report',
        template: '{{value}}', validationError: null,
        placeholders: [{ id: 'value', label: 'Value', type: 'free-text' }],
      },
    });
    await flushMicrotasks();

    expect(getFillModalInstances()).toHaveLength(0);
    expect(h.app.vault.modify).not.toHaveBeenCalled();
  });

  it('suppresses a pending picker load after dispose', async () => {
    const h = harness(snippetGraph(false));
    expect(await h.host.mount(h.root as unknown as HTMLElement)).toBe(true);
    const picker = getPickerMockInstances()[0]!;
    const load = deferred<any>();
    h.plugin.snippetService.load.mockReturnValue(load.promise);

    (picker.options.onSelect as (result: { relativePath: string }) => void)({
      relativePath: 'report.md',
    });
    await flushMicrotasks(2);
    h.host.dispose();
    load.resolve({
      kind: 'md', path: 'Snippets/Chest/report.md', name: 'report', content: 'Late',
    });
    await flushMicrotasks();

    expect(picker.unmounted).toBe(true);
    expect(h.app.vault.modify).not.toHaveBeenCalled();
    expect(h.root.children).toHaveLength(0);
  });

  it('invalidates sibling picker loads when one missing result replaces the picker with an error', async () => {
    const h = harness(snippetGraph(false));
    expect(await h.host.mount(h.root as unknown as HTMLElement)).toBe(true);
    const picker = getPickerMockInstances()[0]!;
    const firstLoad = deferred<any>();
    const secondLoad = deferred<any>();
    h.plugin.snippetService.load
      .mockReturnValueOnce(firstLoad.promise)
      .mockReturnValueOnce(secondLoad.promise);
    const onSelect = picker.options.onSelect as (result: { relativePath: string }) => void;

    onSelect({ relativePath: 'missing.md' });
    onSelect({ relativePath: 'late.md' });
    firstLoad.resolve(null);
    await flushMicrotasks();
    expect(picker.unmounted).toBe(true);
    expect(getPickerMockInstances()).toHaveLength(2);
    expect(h.root.querySelector('.rp-stp-runner-session-host')).not.toBeNull();
    expect(h.root.querySelector('.rp-empty-state-body')).not.toBeNull();

    secondLoad.resolve({
      kind: 'md', path: 'Snippets/Chest/late.md', name: 'late', content: 'Late',
    });
    await flushMicrotasks();

    expect(h.app.vault.modify).not.toHaveBeenCalled();
  });

  it('closes an opened fill modal on dispose and suppresses its late result', async () => {
    const h = harness(snippetGraph(true));
    h.plugin.snippetService.resolveSnippet.mockResolvedValue({
      status: 'found',
      snippet: {
        kind: 'md-template', path: 'Snippets/report.md', name: 'report',
        template: '{{value}}', validationError: null,
        placeholders: [{ id: 'value', label: 'Value', type: 'free-text' }],
      },
    });
    expect(await h.host.mount(h.root as unknown as HTMLElement)).toBe(true);
    await flushMicrotasks();
    const modal = getFillModalInstances()[0]!;
    expect(modal.opened).toBe(true);

    h.host.dispose();
    modal.__resolve('Late value');
    await flushMicrotasks();

    expect(modal.closed).toBe(true);
    expect(h.app.vault.modify).not.toHaveBeenCalled();
    expect(h.root.children).toHaveLength(0);
  });

  it('ignores unrelated deletion, but matching deletion invalidates writes and removes listener', async () => {
    const h = harness(answerGraph(), JSON.stringify({
      selfCheckEnabled: true,
      selfCheckItems: ['Review'],
    }));
    const pendingRead = deferred<string>();
    h.app.vault.read.mockImplementation((file: { path: string }) =>
      file.path === h.protocolFile.path ? Promise.resolve('{}') : pendingRead.promise);
    expect(await h.host.mount(h.root as unknown as HTMLElement)).toBe(true);
    expect(h.app._vaultHandlerCount('delete')).toBe(1);

    h.root.querySelector('.rp-answer-btn')?.dispatchEvent({ type: 'click' });
    await flushMicrotasks(2);
    h.app._emitVault('delete', new (TFile as any)('notes/unrelated.md'));
    expect(h.host.isMounted()).toBe(true);
    expect(h.onRequestClose).not.toHaveBeenCalled();
    expect(h.app._vaultHandlerCount('delete')).toBe(1);

    h.app._emitVault('delete', h.targetNote);
    expect(h.host.isMounted()).toBe(false);
    expect(h.onRequestClose).toHaveBeenCalledTimes(1);
    expect(h.app._vaultHandlerCount('delete')).toBe(0);
    expect(h.app.vault.offref).toHaveBeenCalledTimes(1);

    pendingRead.resolve('Seed\n');
    await flushMicrotasks();
    expect(h.app.vault.modify).not.toHaveBeenCalled();
  });
});

describe('RunnerSessionHost free-text drafts and submission', () => {
  it('retains independent Answer-ID drafts across destructive rerenders', async () => {
    const h = harness(freeTextDraftGraph());
    expect(await h.host.mount(h.root as unknown as HTMLElement)).toBe(true);
    let textareas = h.root.querySelectorAll('.rp-free-text-answer-textarea');
    expect(textareas).toHaveLength(2);

    textareas[0]!.value = 'first draft';
    textareas[0]!.dispatchEvent({ type: 'input' });
    textareas[1]!.value = 'second draft';
    textareas[1]!.dispatchEvent({ type: 'input' });

    (h.host as any).render();
    textareas = h.root.querySelectorAll('.rp-free-text-answer-textarea');
    expect(textareas.map((textarea) => textarea.value)).toEqual([
      'first draft',
      'second draft',
    ]);

    textareas[1]!.value = '   ';
    textareas[1]!.dispatchEvent({ type: 'input' });
    h.root.querySelectorAll('.rp-free-text-answer-submit')[1]!
      .dispatchEvent({ type: 'click' });

    textareas = h.root.querySelectorAll('.rp-free-text-answer-textarea');
    expect(textareas.map((textarea) => textarea.value)).toEqual([
      'first draft',
      '   ',
    ]);
    expect(h.root.querySelector('.rp-free-text-answer-error')).not.toBeNull();
    expect(h.app.vault.modify).not.toHaveBeenCalled();
  });

  it('forwards exact whitespace through the actual runner and writes submitted plus downstream output', async () => {
    const raw = JSON.stringify({
      selfCheckEnabled: true,
      selfCheckItems: ['Review'],
    });
    const h = harness(freeTextWithDownstreamGraph(), raw);
    h.app.vault.read.mockImplementation((file: { path: string }) =>
      Promise.resolve(file.path === h.protocolFile.path ? raw : ''));
    const chooseAnswer = vi.spyOn(ProtocolRunner.prototype, 'chooseAnswer');
    try {
      expect(await h.host.mount(h.root as unknown as HTMLElement)).toBe(true);
      const textarea = h.root.querySelector('.rp-free-text-answer-textarea')!;
      textarea.value = '  custom\nvalue  ';
      textarea.dispatchEvent({ type: 'input' });
      h.root.querySelector('.rp-free-text-answer-submit')!
        .dispatchEvent({ type: 'click' });
      await flushMicrotasks();

      expect(chooseAnswer).toHaveBeenCalledWith('free', '  custom\nvalue  ');
      expect(h.app.vault.modify).toHaveBeenCalledTimes(1);
      expect(h.app.vault.modify).toHaveBeenCalledWith(
        h.targetNote,
        '  custom\nvalue  \nTail',
      );
      expect(h.root.querySelector('.rp-runner-session-self-check')).not.toBeNull();
    } finally {
      chooseAnswer.mockRestore();
    }
  });

  it('preserves an authored leading separator on the first free-text chunk', async () => {
    const h = harness(freeTextWithDownstreamGraph(), JSON.stringify({
      selfCheckEnabled: true,
      selfCheckItems: ['Review'],
    }));
    h.app.vault.read.mockImplementation((file: { path: string }) =>
      Promise.resolve(file.path === h.protocolFile.path ? '{}' : 'Existing\n'));
    expect(await h.host.mount(h.root as unknown as HTMLElement)).toBe(true);

    const textarea = h.root.querySelector('.rp-free-text-answer-textarea')!;
    textarea.value = '\nleading';
    textarea.dispatchEvent({ type: 'input' });
    h.root.querySelector('.rp-free-text-answer-submit')!
      .dispatchEvent({ type: 'click' });
    await flushMicrotasks();

    expect(h.app.vault.modify).toHaveBeenCalledWith(
      h.targetNote,
      'Existing\n\nleading\nTail',
    );
  });

  it('rejects blank text without runner state/history, lock, note-read, or note-write mutation', async () => {
    const h = harness(freeTextMixedGraph());
    expect(await h.host.mount(h.root as unknown as HTMLElement)).toBe(true);
    const runner = (h.host as any).runner as ProtocolRunner;
    const stateBefore = runner.getState();
    const historyBefore = runner.getSerializableState();

    h.root.querySelector('.rp-free-text-answer-submit')!
      .dispatchEvent({ type: 'click' });

    expect(runner.getState()).toEqual(stateBefore);
    expect(runner.getSerializableState()).toEqual(historyBefore);
    expect(h.withTargetNoteLock).not.toHaveBeenCalled();
    expect(h.app.vault.read.mock.calls.filter(
      ([file]) => (file as { path: string }).path === h.targetNote.path,
    )).toHaveLength(0);
    expect(h.app.vault.modify).not.toHaveBeenCalled();
  });

  it('renders a localized mixed-question alert, restores focus, and clears error state on exact input', async () => {
    vi.useFakeTimers();
    try {
      const h = harness(freeTextMixedGraph());
      expect(await h.host.mount(h.root as unknown as HTMLElement)).toBe(true);
      expect(h.root.querySelector('.rp-free-text-answer-textarea')!.focusCount).toBe(0);

      h.root.querySelector('.rp-free-text-answer-submit')!
        .dispatchEvent({ type: 'click' });
      const rejectedTextarea = h.root.querySelector('.rp-free-text-answer-textarea')!;
      const alert = h.root.querySelector('.rp-free-text-answer-error')!;
      expect(alert._text).toBe('Введите текст перед отправкой.');
      expect(alert.getAttribute('role')).toBe('alert');
      expect(rejectedTextarea.getAttribute('aria-invalid')).toBe('true');

      vi.advanceTimersByTime(0);
      expect(rejectedTextarea.focusCount).toBe(1);

      rejectedTextarea.value = '  сохранено точно  ';
      rejectedTextarea.dispatchEvent({ type: 'input' });
      expect(rejectedTextarea.getAttribute('aria-invalid')).toBeNull();
      expect(h.root.querySelector('.rp-free-text-answer-error')).toBeNull();

      (h.host as any).render();
      const rerenderedTextarea = h.root.querySelector('.rp-free-text-answer-textarea')!;
      expect(rerenderedTextarea.value).toBe('  сохранено точно  ');
      vi.advanceTimersByTime(0);
      expect(rerenderedTextarea.focusCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores input and submission events from controls detached by disposal', async () => {
    const h = harness(freeTextMixedGraph());
    expect(await h.host.mount(h.root as unknown as HTMLElement)).toBe(true);
    const textarea = h.root.querySelector('.rp-free-text-answer-textarea')!;
    const submit = h.root.querySelector('.rp-free-text-answer-submit')!;
    const runner = (h.host as any).runner as ProtocolRunner;
    const stateBefore = runner.getState();

    h.host.dispose();
    textarea.value = 'late detached value';
    textarea.dispatchEvent({ type: 'input' });
    submit.dispatchEvent({ type: 'click' });
    await flushMicrotasks();

    expect((h.host as any).answerDrafts.size).toBe(0);
    expect((h.host as any).answerErrors.size).toBe(0);
    expect(runner.getState()).toEqual(stateBefore);
    expect(h.withTargetNoteLock).not.toHaveBeenCalled();
    expect(h.app.vault.modify).not.toHaveBeenCalled();
  });

  it('applies sole-answer focus only on the initial projection, not every rerender', async () => {
    vi.useFakeTimers();
    try {
      const sole = graph([
        { ...base, id: 'start', kind: 'start' },
        { ...base, id: 'question', kind: 'question', questionText: 'Describe' },
        {
          ...base,
          id: 'free',
          kind: 'answer',
          answerText: 'Free-text prompt',
          freeText: true,
        },
      ], [
        { id: 'start-question', fromNodeId: 'start', toNodeId: 'question' },
        { id: 'question-free', fromNodeId: 'question', toNodeId: 'free' },
      ]);
      const h = harness(sole);
      expect(await h.host.mount(h.root as unknown as HTMLElement)).toBe(true);
      const initialTextarea = h.root.querySelector('.rp-free-text-answer-textarea')!;

      vi.advanceTimersByTime(0);
      expect(initialTextarea.focusCount).toBe(1);

      (h.host as any).render();
      const rerenderedTextarea = h.root.querySelector('.rp-free-text-answer-textarea')!;
      vi.advanceTimersByTime(0);
      expect(rerenderedTextarea.focusCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a deferred sole-answer focus when the session is disposed', async () => {
    vi.useFakeTimers();
    try {
      const sole = graph([
        { ...base, id: 'start', kind: 'start' },
        { ...base, id: 'question', kind: 'question', questionText: 'Describe' },
        {
          ...base,
          id: 'free',
          kind: 'answer',
          answerText: 'Free-text prompt',
          freeText: true,
        },
      ], [
        { id: 'start-question', fromNodeId: 'start', toNodeId: 'question' },
        { id: 'question-free', fromNodeId: 'question', toNodeId: 'free' },
      ]);
      const h = harness(sole);
      expect(await h.host.mount(h.root as unknown as HTMLElement)).toBe(true);
      const textarea = h.root.querySelector('.rp-free-text-answer-textarea')!;

      h.host.dispose();
      vi.advanceTimersByTime(0);

      expect(textarea.focusCount).toBe(0);
      expect(h.root.contains(textarea)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

function freeTextLoopGraph(): ProtocolGraph {
  return graph([
    { ...base, id: 'start', kind: 'start' },
    { ...base, id: 'loop', kind: 'question', questionText: 'Repeat?', loop: true },
    {
      ...base,
      id: 'free',
      kind: 'answer',
      answerText: 'Describe finding',
      freeText: true,
      radiprotocol_separator: 'space',
    },
    { ...base, id: 'end', kind: 'text-block', content: 'End' },
  ], [
    { id: 'start-loop', fromNodeId: 'start', toNodeId: 'loop' },
    { id: 'loop-free', fromNodeId: 'loop', toNodeId: 'free' },
    { id: 'free-loop', fromNodeId: 'free', toNodeId: 'loop' },
    { id: 'loop-exit', fromNodeId: 'loop', toNodeId: 'end', label: 'Finish', isLoopExit: true },
  ]);
}

describe('RunnerSessionHost free-text Answer as a direct loop branch target', () => {
  it('renders the free-text row inside the loop picker and writes the submitted text to the bound note', async () => {
    const h = harness(freeTextLoopGraph());
    expect(await h.host.mount(h.root as unknown as HTMLElement)).toBe(true);

    // Loop picker with a free-text body branch: no dead body button, real row.
    expect(h.root.querySelectorAll('.rp-loop-body-btn')).toHaveLength(0);
    expect(h.root.querySelectorAll('.rp-loop-exit-btn')).toHaveLength(1);
    const textarea = h.root.querySelector('.rp-free-text-answer-textarea')!;
    expect(h.root.querySelector('.rp-free-text-answer-prompt')?._text).toBe('Describe finding');

    textarea.value = 'custom finding';
    textarea.dispatchEvent({ type: 'input' });
    h.root.querySelector('.rp-free-text-answer-submit')!
      .dispatchEvent({ type: 'click' });
    await flushMicrotasks();

    expect(h.app.vault.modify).toHaveBeenCalledTimes(1);
    expect(h.app.vault.modify).toHaveBeenCalledWith(h.targetNote, 'Seed\ncustom finding');
    // Back-edge re-entry returns to the picker; the draft was consumed.
    expect(h.root.querySelector('.rp-loop-exit-btn')).not.toBeNull();
    expect(h.root.querySelector('.rp-free-text-answer-textarea')?.value).toBe('');
  });

  it('rejects blank loop free-text without runner mutation, lock, read, or write', async () => {
    const h = harness(freeTextLoopGraph());
    expect(await h.host.mount(h.root as unknown as HTMLElement)).toBe(true);
    const runner = (h.host as any).runner as ProtocolRunner;
    const stateBefore = runner.getState();
    const historyBefore = runner.getSerializableState();

    h.root.querySelector('.rp-free-text-answer-submit')!
      .dispatchEvent({ type: 'click' });
    await flushMicrotasks();

    const alert = h.root.querySelector('.rp-free-text-answer-error')!;
    expect(alert._text).toBe('Введите текст перед отправкой.');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(h.root.querySelector('.rp-free-text-answer-textarea')!
      .getAttribute('aria-invalid')).toBe('true');
    expect(runner.getState()).toEqual(stateBefore);
    expect(runner.getSerializableState()).toEqual(historyBefore);
    expect(h.withTargetNoteLock).not.toHaveBeenCalled();
    expect(h.app.vault.modify).not.toHaveBeenCalled();
  });

  it('retains the loop free-text draft across a destructive rerender and clears it after acceptance', async () => {
    const h = harness(freeTextLoopGraph());
    expect(await h.host.mount(h.root as unknown as HTMLElement)).toBe(true);

    const textarea = h.root.querySelector('.rp-free-text-answer-textarea')!;
    textarea.value = 'kept draft';
    textarea.dispatchEvent({ type: 'input' });

    (h.host as any).render();
    expect(h.root.querySelector('.rp-free-text-answer-textarea')?.value).toBe('kept draft');

    h.root.querySelector('.rp-free-text-answer-submit')!
      .dispatchEvent({ type: 'click' });
    await flushMicrotasks();

    expect(h.app.vault.modify).toHaveBeenCalledTimes(1);
    expect(h.root.querySelector('.rp-free-text-answer-textarea')?.value).toBe('');
  });
});

describe('RunnerSessionHost keyboard model', () => {
  function keyboard(
    init: { code?: string; key?: string; ctrlKey?: boolean; altKey?: boolean; target?: unknown },
  ): { event: KeyboardEvent; preventDefault: ReturnType<typeof vi.fn> } {
    const preventDefault = vi.fn();
    const event = {
      code: init.code,
      key: init.key,
      ctrlKey: init.ctrlKey ?? false,
      altKey: init.altKey ?? false,
      metaKey: false,
      shiftKey: false,
      isComposing: false,
      target: init.target ?? null,
      preventDefault,
    } as unknown as KeyboardEvent;
    return { event, preventDefault };
  }

  function twoOptionGraph(): ProtocolGraph {
    return graph([
      { ...base, id: 'start', kind: 'start' },
      { ...base, id: 'question', kind: 'question', questionText: 'First?' },
      { ...base, id: 'a1', kind: 'answer', answerText: 'A1' },
      { ...base, id: 'a2', kind: 'answer', answerText: 'A2' },
      { ...base, id: 'next', kind: 'question', questionText: 'Second?' },
      { ...base, id: 'a3', kind: 'answer', answerText: 'A3' },
    ], [
      { id: 'start-question', fromNodeId: 'start', toNodeId: 'question' },
      { id: 'q-a1', fromNodeId: 'question', toNodeId: 'a1' },
      { id: 'q-a2', fromNodeId: 'question', toNodeId: 'a2' },
      { id: 'a1-next', fromNodeId: 'a1', toNodeId: 'next' },
      { id: 'a2-next', fromNodeId: 'a2', toNodeId: 'next' },
      { id: 'next-a3', fromNodeId: 'next', toNodeId: 'a3' },
    ]);
  }

  function optionKeys(root: MockEl): string[] {
    return root.querySelectorAll('.rp-answer-btn')
      .map((el) => el.getAttribute('data-rp-key') ?? '');
  }

  it('numbers the rendered options and dispatches the Nth digit', async () => {
    const h = harness(twoOptionGraph());
    expect(await h.host.mount(h.root as unknown as HTMLElement)).toBe(true);
    expect(h.root.querySelector('.rp-question-text')?._text).toBe('First?');
    expect(optionKeys(h.root)).toEqual(['1', '2']);
    expect(h.root.querySelector('.rp-answer-btn')?.getAttribute('aria-keyshortcuts')).toBe('1');

    const { event, preventDefault } = keyboard({ code: 'Digit2', key: '2' });
    expect(h.host.handleKeydown(event)).toBe(true);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    await flushMicrotasks();

    expect(h.app.vault.modify).toHaveBeenCalledWith(h.targetNote, 'Seed\nA2');
    expect(h.root.querySelector('.rp-question-text')?._text).toBe('Second?');
    h.host.dispose();
  });

  it('ignores digits beyond the option count without preventing default', async () => {
    const h = harness(twoOptionGraph());
    await h.host.mount(h.root as unknown as HTMLElement);
    const { event, preventDefault } = keyboard({ code: 'Digit9', key: '9' });
    expect(h.host.handleKeydown(event)).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(h.app.vault.modify).not.toHaveBeenCalled();
    h.host.dispose();
  });

  it('focuses a free-text option instead of submitting it', async () => {
    const h = harness(freeTextMixedGraph());
    await h.host.mount(h.root as unknown as HTMLElement);
    const { event } = keyboard({ code: 'Digit1', key: '1' });
    expect(h.host.handleKeydown(event)).toBe(true);

    expect(h.root.querySelector('.rp-free-text-answer-textarea')?.focusCount).toBe(1);
    expect(h.app.vault.modify).not.toHaveBeenCalled();
    h.host.dispose();
  });

  it('navigates with Z, X, and Backspace, including a Russian-layout event', async () => {
    const h = harness(twoOptionGraph());
    await h.host.mount(h.root as unknown as HTMLElement);

    h.root.querySelector('.rp-answer-btn')!.dispatchEvent({ type: 'click' });
    await flushMicrotasks();
    expect(h.root.querySelector('.rp-question-text')?._text).toBe('Second?');

    expect(h.host.handleKeydown(keyboard({ code: 'KeyZ', key: 'я' }).event)).toBe(true);
    expect(h.root.querySelector('.rp-question-text')?._text).toBe('First?');
    await flushMicrotasks(1);

    expect(h.host.handleKeydown(keyboard({ code: 'KeyX', key: 'ч' }).event)).toBe(true);
    expect(h.root.querySelector('.rp-question-text')?._text).toBe('Second?');
    await flushMicrotasks(1);

    expect(h.host.handleKeydown(keyboard({ code: 'Backspace', key: 'Backspace' }).event)).toBe(true);
    expect(h.root.querySelector('.rp-question-text')?._text).toBe('First?');
    h.host.dispose();
  });

  it('keeps every key inert after disposal', async () => {
    const h = harness(twoOptionGraph());
    await h.host.mount(h.root as unknown as HTMLElement);
    h.host.dispose();
    const { event, preventDefault } = keyboard({ code: 'KeyZ', key: 'z' });
    expect(h.host.handleKeydown(event)).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('never intercepts keys typed inside a field', async () => {
    const h = harness(freeTextMixedGraph());
    await h.host.mount(h.root as unknown as HTMLElement);
    const { event, preventDefault } = keyboard({
      code: 'KeyZ',
      key: 'z',
      target: { tagName: 'TEXTAREA' },
    });
    expect(h.host.handleKeydown(event)).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    h.host.dispose();
  });

  it('toggles the hint row with H and lists only available actions', async () => {
    const h = harness(twoOptionGraph());
    await h.host.mount(h.root as unknown as HTMLElement);
    const hints = h.root.querySelector('.rp-runner-key-hints')!;
    const hintLabels = (): string[] =>
      hints.querySelectorAll('.rp-runner-key-hint-label').map((el) => el._text);
    expect(hints.hasClass('is-hidden')).toBe(false);
    // A fresh session has nothing to undo, so Back/Redo are absent.
    expect(hintLabels()).toContain('Выбор');
    expect(hintLabels()).toContain('Пропуск');
    expect(hintLabels()).toContain('Закрыть');
    expect(hintLabels()).not.toContain('Назад');

    h.root.querySelector('.rp-answer-btn')!.dispatchEvent({ type: 'click' });
    await flushMicrotasks();
    expect(hintLabels()).toContain('Назад');
    expect(hintLabels()).not.toContain('Вперёд');

    expect(h.host.handleKeydown(keyboard({ code: 'KeyH', key: 'h' }).event)).toBe(true);
    expect(hints.hasClass('is-hidden')).toBe(true);

    expect(h.host.handleKeydown(keyboard({ code: 'KeyH', key: 'h' }).event)).toBe(true);
    expect(hints.hasClass('is-hidden')).toBe(false);
    h.host.dispose();
  });

  it('focuses the runner root on mount unless the shell opts out', async () => {
    vi.useFakeTimers();
    try {
      const focused = harness(twoOptionGraph());
      await focused.host.mount(focused.root as unknown as HTMLElement);
      vi.runAllTimers();
      expect(focused.root.focusCount).toBe(1);
      focused.host.dispose();

      const sidebar = harness(twoOptionGraph());
      (sidebar.host as unknown as { options: { autoFocusOnMount?: boolean } }).options.autoFocusOnMount = false;
      await sidebar.host.mount(sidebar.root as unknown as HTMLElement);
      vi.runAllTimers();
      expect(sidebar.root.focusCount).toBe(0);
      sidebar.host.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores root focus after a digit action removes the clicked control', async () => {
    vi.useFakeTimers();
    try {
      const h = harness(twoOptionGraph());
      await h.host.mount(h.root as unknown as HTMLElement);
      const before = h.root.focusCount;
      h.host.handleKeydown(keyboard({ code: 'Digit2', key: '2' }).event);
      await flushMicrotasks();
      vi.runAllTimers();
      expect(h.root.focusCount).toBeGreaterThan(before);
      h.host.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes through the host on Escape, including the draft confirmation path', async () => {
    const clean = harness(twoOptionGraph());
    await clean.host.mount(clean.root as unknown as HTMLElement);
    expect(clean.host.handleKeydown(keyboard({ code: 'Escape', key: 'Escape' }).event)).toBe(true);
    expect(clean.onRequestClose).toHaveBeenCalledTimes(1);
    clean.host.dispose();

    const dirty = harness(twoOptionGraph(), '{}', true);
    await dirty.host.mount(dirty.root as unknown as HTMLElement);
    const draft = dirty.root.querySelector('.rp-runner-draft')!.querySelector('textarea')!;
    draft.value = 'Keep me';
    draft.dispatchEvent({ type: 'input' });
    expect(dirty.host.handleKeydown(keyboard({ code: 'Escape', key: 'Escape' }).event)).toBe(true);
    expect(confirmations).toHaveLength(1);
    expect(dirty.onRequestClose).not.toHaveBeenCalled();
    dirty.host.dispose();
  });

  it('inserts the conclusion draft with V and reports it in the hint row', async () => {
    const h = harness(twoOptionGraph(), '{}', true);
    let text = 'Seed';
    const editor = {
      getValue: () => text,
      getCursor: () => ({ line: 0, ch: 4 }),
      posToOffset: () => 4,
      offsetToPos: () => ({ line: 0, ch: 4 }),
      replaceRange: (inserted: string) => { text += inserted; },
      setCursor: () => {},
    };
    h.app.workspace.iterateAllLeaves.mockImplementation((callback: any) => callback({
      view: { file: h.targetNote, editor, getMode: () => 'source', save: async () => {} },
    }));
    await h.host.mount(h.root as unknown as HTMLElement);

    const draft = h.root.querySelector('.rp-runner-draft')!.querySelector('textarea')!;
    draft.value = 'Drafted conclusion';
    draft.dispatchEvent({ type: 'input' });
    // The hint row refreshes on the next render (V availability is per-render).
    (h.host as any).render();
    const labels = h.root.querySelector('.rp-runner-key-hints')!
      .querySelectorAll('.rp-runner-key-hint-label').map((el) => el._text);
    expect(labels).toContain('Вставить');

    expect(h.host.handleKeydown(keyboard({ code: 'KeyV', key: 'v' }).event)).toBe(true);
    await flushMicrotasks();
    expect(text).toBe('SeedDrafted conclusion');
    h.host.dispose();
  });

  it('focuses the first blank free-text field with F', async () => {
    const h = harness(freeTextDraftGraph());
    await h.host.mount(h.root as unknown as HTMLElement);
    const [first, second] = h.root.querySelectorAll('.rp-free-text-answer-textarea');
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    first!.value = 'already typed';
    first!.dispatchEvent({ type: 'input' });

    expect(h.host.handleKeydown(keyboard({ code: 'KeyF', key: 'f' }).event)).toBe(true);
    expect(second!.focusCount).toBe(1);
    expect(first!.focusCount).toBe(0);
    h.host.dispose();
  });

  it('keeps the whole keymap inert while a note write is blocked', async () => {
    const h = harness(twoOptionGraph());
    const pendingRead = deferred<string>();
    h.app.vault.read.mockImplementation((file: { path: string }) =>
      file.path === h.protocolFile.path ? Promise.resolve('{}') : pendingRead.promise);
    await h.host.mount(h.root as unknown as HTMLElement);
    h.root.querySelector('.rp-answer-btn')!.dispatchEvent({ type: 'click' });
    await flushMicrotasks(2);

    const { event, preventDefault } = keyboard({ code: 'Digit1', key: '1' });
    expect(h.host.handleKeydown(event)).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    pendingRead.resolve('Seed\n');
    await flushMicrotasks();
    h.host.dispose();
  });
});
