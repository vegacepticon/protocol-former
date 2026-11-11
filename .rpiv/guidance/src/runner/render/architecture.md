# Runner Render Sub-Layer Architecture

## Responsibility
State-specific DOM projections between the pure runner and `RunnerSessionHost`. Render functions receive narrowed state/data and host callbacks; the host owns runner mutation, vault I/O, lifecycle, localization injection, and rerendering.

## Dependencies
- **`runner/` and `graph/`**: state variants, node labels, ordered edges, and semantic edge metadata.
- **`utils/dom-helpers` and `constants/css-classes`**: shared DOM/button vocabulary.
- **Obsidian**: `setIcon` in the footer and the picker’s injected app boundary.
- **`views/SnippetTreePicker`**: one documented picker adapter exception.

## Consumers
`RunnerSessionHost` is the direct production host for all renderers and is shared by the floating and sidebar presentations; the shared footer is currently used by the snippet picker adapter.

## Module Structure
```
render-question.ts + render-loop-picker.ts  # two-zone branch modes
render-snippet-picker.ts                    # async picker adapter
render-snippet-fill.ts                      # one-zone snippet messages
render-complete.ts + render-error.ts        # terminal fragments
render-footer.ts                             # Back/Redo/Skip controls
```

## Host-Injected Projection Boundary
```typescript
type AtNode = Extract<RunnerState, { status: 'at-node' }>;

interface QuestionHost {
  bindClick(el: HTMLElement, handler: (event: MouseEvent) => void): void;
  renderError(messages: string[]): void;
  onChooseAnswer(node: AnswerNode): void | Promise<void>;
  onChooseQuestion(edge: RPEdge): void;
}

function renderQuestion(
  textZone: HTMLElement, actionZone: HTMLElement,
  graph: ProtocolGraph | null, state: AtNode, host: QuestionHost,
): 'rendered' | 'not-question' | 'error' {
  const node = graph?.nodes.get(state.nodeId);
  if (node === undefined) { host.renderError(['Missing node']); return 'error'; }
  if (node.kind !== 'question') return 'not-question';
  // Create text/buttons; delegate every click through host callbacks.
  return 'rendered';
}
```
Renderers never call `ProtocolRunner`, never use `this`, and never bind raw listeners directly. Return values describe only what the host needs.

## Semantic Edges and Zone Contracts
```typescript
const edges = orderedOutgoingEdges(graph, state.nodeId);
for (const edge of edges) {
  const isExit = edge.isLoopExit === true;
  const target = graph.nodes.get(edge.toNodeId);
  const caption = isExit ? edge.label ?? '' : target ? nodeLabel(target) : edge.toNodeId;
  const button = createButton(actionZone, { text: caption });
  if (caption.trim() === '') button.setAttr('aria-label', edge.toNodeId);
  host.bindClick(button, () => host.onChooseLoopBranch(edge));
}
```
Use edges when labels, edge IDs, ordering, or exit metadata matter; use adjacency only when grouping by target kind is sufficient. Questions and loop pickers use two zones; completion/error/fill/picker fragments use one zone with deliberate clearing ownership.

## Async and Reentrancy Guards
```typescript
const capturedNodeId = state.nodeId;
const snippet = await snippetService.load(relativePath);
if (host.getCurrentNodeId() !== capturedNodeId) return;
if (host.isStillMounted?.() === false) return;
if (snippet === null) return host.renderAsyncError('Snippet not found');
await host.onSnippetReady(snippet);

host.bindClick(backButton, () => {
  backButton.disabled = true; // before host mutation
  host.onBack();
});
```
Capture state identity before awaits, reject detached results, and return the mounted picker so the host can unmount it. Back/Redo are synchronously disabled; the runner adds its own same-microtask Back guard.

## Architectural Boundaries
- Only `render-footer.ts` has a runtime Obsidian utility import; other renderers are DOM/pure adapters.
- `render-snippet-picker.ts` may construct `views/SnippetTreePicker`; no other renderer imports `views/`.
- Dynamic text uses text nodes/`createButton`, not `innerHTML`; icon-only controls require localized `aria-label` values.
- Two-zone renderers do not clear the host’s zones; terminal fill messages may replace their own zone.

<important if="you are adding a new runner render mode">
## Adding a Render Mode
1. Add/update the runner state first; see `.rpiv/guidance/src/runner/architecture.md`.
2. Create `render-<state>.ts` with an `Extract` state alias and narrow host interface.
3. Choose one- or two-zone ownership and a minimal return contract.
4. Use semantic edges/adjacency appropriately, safe text DOM, localized labels, and async/click guards.
5. Wire an exhaustive host switch and two-zone layout membership if needed.
6. Add MockEl renderer tests plus host integration for transitions and lifecycle.
</important>

<important if="you are writing or modifying tests for the render layer">
- Use the smallest `MockEl`/`FakeNode` needed and `vi.fn()` host spies; do not mount real Obsidian UI.
- Assert classes, order, captions, ARIA, callback payload identity, return contracts, and wrong-node/error paths.
- Picker tests must cover successful, missing, stale-node, detached-DOM, and unmount behavior.
</important>
