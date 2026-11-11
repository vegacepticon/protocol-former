# Text expansion (`src/expansion/`)

Typed trigger → insertion text, in RadiProtocol's own text fields and in the note editor. Built to replace the
Substitutions and Text Snippets community plugins without depending on either.

## Layers

| File | Role |
|---|---|
| `rules.ts` | Pure phrase model: `ExpansionRule { trigger, replacement, mode? }`, validity, default phrases, replacement markers (`$nl$`, `$end$`, escapes), and the one-way reader for the 3.6.21 line format. |
| `engine.ts` | Pure matching: auto (suffix) and hotkey (whole word) plans in document coordinates. |
| `config.ts` | Process-wide snapshot of the parsed settings, pre-split into `autoRules`, `hotkeyRules`, and `allRules`; read by the adapters at event time. |
| `textarea.ts` | `attachTextExpansion(textarea)` for auto phrases, plus `expandHotkeyPhrase()` and the ownership set used by the command. |
| `editor.ts` | `textExpansionExtension()` (auto phrases in CodeMirror) and `expandHotkeyPhraseInEditor()` (hotkey phrase insertion). |

Never put DOM, Obsidian, or settings access in `rules.ts` / `engine.ts`: they are the testable core and the
adapters are deliberately thin.

## Modes

- `auto` — fires while typing. The input handler reacts to direct `insertText`; `EditorView.inputHandler` and the
  textarea `input` listener both read `autoRules`.
- `hotkey` — never fires while typing. The user types the trigger and runs the `Insert phrase from trigger`
  command (`id: insert-phrase`), which replaces the whole word before the caret. Assign a chord in
  **Settings → Hotkeys**; there is no default because the runner already owns `Ctrl+Space`.

The command matches **any** phrase, not only hotkey-mode ones: a hotkey phrase only differs by waiting for the
command instead of firing while typing. A space or tab between the trigger and the caret is ignored and left in
place, so a trigger typed together with a habitual space still expands.

A phrase with no `mode` is treated as `auto` (legacy/hand-written data). The settings page always writes an
explicit mode.

## Settings flow

`main.ts` calls `applyTextExpansionSettings()` on load and from `saveSettings()`. It normalizes the structured
`textExpansionPhrases` list, drops invalid rows (blank or multi-word trigger) from the runtime snapshot, splits
the result by mode, and pushes `autoRules`, `hotkeyRules`, and the full ordered `allRules` with
`setTextExpansionConfig()`. `config.ts` is the only place where adapters read settings, so enabling or editing
phrases needs no restart and no editor reconfiguration. Do not add a settings parameter to renderer/host
interfaces for this feature — the adapters are attached where elements are created.

The phrase list has its own nested settings page (`settings.ts` `displayPhrasesPage()`); the main page has only
the enable toggle, the entry button, and the editor-scope toggle. Rows are trigger/insertion text pairs with an
icon button that flips the mode and a delete button. A row is invalid when its trigger is blank or contains
whitespace; invalid rows are persisted (so the user can fix them) but ignored at runtime.

## Migration (3.6.21)

`main.ts` checks the raw stored data before merging defaults. If `textExpansionPhrases` is absent, it reads the
old `textExpansionRules` text and the old global `textExpansionMode`: `auto` lines become auto phrases and
`delimiter` (old Space mode) lines become hotkey phrases, because they were the two non-identical behaviours.
The legacy keys are deleted and the migrated list is saved once. Fresh installs get
`DEFAULT_TEXT_EXPANSION_PHRASES`.

## Adapter invariants

- Auto mode reacts to `input` with `inputType === 'insertText'` only (pasted text is never rewritten) and bails
  during IME composition.
- The textarea adapter marks the fields it owns in a `WeakSet`; the hotkey command only touches those fields plus
  the note editor, never a search box or another plugin's input.
- A replacement assigns `textarea.value`, restores the caret with `setSelectionRange`, then dispatches one
  synthetic `input` event so the owning component (draft state, live preview) updates through its normal path.
  A shared `WeakSet` guard stops that synthetic event from re-expanding.
- Read-back is bounded by `maxTriggerLength()` in auto mode. Hotkey mode reads the current word from the caret
  back to the nearest whitespace, ignoring spaces/tabs directly before the caret (never a line break).
- `attachTextExpansion()` returns a detach function and removes the field from the ownership set. Elements
  recreated per render can rely on garbage collection; long-lived fields should detach.
- The editor hotkey path computes the caret offset *inside the insertion* (`change.caret - change.from`) before
  `offsetToPos`, because the replacement may contain line breaks.

## Editor extension

- Uses only public APIs: `Plugin.registerEditorExtension` plus `EditorView.inputHandler`. Do not reach for
  `app.embedRegistry`, `MarkdownScrollableEditView`, or other internals.
- The extension reads `getTextExpansionConfig()` at event time; toggling the feature needs no compartment or
  re-registration.
- `view.compositionStarted` guards IME composition. The final commit (after `compositionend`) is allowed to
  expand, which is what makes non-Latin triggers work.
- The replacement is one transaction in **pre-insert document coordinates**: `planAutoInsert()` removes the
  trigger text that is already in the document and consumes the incoming text instead of referring to
  `from + text.length`, which does not exist yet. Dispatching such a range throws `Invalid change range`.
- Multi-cursor input and non-collapsed changes bail out; the extension handles one typed insertion at a time.
- Hotkey insertion is a command, not an editor keymap binding: the user chooses the chord in Obsidian and the
  command runs while focus is in the editor. The command must resolve `editor.hasFocus()` *before* the generic
  `isTextEntryTarget()` branch, because the CM content element is contenteditable and would otherwise be
  mistaken for a foreign text field.

## Attach points (keep in sync)

- `runner/render/render-question.ts`, `runner/render/render-loop-picker.ts` — free-text answer textareas.
- `views/runner-conclusion-draft.ts` — draft input and per-item editors.
- `views/snippet-fill-in-modal.ts` — free-text placeholder and the Custom override.
- `main.ts` — the editor extension and the `Insert phrase from trigger` command.

Search fields and rename inputs are intentionally excluded: expanding a query would break searching.

## Known trade-offs

- Textarea replacement bypasses the browser's native undo stack; CodeMirror dispatches a transaction and keeps
  its history.
- The old "expand on Space" mode is gone. Hotkey phrases need one user-assigned chord for the command.
- If another expansion plugin is enabled at the same time, the note editor will expand twice. Document this
  rather than trying to detect other plugins.

## Tests

`src/__tests__/expansion/` covers the phrase format and migration (`rules.test.ts`), the matching/planning core
including the pre-insert coordinates (`engine.test.ts`), the config snapshot and `allRules` derivation
(`config.test.ts`), the textarea auto/hotkey adapters with a local `FakeTextarea` (`textarea.test.ts`), and the
editor hotkey path with a single-line `Editor` stand-in (`hotkey-editor.test.ts`). The CodeMirror auto adapter is
intentionally thin: its logic lives in `engine.ts` plans, so the untested part is only the `view.dispatch` call;
verify it in a live editor after changing either plan function.
