# View Test Architecture

## Responsibility
Specialized UI tests for modals, ItemViews, standalone components, runner-host orchestration, accessibility, async ownership, and structural wiring. Shared Vitest/mocking rules live in the parent test guidance.

## Dependencies
- **Vitest + Node**: explicit imports; no jsdom/happy-dom assumption.
- **`src/__mocks__/obsidian.ts` and local MockEl doubles**: choose the smallest host surface for the subject.
- **`runner-renderer-host-fixtures.ts`**: shared inline-runner integration harness.

## Consumers
`src/views/` and its service/runner collaborators. Parent-root suites still own broad SnippetManager and SnippetEditor pipelines; do not duplicate them here.

## Module Structure
```
inline-runner-modal-*.test.ts   # floating host state, keyboard, layout, lifecycle
sidebar-runner-view.test.ts      # right-sidebar session lifecycle and note binding
protocol-editor-*.test.ts       # document mutation, geometry, overlays, accessibility
snippet-*/folder-*.test.ts      # picker, editor/fill UI, chips, manager seams
library-*.test.ts + folder-suggest.test.ts # library/picker UI and wiring guards
```

## Modal Results and Completion
```typescript
const pending = deferred<InstallResult>();
const modal = new LibraryInstallProgressModal(plugin, () => pending.promise);
const operation = modal.runInstall();
modal.onClose();
await expect(modal.result).resolves.toEqual({ done: false });
pending.resolve({ status: 'ok' });
await operation;
await expect(modal.completion).resolves.toMatchObject({ status: 'ok' });
```
Drive `onOpen()`/events, await the public result, and assert child construction, service calls, cancellation, close-before-completion, and no late DOM writes. Distinguish dismissible `result` from long-operation `completion`.

## ItemView Mutation and Generation Races
```typescript
const update = vi.fn(async (_path, mutate) => {
  view.loadGeneration++;
  return mutate(oldDocument);
});
view.protocolDocumentStore = { update };
await view.saveNodeGeometry(node);
expect(view.renderMinimap).not.toHaveBeenCalled(); // stale completion rejected
```
Prime the real view with a minimal leaf/plugin/DOM state; execute store mutators against fixture documents; assert persistence, in-memory replacement, DOM, notices, focus, and path/generation stale guards independently.

## Standalone Component DOM and Cleanup
```typescript
const root = new MockEl();
const component = mountSnippetComponent({ container: root, onChange: vi.fn() });
fireInput(root, 'value');
expect(findByClass(root, 'row')).toHaveLength(1);
component.destroy();
expect(root.children).toHaveLength(0);
```
Use purpose-built MockEl behavior for tree selectors, inputs, SVG, DnD, and keyboard events. Assert callback counts/payloads, no-op inputs, ARIA state, listener removal, child picker unmount, and detached-handler suppression.

## Accessibility and Structural Guards
```typescript
button.dispatchEvent({ type: 'keydown', key: 'Enter', preventDefault: vi.fn() });
expect(button.getAttribute('aria-pressed')).toBe('true');
expect(button.getAttribute('title')).toBeNull();
expect(validationEl.textContent).toContain('<script>'); // literal text, no HTML node
```
Cover Enter/Space/modifier guards, roles/tabindex/ARIA synchronization, localized static copy versus literal user content, and source/CSS guards only where runtime behavior cannot prove wiring or absence.

## Architectural Boundaries
- Child-specific DOM mocks are valid when the central fixture lacks the required API; explain the modeled surface in the test.
- Keep pure helper assertions out of heavy view harnesses and keep extracted renderer behavior under runner tests.
- Restore globals/timers and reset captured modal/picker/Notice state in every suite.
- Static wiring tests are tripwires, not replacements for behavioral tests.

<important if="you are adding tests for a new Modal">
## Adding Modal Tests
1. Select the default alias or a local lifecycle-capable Obsidian/MockEl mock.
2. Instantiate the real modal, await render, drive user events, and await its result/completion.
3. Cover confirm/cancel/Escape/external close, failure, double-resolution, child teardown, and late async completion.
</important>

<important if="you are adding tests for a new ItemView">
## Adding ItemView Tests
1. Construct with a fake leaf and minimal plugin/services; inject only required private DOM/model state.
2. Execute store mutators and assert persistence, model, DOM, notices, focus, and read-only guards.
3. Add stale path/generation, close-during-load, watcher/debounce, keyboard, and cleanup cases.
</important>

<important if="you are adding tests for a standalone component or picker">
## Adding Component Tests
1. Verify construction is inert, mount clears stale content, and mode/search/filter results are correct.
2. Dispatch mouse/input/keyboard/DnD events through the MockEl listener map and assert exact callbacks/ARIA.
3. Verify `destroy()`/`unmount()` removes DOM/listeners and prevents late async results from mutating the host.
</important>
