---
date: 2026-11-11T12:03:00+0300
author: Roman Shulgha
commit: d01606e
branch: main
repository: RadiProtocol
topic: "3.6.24 — searchable phrase list with the add control above the list"
tags: [handoff, release, 3.6.24, expansion, settings, search, i18n, tests]
status: complete
last_updated: 2026-11-11T12:03:00+0300
last_updated_by: Roman Shulgha
type: session_handoff
supersedes: .rpiv/artifacts/handoffs/2026-11-11_11-25-00_editor-expansion-fixes.md
---

# Handoff: 3.6.24 — phrase search and top add toolbar

This file supersedes `2026-11-11_11-25-00_editor-expansion-fixes.md` for session continuity. The
3.6.23 handoff remains the implementation record for the editor expansion and hotkey fixes.

## User request

Two small UX fixes on **Settings → RadiProtocol → Text expansion → Insertion phrases**:

1. Move the **Add phrase** button above the list, so adding a phrase does not require scrolling to
   the bottom of a long list.
2. Add a search field for phrases, for working with a large phrase base.

The user confirmed the result: «Отлично!» and asked to save the session.

## What changed

### Search + add toolbar above the list

- The phrase page now renders one toolbar `Setting` between the description/status and the row
  list: a search input on the left and the **Add phrase** CTA button on the right.
- The input is `type="search"`, class `rp-phrase-search`, with a localized `aria-label` and
  placeholder: «Фильтр по ключу или вставке» / “Filter by trigger or insertion”.
- The field filters rows by a case-insensitive substring of the **trigger or the replacement**.
  Filtering toggles the `is-hidden` class on existing row elements; it does not re-render the page,
  so typing keeps focus and caret position.
- When the query is non-empty and nothing matches, a localized line appears directly under the
  toolbar: «Нет фраз, совпадающих с «…».» / `No phrases match "…".` The message is hidden for an
  empty query and when the phrase list itself is empty.
- The previous bottom `Add phrase` row is gone. The button no longer has an icon: Obsidian's
  `ButtonComponent.setIcon()` overwrites `setButtonText()`, and the icon-only `+` was ambiguous next
  to the search field. It stays a `.mod-cta` (accent) button.

### Add semantics

- **Add phrase prepends a blank row**, clears the filter, re-renders, and focuses the new row's
  trigger input. This is deliberate: with the button at the top, appending to the bottom would
  immediately send the user away from the control they just clicked. Several phrases can be added
  back-to-back without scrolling.
- The rest of the list keeps its stored order. Matching is unaffected: auto mode chooses the
  longest trigger and hotkey mode looks up the whole word, so display order is not a runtime
  contract. (Duplicate triggers are not a supported way to choose a winner.)
- Delete re-renders the page but **keeps** the current filter, so deleting a search result leaves
  the user in context.
- The back button and `hide()` clear the filter; reopening the nested page starts unfiltered.
- The invalid-trigger counter still counts the whole stored list, not only visible rows. Editing a
  row while filtered does not hide it under the caret; filtering is recomputed on the next search
  keystroke or re-render.

## Implementation notes

- `src/expansion/rules.ts` — new pure `phraseMatchesQuery(phrase, query)`: trims the query, treats
  an empty query as “match all”, lowercases both sides, and checks trigger/replacement substrings.
  This keeps the settings page free of matching rules and testable without a DOM.
- `src/settings.ts` — `PhraseRowEntry { phrase, rowEl, triggerInputEl }`; instance state
  `phraseSearchQuery`, `phraseRows`, `phraseNoMatchesEl`. New methods `renderPhrasesToolbar()`,
  `addPhrase()`, `applyPhraseFilter()`. `renderPhraseRow()` now returns its entry instead of `void`.
  `display()` resets the row/no-match references; `hide()` and Back clear the query.
- `src/styles/expansion.css` — `.rp-phrase-toolbar` (hidden info block, full-width control, gap),
  `.rp-phrase-search` (flex, `min-width: 0`), `.rp-phrase-row.is-hidden`,
  `.rp-phrase-no-matches` (shares the muted italic style with `.rp-phrase-empty`). Removed the now
  unused `.rp-phrase-add-row`.
- `src/i18n/locales/{en,ru}.json` — updated `textExpansionPhrasesPageDesc` and
  `textExpansionPhrasesEmpty` (the first phrase is no longer “below”), added
  `textExpansionPhraseSearch`, `textExpansionPhraseSearchPlaceholder`, and
  `textExpansionPhrasesNoMatches` (with a `{query}` parameter). 508 keys at parity.
- Test mocks — `src/__mocks__/obsidian.ts`: `Setting` now appends `settingEl` to the container,
  matching Obsidian, so tests can query `.rp-phrase-row` / `.rp-phrase-toolbar` in `containerEl`;
  `MockInputEl` gained `focus()` and a read-only `focused` flag so the add-focus path is assertable.
- Tests:
  - `src/__tests__/settings-tab.test.ts` — search-field presence, filtering by trigger and
    replacement, no-match visibility, toolbar-before-list DOM order, add-at-top + filter reset +
    focus + delete cleanup.
  - `src/__tests__/expansion/rules.test.ts` — `phraseMatchesQuery` case-insensitivity, empty query,
    trigger and replacement matches, and a non-match.
- Docs: `README.md` / `README.ru.md` describe the search field, top placement, and prepending;
  `.rpiv/guidance/src/expansion/architecture.md` documents the toolbar/filter/focus contract.

## Files touched

- `src/settings.ts`
- `src/expansion/rules.ts`
- `src/styles/expansion.css`
- `src/i18n/locales/en.json`, `src/i18n/locales/ru.json`
- `src/__mocks__/obsidian.ts`
- `src/__tests__/settings-tab.test.ts`, `src/__tests__/expansion/rules.test.ts`
- `README.md`, `README.ru.md`
- `.rpiv/guidance/src/expansion/architecture.md`

## Verification

`npm run check:release` is green at `3.6.24`:

- build + strict TypeScript, ESLint, Stylelint;
- **1530 tests passed (2 skipped)**, 102 files passed / 1 skipped;
- planning freshness, consistency (10 commands, 508 i18n keys at parity), agent docs, knip;
- CSS audit: 257 classes, no orphaned/missing classes;
- i18n UI-text audit: pass.

Live manual check in **Obsidian 1.15.0** on the `working-vault` copy of the plugin (dev build,
before the tag):

- Opened the nested phrase page from the main settings page; 21 stored phrases rendered.
- Filter `с1` (Cyrillic, matching the vault data) left 1 row visible and 20 hidden.
- Filter `zzz` showed 0 rows and «Нет фраз, совпадающих с «zzz».».
- **Add phrase** created a blank row at the top, cleared the search, and focused its trigger input
  (active element had class `rp-phrase-trigger`); the invalid-trigger counter appeared as expected.
- Deleted the test row; the page returned to 21 rows and the first stored phrase was unchanged.
- No console errors. Note for future live tests: the working vault's triggers are Cyrillic `с1…`,
  so a query typed as Latin `c1` correctly returns no matches.

## Release state

- Version `3.6.24` in `package.json` / `manifest.json` / `package-lock.json`; `versions.json` maps
  `3.6.24 → 1.5.7`.
- Commits: `ac8b194` (fix), `d01606e` (`3.6.24`); tag `3.6.24` pushed.
- `main` is clean and equal to `origin/main` (handoff commit added separately after this file).
- CI on `main` and the Release workflow for tag `3.6.24` are green.
- Release published: https://github.com/vegacepticon/RadiProtocol/releases/tag/3.6.24
  - `main.js` — 576217 bytes, sha256 `ab4f8bfe…` (byte-identical to the local build)
  - `styles.css` — 93509 bytes, sha256 `9d182ea1…`
  - `manifest.json` — 299 bytes, sha256 `c043f897…`
- The release workflow pruned older releases, keeping 3.6.22, 3.6.23, and 3.6.24.
- The working vault's manual install is updated to `3.6.24` and the app was restarted; the plugin
  reports version `3.6.24` and is enabled.

## Notes / limits

- The search query is UI state only: it is not persisted to `data.json`, survives re-renders caused
  by delete, and is cleared by add, Back, and closing the settings tab.
- New rows are prepended, not appended. If the user ever wants append-at-bottom, change `unshift()`
  to `push()` in `addPhrase()` and focus/scroll the last row instead.
- No per-row enable, reorder, or multi-line editor was added. Search does not rewrite phrases; it
  only hides rows.
- The toolbar stays at the top of the page, not sticky while scrolling. Adding several phrases works
  because each add focuses the new top row, so the control remains in view.
- Operational gotcha: after copying a **manifest with a new version** into the working vault,
  `obsidian plugin:reload id=radiprotocol` left the plugin unregistered in the runtime
  (`app.plugins.manifests.radiprotocol` absent) until `obsidian restart`. Reloading the plugin alone
  is enough for code-only changes; restart after a manifest/version change.

## First thing in the next session

Read this file, then `git log -3`. The phrase page work is complete and released. Start from a new
user request or from the backlog at the end of the 3.6.22 handoff (per-phrase hotkeys, reorder,
per-row enable, multi-line editing, and undo of the last replacement remain open; none are bugs).
