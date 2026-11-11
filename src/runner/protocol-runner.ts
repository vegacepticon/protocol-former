// runner/protocol-runner.ts
// Pure module — zero Obsidian API imports (NFR-01)
import type { ProtocolGraph, LoopContext } from '../graph/graph-model';
import { orderedOutgoingEdges } from '../graph/edge-order';
import type { RunnerState, UndoEntry, RedoEntry } from './runner-state';
import { TextAccumulator } from './text-accumulator';
import { RUNNER_STATUS } from '../constants/runner-states';
import { defaultT, type Translator } from '../i18n';

interface ProtocolRunnerOptions {
  /** Hard maximum loop iteration count before transitioning to error state. Default: 50. (D-08, RUN-09) */
  maxIterations?: number;
  /** Separator inserted between text chunks when no per-node override is set. Default: 'newline'. (D-08, SEP-01) */
  defaultSeparator?: 'newline' | 'space';
  /** Phase 84 I18N-02: translator for runner-emitted runtime error messages. Defaults to English
   *  (defaultT) for pure-test sites that don't carry a plugin reference. */
  t?: Translator;
}

/**
 * Pure traversal state machine for Protocol Former sessions.
 *
 * Public API (D-01):
 *   start(graph)              — begin a session
 *   chooseAnswer(answerId, submittedText?) — select a preset or free-text Answer
 *   chooseQuestionBranch(edgeId) — user selects a direct Question-to-Question edge
 *   stepBack()                — undo last user action
 *   completeSnippet(text)     — Phase 5 submits rendered snippet text
 *   getState()                — read-only snapshot of current state (D-02)
 *
 * No Obsidian API — fully unit-testable with Vitest in a pure Node.js environment.
 */
export class ProtocolRunner {
  private readonly maxIterations: number;
  private readonly defaultSeparator: 'newline' | 'space';
  /** Phase 84 I18N-02: translator (defaults to English defaultT). */
  private readonly t: Translator;

  private graph: ProtocolGraph | null = null;
  private currentNodeId: string | null = null;
  private accumulator = new TextAccumulator();
  private undoStack: UndoEntry[] = [];
  private redoStack: RedoEntry[] = [];
  /** Phase 66 D-01: silently no-ops a second stepBack call in the same synchronous tick. */
  private _stepBackInFlight = false;
  private runnerStatus: RunnerState['status'] = RUNNER_STATUS.IDLE;
  /**
   * Start-from-node support: when the explicit session start node is a free-text
   * Answer, advanceThrough must HALT on it instead of passing through silently,
   * so the radiologist is prompted for the report text. Null for every other
   * start configuration (preset Answers keep their normal auto-append flow).
   */
  private explicitStartFreeTextAnswerId: string | null = null;

  // Extra fields for non-at-node states
  private errorMessage: string | null = null;
  private snippetId: string | null = null;
  private snippetNodeId: string | null = null;
  private loopContextStack: LoopContext[] = [];

  constructor(options: ProtocolRunnerOptions = {}) {
    this.maxIterations = options.maxIterations ?? 50;
    this.defaultSeparator = options.defaultSeparator ?? 'newline';
    this.t = options.t ?? defaultT;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Start a new protocol session.
   * Transitions from idle to at-node (or error if graph has no start node).
   *
   * @param graph — protocol graph to traverse
   * @param startNodeId — Phase 45 (LOOP-06 / D-14): optional explicit starting node id.
   *                      When provided, auto-advance begins from this node instead of
   *                      graph.startNodeId. Used by the start-from-node command
   *                      (main.ts handleStartFromNode). When omitted, defaults to
   *                      graph.startNodeId for backward compatibility with v1.0 flow.
   */
  start(graph: ProtocolGraph, startNodeId?: string): void {
    this.graph = graph;
    this.currentNodeId = null;
    this.accumulator = new TextAccumulator();
    this.undoStack = [];
    this.redoStack = [];
    this.errorMessage = null;
    this.snippetId = null;
    this.snippetNodeId = null;
    this.loopContextStack = [];
    // Start-from-node: a free-text Answer chosen as the explicit session start
    // must HALT (prompt for text) instead of being silently passed through.
    const startNode = startNodeId !== undefined ? graph.nodes.get(startNodeId) : undefined;
    this.explicitStartFreeTextAnswerId =
      startNode !== undefined && startNode.kind === 'answer' && startNode.freeText === true
        ? startNodeId!
        : null;
    this.runnerStatus = RUNNER_STATUS.AT_NODE;
    // Auto-advance from the explicit start or graph.startNodeId default
    this.advanceThrough(startNodeId ?? graph.startNodeId);
  }

  /**
   * User selects an Answer. Preset Answers append their authored answerText;
   * free-text Answers append the submitted command payload while retaining the
   * Answer id as branch identity. A blank free-text payload is rejected before
   * redo/history/accumulator/navigation mutation. Accepted text is preserved
   * verbatim after the blank-only check.
   *
   * @returns true when the Answer command was accepted; false for a wrong-state,
   * invalid Answer, or blank free-text submission.
   */
  chooseAnswer(answerId: string, submittedText?: string): boolean {
    if (this.runnerStatus !== RUNNER_STATUS.AT_NODE) return false;
    if (this.graph === null || this.currentNodeId === null) return false;

    const answerNode = this.graph.nodes.get(answerId);
    if (answerNode === undefined || answerNode.kind !== 'answer') {
      this.transitionToError(`Answer node '${answerId}' not found or is not an answer node.`);
      return false;
    }

    const textToAppend = answerNode.freeText === true
      ? submittedText
      : answerNode.answerText;
    if (answerNode.freeText === true && (textToAppend === undefined || textToAppend.trim() === '')) {
      return false;
    }

    // Forward action — clear redo stack (any undone transition is now invalidated)
    this.redoStack = [];
    // Push undo entry BEFORE any mutation (Pitfall 3 — snapshot must come first)
    this.undoStack.push({
      nodeId: this.currentNodeId,
      textSnapshot: this.accumulator.snapshot(),
      loopContextStack: this.loopContextStack.map(f => ({ ...f })),
    });

    // Append the authored text for preset Answers, or the accepted command payload
    // for free-text Answers. A truly empty preset answer behaves like Skip.
    this.appendAnswerText(textToAppend ?? '', this.resolveSeparator(answerNode));

    // Advance to the next node after this answer.
    // Phase 44 UAT-fix: dead-end answer inside a loop body returns to the owning picker
    // (iteration++) instead of completing the protocol — matches the auto-advance contract in
    // advanceOrReturnToLoop (protocol-runner.ts:682-700). Outside a loop, dead-end still completes.
    const neighbors = this.graph.adjacency.get(answerId);
    const next = neighbors !== undefined ? neighbors[0] : undefined;
    if (next !== undefined) this.exitTrivialLoopFrames(next);
    if (next === undefined) {
      this.advanceOrReturnToLoop(undefined);
      return true;
    }
    this.advanceThrough(next);
    return true;
  }

  /**
   * Phase 53 RUNNER-SKIP-02 / D-08 / D-10:
   * User clicks the Skip button on a question node — advance through the first
   * answer-kind neighbor WITHOUT appending the answer's text to the accumulator.
   * Pushes an UndoEntry BEFORE mutation so stepBack returns to the question.
   * Snippet neighbors are ignored (D-09). No-op outside at-node + question context.
   * BUG-01 / D-11 is enforced by the caller (currently InlineRunnerModal click handler) via
   * syncManualEdit before invoking skip() — this method uses accumulator.snapshot()
   * which reflects any synced manual edit.
   */
  skip(): void {
    if (this.runnerStatus !== RUNNER_STATUS.AT_NODE) return;
    if (this.graph === null || this.currentNodeId === null) return;

    const currentNode = this.graph.nodes.get(this.currentNodeId);
    if (currentNode === undefined || currentNode.kind !== 'question') return;

    // FR-8 / D-08 / D-09: select the first answer-kind option. When the question
    // carries an authored `optionOrder`, resolve its outgoing edges in display
    // order and pick the first whose target is an answer; stale ids yield no
    // target and are skipped silently. If `optionOrder` is absent OR yields no
    // answer edge, fall back to today's adjacency-order scan.
    let skipTargetId: string | undefined;
    if (currentNode.optionOrder !== undefined) {
      const orderedEdges = orderedOutgoingEdges(this.graph, this.currentNodeId);
      for (const edge of orderedEdges) {
        const target = this.graph.nodes.get(edge.toNodeId);
        if (target !== undefined && target.kind === 'answer') { skipTargetId = edge.toNodeId; break; }
      }
    }
    if (skipTargetId === undefined) {
      const neighborIds = this.graph.adjacency.get(this.currentNodeId) ?? [];
      for (const nid of neighborIds) {
        const n = this.graph.nodes.get(nid);
        if (n !== undefined && n.kind === 'answer') { skipTargetId = nid; break; }
      }
    }
    if (skipTargetId === undefined) return;  // no answer neighbor — UI hides the button, this is defence in depth

    // Forward action — clear redo stack
    this.redoStack = [];
    // D-10: Skip is a full choice — push UndoEntry BEFORE any mutation (Pitfall 3).
    this.undoStack.push({
      nodeId: this.currentNodeId,
      textSnapshot: this.accumulator.snapshot(),
      loopContextStack: this.loopContextStack.map(f => ({ ...f })),
    });

    // D-08: advance through the answer's first neighbor (same dead-end / loop-return
    // contract as chooseAnswer lines 104-110). Accumulator is NOT touched.
    const answerNeighbors = this.graph.adjacency.get(skipTargetId);
    const next = answerNeighbors !== undefined ? answerNeighbors[0] : undefined;
    if (next !== undefined) this.exitTrivialLoopFrames(next);
    if (next === undefined) {
      this.advanceOrReturnToLoop(undefined);
      return;
    }
    this.advanceThrough(next);
  }

  /**
   * Phase 31 D-08: user picks a snippet-kind branch at a question node.
   * Valid only in 'at-node' state when the current node is a question AND
   * the target is a direct snippet neighbour of that question. Pushes an
   * UndoEntry with returnToBranchList=true BEFORE any mutation so that
   * stepBack() returns the user to the question's branch list (not the
   * question's predecessor). Does NOT append anything to the accumulator —
   * the snippet picker takes over and the actual text insertion happens
   * later via completeSnippet().
   */
  chooseSnippetBranch(snippetNodeId: string): void {
    if (this.runnerStatus !== RUNNER_STATUS.AT_NODE) return;
    if (this.graph === null || this.currentNodeId === null) return;

    const currentNode = this.graph.nodes.get(this.currentNodeId);
    if (currentNode === undefined || currentNode.kind !== 'question') {
      this.transitionToError(
        `chooseSnippetBranch called when current node '${this.currentNodeId}' is not a question.`,
      );
      return;
    }

    const snippetNode = this.graph.nodes.get(snippetNodeId);
    if (snippetNode === undefined || snippetNode.kind !== 'snippet') {
      this.transitionToError(
        `Snippet node '${snippetNodeId}' not found or is not a snippet node.`,
      );
      return;
    }

    const neighbours = this.graph.adjacency.get(this.currentNodeId);
    if (neighbours === undefined || !neighbours.includes(snippetNodeId)) {
      this.transitionToError(
        `Snippet node '${snippetNodeId}' is not a direct branch of question '${this.currentNodeId}'.`,
      );
      return;
    }

    // Forward action — clear redo stack
    this.redoStack = [];
    // Phase 31 Pitfall 1: undo-before-mutate with returnToBranchList flag.
    this.undoStack.push({
      nodeId: this.currentNodeId, // question id
      textSnapshot: this.accumulator.snapshot(),
      loopContextStack: this.loopContextStack.map(f => ({ ...f })),
      returnToBranchList: true,
    });

    // Transition to picker at the snippet node — no accumulator mutation.
    this.currentNodeId = snippetNodeId;
    this.snippetNodeId = snippetNodeId;
    this.runnerStatus = RUNNER_STATUS.AWAITING_SNIPPET_PICK;
  }

  /**
   * User selects a direct edge from the current ordinary Question to another
   * Question. The edge ID is the stable selection identity because captions
   * and targets are not guaranteed to be unique.
   *
   * Validation completes before history mutation. A successful transition
   * preserves accumulated text, clears redo, captures one undo snapshot, and
   * delegates target-state selection to advanceThrough().
   */
  chooseQuestionBranch(edgeId: string): void {
    if (this.runnerStatus !== RUNNER_STATUS.AT_NODE) return;
    if (this.graph === null || this.currentNodeId === null) return;

    const currentNode = this.graph.nodes.get(this.currentNodeId);
    if (currentNode === undefined || currentNode.kind !== 'question' || currentNode.loop === true) {
      this.transitionToError(
        `chooseQuestionBranch called when current node '${this.currentNodeId}' is not an ordinary question.`,
      );
      return;
    }

    const edge = this.graph.edges.find(candidate => candidate.id === edgeId);
    if (edge === undefined || edge.fromNodeId !== this.currentNodeId) {
      this.transitionToError(
        `Question transition edge '${edgeId}' not found or does not originate at current question '${this.currentNodeId}'.`,
      );
      return;
    }

    const targetNode = this.graph.nodes.get(edge.toNodeId);
    if (targetNode === undefined || targetNode.kind !== 'question') {
      this.transitionToError(
        `Question transition edge '${edgeId}' does not target a question node.`,
      );
      return;
    }

    this.redoStack = [];
    this.undoStack.push({
      nodeId: this.currentNodeId,
      textSnapshot: this.accumulator.snapshot(),
      loopContextStack: this.loopContextStack.map(frame => ({ ...frame })),
    });

    // A direct transition is one user action. If its target is looped, the
    // action snapshot above replaces advanceThrough's automatic loop-entry
    // snapshot so one Back returns directly to the source Question.
    this.advanceThrough(edge.toNodeId, true);
  }

  /**
   * Phase 44 (RUN-01, RUN-03): user picks a branch at the loop picker.
   * Valid only in 'awaiting-loop-pick'. Dispatches by edge metadata:
   *   - edge.isLoopExit === true → pop the current loop frame, advance along the selected exit edge
   *   - other    → walk the body branch (B1 re-entry guard inside the looped-question
   *                case handles the iteration increment on return to picker)
   *
   * When the selected edge targets a free-text Answer, `submittedText` is
   * required (blank rejected before any mutation): the payload is appended
   * with the Answer's separator and traversal continues through the Answer's
   * first neighbour — the exact contract advanceThrough applies to a preset
   * Answer auto-advanced in a loop body (including loop quick-exit and
   * dead-end return to the picker). A preset Answer target ignores an
   * accidental payload, mirroring chooseAnswer.
   *
   * edgeId is the stable identifier per locked decision (planner D-02): labels
   * can duplicate and targetNodeIds can collide when two body branches point to
   * the same node. Only edgeId is unambiguous.
   *
   * Post loop→question merge: the exit predicate is the explicit `edge.isLoopExit`
   * flag, replacing the former `+`-prefix label convention.
   *
   * @returns true when the branch command was accepted; false for a
   * wrong-state, unknown edge, or blank free-text submission.
   */
  chooseLoopBranch(edgeId: string, submittedText?: string): boolean {
    if (this.runnerStatus !== RUNNER_STATUS.AWAITING_LOOP_PICK) return false;
    if (this.graph === null || this.currentNodeId === null) return false;

    const edge = this.graph.edges.find(e => e.id === edgeId);
    if (edge === undefined || edge.fromNodeId !== this.currentNodeId) {
      this.transitionToError(
        `Loop picker edge '${edgeId}' not found or does not originate at current looped question.`,
      );
      return false;
    }

    const target = this.graph.nodes.get(edge.toNodeId);
    const freeTextTarget = target !== undefined
      && target.kind === 'answer'
      && target.freeText === true
      ? target
      : undefined;
    if (freeTextTarget !== undefined && (submittedText === undefined || submittedText.trim() === '')) {
      return false;
    }

    // Forward action — clear redo stack
    this.redoStack = [];
    // Undo-before-mutate (Pitfall 1)
    this.undoStack.push({
      nodeId: this.currentNodeId,
      textSnapshot: this.accumulator.snapshot(),
      loopContextStack: this.loopContextStack.map(f => ({ ...f })),
      restoreStatus: RUNNER_STATUS.AWAITING_LOOP_PICK,
    });

    if (edge.isLoopExit === true) {
      // RUN-03: pop frame (top-of-stack, nested-safe). Multiple isLoopExit edges
      // are allowed; the selected edge is the concrete exit branch.
      this.loopContextStack.pop();
    }
    // Body branch: DO NOT increment iteration here. The B1 re-entry guard inside
    // case 'question' (loop === true) is the sole site that increments iteration
    // (fires on back-edge re-entry AND on inner-exit landing on outer). This keeps
    // the semantic "iteration = number of times user has seen the picker for this looped question":
    //   - First loop-entry:         iteration = 1 (halts at picker)
    //   - Pick body → walk → return: B1 increments to 2 (2nd picker view)
    //   - Pick body again → return:  B1 increments to 3 (3rd picker view)
    // Without this rule, both chooseLoopBranch AND B1 would increment, giving
    // iteration = 2*N + 1 after N picks — confusing and out of line with the
    // Plan 02b RUN-02 assertion expect(iteration).toBe(2).

    if (freeTextTarget !== undefined) {
      // Mirror advanceThrough's case 'answer' for the submitted payload: append
      // the free text, then advance from the Answer's first neighbour (the
      // Answer node itself is not re-entered because its text was just appended).
      this.appendAnswerText(submittedText ?? '', this.resolveSeparator(freeTextTarget));
      const next = this.firstNeighbour(freeTextTarget.id);

      // Quick-exit from loop body: same contract as advanceThrough's answer case
      // — if the Answer is wired directly to the same target as any of the
      // loop's isLoopExit edges, pop the loop frame so the runner continues past
      // the loop instead of returning to the picker when the branch dead-ends.
      if (this.graph !== null && this.loopContextStack.length > 0 && next !== undefined) {
        const topLoop = this.loopContextStack[this.loopContextStack.length - 1];
        if (topLoop !== undefined) {
          const exitsToNext = this.graph.edges.some(
            e => e.fromNodeId === topLoop.loopNodeId && e.isLoopExit === true && e.toNodeId === next,
          );
          if (exitsToNext) {
            this.loopContextStack.pop();
          }
        }
      }
      if (next !== undefined) this.exitTrivialLoopFrames(next);

      if (next === undefined) {
        this.advanceOrReturnToLoop(undefined);
      } else {
        this.advanceThrough(next);
      }
      return true;
    }

    this.runnerStatus = RUNNER_STATUS.AT_NODE;
    this.advanceThrough(edge.toNodeId);
    return true;
  }

  /**
   * Undo the last user action (RUN-06).
   * Reverts both currentNodeId and accumulatedText to the state before the last
   * chooseAnswer() call (D-03).
   * No-op if canStepBack is false.
   * Pushes a RedoEntry so redo() can re-apply the undone state transition.
   */
  stepBack(): void {
    if (this._stepBackInFlight) return;
    this._stepBackInFlight = true;
    queueMicrotask(() => { this._stepBackInFlight = false; });

    const entry = this.undoStack.pop();
    if (entry === undefined) return; // Nothing to undo

    // Capture current state as a RedoEntry before restoring from the popped undo entry.
    this.redoStack.push({
      nodeId: this.currentNodeId,
      textSnapshot: this.accumulator.snapshot(),
      loopContextStack: this.loopContextStack.map(f => ({ ...f })),
      runnerStatus: this.runnerStatus,
      snippetId: this.snippetId,
      snippetNodeId: this.snippetNodeId,
      poppedUndoEntry: entry,
    });

    if (entry.returnToBranchList === true) {
      // Phase 31 D-08: close the branch-entered picker, return to the
      // question's branch list — not to the question's predecessor.
      this.currentNodeId = entry.nodeId;
      this.accumulator.restoreTo(entry.textSnapshot);
      this.loopContextStack = [...entry.loopContextStack];
      this.runnerStatus = RUNNER_STATUS.AT_NODE;
      this.snippetId = null;
      this.snippetNodeId = null;
      this.errorMessage = null;
      return;
    }

    this.currentNodeId = entry.nodeId;
    this.accumulator.restoreTo(entry.textSnapshot);
    this.loopContextStack = [...entry.loopContextStack]; // restore from snapshot (LOOP-05)
    this.runnerStatus = entry.restoreStatus ?? RUNNER_STATUS.AT_NODE;
    this.errorMessage = null;
    this.snippetId = null;
    this.snippetNodeId = null;
  }

  /**
   * Redo the last undone action.
   * Restores the runner to the state that existed immediately before the most recent stepBack().
   * Clears the redo stack when a new forward action is taken (chooseAnswer, skip, etc.).
   * No-op if canRedo is false (redoStack is empty).
   */
  redo(): void {
    const entry = this.redoStack.pop();
    if (entry === undefined) return; // Nothing to redo

    // Re-push the undo entry that was popped during stepBack, so stepBack
    // works correctly after a redo.
    this.undoStack.push(entry.poppedUndoEntry);

    // Restore the state to what it was before stepBack was called.
    this.currentNodeId = entry.nodeId;
    this.accumulator.restoreTo(entry.textSnapshot);
    this.loopContextStack = entry.loopContextStack.map(f => ({ ...f }));
    this.runnerStatus = entry.runnerStatus;
    this.snippetId = entry.snippetId;
    this.snippetNodeId = entry.snippetNodeId;
    this.errorMessage = null;
  }

  /**
   * Phase 30 D-08: user picks a snippet at the current snippet node.
   * Valid only in 'awaiting-snippet-pick'. Pushes UndoEntry BEFORE any
   * mutation so stepBack reverts to the snippet node's predecessor.
   * Transitions to 'awaiting-snippet-fill'; the host then either opens
   * SnippetFillInModal (placeholders) or calls completeSnippet(template)
   * directly (no placeholders, D-09).
   */
  pickSnippet(snippetId: string): void {
    if (this.runnerStatus !== RUNNER_STATUS.AWAITING_SNIPPET_PICK) return;
    if (this.currentNodeId === null) return;

    // Forward action — clear redo stack
    this.redoStack = [];
    // Pattern A: undo-before-mutate. Deep-copy loopContextStack frames (LOOP-05).
    this.undoStack.push({
      nodeId: this.currentNodeId,
      textSnapshot: this.accumulator.snapshot(),
      loopContextStack: this.loopContextStack.map(f => ({ ...f })),
      restoreStatus: RUNNER_STATUS.AWAITING_SNIPPET_PICK,
    });

    this.snippetId = snippetId;
    this.snippetNodeId = this.currentNodeId;
    this.runnerStatus = RUNNER_STATUS.AWAITING_SNIPPET_FILL;
  }

  /**
   * Phase 56 D-03 (PICKER-01 reversal) — click-driven entry point for file-bound
   * Snippet insertion. Called by the inline runner sibling-button click handler when the
   * clicked Snippet node is file-bound (radiprotocol_snippetPath non-empty,
   * radiprotocol_subfolderPath empty/absent). Mirrors pickSnippet's undo-before-mutate
   * pattern but is triggered from a user click at at-node instead of from
   * awaiting-snippet-pick.
   *
   * Semantics:
   *   1. Guard: runnerStatus must be 'at-node' and currentNodeId must equal questionNodeId.
   *   2. Push UndoEntry keyed on the Question node (D-15 undo-before-mutate).
   *   3. Set snippetId = snippetPath, snippetNodeId = snippetNodeId, currentNodeId = snippetNodeId.
   *   4. Flip runnerStatus to 'awaiting-snippet-fill' — host render arm
   *      dispatches .md insert / .json fill-in modal / .json no-placeholder insert.
   *
   * stepBack() from awaiting-snippet-fill restores the Question with pre-insertion
   * accumulator via the existing stepBack path (no new branch — reuses UndoEntry shape).
   *
   * Signature: pickFileBoundSnippet(questionNodeId, snippetNodeId, snippetPath) → void
   */
  pickFileBoundSnippet(
    questionNodeId: string,
    snippetNodeId: string,
    snippetPath: string,
  ): void {
    if (this.runnerStatus !== RUNNER_STATUS.AT_NODE) return;
    if (this.currentNodeId !== questionNodeId) return;

    // Forward action — clear redo stack
    this.redoStack = [];
    // D-15 undo-before-mutate — identical UndoEntry shape to pickSnippet (:305).
    this.undoStack.push({
      nodeId: questionNodeId,
      textSnapshot: this.accumulator.snapshot(),
      loopContextStack: this.loopContextStack.map(f => ({ ...f })),
    });

    this.snippetId = snippetPath;
    this.snippetNodeId = snippetNodeId;
    this.currentNodeId = snippetNodeId;
    this.runnerStatus = RUNNER_STATUS.AWAITING_SNIPPET_FILL;
  }

  /**
   * Phase 5 calls this after the user completes the snippet fill-in modal.
   * Only valid in awaiting-snippet-fill state (D-06, D-07).
   * Appends the pre-rendered text and advances past the snippet text-block node.
   */
  completeSnippet(renderedText: string): void {
    if (this.runnerStatus !== RUNNER_STATUS.AWAITING_SNIPPET_FILL) return;
    if (this.graph === null || this.snippetNodeId === null) return;

    // Forward action — clear redo stack (even though no undo push, this is a user-driven transition)
    this.redoStack = [];

    const pendingNodeId = this.snippetNodeId;
    const snippetNode = this.graph.nodes.get(pendingNodeId);
    // Phase 31 D-04: also honour per-node override on SnippetNode (branch-entered picker)
    const snippetSep = (snippetNode?.kind === 'text-block' || snippetNode?.kind === 'snippet')
      ? this.resolveSeparator(snippetNode)
      : this.defaultSeparator;
    this.accumulator.appendWithSeparator(renderedText, snippetSep);
    this.snippetId = null;
    this.snippetNodeId = null;
    this.runnerStatus = RUNNER_STATUS.AT_NODE; // Reset before advanceThrough determines next state

    // Advance from the node that had the snippetId.
    // Phase 44 UAT-fix: dead-end snippet inside a loop body returns to the owning picker
    // (iteration++) instead of completing the protocol — same contract as dead-end answer.
    const neighbors = this.graph.adjacency.get(pendingNodeId);
    const next = neighbors !== undefined ? neighbors[0] : undefined;
    if (next !== undefined) this.exitTrivialLoopFrames(next);
    if (next === undefined) {
      this.advanceOrReturnToLoop(undefined);
      return;
    }
    this.advanceThrough(next);
  }

  /**
   * Inject a manual textarea edit into the accumulator before an advance action (BUG-01, D-01).
   * Must be called BEFORE chooseAnswer() / chooseLoopBranch() so that
   * the undo snapshot captured inside those methods includes the manual edit.
   * No-op if runner is not in 'at-node' or 'awaiting-loop-pick' state.
   *
   * Phase 47 RUNFIX-01: the awaiting-loop-pick gate extension keeps the BUG-01
   * capture-before-advance invariant alive on every loop transition — the host handler
   * calls syncManualEdit before chooseLoopBranch, and chooseLoopBranch (line 190) takes
   * the undo snapshot from the accumulator the instant after this call returns. Without
   * the awaiting-loop-pick gate the call was a no-op and the undo snapshot recorded
   * pre-edit text, so manual textarea edits were silently discarded on body-branch entry,
   * exit-edge transition, back-edge re-entry, and dead-end return.
   */
  syncManualEdit(text: string): void {
    if (this.runnerStatus !== RUNNER_STATUS.AT_NODE && this.runnerStatus !== RUNNER_STATUS.AWAITING_LOOP_PICK) return;
    this.accumulator.overwrite(text);
  }

  /**
   * Return a read-only snapshot of the current runner state (D-02).
   * Callers must narrow with switch(state.status) — do not access internal fields.
   */
  getState(): RunnerState {
    switch (this.runnerStatus) {
      case RUNNER_STATUS.IDLE:
        return { status: RUNNER_STATUS.IDLE };
      case RUNNER_STATUS.AT_NODE: {
        return {
          status: RUNNER_STATUS.AT_NODE,
          currentNodeId: this.currentNodeId ?? '',
          accumulatedText: this.accumulator.current,
          canStepBack: this.undoStack.length > 0,
          canRedo: this.redoStack.length > 0,
          undoStackSize: this.undoStack.length,
        };
      }
      case RUNNER_STATUS.AWAITING_SNIPPET_PICK: {
        if (this.graph === null || this.currentNodeId === null) {
          return { status: RUNNER_STATUS.ERROR, message: 'invalid awaiting-snippet-pick' };
        }
        const node = this.graph.nodes.get(this.currentNodeId);
        const subfolderPath =
          node !== undefined && node.kind === 'snippet' ? node.subfolderPath : undefined;
        return {
          status: RUNNER_STATUS.AWAITING_SNIPPET_PICK,
          nodeId: this.currentNodeId,
          subfolderPath,
          accumulatedText: this.accumulator.current,
          canStepBack: this.undoStack.length > 0,
          canRedo: this.redoStack.length > 0,
          undoStackSize: this.undoStack.length,
        };
      }
      case RUNNER_STATUS.AWAITING_LOOP_PICK:
        return {
          status: RUNNER_STATUS.AWAITING_LOOP_PICK,
          nodeId: this.currentNodeId ?? '',
          accumulatedText: this.accumulator.current,
          canStepBack: this.undoStack.length > 0,
          canRedo: this.redoStack.length > 0,
          undoStackSize: this.undoStack.length,
        };
      case RUNNER_STATUS.AWAITING_SNIPPET_FILL:
        return {
          status: RUNNER_STATUS.AWAITING_SNIPPET_FILL,
          snippetId: this.snippetId ?? '',
          nodeId: this.snippetNodeId ?? '',
          accumulatedText: this.accumulator.current,
          canStepBack: this.undoStack.length > 0,
          canRedo: this.redoStack.length > 0,
          undoStackSize: this.undoStack.length,
        };
      case RUNNER_STATUS.COMPLETE:
        return { status: RUNNER_STATUS.COMPLETE, finalText: this.accumulator.current };
      case RUNNER_STATUS.ERROR:
        return { status: RUNNER_STATUS.ERROR, message: this.errorMessage ?? 'Unknown error.' };
      default: {
        // TypeScript exhaustiveness check
        const _exhaustive: never = this.runnerStatus;
        void _exhaustive;
        return { status: RUNNER_STATUS.ERROR, message: 'Unknown runner status.' };
      }
    }
  }

  /**
   * Return a serializable snapshot of current runner state for session persistence (SESSION-01).
   * Returns null when the runner is in idle, complete, or error state — these are not
   * valid resume points (only 'at-node' and 'awaiting-snippet-fill' are resumable).
   *
   * The returned object is JSON-safe: all values are strings, numbers, arrays of those,
   * or null. No Set values are present (SESSION-07 — verified by RESEARCH.md audit).
   *
   * Returns a JSON-safe snapshot for tests and internal handoff code.
   */
  getSerializableState(): {
    runnerStatus: typeof RUNNER_STATUS.AT_NODE | typeof RUNNER_STATUS.AWAITING_SNIPPET_PICK | typeof RUNNER_STATUS.AWAITING_SNIPPET_FILL | typeof RUNNER_STATUS.AWAITING_LOOP_PICK;
    currentNodeId: string;
    accumulatedText: string;
    undoStack: Array<{ nodeId: string; textSnapshot: string; loopContextStack: Array<{ loopNodeId: string; iteration: number; textBeforeLoop: string }>; returnToBranchList?: boolean; restoreStatus?: RunnerState['status'] }>;
    loopContextStack: Array<{ loopNodeId: string; iteration: number; textBeforeLoop: string }>;
    snippetId: string | null;
    snippetNodeId: string | null;
  } | null {
    if (
      this.runnerStatus !== RUNNER_STATUS.AT_NODE &&
      this.runnerStatus !== RUNNER_STATUS.AWAITING_SNIPPET_FILL &&
      this.runnerStatus !== RUNNER_STATUS.AWAITING_SNIPPET_PICK &&
      this.runnerStatus !== RUNNER_STATUS.AWAITING_LOOP_PICK
    ) {
      return null;
    }
    return {
      runnerStatus: this.runnerStatus,
      currentNodeId: this.currentNodeId ?? '',
      accumulatedText: this.accumulator.current,
      // Deep-copy arrays to prevent aliasing (Pitfall 1 — snapshot must be independent)
      undoStack: this.undoStack.map(e => ({
        nodeId: e.nodeId,
        textSnapshot: e.textSnapshot,
        loopContextStack: e.loopContextStack.map(f => ({ ...f })),
        returnToBranchList: e.returnToBranchList,
        restoreStatus: e.restoreStatus,
      })),
      loopContextStack: this.loopContextStack.map(f => ({ ...f })),
      snippetId: this.snippetId,
      snippetNodeId: this.snippetNodeId,
    };
  }

  /**
   * Set the graph reference without calling start() or advanceThrough() (SESSION-01).
   * Must be called BEFORE restoreFrom() so subsequent runner method calls have a valid
   * graph to traverse (Pitfall 2 in RESEARCH.md — restoreFrom before setGraph causes silent no-ops).
   *
   * Correct call order for snapshot restoration:
   *   1. runner.setGraph(parsedGraph)
   *   2. runner.restoreFrom(snapshot)
   *   3. render the host
   */
  setGraph(graph: ProtocolGraph): void {
    this.graph = graph;
  }

  /**
   * Restore runner state from a persisted session snapshot (SESSION-01).
   * Directly assigns all private fields — does NOT call start() or advanceThrough().
   *
   * PRECONDITION: setGraph() must be called first (Pitfall 2).
   * POSTCONDITION: getState() returns the same status/nodeId/text as was present at save time.
   *
   * errorMessage is always reset to null after a valid restore (a restored session
   * is never in error state).
   */
  restoreFrom(session: {
    runnerStatus: typeof RUNNER_STATUS.AT_NODE | typeof RUNNER_STATUS.AWAITING_SNIPPET_PICK | typeof RUNNER_STATUS.AWAITING_SNIPPET_FILL | typeof RUNNER_STATUS.AWAITING_LOOP_PICK;
    currentNodeId: string;
    accumulatedText: string;
    undoStack: Array<{ nodeId: string; textSnapshot: string; loopContextStack: Array<{ loopNodeId: string; iteration: number; textBeforeLoop: string }>; returnToBranchList?: boolean; restoreStatus?: RunnerState['status'] }>;
    loopContextStack: Array<{ loopNodeId: string; iteration: number; textBeforeLoop: string }>;
    snippetId: string | null;
    snippetNodeId: string | null;
  }): void {
    this.runnerStatus = session.runnerStatus;
    this.currentNodeId = session.currentNodeId;
    this.accumulator.restoreTo(session.accumulatedText);
    // Deep-copy to prevent aliasing between the session object and internal state
    this.undoStack = session.undoStack.map(e => ({
      nodeId: e.nodeId,
      textSnapshot: e.textSnapshot,
      loopContextStack: e.loopContextStack.map(f => ({ ...f })),
      returnToBranchList: e.returnToBranchList,
      restoreStatus: e.restoreStatus,
    }));
    this.loopContextStack = session.loopContextStack.map(f => ({ ...f }));
    this.snippetId = session.snippetId;
    this.snippetNodeId = session.snippetNodeId;
    // Redo history does not survive session restore — start with a clean redo stack.
    this.redoStack = [];
    // errorMessage is always null after a valid restore (SESSION-06)
    this.errorMessage = null;
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  /**
   * Resolve the effective separator for a node that produces text (D-04).
   * Per-node radiprotocol_separator takes priority over the global default.
   */
  private resolveSeparator(
    node: import('../graph/graph-model').AnswerNode
          | import('../graph/graph-model').TextBlockNode
          | import('../graph/graph-model').SnippetNode,
  ): 'newline' | 'space' {
    // Phase 31 D-04: SnippetNode uses its own property name
    if (node.kind === 'snippet') {
      return node.radiprotocol_snippetSeparator ?? this.defaultSeparator;
    }
    return node.radiprotocol_separator ?? this.defaultSeparator;
  }

  private appendAnswerText(text: string, separator: 'newline' | 'space'): void {
    if (text.length === 0) return;
    this.accumulator.appendWithSeparator(text, separator);
  }

  /**
   * Internal auto-advance loop.
   * Processes nodes that do not require user input (start, text-block, answer) and
   * halts at nodes that require input (question) or terminal conditions.
   *
   * IMPORTANT: This method NEVER pushes UndoEntry (Pitfall 1 / D-03).
   * The iteration counter guards against infinite cycles (RUN-09 / D-08).
   */
  private advanceThrough(nodeId: string, suppressLoopEntryUndo = false): void {
    let cursor = nodeId;
    // steps counter resets on each advanceThrough entry (RUN-07 context: per-call cycle guard,
    // NOT per-loop cap). W4 — long-body integration test in Plan 02b Task 2 exercises a loop
    // body with 10 text-blocks × 10 iterations ≈ 110 nodes-per-call to confirm the guard does
    // NOT trip in realistic long-body cases. ProtocolRunner.maxIterations stays at its default.
    let steps = 0;

    while (true) {
      steps += 1;
      if (steps > this.maxIterations) {
        this.transitionToError(
          `Iteration cap reached (${this.maxIterations}). Possible cycle in protocol.`,
        );
        return;
      }

      if (this.graph === null) {
        this.transitionToError('Internal error: graph is null during traversal.');
        return;
      }

      const node = this.graph.nodes.get(cursor);
      if (node === undefined) {
        this.transitionToError(`Node '${cursor}' not found in graph.`);
        return;
      }

      switch (node.kind) {
        case 'start': {
          // Auto-advance through the start node to the first real node
          const next = this.firstNeighbour(cursor);
          if (this.advanceOrReturnToLoop(next) === 'halted') return;
          cursor = next!;
          break;
        }
        case 'text-block': {
          if (node.snippetId !== undefined) {
            // D-06: transition to awaiting-snippet-fill for Phase 5 to handle
            this.runnerStatus = RUNNER_STATUS.AWAITING_SNIPPET_FILL;
            this.snippetId = node.snippetId;
            this.snippetNodeId = cursor;
            return;
          }
          // RUN-05: auto-append static text — no user interaction required
          this.accumulator.appendWithSeparator(node.content, this.resolveSeparator(node));
          const next = this.firstNeighbour(cursor);
          if (this.advanceOrReturnToLoop(next) === 'halted') return;
          cursor = next!;
          break;
        }
        case 'question': {
          if (node.loop === true) {
            // B1 re-entry guard — looped question re-entry via a body back-edge
            // or an inner-exit landing on the outer looped question. The top
            // frame already exists — increment iteration in-place and halt at
            // the picker WITHOUT pushing a second frame or a second undo entry.
            const top = this.loopContextStack[this.loopContextStack.length - 1];
            if (top !== undefined && top.loopNodeId === cursor) {
              top.iteration += 1;
              this.currentNodeId = cursor;
              this.runnerStatus = RUNNER_STATUS.AWAITING_LOOP_PICK;
              return;
            }
            // First-entry path — push an undo snapshot unless the caller already
            // captured the loop entry as part of the same user action.
            if (!suppressLoopEntryUndo) {
              this.undoStack.push({
                nodeId: cursor,
                textSnapshot: this.accumulator.snapshot(),
                loopContextStack: this.loopContextStack.map(f => ({ ...f })),
                restoreStatus: RUNNER_STATUS.AWAITING_LOOP_PICK,
              });
            }
            this.loopContextStack.push({
              loopNodeId: cursor,
              iteration: 1,
              textBeforeLoop: this.accumulator.snapshot(),
            });
            this.currentNodeId = cursor;
            this.runnerStatus = RUNNER_STATUS.AWAITING_LOOP_PICK;
            return;
          }
          // Ordinary question — halt at at-node.
          // Phase 56 D-02: Phase 51 D-13 auto-insert block removed per CONTEXT D-02
          // (explicit exception to CLAUDE.md never-remove rule — this is the phase mandate).
          // File-bound Snippet dispatch now flows through the host click handler →
          // ProtocolRunner.pickFileBoundSnippet (see Task 2 of this plan).
          this.currentNodeId = cursor;
          this.runnerStatus = RUNNER_STATUS.AT_NODE;
          return;
        }
        case 'answer': {
          // Start-from-node halt: when the session was started AT this free-text
          // Answer, stop here so the radiologist submits the report text (the
          // host renders the same free-text row as a question branch would).
          // Undo history stays empty — this is the initial state, not a user action.
          if (cursor === this.explicitStartFreeTextAnswerId) {
            this.currentNodeId = cursor;
            this.runnerStatus = RUNNER_STATUS.AT_NODE;
            return;
          }
          // A free-text Answer's authored text is a prompt only. Selected
          // free-text Answers are handled by chooseAnswer(answerId, payload);
          // if one is encountered in an automatic chain, pass through without
          // inserting its prompt.
          this.appendAnswerText(
            node.freeText === true ? '' : node.answerText,
            this.resolveSeparator(node),
          );
          const next = this.firstNeighbour(cursor);

          // Quick-exit from loop body: if an answer node inside a loop body is wired
          // directly to the same target as any of the loop's isLoopExit edges, pop the loop frame
          // so the runner continues past the loop instead of returning to the picker
          // when the branch eventually hits a dead-end.
          if (this.graph !== null && this.loopContextStack.length > 0 && next !== undefined) {
            const topLoop = this.loopContextStack[this.loopContextStack.length - 1];
            if (topLoop !== undefined) {
              const exitsToNext = this.graph.edges.some(
                e => e.fromNodeId === topLoop.loopNodeId && e.isLoopExit === true && e.toNodeId === next
              );
              if (exitsToNext) {
                this.loopContextStack.pop();
              }
            }
          }
          if (next !== undefined) this.exitTrivialLoopFrames(next);

          if (this.advanceOrReturnToLoop(next) === 'halted') return;
          cursor = next!;
          break;
        }
        case 'loop-start':
        case 'loop-end': {
          // Phase 43 D-14 — legacy kinds are parsed (D-06) so GraphValidator can emit a migration error.
          // They never reach runtime: the validator rejects the canvas before the runner starts.
          // Phase 84 I18N-02: localized via injected translator (protocolRunner.legacyLoopRuntime).
          this.transitionToError(this.t('protocolRunner.legacyLoopRuntime'));
          return;
        }
        case 'snippet': {
          // Phase 67 D-14 — file-bound snippet bypass picker; directory-bound preserves Phase 30 D-07 picker path.
          // Mandate exception to CLAUDE.md "never remove existing code you didn't add": the original 4-line block
          // at this location (Phase 30 D-07) was the bug — it unconditionally halted at 'awaiting-snippet-pick'
          // regardless of radiprotocol_snippetPath, breaking loop-body and direct-edge traversals to file-bound
          // snippets. Phase 56 fixed only the sibling-button dispatch (pickFileBoundSnippet); the runner-core
          // traversal arm was the root cause of FIX-07 and is replaced here.
          //
          // No undo push here — advanceThrough never pushes (Pitfall 1). The caller has already pushed the
          // appropriate undo entry (e.g. chooseLoopBranch line ~238 pushes the loop-picker undo before invoking
          // advanceThrough(edge.toNodeId)). Mirroring pickFileBoundSnippet (line 349) with its undo push removed.
          this.currentNodeId = cursor;
          if (typeof node.radiprotocol_snippetPath === 'string' && node.radiprotocol_snippetPath !== '') {
            // File-bound: direct dispatch — view's existing 'awaiting-snippet-fill' arm handles handleSnippetFill.
            this.snippetId = node.radiprotocol_snippetPath;
            this.snippetNodeId = cursor;
            this.runnerStatus = RUNNER_STATUS.AWAITING_SNIPPET_FILL;
          } else {
            // Directory-bound (or unbound) — Phase 30 D-07 picker path preserved.
            this.runnerStatus = RUNNER_STATUS.AWAITING_SNIPPET_PICK;
          }
          return;
        }
        default: {
          // TypeScript exhaustiveness check — should never reach here with correct graph
          const _exhaustive: never = node;
          void _exhaustive;
          this.transitionToError('Unknown node kind encountered during traversal.');
          return;
        }
      }
    }
  }

  /**
   * Close stale loop frames when traversal moves to a node that is reachable
   * ONLY through some loop's explicit isLoopExit edge (a "trivial" loop: the
   * exit does not re-enter the looped question, so its body can never return
   * to the picker). Authoring tools make exit targets easy to reach through a
   * body branch too (e.g. an organ snippet wired both to the loop question and
   * onward into the chain), so walking such a body branch left the frame open.
   * A leaked frame later swallowed unrelated dead ends (e.g. the terminal
   * '\n\nЗаключение…' answer) and threw the user back into an organ loop
   * picker they had already finished. Only frames whose exit edge targets the
   * very next node are popped — the innermost match first; deeper frames keep
   * guarding legitimate outer loops.
   */
  private exitTrivialLoopFrames(nextNodeId: string): void {
    if (this.graph === null || this.loopContextStack.length === 0) return;
    for (let i = this.loopContextStack.length - 1; i >= 0; i -= 1) {
      const frame = this.loopContextStack[i];
      if (frame === undefined) return;
      const exitsToNext = this.graph.edges.some(
        e => e.fromNodeId === frame.loopNodeId && e.isLoopExit === true && e.toNodeId === nextNodeId,
      );
      if (!exitsToNext) return;
      this.loopContextStack.pop();
    }
  }

  /**
   * Phase 44 (RUN-02): helper for auto-advance dead-end handling.
   * When `next` is undefined (current node has no outgoing edge):
   *   - if inside a loop frame, increment the top frame's iteration, set
   *     currentNodeId to the top frame's loopNodeId, set runnerStatus to
   *     'awaiting-loop-pick', and return 'halted';
   *   - otherwise call transitionToComplete() and return 'halted'.
   * When `next` is defined, return 'continue' — caller updates its local cursor.
   *
   * Iteration semantic: dead-end bodies and back-edge bodies BOTH count as one
   * new iteration per return to the picker. Back-edge bodies hit B1 re-entry
   * guard inside case 'question' (loop === true) (different code path); this
   * helper is ONLY for the true-dead-end case (node with zero outgoing edges).
   */
  private advanceOrReturnToLoop(next: string | undefined): 'continue' | 'halted' {
    if (next !== undefined) return 'continue';
    if (this.loopContextStack.length > 0) {
      const frame = this.loopContextStack[this.loopContextStack.length - 1];
      if (frame !== undefined) {
        // Dead-end body (no outgoing edge) returning to the owning picker counts as a new
        // iteration, same as a back-edge body would (via B1 re-entry guard). This keeps the
        // semantic consistent: EVERY return to a picker from a body pass increments iteration
        // exactly once. Note that back-edge bodies reach the looped question via cursor = next! →
        // case 'question' (loop === true) → B1 guard, which is a different code path and NOT this helper.
        frame.iteration += 1;
        this.currentNodeId = frame.loopNodeId;
        this.runnerStatus = RUNNER_STATUS.AWAITING_LOOP_PICK;
        return 'halted';
      }
    }
    this.transitionToComplete();
    return 'halted';
  }

  private firstNeighbour(nodeId: string): string | undefined {
    if (this.graph === null) return undefined;
    const neighbors = this.graph.adjacency.get(nodeId);
    if (neighbors === undefined) return undefined;
    return neighbors[0];
  }

  private transitionToComplete(): void {
    this.runnerStatus = RUNNER_STATUS.COMPLETE;
  }

  private transitionToError(message: string): void {
    this.runnerStatus = RUNNER_STATUS.ERROR;
    this.errorMessage = message;
  }
}
