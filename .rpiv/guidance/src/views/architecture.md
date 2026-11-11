# Views Layer Architecture

## Responsibility
`src/views/` provides Obsidian presentation and orchestration: ItemViews, Promise modals, suggestion pickers, standalone DOM components, custom editor overlays, the floating inline runner host, and the optional right-sidebar runner view. Views consume lower services, but current editor projections and note-output orchestration are intentionally view-owned.

## Dependencies
- **Obsidian UI APIs**: `Modal`, `ItemView`, suggestion classes, `Notice`, DOM helpers, workspace/vault events.
- **Lower layers**: protocol, graph, runner/render, snippets, library, settings, i18n, and utils.
- **`dagre`**: protocol-editor auto-layout only.

## Consumers
`main.ts` registers views, commands, and settings; lower layers do not import views except the documented runner snippet-picker adapter.

## Module Structure
```
*-view.ts + protocol-editor-view.ts       # long-lived ItemViews
protocol-editor-document-owner.ts         # load/edit leases and owned resources
*-modal.ts + *-picker.ts + folder-suggest  # Promise/suggestion UI
inline-runner-modal.ts + inline-runner-layout.ts # plain floating host
sidebar-runner-view.ts                    # optional right-sidebar presentation
snippet-chip-editor.ts + option-order-chip-editor.ts + tree-renderer.ts # components
library-* UI modules                         # catalog/install/export presentation
```

## Promise Modal Results and Child Ownership
```typescript
type Result = { saved: true; data: Draft } | { saved: false };
class EditorModal extends Modal {
  readonly result: Promise<Result>; private resolved = false;
  private resolve!: (value: Result) => void;
  constructor(app: App) {
    super(app); this.result = new Promise(resolve => { this.resolve = resolve; });
  }
  onClose(): void { this.safeResolve({ saved: false }); this.contentEl.empty(); }
  private safeResolve(value: Result): void {
    if (this.resolved) return;
    this.resolved = true; this.resolve(value);
  }
}
```
Resolve the intended result before `close()`; `onClose()` supplies the idempotent cancellation fallback. Long operations may expose a separate `completion` promise from the dismissible UI `result`.

## ItemView Generation Ownership
```typescript
private async refresh(): Promise<void> {
  const generation = ++this.generation;
  const model = await this.loadModel();
  if (!this.mounted || generation !== this.generation) return;
  this.model = model; this.renderModel();
}
onClose(): void {
  this.mounted = false; this.generation++;
  if (this.timer !== null) window.clearTimeout(this.timer);
  this.contentEl.empty();
}
```
Use `registerDomEvent()`/`registerEvent()`, slash-boundary watcher filters, debounced refresh, and mounted/generation checks around every awaited model load. The plugin registers each stable `VIEW_TYPE` and activates it through a get-or-create leaf flow.

## Protocol Editor Document Ownership
`ProtocolEditorDocumentOwner` owns loading, mutation leases, and transient-resource disposal. The view retains document projections and supplies its current path, generation, and read-only status. Explicit document loads invalidate the session before awaiting storage; save-triggered refreshes carry the existing lease so they do not cancel other accepted edits. New edits supersede earlier refresh snapshots. Begin loads through the owner before awaiting storage; only the latest request may apply its result. Close invalidates pending work and disposes overlays and active pointer gestures.

Capture a lease when opening an overlay or starting a document action. Route every editor mutation through `owner.update(lease, mutate)`: it rejects detached/read-only work before storage, checks again inside the store's file lock, and returns `null` for cancelled or stale completion. Throwing inside the locked mutator prevents a queued stale operation from writing. A write already started may finish in its original file, but its late result must not change the new view. Check `owner.isCurrent(lease)` in the consumer continuation before applying projections, notices, or reloads.

Register parent overlay cleanup and temporary document mouse listeners through `owner.own()`. Parent cleanup unmounts child snippet pickers and destroys option-order chips. Delayed focus and viewport restoration check their captured lease; viewport debounce is cancelled on invalidation. Failed current loads rebuild the previous projection so its controls receive the new generation.

## Destroyable Components and Safe DOM
```typescript
export function mountComponent(options: Options): { destroy(): void } {
  const listeners: Listener[] = []; options.container.empty();
  const on = (el: EventTarget, type: string, handler: EventListener) => {
    el.addEventListener(type, handler); listeners.push({ el, type, handler });
  };
  const button = options.container.createEl('button', { text: options.label });
  on(button, 'click', options.onClick);
  return { destroy() {
    for (const item of listeners) item.el.removeEventListener(item.type, item.handler);
    listeners.length = 0; options.container.empty();
  }};
}
```
Components receive services/callbacks through options, track raw listeners/timers/observers, and expose `destroy()`/`unmount()`. Dynamic/user-authored text uses `textContent`/`createEl({text})`; static UI copy uses the bound translator and accessible roles/labels.

## View-Owned Orchestration and Exhaustive Dispatch
```typescript
switch (state.status) {
  case 'at-node': return renderQuestionAtNode(text, actions, graph, state, host);
  case 'awaiting-loop-pick': return renderLoopPicker(text, actions, graph, state, host);
  case 'awaiting-snippet-pick': return mountSnippetPicker(state);
  case 'complete': return renderComplete(state);
  case 'error': return renderError(state);
  default: { const neverState: never = state; return neverState; }
}
```
The runner host intentionally owns protocol migration/read/validation, accumulator-delta note writes, child picker/fill lifecycle, and runner dispatch. The editor intentionally owns document-record projections such as defaults, edge labels, and option-order editing. `render-snippet-picker.ts` → `SnippetTreePicker` and snippet-manager → protocol ref-sync are sanctioned cross-layer exceptions.

## Architectural Boundaries
- Do not put service/network/vault construction in individual views; use plugin-owned services or explicit options.
- Use type-only plugin/domain imports where runtime cycles are possible.
- Guard library-managed protocol/snippet paths at every mutation surface.
- Keep custom overlays and the runner hosts responsible for their own focus, observers, timers, and teardown.

<important if="you are adding a new Promise-based Modal">
## Adding a Modal
1. Choose `Modal`, `SuggestModal`, or a plain host deliberately and define a typed result.
2. Add a one-shot resolver, cancellation in `onClose()`, and resolve-before-close ordering.
3. Inject services/translator; render dynamic content as text; guard late async work.
4. Unmount child pickers and clear timers/listeners during close.
5. Add confirm/cancel/Escape/failure/double-resolution tests; see `.rpiv/guidance/src/__tests__/views/architecture.md`.
</important>

<important if="you are adding a new ItemView">
## Adding an ItemView
1. Export/register a stable `VIEW_TYPE`, display text, and icon in `main.ts`.
2. Build the shell in `onOpen()`, register scoped events, and route loads through one generation-guarded refresh.
3. Debounce vault redraws, invalidate/clear timers in `onClose()`, and test stale/close races and accessibility.
</important>

<important if="you are adding a standalone DOM component or SuggestModal">
## Adding a Component or Picker
1. Accept an options object with state, services, translator, and callbacks; keep plugin state outside.
2. Define mode/result unions, safe text rendering, keyboard/ARIA behavior, and exact callback payloads.
3. Track every raw listener/timer/observer and return `destroy()`/`unmount()`; parent owns disposal.
4. Use the smallest child-specific MockEl test harness and cover no-op, keyboard, stale, and cleanup behavior.
</important>

<important if="you are adding a custom protocol-editor overlay">
## Adding an Editor Overlay
1. Keep the overlay local to the editor owner, with explicit focus restoration and Escape ordering.
2. Capture a document-owner lease at opening; register cleanup with `owner.own()` and route saves through `owner.update()` using that lease.
3. Preserve read-only library guards and route persistence through the document store.
</important>

## Runner Output Recovery
Both runner presentations use `RunnerSessionHost` and `runner/runner-output.ts` for accepted note deltas. Pending writes block navigation and stale controls; rejected writes show retained output and a retry action. Completion and self-check are rendered only after acknowledgement. Dispose guards still cancel unstarted writes and suppress late renders.
