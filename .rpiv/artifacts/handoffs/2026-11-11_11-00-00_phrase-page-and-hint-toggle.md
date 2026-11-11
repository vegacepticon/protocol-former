---
date: 2026-11-11T11:00:00+0300
author: Roman Shulgha
commit: 6e20b1e
branch: main
repository: RadiProtocol
topic: "Runner hint toggle + shortcut reference, per-phrase auto/hotkey modes on a nested settings page"
tags: [handoff, release, runner, hints, settings, expansion, phrases, hotkey, migration]
status: complete
last_updated: 2026-11-11T11:00:00+0300
last_updated_by: Roman Shulgha
type: session_handoff
supersedes: .rpiv/artifacts/handoffs/2026-11-11_10-25-00_text-expansion-and-runner-fixes.md
---

# Handoff: hint toggle + phrase list page (3.6.22)

This file supersedes `2026-11-11_10-25-00_text-expansion-and-runner-fixes.md`. It records the
changes made from the user's manual test of tag 3.6.21.

## User feedback from 3.6.21 and what changed

1. **Ctrl+Space in runner free-text fields** — already fixed in 3.6.20, confirmed working. No change.
2. **Digit badges on snippet choice pills** — already shipped, confirmed working. No change.
3. **The key-hint row always appeared on runner launch.** Added `showRunnerKeyHints` (default on) under
   **Settings → RadiProtocol**. Both shells seed `RunnerSessionHost` through the new
   `keyHintsVisibleByDefault` option; `H` still toggles the row for the current session. A collapsible
   shortcut table (`<details>` + table) now sits in the same settings section, directly under the toggle.
4. **The phrase list was one text area and grew badly.** Text expansion now has a nested settings page
   (**Text expansion → Insertion phrases**). Each row is a trigger/insertion text pair, with an icon button
   that flips the row between **auto-replacement** (`zap`) and **hotkey insertion** (`keyboard`), plus a
   delete button and an **Add phrase** button. Invalid triggers (blank or containing whitespace) are marked
   red per row and counted at the top; they stay in settings so they can be fixed but are ignored at runtime.
5. **Tab / Shift+Tab in the snippet picker** — confirmed working. No change.

## Product decision: what "by hotkey" means

The user chose **one plugin command with one user-assigned hotkey** (not one command per phrase, not the old
Space delimiter):

- `Insert phrase from trigger` (`id: insert-phrase`) replaces the whole word before the caret with a
  hotkey-mode phrase. The user assigns its chord in **Settings → Hotkeys**; there is no default because the
  runner already owns `Ctrl+Space`.
- Hotkey phrases never expand while typing. Auto phrases still do.
- The command only touches RadiProtocol textareas (tracked in a `WeakSet` by `attachTextExpansion`) and the
  note editor. It refuses foreign text fields, runner chrome, and the fill-in modal chrome, so it cannot
  rewrite a search box or the note behind a focused runner panel.
- The note-editor path respects the existing **Expand in the note editor** toggle; when that is off the
  command shows a dedicated notice instead of silently doing nothing.

## Data model and migration

- `ExpansionRule` is now `{ trigger, replacement, mode?: 'auto' | 'hotkey' }`; absent mode means `auto`.
- Settings store the structured list as `textExpansionPhrases`; the old `textExpansionRules` string and
  global `textExpansionMode` are deprecated fields that are read once and deleted.
- Migration in `main.ts` runs before the defaults merge: old `auto` lines become auto phrases, old
  `delimiter` (Space) lines become hotkey phrases. Fresh installs get `DEFAULT_TEXT_EXPANSION_PHRASES`.
- `config.ts` pre-splits the list into `autoRules` and `hotkeyRules`, so adapters never reinterpret modes.
- The old Space-delimiter adapter was removed from both the textarea and CodeMirror extension. This is an
  intentional regression of 3.6.21's second mode: hotkey phrases replace it.

## Files touched

- `src/expansion/rules.ts` — phrase model, validation/normalization, legacy line reader, defaults.
- `src/expansion/config.ts` — split snapshot.
- `src/expansion/textarea.ts` — auto listener, ownership set, `expandHotkeyPhrase()`.
- `src/expansion/editor.ts` — auto input handler, `expandHotkeyPhraseInEditor()`.
- `src/main.ts` — migration, config split, command, focused-target policy.
- `src/settings.ts` — nested phrase page, pair rows, mode/delete/add controls, hint toggle + cheat sheet.
- `src/views/runner-session-host.ts`, `inline-runner-modal.ts`, `sidebar-runner-view.ts` — hint visibility seed.
- `src/i18n/locales/{en,ru}.json` — 505 keys at parity.
- `src/styles/expansion.css`, `runner-session.css` — phrase page and cheat-sheet styles.
- Tests: `src/__tests__/expansion/{rules,textarea,hotkey-editor}.test.ts`, `settings-tab.test.ts`,
  `views/runner-session-host.test.ts`, `runner/render-question.test.ts`.

## Current state

- Version `3.6.22` in `package.json` / `manifest.json` / `package-lock.json`; `versions.json` maps
  `3.6.22 → 1.5.7`.
- `npm run check:release` green: build, ESLint + Stylelint, **1518 tests passed (2 skipped)**, planning
  freshness, consistency (10 commands documented, 505 i18n keys at parity), agent docs, knip, CSS audit
  (no orphaned/missing classes), i18n audit.
- The generated `main.js` / `styles.css` are build artifacts and stay gitignored.

## Known limits / backlog

1. One shared hotkey for all hotkey phrases. Per-phrase commands were offered as an option and rejected
   because they would flood Settings → Hotkeys.
2. No Space delimiter anymore. Users who relied on it must switch those rows to auto-replacement or assign
   the command hotkey.
3. Phrase rows are single-line inputs; multi-line insertions still use `$nl$` / `\n`. No swap button, no
   enable-per-row toggle, no reorder controls, no regex rules.
4. No "Backspace undoes the last replacement".
5. The editor hotkey path uses only `Editor.getSelection/getCursor/getLine/posToOffset/replaceRange/
   setCursor/offsetToPos`; still no automated test in a real vault. Verify `;plan` + chord in Live Preview
   and Source mode.
6. If Substitutions or Text-Snippets remains enabled, the note editor expands twice. README asks the user
   to disable them.

## Architecture reminders (carry forward)

- Renderers **register** options; the host **dispatches**. `keymap.ts` stays pure.
- Shells must forward `isConfirmChord` from text fields; every other key in a field stays native.
- Expansion: pure core in `rules.ts`/`engine.ts`; adapters attach where elements are created; the only
  settings reader is `config.ts`. Do not add settings parameters to renderer/host interfaces.
- The settings tab is two pages in one `PluginSettingTab` (`page: 'main' | 'phrases'`); `hide()` resets to
  the main page.
- Every UI string needs `en.json` + `ru.json`. Phrase CSS lives in `src/styles/expansion.css`; the cheat
  sheet lives in `runner-session.css`.

## Gotchas

- Never edit `main.js` / `styles.css` by hand; edit `src/` and `src/styles/` then `npm run build`.
- The settings-tab mock now exposes `__getMockButtonComponents()` and `__getMockExtraButtonComponents()`;
  `Setting` has `settingEl/controlEl/setClass`, and `addClass`/`setAttribute` were added to `MockInputEl`.
- Tests share `DEFAULT_SETTINGS.textExpansionPhrases`; `makePlugin()` clones it. Keep cloning when adding
  tests that add or delete phrases.
- `IsTextExpansionTextarea` uses a `WeakSet`, so a detached field is no longer a valid command target.
- The hotkey command's editor path must convert only `change.caret - change.from` through `offsetToPos`
  when the insertion contains line breaks; using `change.caret` directly double-counts `from`.
- Component counts in `settings-tab.test.ts` are order-sensitive: five toggles on the main page (sidebar,
  draft, hint row, expansion enabled, expansion in editor); three text fields (protocol folder, snippet
  folder, registry URL); two folder suggesters.

## How to resume

```bash
git status
git log -3 --oneline
npm ci
npm run check:release
```

Then read this handoff. Ask the user to verify the nested phrase page and the `Insert phrase from trigger`
chord in a real vault (item 5 above). Likely next work: per-row enable/disable, reorder, or an import from
Substitutions if the user asks.

## References

- Release `3.6.22`
- `.rpiv/guidance/src/expansion/architecture.md`
- `.rpiv/guidance/src/views/architecture.md` — `keyHintsVisibleByDefault`
- `src/settings.ts` — `displayMainPage()` / `displayPhrasesPage()`
- `src/main.ts` — `migrateTextExpansionPhrases()` / `insertPhraseFromTrigger()`
- Superseded handoff:
  `.rpiv/artifacts/handoffs/2026-11-11_10-25-00_text-expansion-and-runner-fixes.md`
