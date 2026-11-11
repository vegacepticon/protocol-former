# Text expansion (`src/expansion/`)

Typed trigger → replacement, in RadiProtocol's own text fields and in the note editor. Built to replace the
Substitutions and Text Snippets community plugins without depending on either.

## Layers

| File | Role |
|---|---|
| `rules.ts` | Pure authoring format: parse/serialize rule lines, resolve `$nl$`/`$end$`/escapes, ship defaults. |
| `engine.ts` | Pure matching: auto (suffix) and delimiter (whole word) modes, document-coordinate plans. |
| `config.ts` | Process-wide snapshot of the parsed settings; read by both adapters at event time. |
| `textarea.ts` | `attachTextExpansion(textarea)` — the adapter for plugin fields. |
| `editor.ts` | `textExpansionExtension()` — CodeMirror 6 extension for the note editor. |

Never put DOM, Obsidian, or settings access in `rules.ts` / `engine.ts`: they are the testable core and the
adapters are deliberately thin.

## Settings flow

`main.ts` calls `applyTextExpansionSettings()` on load and from `saveSettings()`; it parses the raw rules text
once and pushes a snapshot with `setTextExpansionConfig()`. `config.ts` is the only place where adapters read
settings, so enabling or editing rules needs no restart and no editor reconfiguration. Do not add a settings
parameter to renderer/host interfaces for this feature — the adapters are attached where elements are created.

## Adapter invariants

- Auto mode reacts to `input` with `inputType === 'insertText'` only (pasted text is never rewritten) and
  bails during IME composition.
- Delimiter mode reacts to Space `keydown`, consumes the delimiter with `preventDefault()`, and replaces the
  whole word before the caret. Tab is not a delimiter: it moves focus in modals and indents lists in the
  editor.
- A replacement assigns `textarea.value`, restores the caret with `setSelectionRange`, then dispatches one
  synthetic `input` event so the owning component (draft state, live preview) updates through its normal path.
  A re-entry flag stops that synthetic event from expanding again.
- Read-back is bounded by `maxTriggerLength()` in auto mode. Word mode reads to the line start because equality
  against a full word must not be decided on a truncated string.
- `attachTextExpansion()` returns a detach function. Elements recreated per render can rely on garbage
  collection; long-lived fields should detach.

## Editor extension

- Uses only public APIs: `Plugin.registerEditorExtension` plus `EditorView.inputHandler` and a `Prec.high`
  Space keymap binding. Do not reach for `app.embedRegistry`, `MarkdownScrollableEditView`, or other internals.
- The extension reads `getTextExpansionConfig()` at event time; toggling the feature needs no compartment or
  re-registration.
- Space is bound with high precedence but only consumes the key when a rule matches, so normal typing and list
  indentation keep working.
- `view.composing` guards IME composition.

## Attach points (keep in sync)

- `runner/render/render-question.ts`, `runner/render/render-loop-picker.ts` — free-text answer textareas.
- `views/runner-conclusion-draft.ts` — draft input and per-item editors.
- `views/snippet-fill-in-modal.ts` — free-text placeholder and the Custom override.
- `main.ts` — the editor extension.

Search fields and rename inputs are intentionally excluded: expanding a query would break searching.

## Known trade-offs

- Textarea replacement bypasses the browser's native undo stack; CodeMirror dispatches a transaction and keeps
  its history.
- If another expansion plugin is enabled at the same time, the note editor will expand twice. Document this
  rather than trying to detect other plugins.

## Tests

`src/__tests__/expansion/` covers the pure format (`rules.test.ts`), the matching/planning core
(`engine.test.ts`), and the textarea adapter with a small `FakeTextarea` (`textarea.test.ts`). The CodeMirror
adapter is intentionally thin: its logic lives in `engine.ts` plans, so the untested part is only the
`view.dispatch` call.
