// runner/render/render-question.ts
// Phase 87 — 2-zone render: textZone (question text, choices text, errors) + actionZone (answer/snippet buttons).
import { orderedOutgoingEdges } from '../../graph/edge-order';
import { nodeLabel } from '../../graph/node-label';
import type { AnswerNode, ProtocolGraph, RPEdge, SnippetNode } from '../../graph/graph-model';
import type { Translator } from '../../i18n';
import { createButton, createTextarea, growAutoTextarea } from '../../utils/dom-helpers';
import type { RunnerState } from '../runner-state';
import type { RunnerOptionTarget } from '../option-target';
import { isFileBoundSnippetNode, snippetBranchLabel } from '../snippet-label';

type AtNodeState = Extract<RunnerState, { status: 'at-node' }>;

type RenderQuestionResult = 'rendered' | 'not-question' | 'error';

interface FreeTextControl {
  answerId: string;
  textarea: HTMLTextAreaElement;
}

export interface QuestionBranchHost {
  bindClick(el: HTMLElement, handler: (ev: MouseEvent) => void): void;
  bindInput(el: HTMLTextAreaElement, handler: (ev: Event) => void): void;
  bindKeydown(el: HTMLTextAreaElement, handler: (ev: KeyboardEvent) => void): void;
  /** Registers the option for numbered keyboard selection, in render order. */
  registerOption(option: RunnerOptionTarget): void;
  scheduleTextareaResize(textarea: HTMLTextAreaElement, resize: () => void): void;
  renderError(messages: string[]): void;
  getAnswerDraft(answerId: string): string;
  onAnswerDraftChange(answerNode: AnswerNode, value: string): boolean;
  getAnswerError(answerId: string): string | undefined;
  onSubmitFreeText(answerNode: AnswerNode, value: string): void | Promise<void>;
  getAnswerFocusRequest(): string | null;
  requestAnswerFocus(
    answerId: string,
    textarea: HTMLTextAreaElement,
    explicitRequest: boolean,
  ): void;
  onChooseAnswer(answerNode: AnswerNode): void | Promise<void>;
  onChooseSnippetBranch(snippetNode: SnippetNode, isFileBound: boolean): void | Promise<void>;
  onChooseQuestionBranch(edge: RPEdge): void | Promise<void>;
  t: Translator;
}

// Shared per-kind button construction for both the grouped fallback and the
// interleaved authored-order path so the CSS class, caption source, and
// callback payload are byte-for-byte identical — only the container/iteration
// order differs between the two render paths.
function appendAnswerButton(parent: HTMLElement, answerNode: AnswerNode, host: QuestionBranchHost): void {
  const btn = createButton(parent, {
    cls: 'rp-answer-btn',
    text: answerNode.displayLabel ?? answerNode.answerText,
  });
  const activate = (): void => {
    void host.onChooseAnswer(answerNode);
  };
  host.bindClick(btn, activate);
  host.registerOption({ element: btn, activate });
}

function growTextarea(textarea: HTMLTextAreaElement): void {
  growAutoTextarea(textarea);
}

function appendFreeTextAnswer(
  parent: HTMLElement,
  answerNode: AnswerNode,
  host: QuestionBranchHost,
): FreeTextControl {
  const row = parent.createDiv({ cls: 'rp-free-text-answer' });
  const label = row.createEl('label', { cls: 'rp-free-text-answer-label' });
  label.createSpan({
    cls: 'rp-free-text-answer-prompt',
    text: answerNode.displayLabel ?? answerNode.answerText,
  });

  const textarea = createTextarea(label, {
    cls: 'rp-free-text-answer-textarea',
    // Start at a single compact line; growTextarea expands it as content grows.
    attr: { rows: 1 },
  });
  textarea.value = host.getAnswerDraft(answerNode.id);

  let alertElement: HTMLElement | null = null;
  const error = host.getAnswerError(answerNode.id);
  if (error !== undefined) {
    textarea.setAttribute('aria-invalid', 'true');
    alertElement = row.createEl('p', {
      cls: 'rp-free-text-answer-error',
      text: error,
      attr: { role: 'alert' },
    });
  }

  const controls = row.createDiv({ cls: 'rp-free-text-answer-controls' });
  const submitButton = createButton(controls, {
    cls: 'rp-free-text-answer-submit',
    text: host.t('protocolRunner.freeTextSubmit'),
    attr: { type: 'button' },
  });

  host.bindInput(textarea, () => {
    const value = textarea.value;
    if (!host.onAnswerDraftChange(answerNode, value)) return;
    textarea.removeAttribute('aria-invalid');
    if (alertElement !== null) {
      alertElement.remove();
      alertElement = null;
    }
    growTextarea(textarea);
  });
  // One submit path for the button, the Shift+Enter alias, and Ctrl+Space, so
  // the three can never drift apart (the host dispatches the chord by target).
  const submit = (): void => {
    void host.onSubmitFreeText(answerNode, textarea.value);
  };
  host.bindKeydown(textarea, (event) => {
    if (event.key !== 'Enter' || !event.shiftKey) return;
    event.preventDefault();
    submit();
  });
  host.bindClick(submitButton, submit);
  // A digit aimed at a free-text option moves the caret into the field: the
  // option cannot be "chosen" until text exists, and submitting an empty draft
  // on a number press would surface a spurious validation error.
  host.registerOption({
    element: row,
    keyboardElement: textarea,
    activate: () => textarea.focus(),
    submit,
  });

  host.scheduleTextareaResize(textarea, () => growTextarea(textarea));
  return { answerId: answerNode.id, textarea };
}

function appendAnswerOption(
  parent: HTMLElement,
  answerNode: AnswerNode,
  host: QuestionBranchHost,
): FreeTextControl | null {
  if (answerNode.freeText === true) {
    return appendFreeTextAnswer(parent, answerNode, host);
  }
  appendAnswerButton(parent, answerNode, host);
  return null;
}

function appendQuestionTransitionButton(parent: HTMLElement, edge: RPEdge, graph: ProtocolGraph, host: QuestionBranchHost): void {
  const target = graph.nodes.get(edge.toNodeId);
  const fallbackCaption = target !== undefined
    ? nodeLabel(target).trim() || edge.toNodeId
    : edge.toNodeId;
  const caption = edge.label !== undefined && edge.label.trim() !== ''
    ? edge.label
    : fallbackCaption;
  const btn = createButton(parent, {
    cls: 'rp-question-transition-btn',
    text: caption,
  });
  const activate = (): void => {
    void host.onChooseQuestionBranch(edge);
  };
  host.bindClick(btn, activate);
  host.registerOption({ element: btn, activate });
}

function appendSnippetBranchButton(parent: HTMLElement, snippetNode: SnippetNode, host: QuestionBranchHost): void {
  const isFileBound = isFileBoundSnippetNode(snippetNode);
  const btn = createButton(parent, {
    cls: 'rp-snippet-branch-btn',
    text: snippetBranchLabel(snippetNode),
  });
  const activate = (): void => {
    void host.onChooseSnippetBranch(snippetNode, isFileBound);
  };
  host.bindClick(btn, activate);
  host.registerOption({ element: btn, activate });
}

function requestProjectedAnswerFocus(
  controls: FreeTextControl[],
  actionableOptionCount: number,
  host: QuestionBranchHost,
): void {
  const requestedAnswerId = host.getAnswerFocusRequest();
  for (const control of controls) {
    const isExplicitRequest = requestedAnswerId === control.answerId;
    const isSoleFreeTextAction = requestedAnswerId === null
      && actionableOptionCount === 1;
    if (isExplicitRequest || isSoleFreeTextAction) {
      host.requestAnswerFocus(
        control.answerId,
        control.textarea,
        isExplicitRequest,
      );
    }
  }
}

export function renderQuestionAtNode(
  textZone: HTMLElement,
  actionZone: HTMLElement,
  graph: ProtocolGraph | null,
  state: AtNodeState,
  host: QuestionBranchHost,
): RenderQuestionResult {
  if (graph === null) {
    host.renderError(['Internal error: graph not loaded.']);
    return 'error';
  }

  const node = graph.nodes.get(state.currentNodeId);
  if (node === undefined) {
    host.renderError([`Node "${state.currentNodeId}" not found in graph.`]);
    return 'error';
  }
  if (node.kind === 'answer') {
    // Start-from-node halt: the session began AT this Answer. Only free-text
    // Answers halt here (preset ones auto-append and advance); render the same
    // free-text row used for question branches so the radiologist can submit.
    const answerNode = node as AnswerNode;
    if (answerNode.freeText !== true) return 'not-question';
    const answerList = actionZone.createDiv({ cls: 'rp-answer-list rp-stack' });
    answerList.setCssProps({ 'margin-top': 'var(--size-4-3)' });
    const control = appendFreeTextAnswer(answerList, answerNode, host);
    requestProjectedAnswerFocus([control], 1, host);
    return 'rendered';
  }
  if (node.kind !== 'question') {
    return 'not-question';
  }

  textZone.createEl('p', {
    text: node.questionText,
    cls: 'rp-question-text',
  });

  let actionableOptionCount = 0;
  const freeTextControls: FreeTextControl[] = [];

  // Authored display order: when the question carries an `optionOrder`, render
  // its outgoing options as a single interleaved stack in that order (answers,
  // question transitions, snippet branches interleaved). Per-kind preset button
  // construction stays shared with the grouped fallback; a free-text Answer is
  // one direct child at the same authored position.
  if (node.optionOrder !== undefined) {
    const orderedEdges = orderedOutgoingEdges(graph, state.currentNodeId);
    if (orderedEdges.length > 0) {
      const optionList = actionZone.createDiv({ cls: 'rp-option-list rp-stack' });
      optionList.setCssProps({ 'margin-top': 'var(--size-4-3)' });
      for (const edge of orderedEdges) {
        const target = graph.nodes.get(edge.toNodeId);
        if (target === undefined) continue;
        if (target.kind === 'answer') {
          actionableOptionCount += 1;
          const control = appendAnswerOption(optionList, target, host);
          if (control !== null) freeTextControls.push(control);
        } else if (target.kind === 'question') {
          actionableOptionCount += 1;
          appendQuestionTransitionButton(optionList, edge, graph, host);
        } else if (target.kind === 'snippet') {
          actionableOptionCount += 1;
          appendSnippetBranchButton(optionList, target, host);
        }
      }
    }
    requestProjectedAnswerFocus(freeTextControls, actionableOptionCount, host);
    return 'rendered';
  }

  // Phase 31: partition outgoing neighbors into answer + snippet branches.
  const neighborIds = graph.adjacency.get(state.currentNodeId) ?? [];
  const answerNeighbors: AnswerNode[] = [];
  const snippetNeighbors: SnippetNode[] = [];
  for (const nid of neighborIds) {
    const neighbor = graph.nodes.get(nid);
    if (neighbor === undefined) continue;
    if (neighbor.kind === 'answer') answerNeighbors.push(neighbor);
    else if (neighbor.kind === 'snippet') snippetNeighbors.push(neighbor);
  }

  if (answerNeighbors.length > 0) {
    const answerList = actionZone.createDiv({ cls: 'rp-answer-list rp-stack' });
    answerList.setCssProps({ 'margin-top': 'var(--size-4-3)' });
    for (const answerNode of answerNeighbors) {
      actionableOptionCount += 1;
      const control = appendAnswerOption(answerList, answerNode, host);
      if (control !== null) freeTextControls.push(control);
    }
  }

  // Direct Question transitions are edge-sensitive: preserve persisted edge
  // order, caption, and identity rather than reducing them to adjacency IDs.
  const questionEdges = graph.edges.filter((edge) => {
    if (edge.fromNodeId !== state.currentNodeId) return false;
    return graph.nodes.get(edge.toNodeId)?.kind === 'question';
  });

  if (questionEdges.length > 0) {
    const transitionList = actionZone.createDiv({ cls: 'rp-question-transition-list' });
    if (answerNeighbors.length === 0) {
      transitionList.setCssProps({ 'margin-top': 'var(--size-4-3)' });
    }
    for (const edge of questionEdges) {
      actionableOptionCount += 1;
      appendQuestionTransitionButton(transitionList, edge, graph, host);
    }
  }

  if (snippetNeighbors.length > 0) {
    // Phase 31 D-02: snippet branches render below answers, visually distinct.
    const snippetList = actionZone.createDiv({ cls: 'rp-snippet-branch-list' });
    if (answerNeighbors.length === 0) {
      snippetList.setCssProps({ 'margin-top': 'var(--size-4-3)' });
    }
    for (const snippetNode of snippetNeighbors) {
      actionableOptionCount += 1;
      appendSnippetBranchButton(snippetList, snippetNode, host);
    }
  }

  requestProjectedAnswerFocus(freeTextControls, actionableOptionCount, host);
  return 'rendered';
}
