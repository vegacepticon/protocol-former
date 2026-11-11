---
date: 2026-11-11T11:25:00+0300
author: Roman Shulgha
commit: ce7b492
branch: main
repository: RadiProtocol
topic: "Post-3.6.22 manual test: editor auto-expansion RangeError, editor hotkey routing, phrase-command scope"
tags: [handoff, release, 3.6.23, expansion, codemirror, hotkey, settings, manual-test]
status: complete
last_updated: 2026-11-11T11:30:00+0300
last_updated_by: Roman Shulgha
type: session_handoff
supersedes: .rpiv/artifacts/handoffs/2026-11-11_11-05-00_post-3.6.22-manual-test.md
---

# Handoff: 3.6.23 — editor expansion and hotkey fixes

This file supersedes `2026-11-11_11-05-00_post-3.6.22-manual-test.md` for session continuity. It
records the fixes made from the user's manual test of 3.6.22.

## User report (the two reported items)

1. **Auto-replacement works in RadiProtocol text fields but not in the Obsidian note editor.**
   **Hotkey replacement worked nowhere**: pressing the assigned chord showed
   «Ни одна фраза не совпадает…» even though the trigger was correct.
2. On the settings page, remove «Другие плагины не нужны» from the **Enable text expansion**
   description.

## Root causes

### 1. Editor auto mode threw and swallowed the trigger character

`EditorView.inputHandler` is called **before** the typed text is in the document. The old
`planAutoInsert()` planned against `before + insert`, then dispatched a transaction whose `to` was
`from + insert.length` — a position that did not exist yet. Every completed trigger produced:

```text
Uncaught RangeError: Invalid change range 467 to 469 (in doc of length 468)
  at dispatch (app://obsidian.md/…)
  at plugin:radiprotocol (textExpansionExtension)
```

The dispatch failed, so the last character was lost and no replacement happened. This explains the
`ту` line in the user's `Untitled.md` scratch note: typing `тур` left `ту`.

**Fix.** `planAutoInsert()` now returns one transaction in **pre-insert document coordinates**:
the part of the trigger already in the document is replaced, and the incoming text is part of the
replacement instead of being referenced at a not-yet-existing offset. A whole trigger delivered in
one input event (IME commit) keeps any text that arrived in front of it. The editor extension also
uses `view.compositionStarted` instead of `view.composing` and bails on multi-cursor input.

### 2. Editor hotkey fell into the foreign-text-field branch

In the note editor, `document.activeElement` is `DIV.cm-content` with `contenteditable="true"`.
`isTextEntryTarget()` therefore returned `true`, and `insertPhraseFromTrigger()` reported
`expansion.hotkeyNoMatch` before it ever looked at the editor. The editor path was unreachable from
inside the editor.

**Fix.** The command resolves `workspace.activeEditor?.editor` /
`getActiveMarkdownView()?.editor` first and routes to `expandHotkeyPhraseInEditor()` when
`editor.hasFocus()`. Only after that does it test `isTextEntryTarget()` for RadiProtocol textareas.
The **Expand in the note editor** toggle is still respected.

### 3. Hotkey command scope was narrower than the user's expectation

The command originally matched only phrases whose mode was `hotkey`. Re-testing the release build
live against the vault's data (`mpr` in hotkey mode, `тур` in auto mode) showed the textarea path
itself was healthy: `mpr` + chord replaced correctly. The likely mismatch for the user was an auto
phrase (or a trigger typed with a trailing space), which produced the same no-match notice.

**Fix.** The command now matches **all** configured phrases (`allRules`), not only hotkey-mode ones.
Auto phrases can be inserted manually too; hotkey-mode phrases still never fire while typing.
Spaces/tabs between the word and the caret are ignored and left in place, so a trigger typed with a
habitual space still expands. The no-match notice and the settings hint no longer say «hotkey
phrase».

### 4. Settings description

Removed the trailing «Другие плагины не нужны.» / «No other plugin is required.» from
`settings.textExpansionEnabledDesc` in both locales. The rest of the sentence is unchanged.

## Files touched

- `src/expansion/engine.ts` — pre-insert `planAutoInsert()`, trailing-space tolerance in
  `planWordExpansion()`.
- `src/expansion/editor.ts` — `compositionStarted`, single-collapsed-cursor guard.
- `src/expansion/config.ts` — `allRules` snapshot (explicit list, or derived from mode lists).
- `src/main.ts` — editor-first routing in `insertPhraseFromTrigger()`, `allRules` for both branches,
  `allRules` pushed from `applyTextExpansionSettings()`.
- `src/i18n/locales/{en,ru}.json` — description, hotkey hint, no-match notice.
- `README.md`, `README.ru.md` — the command works for any phrase.
- `.rpiv/guidance/src/expansion/architecture.md` — coordinates, composition, focus routing, command
  scope, tests.
- Tests: `src/__tests__/expansion/engine.test.ts` (coordinates, whole-trigger input, multi-line
  caret, whitespace, line break), `src/__tests__/expansion/config.test.ts` (new: `allRules`
  derivation/order/reset).

## Verification

Live in Obsidian **1.15.0** (working vault), driving the running renderer through the Obsidian CLI
`eval` and `dev:cdp`:

- Editor auto: `тур` → `Пустое турецкое седло`; `!=` → `≠`; no console errors.
- Editor hotkey: `mpr` + `Ctrl+L` → `MPR`, no notice.
- Runner textarea: `mpr ` + chord → `MPR ` (space preserved); `тур` + chord → the full auto phrase.
- No-match notice: «Ни одна фраза не совпадает со словом перед курсором.»
- Settings: the description now ends with «…и в редакторе заметок.».

**User confirmation (2026-11-11, after installing 3.6.23):** «Отлично! Теперь работает!» — all
reported scenarios pass; no further nuances from this round.

`npm run check:release` is green at `3.6.23`: build, ESLint + Stylelint, **1527 tests passed
(2 skipped)**, planning freshness, consistency (10 commands, 505 i18n keys at parity), agent docs,
knip, CSS audit, i18n audit.

## Release state

- Version `3.6.23` in `package.json` / `manifest.json` / `package-lock.json`; `versions.json` maps
  `3.6.23 → 1.5.7`.
- Commits: `87db134` (fix), `ce7b492` (`3.6.23`); tag `3.6.23` pushed. The handoff is committed
  separately.
- GitHub Actions: CI on `main` and the Release workflow for the tag are green.
- Release published: https://github.com/vegacepticon/RadiProtocol/releases/tag/3.6.23 — assets
  `main.js` (sha256 `1c9fe36c…`), `manifest.json`, `styles.css`. The locally built `main.js` is
  byte-identical to the published asset.
- The working vault's manual install is updated to `3.6.23` (`main.js`, `manifest.json`,
  `styles.css`) and was reloaded; it is not a tracked release artifact.

## Notes / open items

- Substitutions and Text Snippets are still enabled in the working vault. Substitutions' `--` → `—`
  rule intercepts the start of `-->` in the note editor; this is the documented double-expansion
  trade-off, not a RadiProtocol bug. Disable the old plugin if the editor should use RadiProtocol's
  list only.
- If matching auto phrases with the command turns out to be unwanted, the narrow behaviour is a
  one-line change back to `config.hotkeyRules`.
- User confirmed 3.6.23 works in a manual check. No follow-up bug is open for this round; the next
  session can start from the backlog in the 3.6.22 handoff or from a fresh manual test.
