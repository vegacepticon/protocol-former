---
date: 2026-11-11T09:40:00+0300
author: Roman Shulgha
commit: f555a02
branch: main
repository: RadiProtocol
topic: "Session close: runner keyboard release 3.6.18 + one-hand confirm, placeholder navigation, and phrase-substitution backlog"
tags: [handoff, release, brat, runner, keyboard, snippet-fill, placeholders, i18n, backlog]
status: complete
last_updated: 2026-11-11T09:40:00+0300
last_updated_by: Roman Shulgha
type: session_handoff
supersedes: .rpiv/artifacts/handoffs/2026-11-11_09-15-06_runner-keyboard-and-ui.md
---

# Handoff: release 3.6.18 + next-session backlog

This file supersedes `2026-11-11_09-15-06_runner-keyboard-and-ui.md`. The work it
describes is shipped; the value now is the current state plus the three backlog
items the user raised while testing the release.

## Since the previous handoff

- The runner keyboard/UI track was released as **3.6.18** and the user installed it
  through BRAT and confirmed it works ("Все работает").
- Release: tag/commit `3.6.18` / `f555a02`, published
  `https://github.com/vegacepticon/RadiProtocol/releases/tag/3.6.18` with assets
  `main.js`, `styles.css`, `manifest.json`. Not draft, not prerelease. Release and
  CI workflows both green. Old releases were pruned to the last three
  (3.6.18, 3.6.17, 3.6.16) by the workflow's existing prune step.

## Current state

- Branch `main`, clean tree, local == origin, HEAD = `f555a02` (`3.6.18`).
- Version `3.6.18` in `package.json` / `manifest.json` / `package-lock.json`;
  `versions.json` maps `3.6.18 → 1.5.7`. Tags have no `v` prefix (`.npmrc` sets
  `tag-version-prefix=""`); release commits are named just `3.6.18`.
- `npm run check:release` green at the tag: build, ESLint + Stylelint, **1424 tests**,
  planning freshness, consistency (468 i18n keys at parity), agent docs, knip, CSS
  audit, i18n audit.

### Release mechanics (reuse next time)

```bash
npm run check:release          # must be green first
npm version X.Y.Z -m "X.Y.Z"   # bumps pkg + lock, runs version-bump.mjs, commits, tags
git push origin main
git push origin X.Y.Z          # tag push triggers .github/workflows/release.yml
gh run watch <id> --exit-status
gh release view X.Y.Z --json assets
```

`release.yml` builds on the tag, verifies the tag matches `manifest.json`, attaches
`main.js` + `styles.css` + `manifest.json`, then prunes older releases (KEEP=3).
The repo convention is a **patch** bump even for features (3.6.16 → 3.6.17).

### BRAT install (confirmed working by the user)

`vegacepticon/RadiProtocol` added via BRAT → **Add Beta plugin**; updates via
**Check for updates**. Repo is public, which BRAT requires.

## What shipped in 3.6.18 (short recap)

- `src/runner/keymap.ts` — pure `resolveRunnerKey(input, context)`; `code`-based
  letters/digits (Russian layout works), IME and text-entry guards, modifier
  handling, unavailable actions → `null`.
- `src/runner/option-target.ts` — `RunnerOptionTarget`; renderers register options in
  render order, the host numbers the first nine and dispatches `1–9`, `Z`, `X`, `S`,
  `F`, `C`, `V`, `H`, `Esc`; `Ctrl/Alt/Mod+←/→` and `Backspace` are aliases.
- Host owns Escape (`close` → `requestClose()`); shells keep a pre-mount fallback.
- Focus: `autoFocusOnMount` (default true, sidebar false), root focus restored after
  actions only when focus was inside the runner; `tabindex="-1"` on the root.
- UI: number badges from `data-rp-key`, key-hint row (session-scoped, `H`), protocol
  title in the header, 40px option targets, visible focus rings.
- Docs: key table in README EN/RU; both architecture guides updated. Spec with the
  accepted decisions and implementation notes:
  `.rpiv/artifacts/plans/2026-11-11_09-05-40_runner-keyboard-and-ui.md`.

## Backlog for the next session (user's own ideas, in their priority order)

### A. One-hand confirm/insert for the snippet fill modal

**Problem.** The fill modal confirms with `Shift+Enter`
(`src/views/snippet-fill-in-modal.ts:56`). With the right hand on the mouse this
needs both hands. The modal is the only place where "confirm = insert the snippet",
so one key should cover it.

**Recommendation: `Ctrl+Space`** (left pinky + left thumb, single press). Rationale:

- Works while focus is inside a placeholder textarea (plain `Enter` must stay a
  newline there — free-text placeholders are auto-growing textareas).
- Does not insert characters, unlike `Shift+Space`.
- Layout independent (`event.key === ' '` / `event.code === 'Space'` + `ctrlKey`).
- Not an Obsidian default hotkey, so no conflict with user assignments.
- Caveat: some CJK IMEs toggle the input mode on `Ctrl+Space`. Irrelevant for a
  Russian user, but worth a note in the README if it ships.

Keep `Shift+Enter` as an alias (no user-visible break). Consider also unifying the
runner's free-text submit (`render-question.ts:113`, `render-loop-picker.ts:99`,
currently `Shift+Enter`) on the same `Ctrl+Space`, so confirm/insert is one muscle
memory across the whole runner. The conclusion draft is separate: `Enter` adds a
line and `V` inserts the draft (`src/views/runner-conclusion-draft.ts:56`).

**Implementation points.** Add the chord to `onContentKeydown`; if extended to the
runner, add it to the free-text `bindKeydown` handlers (or to `keymap.ts` as a new
action, which is cleaner: one resolver, one action `confirm`/`submit`). Tests:
fill modal confirm from each field kind (free-text, choice, custom override),
`Ctrl+Space` inside textarea does not insert a space and does not add a newline,
`Shift+Enter` still works, IME composition guard.

**Open decision.** `Ctrl+Space` vs a two-press `Tab` → `Space` flow (Confirm button is
already the last tab stop). The user should pick; `Ctrl+Space` is the proposal.

### B. Left-hand placeholder navigation in the fill modal

**Current behaviour.** Tab order = placeholder array order; the Confirm button is
last (`snippet-fill-in-modal.ts:412`). But a `choice` field renders one button per
option plus the `✎` custom toggle (`snippet-fill-in-modal.ts:168-280`), and every one
of them is a tab stop, so a 5-option choice costs 6 Tab presses. The modal also does
not focus the first field on open, so the first key is always a Tab.

**Proposed interaction.**

1. **Autofocus the first placeholder field on open** (before the preview, which is a
   non-interactive div).
2. **Roving tabindex per choice group**: one Tab stop per fieldset; `←/→` (and
   `↑/↓`) move focus between options; `Space` or `Enter` toggles; `Tab` leaves the
   group for the next field. This is the standard toolbar pattern and keeps the
   existing `aria-pressed` buttons (the group is multi-select, so not `radiogroup`).
3. **Numeric option selection**: `1–9` toggles the Nth option **only when the choice
   group has focus**. Inside a textarea digits must keep typing themselves, so do not
   intercept them there without a modifier.
4. `Ctrl+Space` confirms from anywhere (item A).
5. Optional later: `Alt+1–9` jumps focus to the Nth placeholder from a text field, if
   Tab turns out to be too slow. Left hand reaches Alt with the thumb, so this stays
   one-handed if it is ever needed.

**Watch out.** The custom override textarea lives in a `hidden` row
(`snippet-fill-in-modal.ts:236-270`) — roving focus must skip it while collapsed and
include it when expanded, and the `✎` toggle itself should remain reachable. Also
keep the preview markup untouched: it is a `div` with valued placeholders, not a
field.

**Tests.** Roving tabindex and arrow navigation per group; digits toggle only in the
focused group; digits type normally in a textarea; Tab order still field → field →
Confirm; autofocus on open; collapsed custom row is skipped; `aria-pressed` stays in
sync.

### C. Phrase-substitution plugins inside runner text fields (research spike)

**Problem.** Free-text answers (`F`), loop free-text targets, and the conclusion
draft are plain `<textarea>` elements. Community phrase expanders do not fire there.
"Substitutions" explicitly "replaces text while you type in the editor"
([README](https://github.com/BambusControl/obsidian-substitutions)) — i.e. it hooks
the CodeMirror input path, not arbitrary DOM inputs. Text-Snippets is an editor
suggestion provider for the same reason ([editor interface docs](https://deepwiki.com/obsidianmd/obsidian-api/2.5-editor-interface)).
So this is **not a bug in RadiProtocol** and cannot be fixed by forwarding DOM events.

**Options, cheapest first.**

1. **Own lightweight phrase expansion** inside the runner's text fields (settings
   list + trigger on input, optional popup). No third-party interop, but users would
   retype their phrase library. Lowest risk.
2. **Bridge**: detect that a known phrase-expansion plugin is enabled and re-emit its
   trigger? Not feasible — those plugins operate on editor instances and their rules
   are not exposed through a public API.
3. **Embed a CodeMirror editor** in place of the textarea (the `MarkdownEditor`
   internal used by several community plugins). This is the only path that gives the
   user's existing Substitutions/Text-Snippets rules, but it is a heavy change:
   internal API risk, sizing/growing behaviour, Enter/Shift+Enter semantics, IME,
   mobile parity, focus policy interaction with item A/B, and theme/layout work.
4. Leave textarea fields as they are and document that phrase plugins apply to notes
   only.

**First step next session: a research spike, not code.** Confirm for each plugin
(Substitutions, Text-Snippets) how it registers (CM6 extension vs `EditorSuggest`),
whether an embedded editor created through Obsidian's internal `MarkdownEditor`
inherits editor extensions loaded by other plugins, and what the embed costs
(growing height, focus, escape, `Ctrl+Space` from item A). Then decide option 1 vs 3
with the user. Do not start option 3 without an explicit decision.

## Architecture reminders (carry forward)

- Renderers **register** options; the host **dispatches**. Keep `keymap.ts` pure and
  DOM-free; if a new chord is added, add an action there, not in a shell.
- `render()` = `renderState()` + `finalizeRender()`; post-render work (badges, hints,
  focus) belongs in `finalizeRender`.
- Phase 3's item-A/B work stays in `src/views/snippet-fill-in-modal.ts`; do not
  duplicate key handling in `runner-session-host.ts` for the fill modal (it is a
  separate Obsidian `Modal` and receives its own keydown).
- Every UI string needs `en.json` + `ru.json` (parity enforced).

## Gotchas

- Never edit `main.js` / `styles.css`; edit `src/` then `npm run build`. Release
  assets are built by CI from the tag.
- `stepBack()` has a per-tick double-click guard; tests must `await` a microtask
  between rapid undo calls.
- The node test environment has no `document`; use the existing `currentActiveElement()`
  helper rather than touching `document` directly.
- `scripts/check-consistency.mjs` Check 8 needs command names in both READMEs;
  knip fails on unused exports; CSS audit flags orphaned/missing `rp-`/`is-` classes.
- Conventional commits; `npm run check:release` before every commit that touches
  source, and definitely before a release tag.

## How to resume

```bash
git status
git log -3 --oneline
npm run check:release
```

Then read this handoff and start with **item A** (one-hand confirm), because item B
depends on where the confirm chord lands. Ask the user:

1. `Ctrl+Space` vs `Tab` → `Space` for confirm/insert?
2. Should `Ctrl+Space` also submit free-text answers in the runner (replacing
   `Shift+Enter` as primary, keeping it as alias)?
3. Digits only in a focused choice group (recommended) or global?
4. Item C: spend a spike on embedded CodeMirror, or ship an own phrase expander?

## References

- Release: `https://github.com/vegacepticon/RadiProtocol/releases/tag/3.6.18`
- Spec + implementation notes: `.rpiv/artifacts/plans/2026-11-11_09-05-40_runner-keyboard-and-ui.md`
- Previous handoff (superseded): `.rpiv/artifacts/handoffs/2026-11-11_09-15-06_runner-keyboard-and-ui.md`
- `src/views/snippet-fill-in-modal.ts` — confirm listener (56), field rendering (128),
  choice field (168), custom override (236), button row (412), confirm (405)
- `src/runner/keymap.ts`, `src/runner/option-target.ts`, `src/views/runner-session-host.ts`
- `src/runner/render/render-question.ts:113`, `src/runner/render/render-loop-picker.ts:99`,
  `src/views/runner-conclusion-draft.ts:56` — current Enter chords
- `README.md` / `README.ru.md` — runner key table to extend when the new chords ship
- `.rpiv/guidance/src/runner/architecture.md`, `.rpiv/guidance/src/views/architecture.md`
