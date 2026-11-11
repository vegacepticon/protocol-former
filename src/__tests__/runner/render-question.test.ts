import { describe, expect, it, vi } from 'vitest';
import type { ProtocolGraph, RPEdge, RPNode } from '../../graph/graph-model';
import {
  renderQuestionAtNode,
  type QuestionBranchHost,
} from '../../runner/render/render-question';
import type { RunnerOptionTarget } from '../../runner/option-target';
import {
  findByClass,
  makeEl,
  type MockEl,
} from './runner-renderer-host-fixtures';

const state = {
  status: 'at-node' as const,
  currentNodeId: 'q',
  accumulatedText: 'before',
  canStepBack: true,
  canRedo: false,
  undoStackSize: 0,
};

function asHtml(element: MockEl): HTMLElement {
  return element as unknown as HTMLElement;
}

function className(element: MockEl): string {
  return Array.from(element.classList).join(' ');
}

function baseNode(id: string, kind: RPNode['kind'], extra: Partial<RPNode> = {}): RPNode {
  return {
    id,
    kind,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    ...(kind === 'question' ? { questionText: 'Pick one' } : {}),
    ...(kind === 'answer' ? { answerText: 'Answer text' } : {}),
    ...(kind === 'text-block' ? { content: 'Text' } : {}),
    ...(kind === 'loop-start' ? { loopLabel: 'Loop', exitLabel: 'Exit' } : {}),
    ...(kind === 'loop-end' ? { loopStartId: 'loop' } : {}),
    ...extra,
  } as RPNode;
}

function graphFrom(nodes: RPNode[], edges: RPEdge[]): ProtocolGraph {
  const adjacency = new Map<string, string[]>();
  const reverseAdjacency = new Map<string, string[]>();
  for (const edge of edges) {
    adjacency.set(edge.fromNodeId, [
      ...(adjacency.get(edge.fromNodeId) ?? []),
      edge.toNodeId,
    ]);
    reverseAdjacency.set(edge.toNodeId, [
      ...(reverseAdjacency.get(edge.toNodeId) ?? []),
      edge.fromNodeId,
    ]);
  }
  return {
    canvasFilePath: 'test.rp.json',
    nodes: new Map(nodes.map((node) => [node.id, node])),
    edges,
    adjacency,
    reverseAdjacency,
    startNodeId: 'q',
  };
}

function groupedGraph(current: RPNode = baseNode('q', 'question')): ProtocolGraph {
  const nodes = [
    current,
    baseNode('a1', 'answer', {
      answerText: 'Raw answer',
      displayLabel: 'Shown answer',
    }),
    baseNode('s-file', 'snippet', {
      radiprotocol_snippetPath: 'Chest/report.json',
    }),
    baseNode('s-dir', 'snippet', { snippetLabel: 'Folder label' }),
    baseNode('q-labeled', 'question', { questionText: 'Labeled target' }),
    baseNode('q-fallback', 'question', { questionText: 'Fallback question' }),
    baseNode('q-id', 'question', { questionText: '   ' }),
  ];
  return graphFrom(nodes, [
    { id: 'e-answer', fromNodeId: current.id, toNodeId: 'a1' },
    { id: 'e-file', fromNodeId: current.id, toNodeId: 's-file' },
    { id: 'e-dir', fromNodeId: current.id, toNodeId: 's-dir' },
    { id: 'e-fallback', fromNodeId: current.id, toNodeId: 'q-fallback' },
    {
      id: 'e-labeled',
      fromNodeId: current.id,
      toNodeId: 'q-labeled',
      label: 'Direct label',
    },
    {
      id: 'e-id',
      fromNodeId: current.id,
      toNodeId: 'q-id',
      label: '   ',
    },
  ]);
}

interface HostHarness {
  host: QuestionBranchHost;
  registeredOptions: RunnerOptionTarget[];
  onChooseAnswer: ReturnType<typeof vi.fn>;
  onChooseSnippetBranch: ReturnType<typeof vi.fn>;
  onChooseQuestionBranch: ReturnType<typeof vi.fn>;
  onAnswerDraftChange: ReturnType<typeof vi.fn>;
  onSubmitFreeText: ReturnType<typeof vi.fn>;
  requestAnswerFocus: ReturnType<typeof vi.fn>;
  renderError: ReturnType<typeof vi.fn>;
}

function hostHarness(options: {
  drafts?: Record<string, string>;
  errors?: Record<string, string>;
  focusRequest?: string | null;
} = {}): HostHarness {
  const onChooseAnswer = vi.fn();
  const onChooseSnippetBranch = vi.fn();
  const onChooseQuestionBranch = vi.fn();
  const onAnswerDraftChange = vi.fn(() => true);
  const onSubmitFreeText = vi.fn();
  const requestAnswerFocus = vi.fn();
  const renderError = vi.fn();
  const registeredOptions: RunnerOptionTarget[] = [];
  return {
    registeredOptions,
    host: {
      registerOption: (option) => registeredOptions.push(option),
      bindClick: (element, handler) => element.addEventListener('click', handler),
      bindInput: (element, handler) => element.addEventListener('input', handler),
      bindKeydown: (element, handler) => element.addEventListener('keydown', handler),
      scheduleTextareaResize: (_textarea, resize) => resize(),
      renderError,
      getAnswerDraft: (answerId) => options.drafts?.[answerId] ?? '',
      onAnswerDraftChange,
      getAnswerError: (answerId) => options.errors?.[answerId],
      onSubmitFreeText,
      getAnswerFocusRequest: () => options.focusRequest ?? null,
      requestAnswerFocus,
      onChooseAnswer,
      onChooseSnippetBranch,
      onChooseQuestionBranch,
      t: (key) => key === 'protocolRunner.freeTextSubmit' ? 'Submit' : key,
    },
    onChooseAnswer,
    onChooseSnippetBranch,
    onChooseQuestionBranch,
    onAnswerDraftChange,
    onSubmitFreeText,
    requestAnswerFocus,
    renderError,
  };
}

function render(
  runtimeGraph: ProtocolGraph | null,
  harness: HostHarness,
): { textZone: MockEl; actionZone: MockEl; result: ReturnType<typeof renderQuestionAtNode> } {
  const textZone = makeEl('div');
  const actionZone = makeEl('div');
  const result = renderQuestionAtNode(
    asHtml(textZone),
    asHtml(actionZone),
    runtimeGraph,
    state,
    harness.host,
  );
  return { textZone, actionZone, result };
}

describe('shared question branch renderer', () => {
  it('preserves grouped preset/question/snippet projection and callback identity', () => {
    const harness = hostHarness();
    const { textZone, actionZone, result } = render(groupedGraph(), harness);

    expect(result).toBe('rendered');
    expect(findByClass(textZone, 'rp-question-text')[0]?._text).toBe('Pick one');
    expect(actionZone.children.map(className)).toEqual([
      'rp-answer-list rp-stack',
      'rp-question-transition-list',
      'rp-snippet-branch-list',
    ]);
    expect(findByClass(actionZone, 'rp-answer-btn')[0]?._text).toBe('Shown answer');
    expect(findByClass(actionZone, 'rp-question-transition-btn').map((button) => button._text)).toEqual([
      'Fallback question',
      'Direct label',
      'q-id',
    ]);
    expect(findByClass(actionZone, 'rp-snippet-branch-btn').map((button) => button._text)).toEqual([
      '📄 report',
      '📁 Folder label',
    ]);

    findByClass(actionZone, 'rp-answer-btn')[0]!.dispatchEvent({ type: 'click' });
    for (const button of findByClass(actionZone, 'rp-question-transition-btn')) {
      button.dispatchEvent({ type: 'click' });
    }
    for (const button of findByClass(actionZone, 'rp-snippet-branch-btn')) {
      button.dispatchEvent({ type: 'click' });
    }

    expect(harness.onChooseAnswer.mock.calls[0]?.[0].id).toBe('a1');
    expect(harness.onChooseQuestionBranch.mock.calls.map((call) => call[0].id)).toEqual([
      'e-fallback',
      'e-labeled',
      'e-id',
    ]);
    expect(harness.onChooseSnippetBranch.mock.calls.map((call) => [
      call[0].id,
      call[1],
    ])).toEqual([
      ['s-file', true],
      ['s-dir', false],
    ]);
  });

  it('renders a free-text row at its exact mixed authored position', () => {
    const question = baseNode('q', 'question', {
      optionOrder: ['e-snippet', 'e-free', 'e-next', 'e-preset'],
    });
    const runtimeGraph = graphFrom([
      question,
      baseNode('free', 'answer', {
        answerText: 'Describe',
        freeText: true,
      }),
      baseNode('preset', 'answer', { answerText: 'Preset' }),
      baseNode('snippet', 'snippet', {
        radiprotocol_snippetPath: 'Chest/report.md',
      }),
      baseNode('next', 'question', { questionText: 'Next' }),
    ], [
      { id: 'e-preset', fromNodeId: 'q', toNodeId: 'preset' },
      { id: 'e-next', fromNodeId: 'q', toNodeId: 'next', label: 'Continue' },
      { id: 'e-free', fromNodeId: 'q', toNodeId: 'free' },
      { id: 'e-snippet', fromNodeId: 'q', toNodeId: 'snippet' },
    ]);
    const harness = hostHarness();
    const { actionZone } = render(runtimeGraph, harness);
    const optionList = findByClass(actionZone, 'rp-option-list')[0]!;

    expect(optionList.children.map(className)).toEqual([
      'rp-snippet-branch-btn',
      'rp-free-text-answer',
      'rp-question-transition-btn',
      'rp-answer-btn',
    ]);
    expect(findByClass(optionList, 'rp-free-text-answer-prompt')[0]?._text).toBe('Describe');
    expect(harness.requestAnswerFocus).not.toHaveBeenCalled();
  });

  it('projects authored prompt, draft, implicit label, blank error, and ARIA safely', () => {
    const runtimeGraph = graphFrom([
      baseNode('q', 'question'),
      baseNode('free-label', 'answer', {
        answerText: 'Fallback prompt',
        displayLabel: 'Authored label',
        freeText: true,
      }),
      baseNode('free-fallback', 'answer', {
        answerText: 'Fallback prompt',
        freeText: true,
      }),
    ], [
      { id: 'e-label', fromNodeId: 'q', toNodeId: 'free-label' },
      { id: 'e-fallback', fromNodeId: 'q', toNodeId: 'free-fallback' },
    ]);
    const harness = hostHarness({
      drafts: { 'free-label': 'line one\nline two' },
      errors: { 'free-label': 'Enter a value before submitting.' },
    });
    const { actionZone } = render(runtimeGraph, harness);
    const rows = findByClass(actionZone, 'rp-free-text-answer');
    const labels = findByClass(actionZone, 'rp-free-text-answer-label');
    const prompts = findByClass(actionZone, 'rp-free-text-answer-prompt');
    const textareas = findByClass(actionZone, 'rp-free-text-answer-textarea');
    const alerts = findByClass(actionZone, 'rp-free-text-answer-error');

    expect(rows).toHaveLength(2);
    expect(labels.map((label) => label.tagName)).toEqual(['LABEL', 'LABEL']);
    expect(prompts.map((prompt) => prompt._text)).toEqual([
      'Authored label',
      'Fallback prompt',
    ]);
    expect(textareas[0]!.value).toBe('line one\nline two');
    expect(textareas[1]!.value).toBe('');
    // Browser spellcheck is disabled on all runner free-text textareas.
    expect(textareas[0]!.getAttribute('spellcheck')).toBe('false');
    expect(textareas[1]!.getAttribute('spellcheck')).toBe('false');
    expect(textareas[0]!.getAttribute('aria-invalid')).toBe('true');
    expect(textareas[1]!.getAttribute('aria-invalid')).toBeNull();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!._text).toBe('Enter a value before submitting.');
    expect(alerts[0]!.getAttribute('role')).toBe('alert');
  });

  it('forwards exact input, clears local error/ARIA, and grows initially and on input', () => {
    const runtimeGraph = graphFrom([
      baseNode('q', 'question'),
      baseNode('free', 'answer', { answerText: 'Describe', freeText: true }),
    ], [
      { id: 'e-free', fromNodeId: 'q', toNodeId: 'free' },
    ]);
    const harness = hostHarness({ errors: { free: 'Blank' } });
    const { actionZone } = render(runtimeGraph, harness);
    const textarea = findByClass(actionZone, 'rp-free-text-answer-textarea')[0]!;

    expect(textarea.style.height).toBe(`${textarea.scrollHeight}px`);
    textarea.scrollHeight = 73;
    textarea.value = '  exact\nvalue  ';
    textarea.dispatchEvent({ type: 'input' });

    expect(harness.onAnswerDraftChange).toHaveBeenCalledTimes(1);
    expect(harness.onAnswerDraftChange.mock.calls[0]?.[0].id).toBe('free');
    expect(harness.onAnswerDraftChange.mock.calls[0]?.[1]).toBe('  exact\nvalue  ');
    expect(textarea.style.height).toBe('73px');
    expect(textarea.getAttribute('aria-invalid')).toBeNull();
    expect(findByClass(actionZone, 'rp-free-text-answer-error')).toHaveLength(0);
  });

  it('submits once per click or Shift+Enter, leaves plain Enter untouched, and binds one listener per event', () => {
    const runtimeGraph = graphFrom([
      baseNode('q', 'question'),
      baseNode('free', 'answer', { answerText: 'Describe', freeText: true }),
    ], [
      { id: 'e-free', fromNodeId: 'q', toNodeId: 'free' },
    ]);
    const harness = hostHarness();
    const { actionZone } = render(runtimeGraph, harness);
    const textarea = findByClass(actionZone, 'rp-free-text-answer-textarea')[0]!;
    const submit = findByClass(actionZone, 'rp-free-text-answer-submit')[0]!;
    textarea.value = 'submitted';

    expect(textarea._listeners.get('input')).toHaveLength(1);
    expect(textarea._listeners.get('keydown')).toHaveLength(1);
    expect(submit._listeners.get('click')).toHaveLength(1);
    expect(submit._text).toBe('Submit');

    submit.dispatchEvent({ type: 'click' });
    const shiftPreventDefault = vi.fn();
    textarea.dispatchEvent({
      type: 'keydown',
      key: 'Enter',
      ctrlKey: false,
      metaKey: false,
      shiftKey: true,
      preventDefault: shiftPreventDefault,
    });

    expect(harness.onSubmitFreeText).toHaveBeenCalledTimes(2);
    expect(harness.onSubmitFreeText.mock.calls.map((call) => [
      call[0].id,
      call[1],
    ])).toEqual([
      ['free', 'submitted'],
      ['free', 'submitted'],
    ]);
    expect(shiftPreventDefault).toHaveBeenCalledTimes(1);

    // Mod+Enter / Meta+Enter / plain Enter are NOT submission hotkeys (3.6.12)
    const modPreventDefault = vi.fn();
    textarea.dispatchEvent({
      type: 'keydown',
      key: 'Enter',
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      preventDefault: modPreventDefault,
    });
    const metaPreventDefault = vi.fn();
    textarea.dispatchEvent({
      type: 'keydown',
      key: 'Enter',
      ctrlKey: false,
      metaKey: true,
      shiftKey: false,
      preventDefault: metaPreventDefault,
    });
    const plainPreventDefault = vi.fn();
    textarea.dispatchEvent({
      type: 'keydown',
      key: 'Enter',
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      preventDefault: plainPreventDefault,
    });
    expect(harness.onSubmitFreeText).toHaveBeenCalledTimes(2);
    expect(modPreventDefault).not.toHaveBeenCalled();
    expect(metaPreventDefault).not.toHaveBeenCalled();
    expect(plainPreventDefault).not.toHaveBeenCalled();

    // 3.6.19: the registered option carries the same submit path, so the host
    // can route Ctrl+Space to the field that owns the event target.
    const freeTextOption = harness.registeredOptions.find(
      (option) => (option.keyboardElement as unknown as MockEl | undefined) === textarea,
    );
    expect(freeTextOption?.submit).toBeTypeOf('function');
    freeTextOption?.submit?.();
    expect(harness.onSubmitFreeText).toHaveBeenCalledTimes(3);
    expect(harness.onSubmitFreeText.mock.calls[2]).toEqual([
      expect.objectContaining({ id: 'free' }),
      'submitted',
    ]);
  });

  it('requests initial focus only for a sole free-text action and honors explicit mixed-question focus', () => {
    const soleGraph = graphFrom([
      baseNode('q', 'question'),
      baseNode('free', 'answer', { answerText: 'Describe', freeText: true }),
    ], [
      { id: 'e-free', fromNodeId: 'q', toNodeId: 'free' },
    ]);
    const sole = hostHarness();
    const soleRender = render(soleGraph, sole);
    expect(sole.requestAnswerFocus).toHaveBeenCalledTimes(1);
    expect(sole.requestAnswerFocus.mock.calls[0]?.[0]).toBe('free');
    expect(sole.requestAnswerFocus.mock.calls[0]?.[1]).toBe(
      findByClass(soleRender.actionZone, 'rp-free-text-answer-textarea')[0],
    );
    expect(sole.requestAnswerFocus.mock.calls[0]?.[2]).toBe(false);

    const mixedGraph = graphFrom([
      baseNode('q', 'question'),
      baseNode('free', 'answer', { answerText: 'Describe', freeText: true }),
      baseNode('preset', 'answer', { answerText: 'Preset' }),
      baseNode('snippet', 'snippet', { snippetLabel: 'Snippet' }),
      baseNode('next', 'question', { questionText: 'Next' }),
    ], [
      { id: 'e-free', fromNodeId: 'q', toNodeId: 'free' },
      { id: 'e-preset', fromNodeId: 'q', toNodeId: 'preset' },
      { id: 'e-snippet', fromNodeId: 'q', toNodeId: 'snippet' },
      { id: 'e-next', fromNodeId: 'q', toNodeId: 'next' },
    ]);
    const mixedInitial = hostHarness();
    render(mixedGraph, mixedInitial);
    expect(mixedInitial.requestAnswerFocus).not.toHaveBeenCalled();

    const mixedError = hostHarness({ focusRequest: 'free' });
    const mixedRender = render(mixedGraph, mixedError);
    expect(mixedError.requestAnswerFocus).toHaveBeenCalledTimes(1);
    expect(mixedError.requestAnswerFocus.mock.calls[0]?.[0]).toBe('free');
    expect(mixedError.requestAnswerFocus.mock.calls[0]?.[1]).toBe(
      findByClass(mixedRender.actionZone, 'rp-free-text-answer-textarea')[0],
    );
    expect(mixedError.requestAnswerFocus.mock.calls[0]?.[2]).toBe(true);
  });

  it('returns error/not-question for host-specific chrome handling', () => {
    const harness = hostHarness();
    expect(render(null, harness).result).toBe('error');
    expect(harness.renderError).toHaveBeenCalledWith([
      'Internal error: graph not loaded.',
    ]);

    const nonQuestion = groupedGraph(baseNode('q', 'text-block'));
    expect(render(nonQuestion, hostHarness()).result).toBe('not-question');
  });
});

describe('start-from-node answer halt renderer', () => {
  function answerStartGraph(answerExtra: Partial<RPNode> = {}): ProtocolGraph {
    return graphFrom([
      baseNode('a1', 'answer', { displayLabel: 'Conclusion prompt', ...answerExtra }),
    ], []);
  }

  const answerState = {
    status: 'at-node' as const,
    currentNodeId: 'a1',
    accumulatedText: '',
    canStepBack: false,
    canRedo: false,
    undoStackSize: 0,
  };

  function renderAnswer(harness: HostHarness, extra: Partial<RPNode> = {}) {
    const textZone = makeEl('div');
    const actionZone = makeEl('div');
    const result = renderQuestionAtNode(
      asHtml(textZone),
      asHtml(actionZone),
      answerStartGraph(extra),
      answerState,
      harness.host,
    );
    return { textZone, actionZone, result };
  }

  it('renders the free-text row when a free-text Answer is the explicit start node', () => {
    const harness = hostHarness();
    const { actionZone, result } = renderAnswer(harness, { freeText: true });

    expect(result).toBe('rendered');
    expect(findByClass(actionZone, 'rp-free-text-answer')).toHaveLength(1);
    expect(findByClass(actionZone, 'rp-free-text-answer-prompt')[0]?._text)
      .toBe('Conclusion prompt');
    // The sole free-text action gets projected focus without an explicit request.
    expect(harness.requestAnswerFocus).toHaveBeenCalledTimes(1);
    expect(harness.requestAnswerFocus.mock.calls[0]?.[0]).toBe('a1');
  });

  it('reports not-question for a preset Answer start node (auto-append path)', () => {
    const harness = hostHarness();
    const { result } = renderAnswer(harness);
    expect(result).toBe('not-question');
    expect(findByClass(makeEl('div'), 'rp-free-text-answer')).toHaveLength(0);
  });
});

describe('shared question renderer — numbered option registration', () => {
  it('registers every grouped option once, in render order', () => {
    const harness = hostHarness();
    const { actionZone } = render(groupedGraph(), harness);

    expect(harness.registeredOptions).toHaveLength(6);
    const registeredElements = harness.registeredOptions.map((option) => option.element);
    // Answers render first, then question transitions, then snippet branches.
    expect(className(registeredElements[0] as unknown as MockEl)).toContain('rp-answer-btn');
    expect(className(registeredElements[1] as unknown as MockEl)).toContain('rp-question-transition-btn');
    expect(className(registeredElements[4] as unknown as MockEl)).toContain('rp-snippet-branch-btn');
    const renderedButtons = findByClass(actionZone, 'rp-answer-btn')
      .concat(findByClass(actionZone, 'rp-question-transition-btn'))
      .concat(findByClass(actionZone, 'rp-snippet-branch-btn'));
    expect(registeredElements).toEqual(renderedButtons);
  });

  it('registers authored-order options in the authored sequence', () => {
    const harness = hostHarness();
    const options = [
      baseNode('q', 'question', {
        questionText: 'Pick one',
        optionOrder: ['e-snippet', 'e-answer', 'e-next'],
      }),
      baseNode('a1', 'answer', { answerText: 'Answer' }),
      baseNode('s-dir', 'snippet', { snippetLabel: 'Snippet' }),
      baseNode('q-fallback', 'question', { questionText: 'Next' }),
    ];
    const graph = graphFrom(options, [
      { id: 'e-answer', fromNodeId: 'q', toNodeId: 'a1' },
      { id: 'e-snippet', fromNodeId: 'q', toNodeId: 's-dir' },
      { id: 'e-next', fromNodeId: 'q', toNodeId: 'q-fallback' },
    ]);
    render(graph, harness);

    expect(harness.registeredOptions).toHaveLength(3);
    const classes = harness.registeredOptions.map((option) =>
      className(option.element as unknown as MockEl));
    expect(classes[0]).toContain('rp-snippet-branch-btn');
    expect(classes[1]).toContain('rp-answer-btn');
    expect(classes[2]).toContain('rp-question-transition-btn');
  });

  it('activates the same callback as the click and focuses free-text fields', () => {
    const harness = hostHarness();
    render(groupedGraph(), harness);
    harness.registeredOptions[0]?.activate();
    expect(harness.onChooseAnswer).toHaveBeenCalledTimes(1);

    const freeTextHarness = hostHarness();
    const graph = graphFrom(
      [baseNode('q', 'question'), baseNode('a1', 'answer', { freeText: true, answerText: 'Type' })],
      [{ id: 'e-answer', fromNodeId: 'q', toNodeId: 'a1' }],
    );
    render(graph, freeTextHarness);
    const freeTextOption = freeTextHarness.registeredOptions[0];
    expect(freeTextOption?.element).toBeDefined();
    expect(freeTextOption?.keyboardElement?.tagName).toBe('TEXTAREA');
    freeTextOption?.activate();
    expect((freeTextOption?.keyboardElement as unknown as MockEl).focusCount).toBe(1);
    expect(freeTextHarness.onSubmitFreeText).not.toHaveBeenCalled();
  });
});
