// runner/render/render-loop-picker.ts
// Phase 87 — 2-zone render: textZone (loop header text) + actionZone (body/exit buttons).
// Post loop→question merge: the picker renders for a looped Question, classifies exits
// via the explicit edge.isLoopExit flag, and uses verbatim exit labels.
//
// Free-text Answers as DIRECT branch targets render as an inline free-text row
// (prompt + textarea + Submit) instead of a dead button: the runner cannot pause
// at an auto-advanced Answer, so the input must be projected by the picker.
import type { AnswerNode, ProtocolGraph, RPEdge } from '../../graph/graph-model';
import { nodeLabel } from '../../graph/node-label';
import { orderedOutgoingEdges } from '../../graph/edge-order';
import type { RunnerState } from '../runner-state';
import { createButton, createTextarea, growAutoTextarea } from '../../utils/dom-helpers';
import { attachTextExpansion } from '../../expansion/textarea';
import type { Translator } from '../../i18n';
import type { RunnerOptionTarget } from '../option-target';

type AwaitingLoopPickState = Extract<RunnerState, { status: 'awaiting-loop-pick' }>;

export interface LoopPickerHost {
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
  onSubmitFreeText(edge: RPEdge, value: string): void | Promise<void>;
  onChooseLoopBranch(edge: RPEdge, isExit: boolean): void | Promise<void>;
  getAnswerFocusRequest(): string | null;
  requestAnswerFocus(
    answerId: string,
    textarea: HTMLTextAreaElement,
    explicitRequest: boolean,
  ): void;
  t: Translator;
}

interface FreeTextControl {
  answerId: string;
  textarea: HTMLTextAreaElement;
}

function growTextarea(textarea: HTMLTextAreaElement): void {
  growAutoTextarea(textarea);
}

/** Free-text row for a loop branch whose target Answer requires typed input. */
function appendLoopFreeTextAnswer(
  parent: HTMLElement,
  answerNode: AnswerNode,
  edge: RPEdge,
  host: LoopPickerHost,
): FreeTextControl {
  const row = parent.createDiv({ cls: 'rp-free-text-answer' });
  const label = row.createEl('label', { cls: 'rp-free-text-answer-label' });
  label.createSpan({
    cls: 'rp-free-text-answer-prompt',
    text: answerNode.displayLabel ?? answerNode.answerText,
  });

  const textarea = createTextarea(label, {
    cls: 'rp-free-text-answer-textarea',
    attr: { rows: 1 },
  });
  attachTextExpansion(textarea);
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
  // One submit path for the button, the Shift+Enter alias, and Ctrl+Space; see
  // the matching rule in render-question.ts.
  const submit = (): void => {
    void host.onSubmitFreeText(edge, textarea.value);
  };
  host.bindKeydown(textarea, (event) => {
    if (event.key !== 'Enter' || !event.shiftKey) return;
    event.preventDefault();
    submit();
  });
  host.bindClick(submitButton, submit);
  // A digit aimed at a free-text loop target focuses the field; see the
  // matching rule in render-question.ts.
  host.registerOption({
    element: row,
    keyboardElement: textarea,
    activate: () => textarea.focus(),
    submit,
  });

  host.scheduleTextareaResize(textarea, () => growTextarea(textarea));
  return { answerId: answerNode.id, textarea };
}

function requestProjectedAnswerFocus(
  controls: FreeTextControl[],
  actionableOptionCount: number,
  host: LoopPickerHost,
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

export function renderLoopPicker(
  textZone: HTMLElement,
  actionZone: HTMLElement,
  graph: ProtocolGraph | null,
  state: AwaitingLoopPickState,
  host: LoopPickerHost,
): boolean {
  if (graph === null) {
    host.renderError(['Internal error: graph not loaded.']);
    return false;
  }

  const node = graph.nodes.get(state.nodeId);
  if (node === undefined || node.kind !== 'question' || !node.loop) {
    host.renderError([`Looped question "${state.nodeId}" not found in graph.`]);
    return false;
  }

  // Render the question text above the picker when non-empty.
  if (node.questionText !== '') {
    textZone.createEl('p', {
      text: node.questionText,
      cls: 'rp-loop-header-text',
    });
  }

  // RUN-01: one control per outgoing edge (Pitfall 4 — filter edges, not adjacency).
  // Authored `optionOrder` (when present) determines the picker button order;
  // absent → edges-array order (fallback).
  const outgoing = orderedOutgoingEdges(graph, state.nodeId);
  const list = actionZone.createDiv({ cls: 'rp-loop-picker-list rp-stack-md' });
  let actionableOptionCount = 0;
  const freeTextControls: FreeTextControl[] = [];
  for (const edge of outgoing) {
    // Exit edges are identified by edge.isLoopExit === true (explicit metadata,
    // replacing the former `+`-prefix convention).
    //   * exit edge → caption = edge.label ?? '' (verbatim), class = rp-loop-exit-btn.
    //   * body edge → caption = nodeLabel(target) fallback to target id, class = rp-loop-body-btn.
    const exit = edge.isLoopExit === true;
    const target = graph.nodes.get(edge.toNodeId);
    if (target !== undefined && target.kind === 'answer' && target.freeText === true) {
      actionableOptionCount += 1;
      freeTextControls.push(appendLoopFreeTextAnswer(list, target, edge, host));
      continue;
    }
    const targetCaption = target !== undefined ? nodeLabel(target) : edge.toNodeId;
    const accessibleTargetCaption = targetCaption.trim() !== '' ? targetCaption : edge.toNodeId;
    const caption = exit ? edge.label ?? '' : targetCaption;
    const btn = createButton(list, {
      cls: exit ? 'rp-loop-exit-btn' : 'rp-loop-body-btn',
      text: caption,
      attr: caption.trim() === '' ? { 'aria-label': accessibleTargetCaption } : undefined,
    });
    actionableOptionCount += 1;
    const activate = (): void => {
      void host.onChooseLoopBranch(edge, exit);
    };
    host.bindClick(btn, activate);
    host.registerOption({ element: btn, activate });
  }
  requestProjectedAnswerFocus(freeTextControls, actionableOptionCount, host);

  return true;
}
