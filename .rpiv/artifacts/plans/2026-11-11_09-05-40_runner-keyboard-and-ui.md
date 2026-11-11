---
date: 2026-11-11T09:05:40+0300
author: Roman Shulgha
commit: 91821fe
branch: main
repository: RadiProtocol
topic: "Runner keyboard interaction model and UI affordances"
tags: [plan, spec, runner, keyboard, keymap, focus, ui, accessibility]
status: complete
parent: .rpiv/artifacts/handoffs/2026-11-11_08-59-03_docs-and-advisories.md
phase_count: 5
phases:
  - { n: 1, title: "Pure keymap resolver", files: [src/runner/keymap.ts, src/__tests__/runner/keymap.test.ts], depends_on: [] }
  - { n: 2, title: "Renderer option registration", files: [src/runner/render/render-question.ts, src/runner/render/render-loop-picker.ts, src/__tests__/runner/runner-renderer-host-fixtures.ts, src/__tests__/runner/render-question.test.ts, src/__tests__/runner/render-loop-picker.test.ts], depends_on: [1] }
  - { n: 3, title: "Host dispatch and focus model", files: [src/views/runner-session-host.ts, src/views/inline-runner-modal.ts, src/views/sidebar-runner-view.ts, src/views/runner-conclusion-draft.ts, src/__tests__/views/runner-session-host.test.ts, src/__tests__/views/inline-runner-modal-keyboard.test.ts, src/__tests__/views/sidebar-runner-view.test.ts], depends_on: [1, 2] }
  - { n: 4, title: "Numeric badges, hint row, header title", files: [src/views/runner-session-host.ts, src/constants/css-classes.ts, src/styles/runner-session.css, src/i18n/locales/en.json, src/i18n/locales/ru.json], depends_on: [3] }
  - { n: 5, title: "Verification, docs, and manual checklist", files: [src/__tests__/views/runner-session-host-keyboard.test.ts, README.md, README.ru.md, .rpiv/guidance/src/runner/architecture.md, .rpiv/guidance/src/views/architecture.md], depends_on: [4] }
unresolved_phase_count: 0
last_updated: 2026-11-11T09:05:40+0300
last_updated_by: Roman Shulgha
---

# Runner Keyboard Interaction Spec

## Purpose

The runner is driven today by a fragmented set of listeners: shells own `Esc`, the
host owns `Ctrl/Alt+←/→`, renderers own `Shift+Enter`, and answer buttons only
react to mouse/`Enter`/`Tab`. This spec defines one interaction model — one
resolver, one action registry, one focus policy — so that the floating panel and
the sidebar cannot drift, and so that a radiologist can complete a short protocol
without leaving the keyboard.

## Decisions (approved 2026-11-11)

1. **Keymap**: the draft from the handoff is approved as written (`1–9`, `Z`, `X`,
   `S`, `F`, `C`, `V`, `H`, `Esc`), with `Ctrl/Alt+←/→` and `Backspace` kept as aliases.
2. **Focus**: auto-focus the runner on open and after accepted actions. Focus is
   never stolen while it lives outside the runner.
3. **Test vault**: none. Verification relies on unit tests plus a local HTML
   preview harness built from the real CSS classes.

## States and actions

| Runner state | Keyboard-selectable options | Other actions |
|---|---|---|
| `at-node` (question) | answers (preset), free-text answers, question transitions, snippet branches — in authored order | back, redo, skip (when answers exist), `F`, `C`, `V`, `H`, `Esc` |
| `awaiting-loop-pick` | loop body branches, loop exit, free-text loop targets — in authored order | back, redo, `F`, `C`, `V`, `H`, `Esc` |
| `awaiting-snippet-pick` | none (tree picker owns arrows/`j`/`k`/`Enter`/`Tab`) | back, redo, `C`, `V`, `H`, `Esc` |
| `awaiting-snippet-fill` | none (modal owns keys) | `C`, `V`, `H`, `Esc` |
| `complete` | none (self-check checkboxes keep native `Tab`/`Space`) | `C`, `V`, `H`, `Esc` |
| `idle` / `error` | none | `Esc` |
| output blocked / draft writing / insertion pending | none — every runner key is inert until the write settles | — |

Option numbering is the render order of the current state, counting every
actionable option (a free-text row counts as one option). Only the first nine
options receive a number; further options remain mouse/`Tab` targets. Numbers are
per-render, never persisted.

## Key table

| Key | Scope | Action | Unavailable when |
|---|---|---|---|
| `1`–`9` (main or numpad row) | any state with numbered options | Activate the Nth option; a free-text option focuses its field instead of submitting | fewer than N options; text field focused; modifier held |
| `Enter` / `Space` | native | Activate the focused control (unchanged) | — |
| `Tab` / `Shift+Tab` | native | Move focus (unchanged) | — |
| `Z` | any | Back one step | `canStepBack === false`, snippet picker mid-load |
| `Backspace` | any | Alias of `Z` | same as `Z` |
| `X` | any | Redo the undone step | `canRedo === false` |
| `S` | question states with preset answers | Skip the question | no answers/loop exits to skip |
| `F` | state with a free-text option | Focus the first free-text field (blank field wins when several exist) | no free-text option |
| `C` | any, when the conclusion draft is enabled | Focus the conclusion draft | draft disabled or destroyed |
| `V` | any, outside inputs | Insert the conclusion draft | draft blank, already inserted, busy, or writing blocked |
| `H` | any | Toggle the key-hint row | — |
| `Esc` | any, outside inputs | Close the runner (draft confirmation applies) | — |
| `Ctrl/Alt/Mod + ←/→` | any, outside inputs | Legacy back/redo aliases (unchanged) | `canStepBack` / `canRedo` false |

`H` is a session-scoped toggle (default visible). It is deliberately not persisted
to settings: hint visibility is presentation state, not a user preference.

## Focus policy

1. **On open** — after a successful first render, focus moves to the runner root.
   The user invoked a command; no typing context is lost.
2. **After an accepted action** — focus returns to the runner root, so the next
   digit/letter lands in the runner even though the clicked button was replaced.
3. **Never steal** — a render never moves focus when focus currently lives outside
   the runner (for example the note editor after the user clicked back into it).
4. **Projected free-text field** — when the only actionable option is a free-text
   answer, that field takes focus instead of the root (existing behavior).
5. **Sidebar** — the panel already receives focus when the leaf is active; the same
   policy applies without extra shell work.
6. The root is `tabindex="-1"` so it is programmatically focusable without entering
   the tab order. Shells keep a last-resort `Esc` close only when the host is not
   mounted (bootstrap failure / disposal).

## Input, IME, and layout rules

- Match letters by `event.code` (`KeyZ`, `KeyX`, `KeyS`, `KeyF`, `KeyC`, `KeyV`,
  `KeyH`) so the Russian layout needs no remapping.
- Match digits by `event.code` (`Digit1`–`Digit9`, `Numpad1`–`Numpad9`).
- Ignore `event.isComposing` and `keyCode === 229`; never prevent default while a
  composition session is active.
- Ignore every mapped key when a modifier (`ctrl`/`meta`/`alt`) is held, except the
  legacy arrow aliases. `Shift` is allowed only where it cannot type text (no text
  field focused).
- Never intercept keys when the event target is `INPUT`, `TEXTAREA`, `SELECT`, or a
  `contenteditable` element. Plain keys in fields must keep native meaning.
- Only call `preventDefault()` when an action actually ran.
- `event.repeat` is allowed for `Z`/`X`/`S` (hold-to-rewind is intentional).

## Accessibility

- Each numbered option exposes `data-rp-key="N"` and `aria-keyshortcuts="N"`.
- The hint row is a labelled group (`role="group"`, localized `aria-label`); the
  hint chips use real `<kbd>` elements.
- Number badges are decorative (`aria-hidden` via CSS pseudo-element).
- Icon-only footer buttons keep their localized `aria-label`s.

## Visual direction (this slice)

- Number badge rendered from `data-rp-key` as a CSS `::before` chip: muted border,
  `2ch` square, right-gutter placement so wrapped captions stay aligned.
- Hint row under the action area: one compact, wrapping line of `<kbd>` chips for
  the actions available in the current state; hidden by `H`.
- Header gains the protocol title (basename, no extension) next to the progress bar.
- Minimum option height raised from 36px to 40px; focus ring uses
  `box-shadow: 0 0 0 2px var(--interactive-accent)`.

## Non-goals

- No global command hotkeys (users still assign those in Obsidian).
- No configurable keymap or settings tab option in this slice.
- No remapping of the snippet picker's own `j`/`k`/arrows, the fill modal, or the
  protocol editor.
- No visual regression infrastructure; the HTML preview harness stays local and
  uncommitted unless it proves stable.

## Acceptance criteria

1. `resolveRunnerKey` is pure, DOM-free, and covered for: digits with and without
   options, numpad, modifiers, `isComposing`, text-entry targets, unavailable
   actions, and every mapped letter on a Russian-layout event (`code` set, `key` = `я`).
2. `1`–`9` choose the Nth option in both question and loop-picker states; a digit
   aimed at a free-text row focuses its field and submits nothing.
3. `Z`/`X`/`S`/`F`/`C`/`V`/`H`/`Esc` each map to exactly one action; unavailable
   actions are silent no-ops that do not `preventDefault`.
4. `Ctrl/Alt+←/→` and `Backspace` still work; typing `Z` inside a free-text field
   inserts `Z` and never steps back.
5. Focus after an accepted action is inside the runner root; a render triggered
   while the note editor holds focus leaves it there.
6. Badges and `aria-keyshortcuts` appear only on the first nine options and match
   the numeric dispatch order.
7. Hint row lists only currently available actions and disappears on `H`.
8. `npm run check:release` passes; README EN/RU document the final key table.

## Manual checklist (Obsidian, no test vault available)

- [ ] Floating runner: open, press `2`, `Z`, `X`, `S`, `C`, `V`, `H`, `Esc`.
- [ ] Free-text answer: press its digit → field focuses; type Cyrillic; `Shift+Enter` submits.
- [ ] Click into the note, type, return to the runner → no stolen keystrokes.
- [ ] Sidebar runner: same keys with focus in the panel.
- [ ] Loop picker: digits pick body/exit; free-text loop target focuses.
- [ ] Conclusion draft: `C`, type, `V`, confirm the note content.
- [ ] Snippet picker open: `j`/`k`/arrows still navigate; digits do nothing.

## Implementation notes (2026-11-11)

All five phases landed in one slice; `npm run check:release` is green.

- **Escape moved into the host.** `resolveRunnerKey` returns `close`, the host runs
  `requestClose()` (draft confirmation included), and each shell keeps a fallback
  for the window where the host is missing or not mounted. Shell tests were updated
  to assert delegation rather than shell-local `Escape`.
- **`autoFocusOnMount`** defaults to `true` and is set to `false` by the sidebar,
  whose leaf already owns focus.
- **Focus restoration is deferred** one task so the projected free-text field
  (which focuses itself during the render) keeps the caret. Focus is only restored
  when it was inside the runner before the render, or when a keyboard action
  requested it; focus that lives outside the runner is never taken.
- **Badges** are CSS `::before` chips driven by `data-rp-key`; no extra DOM. The
  free-text row gets a higher-specificity padding rule so its prompt and badge
  align with buttons.
- **Hint row** is rebuilt per render and lists only currently available actions.
  `H` hides it for the session; it is not persisted.
- The HTML preview harness described above stayed local (`/tmp`): the DOM was
  hand-written, so committing it would create a second source of truth. Layout was
  checked at 360×560, 360×400, and 640×460 with the real built `styles.css`.
- Test additions: `src/__tests__/runner/keymap.test.ts` (46), renderer registration
  tests (+4), host keyboard/focus tests (+12), shell delegation tests (+3).
