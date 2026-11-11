# Runner Test Architecture

## Responsibility
Specialized tests for the pure `ProtocolRunner`, `TextAccumulator`, and `runner/render` adapters. They isolate state transitions and renderer contracts; real modal/vault lifecycle belongs under `src/__tests__/views/`.

## Dependencies
- **Vitest**: direct imports, Node environment, no browser runtime.
- **`runner/`, `graph/`, `constants/`**: pure state and topology contracts.
- **`runner-renderer-host-fixtures.ts`**: shared MockEl/Obsidian/app/plugin harness for inline-host integration consumers.

## Consumers
Production runner and render modules; the shared host fixture is also imported by selected view tests.

## Module Structure
```
protocol-runner-*.test.ts       # transitions, loops, snippets, skip, undo/redo
protocol-runner-snapshot.test.ts# JSON-safe resumable state
render-*.test.ts                # extracted DOM projections
text-accumulator.test.ts + runner-renderer-host-fixtures.ts # buffer/harness
```

## Inline Graphs versus Compatibility Fixtures
```typescript
function makeGraph(nodes: RPNode[], edges: RPEdge[]): ProtocolGraph {
  const adjacency = new Map<string, string[]>();
  const reverseAdjacency = new Map<string, string[]>();
  for (const edge of edges) {
    adjacency.set(edge.fromNodeId, [...(adjacency.get(edge.fromNodeId) ?? []), edge.toNodeId]);
    reverseAdjacency.set(edge.toNodeId, [...(reverseAdjacency.get(edge.toNodeId) ?? []), edge.fromNodeId]);
  }
  return { canvasFilePath: 'test.rp.json', nodes: new Map(nodes.map(n => [n.id, n])), edges, adjacency, reverseAdjacency, startNodeId: 'start' };
}
```
Use inline graphs for exact topology, malformed edges, edge-ID/order cases, and one-off regressions. Use fixture factories only when parser/compatibility behavior is part of the contract; see the fixture guidance for ownership.

## State Checkpoints and History
```typescript
const runner = new ProtocolRunner();
runner.start(graph);
const before = runner.getState();
expect(before.status).toBe('at-node');
runner.chooseAnswer('answer');
expect(runner.getState().status).toBe('complete');
runner.stepBack();
await Promise.resolve(); // release same-microtask Back guard
expect(runner.getState()).toEqual(before);
```
Assert status first, then node/text/snippet/loop fields and public history flags. Cover undo-before-mutate, redo invalidation after divergent forward action, loop frame depth/iteration, and explicit `isLoopExit` branch identity.

## Renderer Contract Tests
```typescript
const root = new MockEl();
const onChoose = vi.fn();
renderQuestionAtNode(root as unknown as HTMLElement, root as unknown as HTMLElement, graph, state, {
  bindClick: (_el, handler) => { capturedHandler = handler; },
  onChooseAnswer: onChoose,
  renderError: vi.fn(),
  onChooseSnippetBranch: vi.fn(),
});
capturedHandler?.(new MouseEvent('click'));
expect(onChoose).toHaveBeenCalled();
```
Keep runner mutation outside renderer units. Assert DOM classes/order/captions/ARIA, callback payload identity, return contracts, and host-delegated errors with the smallest fake element.

## Persistence and Async Guards
```typescript
const saved = runner.getSerializableState();
const wire = JSON.parse(JSON.stringify(saved));
const restored = new ProtocolRunner();
restored.setGraph(graph);
restored.restoreFrom(wire);
expect(restored.getState()).toEqual(runner.getState());
```
Round-trip all applicable snapshot fields, including `restoreStatus`/`returnToBranchList`. For snippet picker tests, mock before importing, flush the async chain, and assert missing, stale-node, detached-DOM, and unmount paths.

## Architectural Boundaries
- Do not import Obsidian for pure runner transition tests.
- Do not test runner note writes in extracted render tests; put host effects in `src/__tests__/views/`.
- Keep compatibility `.canvas` cases separate from canonical inline graph behavior.

<important if="you are adding tests for a new runner state or traversal behavior">
## Adding Runner Tests
1. Put pure transition coverage in `protocol-runner-<behavior>.test.ts`; put renderer-only coverage in `render-<mode>.test.ts`.
2. Build a fresh graph/runner and assert every meaningful halt, not only terminal output.
3. Add undo, redo, JSON restoration, and microtask-guard coverage when the action is user-driven.
4. Add a host integration test under `src/__tests__/views/` when vault/modal/lifecycle wiring changes.
</important>
