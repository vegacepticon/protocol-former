# Runner Layer Architecture

## Responsibility
Pure mutable traversal state machine over an already parsed `ProtocolGraph`. It owns navigation, accumulated text, loop frames, undo/redo, and resumable snapshots; parsing, vault writes, snippet I/O, and DOM rendering stay outside the core.

## Dependencies
- **`graph/`**: node/edge contracts, ordered branches, labels, and loop metadata.
- **`constants/runner-states`**: status literals shared with the host.
- **`i18n`**: injected/default translator for runner errors.

## Consumers
`views/runner-session-host.ts` owns execution for both floating and sidebar presentations. It calls commands, dispatches states to renderers, resolves snippets, and submits accepted deltas to `RunnerOutput`.

## Module Structure
```
protocol-runner.ts             # guarded commands and cursor traversal
runner-state.ts                # public state + undo/redo/snapshot contracts
text-accumulator.ts            # separator-aware text buffer
runner-output.ts               # retained output, note lock, acknowledgement/retry
snippet-label.ts               # pure snippet classification/captions
keymap.ts                      # pure KeyboardEvent -> runner action resolver
option-target.ts               # one keyboard-selectable rendered option
render/                         # DOM adapter; see its own guidance
```

## Output Acknowledgement
`RunnerOutput` accepts one delta at a time through an injected note adapter. `flush()` holds the shared target-note lock across read and write. A rejection retains the delta; retry reads fresh note content. An exact match to a previously attempted complete write is acknowledged without appending again. Authored first-chunk whitespace is preserved; only generated separators can be de-duplicated.

While output is pending, the host invalidates old controls, blocks Back/Redo and all new actions, and defers completion/self-check/auto-close. A failed write shows retained text plus a retry button; successful acknowledgement renders the runner's already accepted state. Disposal cancels writes before modify begins and suppresses late presentation; an in-flight modify may finish. Pending output is transient and is not persisted across closing/restarting the session. If a rejected write actually reached disk and other edits subsequently changed that note, exact-result recognition cannot establish acknowledgement reliably.

## Discriminated State Snapshots
```typescript
export type RunnerState =
  | { status: 'idle' } | { status: 'at-node'; nodeId: string; accumulatedText: string }
  | { status: 'awaiting-snippet-pick'; nodeId: string }
  | { status: 'awaiting-loop-pick'; nodeId: string }
  | { status: 'awaiting-snippet-fill'; nodeId: string; snippetId: string }
  | { status: 'complete'; finalText: string } | { status: 'error'; message: string };
getState(): RunnerState {
  return this.projectState(); // expose status-specific data; keep stacks private
}
```
All public consumers narrow on `state.status`; exhaustive switches should retain a `never` check. Four interactive statuses are resumable; idle, complete, and error serialize as `null`.

## Guarded Commands and Undo-Before-Mutate
```typescript
chooseAnswer(answerId: string): void {
  if (this.status !== 'at-node') return;
  const answer = this.graph?.nodes.get(answerId);
  if (answer?.kind !== 'answer') return this.transitionToError('Invalid answer');
  this.redoStack = [];
  this.undoStack.push({
    nodeId: this.currentNodeId,
    textSnapshot: this.accumulator.snapshot(),
    loopContextStack: this.loopFrames.map(frame => ({ ...frame })),
  }); // snapshot precedes every mutation
  this.appendAnswer(answer); this.advanceThrough(answerId);
}
```
Rejected commands must not mutate history. Automatic start/text/answer traversal is part of the initiating action; first loop entry is the deliberate exception that records loop-entry history.

## Loop Context and Cursor Traversal
```typescript
private advanceThrough(initial: string): void {
  let cursor = initial; let steps = 0; // reset per call
  while (++steps <= this.maxSteps) {
    const node = this.graph?.nodes.get(cursor);
    if (node === undefined) return this.transitionToError('Missing node');
    if (node.kind === 'question' && node.loop === true) {
      this.enterOrReenterLoop(node.id); return;
    }
    if (node.kind === 'question') return this.setAtNode(node.id);
    if (node.kind === 'answer' || node.kind === 'text-block') {
      cursor = this.firstNeighbour(node.id); continue;
    }
    if (node.kind === 'snippet') return this.enterSnippet(node);
  }
  this.transitionToError('Possible graph cycle');
}
```
Loop exits pop the top frame only when `edge.isLoopExit === true`; re-entry increments the matching top frame. Edge IDs identify branch choices. The traversal cap is per call, not a global iteration limit.

## Resumable JSON Boundary
```typescript
const snapshot = runner.getSerializableState();
const wire = snapshot === null ? null : JSON.parse(JSON.stringify(snapshot));

restored.setGraph(graph);       // required precondition
if (wire !== null) restored.restoreFrom(wire);
// restoreFrom deep-copies frames/history, clears redo, and resets errors.
```
Serialized undo entries retain `restoreStatus` and `returnToBranchList`; do not rely on stale comments that omit them. `syncManualEdit()` overwrites text without history and must run before the forward action that captures the undo snapshot.

## Keyboard Model
`keymap.ts` is the single source of truth for runner keys: `resolveRunnerKey(input, context)` maps a DOM-free `RunnerKeyInput` plus a `RunnerKeyContext` availability snapshot to at most one `RunnerKeyAction`, or `null`. It matches letters and digits on `event.code` (layout independent), bails out during IME composition and from text-entry targets, accepts modifiers only for the legacy `Ctrl/Alt/Mod+←/→` aliases, and returns `null` for unavailable actions so callers never `preventDefault()` a no-op. Keep it pure: no DOM, no Obsidian, no renderer imports.

Renderers register each keyboard-selectable option through `host.registerOption({ element, activate, keyboardElement? })` in render order; the host owns numbering (`1`–`9`), `data-rp-key`/`aria-keyshortcuts` decoration, dispatch, the hint row, and focus restoration. A free-text option's `activate` focuses its field instead of submitting. Escape also resolves in the host (`close` → `requestClose()`), so shells only translate `onRequestClose` into presentation policy.

## Architectural Boundaries
- No Obsidian, DOM, service, or view imports in the core runner.
- Runner errors are terminal until `start()` or `restoreFrom()`; wrong-state calls are normally no-ops.
- Runner history changes memory only; the runner host owns note persistence and does not undo prior vault writes.
- Renderer contracts live in `.rpiv/guidance/src/runner/render/architecture.md`.

<important if="you are adding a new runner state or traversal behavior">
## Adding a Runner State
1. Add the status literal and state interface/union member.
2. Add reset/transition logic with phase guards and undo-before-mutate.
3. Update `getState()` and both serialization/restoration unions if resumable.
4. Add a renderer and exhaustive `RunnerSessionHost` dispatch; update the two-zone state list when needed.
5. Add focused transition, undo/redo, JSON round-trip, renderer, and host integration tests.
</important>

<important if="you are writing or modifying tests for the runner layer">
- Use `new ProtocolRunner()` with inline `ProtocolGraph` builders for exact topology; use compatibility fixtures only for parser-backed behavior.
- Assert status before status-specific fields, and inspect history through serializable state rather than private fields.
- Yield `await Promise.resolve()` between permitted repeated `stepBack()` calls; test both `isLoopExit`-based branch selection and four-state snapshot restoration.
</important>
