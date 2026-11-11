import { describe, expect, it, vi } from 'vitest';
import type { ProtocolGraph, RPEdge, RPNode } from '../../graph/graph-model';
import { renderRunnerFooter } from '../../runner/render/render-footer';
import { renderLoopPicker, type LoopPickerHost } from '../../runner/render/render-loop-picker';

class MockEl {
  children: MockEl[] = [];
  parent: MockEl | null = null;
  cls = '';
  text = '';
  title = '';
  disabled = false;
  attrs = new Map<string, string>();
  clickHandler: ((ev: MouseEvent) => void) | null = null;
  value = '';
  style: Record<string, string> = {};
  scrollHeight = 24;
  focusCount = 0;
  private readonly listeners = new Map<string, Array<(ev: any) => void>>();

  constructor(readonly tag: string) {}

  createDiv(opts?: { cls?: string }): MockEl {
    const child = new MockEl('div');
    child.cls = opts?.cls ?? '';
    child.parent = this;
    this.children.push(child);
    return child;
  }

  createSpan(opts?: { cls?: string; text?: string }): MockEl {
    return this.createEl('span', opts);
  }

  createEl(tag: string, opts?: { cls?: string; text?: string; attr?: Record<string, string> }): MockEl {
    const child = new MockEl(tag);
    child.cls = opts?.cls ?? '';
    child.text = opts?.text ?? '';
    child.parent = this;
    if (opts?.attr) {
      for (const [k, v] of Object.entries(opts.attr)) {
        child.setAttribute(k, String(v));
      }
    }
    this.children.push(child);
    return child;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }

  addEventListener(type: string, handler: (ev: any) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  dispatchEvent(event: any): void {
    for (const handler of this.listeners.get(event.type) ?? []) {
      handler({ ...event, target: event.target ?? this });
    }
  }

  setCssProps(props: Record<string, string>): void {
    for (const [key, value] of Object.entries(props)) this.style[key] = value;
  }

  focus(): void {
    this.focusCount += 1;
  }

  remove(): void {
    if (this.parent === null) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = null;
  }
}

function asHtml(el: MockEl): HTMLElement {
  return el as unknown as HTMLElement;
}

function findByClass(root: MockEl, cls: string): MockEl[] {
  const out: MockEl[] = [];
  const visit = (el: MockEl): void => {
    if (el.cls.split(/\s+/).includes(cls)) out.push(el);
    for (const child of el.children) visit(child);
  };
  visit(root);
  return out;
}

function node(id: string, kind: RPNode['kind'], extra: Partial<RPNode> = {}): RPNode {
  return {
    id,
    kind,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    ...(kind === 'answer' ? { answerText: id } : {}),
    ...(kind === 'question' ? { questionText: id } : {}),
    ...(kind === 'text-block' ? { content: id } : {}),
    ...(kind === 'loop-start' ? { loopLabel: id, exitLabel: 'exit' } : {}),
    ...(kind === 'loop-end' ? { loopStartId: 'loop' } : {}),
    ...extra,
  } as RPNode;
}

function graph(edges: RPEdge[]): ProtocolGraph {
  const nodes = new Map<string, RPNode>();
  nodes.set('loop', node('loop', 'question', { questionText: 'Repeat?', loop: true }));
  nodes.set('body', node('body', 'answer', { answerText: 'Body answer', displayLabel: 'Body label' }));
  nodes.set('exit', node('exit', 'text-block', { content: 'Done' }));
  return {
    canvasFilePath: 'test.canvas',
    nodes,
    edges,
    adjacency: new Map(),
    reverseAdjacency: new Map(),
    startNodeId: 'loop',
  };
}

function makeHost(overrides: Partial<LoopPickerHost> = {}): LoopPickerHost {
  return {
    bindClick: (el, handler) => {
      (el as unknown as MockEl).clickHandler = handler;
    },
    bindInput: (el, handler) => {
      (el as unknown as MockEl).addEventListener('input', handler as (ev: any) => void);
    },
    bindKeydown: (el, handler) => {
      (el as unknown as MockEl).addEventListener('keydown', handler as (ev: any) => void);
    },
    scheduleTextareaResize: (_textarea, resize) => resize(),
    renderError: vi.fn(),
    getAnswerDraft: () => '',
    onAnswerDraftChange: () => true,
    getAnswerError: () => undefined,
    onSubmitFreeText: vi.fn(),
    onChooseLoopBranch: vi.fn(),
    getAnswerFocusRequest: () => null,
    requestAnswerFocus: vi.fn(),
    registerOption: vi.fn(),
    t: (key: string) => (key === 'protocolRunner.freeTextSubmit' ? 'Submit' : key),
    ...overrides,
  };
}

describe('shared runner footer renderer', () => {
  it('renders Back/Skip icon buttons with synchronous back disable guard', () => {
    const root = new MockEl('root');
    const onBack = vi.fn();
    const onSkip = vi.fn();
    renderRunnerFooter(asHtml(root), {
      bindClick: (el, handler) => {
        (el as unknown as MockEl).clickHandler = handler;
      },
    }, {
      showBack: true,
      onBack,
      showSkip: true,
      onSkip,
      t: (key: string) => key === 'protocolRunner.stepBack' ? 'Go back one step (Ctrl+←)' : key === 'protocolRunner.stepSkip' ? 'Skip this question' : key,
    });

    const back = findByClass(root, 'rp-step-back-btn')[0]!;
    const skip = findByClass(root, 'rp-skip-btn')[0]!;
    back.clickHandler?.({} as MouseEvent);
    skip.clickHandler?.({} as MouseEvent);

    expect(back.disabled).toBe(true);
    expect(skip.attrs.get('aria-label')).toBe('Skip this question');
    expect(back.attrs.get('aria-label')).toBe('Go back one step (Ctrl+←)');
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('uses i18n key as fallback when no t function is provided', () => {
    const root = new MockEl('root');
    renderRunnerFooter(asHtml(root), {
      bindClick: (el, handler) => {
        (el as unknown as MockEl).clickHandler = handler;
      },
    }, {
      showBack: true,
      onBack: () => {},
    });

    const back = findByClass(root, 'rp-step-back-btn')[0]!;
    expect(back.attrs.get('aria-label')).toBe('protocolRunner.stepBack');
  });

  it('renders Redo button with localized aria-label', () => {
    const root = new MockEl('root');
    const onRedo = vi.fn();
    renderRunnerFooter(asHtml(root), {
      bindClick: (el, handler) => {
        (el as unknown as MockEl).clickHandler = handler;
      },
    }, {
      showBack: false,
      onBack: () => {},
      showRedo: true,
      onRedo,
      t: (key: string) => key === 'protocolRunner.stepRedo' ? 'Redo (Ctrl+→)' : key,
    });

    const redo = findByClass(root, 'rp-step-redo-btn')[0]!;
    expect(redo.attrs.get('aria-label')).toBe('Redo (Ctrl+→)');
    redo.clickHandler?.({} as MouseEvent);
    expect(onRedo).toHaveBeenCalledTimes(1);
    expect(redo.disabled).toBe(true);
  });

  it('does not render footer when no buttons are visible', () => {
    const root = new MockEl('root');
    renderRunnerFooter(asHtml(root), {
      bindClick: () => {},
    }, {
      showBack: false,
      onBack: () => {},
    });

    expect(root.children.length).toBe(0);
  });

  it('does not use title attribute on any button (Obsidian icon tooltip pitfall)', () => {
    const root = new MockEl('root');
    renderRunnerFooter(asHtml(root), {
      bindClick: (el, handler) => {
        (el as unknown as MockEl).clickHandler = handler;
      },
    }, {
      showBack: true,
      onBack: () => {},
      showSkip: true,
      onSkip: () => {},
      showRedo: true,
      onRedo: () => {},
      t: (key: string) => {
        const map: Record<string, string> = {
          'protocolRunner.stepBack': 'Go back one step (Ctrl+←)',
          'protocolRunner.stepRedo': 'Redo (Ctrl+→)',
          'protocolRunner.stepSkip': 'Skip this question',
        };
        return map[key] ?? key;
      },
    });

    for (const btn of findByClass(root, 'rp-runner-icon-btn')) {
      expect(btn.attrs.get('title') ?? null).toBeNull();
      expect(btn.attrs.get('aria-label')).not.toBeNull();
    }
  });
});

describe('shared loop picker renderer', () => {
  it('renders header in text zone, body/exit buttons in action zone, and delegates clicks', () => {
    const textZone = new MockEl('text');
    const actionZone = new MockEl('actions');
    const bodyEdge = { id: 'e-body', fromNodeId: 'loop', toNodeId: 'body' };
    const exitEdge = { id: 'e-exit', fromNodeId: 'loop', toNodeId: 'exit', label: 'finish', isLoopExit: true };
    const onChooseLoopBranch = vi.fn();

    const rendered = renderLoopPicker(asHtml(textZone), asHtml(actionZone), graph([bodyEdge, exitEdge]), {
      status: 'awaiting-loop-pick',
      nodeId: 'loop',
      accumulatedText: 'before',
      canStepBack: true,
      canRedo: false,
      undoStackSize: 0,
    }, makeHost({ onChooseLoopBranch }));

    expect(rendered).toBe(true);
    expect(findByClass(textZone, 'rp-loop-header-text')[0]?.text).toBe('Repeat?');
    expect(findByClass(actionZone, 'rp-loop-body-btn')[0]?.text).toBe('Body label');
    expect(findByClass(actionZone, 'rp-loop-exit-btn')[0]?.text).toBe('finish');

    findByClass(actionZone, 'rp-loop-body-btn')[0]!.clickHandler?.({} as MouseEvent);
    findByClass(actionZone, 'rp-loop-exit-btn')[0]!.clickHandler?.({} as MouseEvent);

    expect(onChooseLoopBranch).toHaveBeenNthCalledWith(1, bodyEdge, false);
    expect(onChooseLoopBranch).toHaveBeenNthCalledWith(2, exitEdge, true);
  });

  it('returns false and delegates graph/node errors to host chrome', () => {
    const textZone = new MockEl('text');
    const actionZone = new MockEl('actions');
    const renderError = vi.fn();
    const host = makeHost({ bindClick: vi.fn(), renderError });
    const state = {
      status: 'awaiting-loop-pick' as const,
      nodeId: 'missing',
      accumulatedText: '',
      canStepBack: false,
      canRedo: false,
      undoStackSize: 0,
    };

    expect(renderLoopPicker(asHtml(textZone), asHtml(actionZone), null, state, host)).toBe(false);
    expect(renderLoopPicker(asHtml(textZone), asHtml(actionZone), graph([]), state, host)).toBe(false);
    expect(renderError).toHaveBeenNthCalledWith(1, ['Internal error: graph not loaded.']);
    expect(renderError).toHaveBeenNthCalledWith(2, ['Looped question "missing" not found in graph.']);
  });

  it('returns false when the node is an ordinary question (no loop toggle)', () => {
    const textZone = new MockEl('text');
    const actionZone = new MockEl('actions');
    const renderError = vi.fn();
    const graphOrdinary: ProtocolGraph = {
      ...graph([]),
      nodes: new Map<string, RPNode>([
        ['loop', node('loop', 'question', { questionText: 'Ordinary?' })],
        ['body', node('body', 'answer', { answerText: 'Body answer', displayLabel: 'Body label' })],
        ['exit', node('exit', 'text-block', { content: 'Done' })],
      ]),
    };
    const state = { status: 'awaiting-loop-pick' as const, nodeId: 'loop', accumulatedText: '', canStepBack: false, canRedo: false, undoStackSize: 0 };
    const rendered = renderLoopPicker(asHtml(textZone), asHtml(actionZone), graphOrdinary, state, makeHost({ bindClick: vi.fn(), renderError }));
    expect(rendered).toBe(false);
    expect(renderError).toHaveBeenCalledWith(['Looped question "loop" not found in graph.']);
  });

  it('an unlabeled exit edge renders empty visible text but a target-derived aria-label', () => {
    const textZone = new MockEl('text');
    const actionZone = new MockEl('actions');
    const unlabeledExit = { id: 'e-exit', fromNodeId: 'loop', toNodeId: 'exit', isLoopExit: true };
    const onChooseLoopBranch = vi.fn();
    renderLoopPicker(asHtml(textZone), asHtml(actionZone), graph([unlabeledExit]), {
      status: 'awaiting-loop-pick', nodeId: 'loop', accumulatedText: '', canStepBack: false, canRedo: false, undoStackSize: 0,
    }, makeHost({ onChooseLoopBranch }));

    const exitBtn = findByClass(actionZone, 'rp-loop-exit-btn')[0]!;
    expect(exitBtn.text).toBe('');
    // target 'exit' is a text-block with content 'Done' → nodeLabel slices to 'Done'
    expect(exitBtn.attrs.get('aria-label')).toBe('Done');
  });

  it('renders body/exit buttons in authored optionOrder when present', () => {
    const textZone = new MockEl('text');
    const actionZone = new MockEl('actions');
    const bodyEdge = { id: 'e-body', fromNodeId: 'loop', toNodeId: 'body' };
    const exitEdge = { id: 'e-exit', fromNodeId: 'loop', toNodeId: 'exit', label: 'finish', isLoopExit: true };
    const onChooseLoopBranch = vi.fn();

    // Authored order: exit first, then body (reverse of edges-array order).
    const orderedGraph: ProtocolGraph = {
      ...graph([bodyEdge, exitEdge]),
      nodes: new Map<string, RPNode>([
        ['loop', node('loop', 'question', { questionText: 'Repeat?', loop: true, optionOrder: ['e-exit', 'e-body'] })],
        ['body', node('body', 'answer', { answerText: 'Body answer', displayLabel: 'Body label' })],
        ['exit', node('exit', 'text-block', { content: 'Done' })],
      ]),
    };

    renderLoopPicker(asHtml(textZone), asHtml(actionZone), orderedGraph, {
      status: 'awaiting-loop-pick', nodeId: 'loop', accumulatedText: '', canStepBack: true, canRedo: false, undoStackSize: 0,
    }, makeHost({ onChooseLoopBranch }));

    const list = findByClass(actionZone, 'rp-loop-picker-list')[0]!;
    expect(list.children.map((b) => b.cls)).toEqual(['rp-loop-exit-btn', 'rp-loop-body-btn']);
    expect(list.children.map((b) => b.text)).toEqual(['finish', 'Body label']);
  });

  it('a whitespace-only exit label renders verbatim visible text but a target-derived aria-label', () => {
    const textZone = new MockEl('text');
    const actionZone = new MockEl('actions');
    const whitespaceExit = { id: 'e-exit', fromNodeId: 'loop', toNodeId: 'exit', label: '   ', isLoopExit: true };
    const onChooseLoopBranch = vi.fn();
    renderLoopPicker(asHtml(textZone), asHtml(actionZone), graph([whitespaceExit]), {
      status: 'awaiting-loop-pick', nodeId: 'loop', accumulatedText: '', canStepBack: false, canRedo: false, undoStackSize: 0,
    }, makeHost({ onChooseLoopBranch }));

    const exitBtn = findByClass(actionZone, 'rp-loop-exit-btn')[0]!;
    // Verbatim whitespace preserved as visible text
    expect(exitBtn.text).toBe('   ');
    // Trimmed-empty caption is treated as unlabeled → target-derived aria-label
    expect(exitBtn.attrs.get('aria-label')).toBe('Done');
  });

  it('renders an inline free-text row for a body edge targeting a free-text Answer, not a dead button', () => {
    const textZone = new MockEl('text');
    const actionZone = new MockEl('actions');
    const freeEdge = { id: 'e-free', fromNodeId: 'loop', toNodeId: 'free' };
    const exitEdge = { id: 'e-exit', fromNodeId: 'loop', toNodeId: 'exit', label: 'finish', isLoopExit: true };
    const freeGraph = graph([freeEdge, exitEdge]);
    freeGraph.nodes.set('free', node('free', 'answer', {
      answerText: 'Describe the finding', displayLabel: 'Describe', freeText: true,
    }));
    const onChooseLoopBranch = vi.fn();
    const onSubmitFreeText = vi.fn();

    const rendered = renderLoopPicker(asHtml(textZone), asHtml(actionZone), freeGraph, {
      status: 'awaiting-loop-pick', nodeId: 'loop', accumulatedText: '', canStepBack: true, canRedo: false, undoStackSize: 0,
    }, makeHost({ onChooseLoopBranch, onSubmitFreeText }));

    expect(rendered).toBe(true);
    // No plain button for the free-text branch; the exit keeps its button.
    expect(findByClass(actionZone, 'rp-loop-body-btn')).toHaveLength(0);
    expect(findByClass(actionZone, 'rp-loop-exit-btn')).toHaveLength(1);
    const rows = findByClass(actionZone, 'rp-free-text-answer');
    expect(rows).toHaveLength(1);
    expect(findByClass(rows[0]!, 'rp-free-text-answer-prompt')[0]?.text).toBe('Describe');
    const textarea = findByClass(rows[0]!, 'rp-free-text-answer-textarea')[0]!;
    expect(textarea.attrs.get('rows')).toBe('1');
    expect(textarea.attrs.get('spellcheck')).toBe('false');
    expect(findByClass(rows[0]!, 'rp-free-text-answer-submit')[0]?.text).toBe('Submit');

    // Draft is projected into the textarea.
    const draftHost = makeHost({ getAnswerDraft: () => 'drafted value' });
    const draftZone = new MockEl('actions');
    renderLoopPicker(asHtml(new MockEl('text')), asHtml(draftZone), freeGraph, {
      status: 'awaiting-loop-pick', nodeId: 'loop', accumulatedText: '', canStepBack: true, canRedo: false, undoStackSize: 0,
    }, draftHost);
    expect(findByClass(draftZone, 'rp-free-text-answer-textarea')[0]?.value).toBe('drafted value');
  });

  it('forwards input to the draft host, clears error/ARIA, grows, and submits once per click or Shift+Enter', () => {
    const textZone = new MockEl('text');
    const actionZone = new MockEl('actions');
    const freeEdge = { id: 'e-free', fromNodeId: 'loop', toNodeId: 'free' };
    const freeGraph = graph([freeEdge]);
    freeGraph.nodes.set('free', node('free', 'answer', { answerText: 'Describe', freeText: true }));
    const onAnswerDraftChange = vi.fn<(answerNode: { id: string }, value: string) => boolean>(() => true);
    const onSubmitFreeText = vi.fn<(edge: { id: string }, value: string) => void>();
    const getAnswerError = vi.fn(() => 'Enter a value');
    const host = makeHost({ onAnswerDraftChange, onSubmitFreeText, getAnswerError });

    renderLoopPicker(asHtml(textZone), asHtml(actionZone), freeGraph, {
      status: 'awaiting-loop-pick', nodeId: 'loop', accumulatedText: '', canStepBack: true, canRedo: false, undoStackSize: 0,
    }, host);

    const row = findByClass(actionZone, 'rp-free-text-answer')[0]!;
    const textarea = findByClass(row, 'rp-free-text-answer-textarea')[0]!;
    const submit = findByClass(row, 'rp-free-text-answer-submit')[0]!;
    expect(textarea.attrs.get('aria-invalid')).toBe('true');
    expect(findByClass(row, 'rp-free-text-answer-error')[0]?.text).toBe('Enter a value');

    textarea.value = 'typed text';
    textarea.dispatchEvent({ type: 'input' });
    expect(onAnswerDraftChange).toHaveBeenCalledTimes(1);
    expect(onAnswerDraftChange.mock.calls[0]?.[0]?.id).toBe('free');
    expect(onAnswerDraftChange.mock.calls[0]?.[1]).toBe('typed text');
    expect(textarea.attrs.get('aria-invalid')).toBeUndefined();
    expect(findByClass(row, 'rp-free-text-answer-error')).toHaveLength(0);
    expect(textarea.style.height).toBe(`${textarea.scrollHeight}px`);

    submit.clickHandler?.({} as MouseEvent);
    const preventDefault = vi.fn();
    textarea.dispatchEvent({
      type: 'keydown', key: 'Enter', ctrlKey: false, metaKey: false, shiftKey: true, preventDefault,
    });
    expect(onSubmitFreeText).toHaveBeenCalledTimes(2);
    expect(onSubmitFreeText.mock.calls.map((call) => [call[0]?.id, call[1]])).toEqual([
      ['e-free', 'typed text'],
      ['e-free', 'typed text'],
    ]);
    expect(preventDefault).toHaveBeenCalledTimes(1);

    // The old Ctrl/Cmd+Enter binding is gone (3.6.12)
    const modPreventDefault = vi.fn();
    textarea.dispatchEvent({
      type: 'keydown', key: 'Enter', ctrlKey: true, metaKey: false, shiftKey: false, preventDefault: modPreventDefault,
    });
    expect(onSubmitFreeText).toHaveBeenCalledTimes(2);
    expect(modPreventDefault).not.toHaveBeenCalled();
  });

  it('projects sole-action and explicit focus requests onto the free-text textarea', () => {
    const freeEdge = { id: 'e-free', fromNodeId: 'loop', toNodeId: 'free' };
    const freeGraph = graph([freeEdge]);
    freeGraph.nodes.set('free', node('free', 'answer', { answerText: 'Describe', freeText: true }));
    const requestAnswerFocus = vi.fn<(answerId: string, textarea: unknown, explicitRequest: boolean) => void>();

    const sole = makeHost({ requestAnswerFocus });
    renderLoopPicker(asHtml(new MockEl('text')), asHtml(new MockEl('actions')), freeGraph, {
      status: 'awaiting-loop-pick', nodeId: 'loop', accumulatedText: '', canStepBack: true, canRedo: false, undoStackSize: 0,
    }, sole);
    expect(requestAnswerFocus).toHaveBeenCalledTimes(1);
    expect(requestAnswerFocus.mock.calls[0]?.[0]).toBe('free');
    expect(requestAnswerFocus.mock.calls[0]?.[2]).toBe(false);

    const exitEdge = { id: 'e-exit', fromNodeId: 'loop', toNodeId: 'exit', label: 'finish', isLoopExit: true };
    const mixedGraph = graph([freeEdge, exitEdge]);
    mixedGraph.nodes.set('free', node('free', 'answer', { answerText: 'Describe', freeText: true }));
    const mixed = makeHost({ requestAnswerFocus, getAnswerFocusRequest: () => 'free' });
    renderLoopPicker(asHtml(new MockEl('text')), asHtml(new MockEl('actions')), mixedGraph, {
      status: 'awaiting-loop-pick', nodeId: 'loop', accumulatedText: '', canStepBack: true, canRedo: false, undoStackSize: 0,
    }, mixed);
    expect(requestAnswerFocus).toHaveBeenCalledTimes(2);
    expect(requestAnswerFocus.mock.calls[1]?.[0]).toBe('free');
    expect(requestAnswerFocus.mock.calls[1]?.[2]).toBe(true);
  });
});

describe('shared loop picker — numbered option registration', () => {
  const state = {
    status: 'awaiting-loop-pick' as const,
    nodeId: 'loop',
    accumulatedText: '',
    canStepBack: true,
    canRedo: false,
    undoStackSize: 0,
  };

  it('registers body and exit branches in rendered order', () => {
    const registered: Array<{ element: MockEl; activate: () => void }> = [];
    const onChooseLoopBranch = vi.fn();
    const host = makeHost({
      registerOption: (option) => registered.push(option as unknown as { element: MockEl; activate: () => void }),
      onChooseLoopBranch,
    });
    const textZone = new MockEl('div');
    const actionZone = new MockEl('div');
    renderLoopPicker(asHtml(textZone), asHtml(actionZone), graph([
      { id: 'e-body', fromNodeId: 'loop', toNodeId: 'body' },
      { id: 'e-exit', fromNodeId: 'loop', toNodeId: 'exit', isLoopExit: true, label: 'Stop' },
    ]), state, host);

    expect(registered).toHaveLength(2);
    expect(registered[0]?.element).toBe(findByClass(actionZone, 'rp-loop-body-btn')[0]);
    expect(registered[1]?.element).toBe(findByClass(actionZone, 'rp-loop-exit-btn')[0]);
    registered[1]?.activate();
    expect(onChooseLoopBranch).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'e-exit' }),
      true,
    );
  });

  it('focuses a free-text loop target instead of choosing it', () => {
    const registered: Array<{
      element: MockEl;
      activate: () => void;
      keyboardElement?: MockEl;
      submit?: () => void;
    }> = [];
    const onSubmitFreeText = vi.fn();
    const host = makeHost({
      registerOption: (option) => registered.push(option as unknown as typeof registered[number]),
      onSubmitFreeText,
    });
    const actionZone = new MockEl('div');
    const freeTextGraph = graph([
      { id: 'e-text', fromNodeId: 'loop', toNodeId: 'text' },
    ]);
    freeTextGraph.nodes.set('text', node('text', 'answer', { answerText: 'Typed', freeText: true }));
    renderLoopPicker(asHtml(new MockEl('div')), asHtml(actionZone), freeTextGraph, state, host);

    expect(registered).toHaveLength(1);
    expect(registered[0]?.keyboardElement?.tag).toBe('textarea');
    registered[0]?.activate();
    expect(registered[0]?.keyboardElement?.focusCount).toBe(1);
    expect(onSubmitFreeText).not.toHaveBeenCalled();

    // 3.6.19: Ctrl+Space submits through the same path as the button.
    const textarea = registered[0]!.keyboardElement!;
    textarea.value = 'typed into loop';
    expect(registered[0]?.submit).toBeTypeOf('function');
    registered[0]?.submit?.();
    expect(onSubmitFreeText).toHaveBeenCalledTimes(1);
    expect(onSubmitFreeText).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'e-text' }),
      'typed into loop',
    );
  });
});
