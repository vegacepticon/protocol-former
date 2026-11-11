---
date: 2026-11-11T09:15:06+0300
author: Roman Shulgha
commit: 1c09312
branch: main
repository: RadiProtocol
topic: "Runner keyboard interaction model, hint UI, and focus policy"
tags: [handoff, runner, keyboard, keymap, focus, ui, accessibility]
status: complete
last_updated: 2026-11-11T09:15:06+0300
last_updated_by: Roman Shulgha
type: session_handoff
---

# Handoff: runner keyboard model + UI affordances

## Task(s)

- **Completed — interaction spec.** `.rpiv/artifacts/plans/2026-11-11_09-05-40_runner-keyboard-and-ui.md`
  holds the approved keymap, focus policy, state/action matrix, input rules, and
  acceptance criteria. Decisions confirmed by the user: keymap approved as drafted,
  auto-focus on open/after actions, no separate test vault.
- **Completed — pure keymap.** `src/runner/keymap.ts`: `resolveRunnerKey(input, context)`
  returns at most one action or `null`. 46 unit tests in `src/__tests__/runner/keymap.test.ts`.
- **Completed — option registry and dispatch.** Renderers register options in render
  order; the host numbers the first nine, decorates them, and dispatches keys.
- **Completed — focus policy, Escape unification, hint row, badges, header title.**
- **Not done — manual Obsidian validation.** No test vault was available; the
  checklist in the spec is still unexecuted. This is the first thing to do.
- **Deferred — remaining UI direction.** Collapsible draft in narrow panels, action
  hierarchy polish, floating/sidebar visual parity audit.

## Current state

- Branch `main`, clean working tree, HEAD = `1c09312`
  (`feat(runner): add numbered keyboard model with hint row and focus policy`).
- Version still `3.6.17`; no release bump was made (release uses `npm version X.Y.Z`).
- `npm run check:release` exits 0: build, ESLint + Stylelint, **1424 tests passed /
  2 skipped**, planning freshness, consistency (468 i18n keys at parity), agent docs,
  knip (no unused exports), CSS class audit, i18n UI-text audit.
- Generated `main.js` / `styles.css` remain gitignored build outputs.

## What the keymap does now

| Key | Action |
|---|---|
| `1`–`9` | Activate Nth rendered option (answer, question transition, snippet branch, loop body/exit). Free-text option focuses its field. |
| `Z` / `Backspace` | Back |
| `X` | Redo |
| `S` | Skip (question with preset answers) |
| `F` | Focus first blank free-text field |
| `C` | Focus conclusion draft |
| `V` | Insert conclusion draft |
| `H` | Toggle hint row (session-scoped, default visible) |
| `Esc` | Close via host `requestClose()` (draft confirmation applies) |
| `Ctrl/Alt/Mod+←/→` | Legacy back/redo aliases |

Matching is on `event.code`, so the Russian layout works. IME composition and
text-entry targets are ignored. Modifiers other than the arrow aliases are inert.
Unavailable actions resolve to `null` and never `preventDefault()`.

## Architecture notes (carry forward)

- `src/runner/keymap.ts` is pure and DOM-free — keep it that way; no Obsidian or
  renderer imports.
- `src/runner/option-target.ts` defines `RunnerOptionTarget`; renderers register,
  the host dispatches. Option order == render order, and grouping (answers →
  transitions → snippets) or authored `optionOrder` is preserved automatically.
- The host owns Escape. Shells (`inline-runner-modal.ts`, `sidebar-runner-view.ts`)
  only forward `keydown` and keep an `Esc` fallback for the pre-mount/disposed
  window. Do not reintroduce duplicate shortcut logic in shells.
- Focus: `autoFocusOnMount` defaults true; the sidebar passes false. `finalizeRender`
  restores root focus only when focus was inside the runner before the render, or
  when a keyboard action requested it. Focus outside the runner is never taken.
- `render()` is now a thin wrapper around `renderState()` + `finalizeRender()`;
  anything that must run after every state (badges, hints, focus) belongs in
  `finalizeRender`.
- Numbered selection only covers nine options; longer lists stay `Tab`/mouse.
- Badges are CSS `::before` from `data-rp-key`; tests assert the attribute.

## Verification highlights

- New tests: keymap (46), renderer registration (+4), host keyboard/focus (+12),
  shell delegation (+3). Total 1424 passing.
- Visual layout was checked with a throwaway HTML harness (real built `styles.css`,
  Chromium) at 360×560, 360×400, and 640×460. It was deliberately **not committed**
  (`/tmp/rp-preview`) because its DOM is hand-written; treat screenshots as advisory.
- Known limitation seen in the harness: with the conclusion draft enabled and a short
  floating panel (~400px), only two options fit above the fold. Options scroll, but
  a collapsible draft would recover space — candidate for the next UI slice.

## Next steps (recommended order)

1. **Manual validation in Obsidian** using the checklist in the spec. Watch
   specifically: keys after clicking an option, `Esc` with an uninserted draft,
   sidebar focus behaviour, loop picker digits, free-text focus with the Russian layout.
2. **UI slice 2**: collapsible conclusion draft in narrow panels; stronger action
   hierarchy; verify floating vs sidebar parity (shared CSS only).
3. **Optional**: promote the preview harness into `scripts/` only if it can be
   generated from the real renderers instead of hand-written markup.
4. Library track still needs a product decision (external registry/moderation);
   do not start client work without a concrete gap.

## Important constraints / gotchas

- Do not edit `main.js` / `styles.css`; edit `src/` and run `npm run build`.
- Every UI string needs `en.json` and `ru.json`; parity is enforced.
- `scripts/check-consistency.mjs` Check 8 requires command names in both READMEs;
  Check 7 enforces i18n parity; knip fails on unused exports.
- Keyboard tests must `await` a microtask between rapid `stepBack()` calls — the
  runner's per-tick double-click guard silently drops a second synchronous undo.
- The node test environment has no `document`; host code uses
  `currentActiveElement()` and must keep working when `document` is undefined.
- Conventional commits; run `npm run check:release` before committing.

## How to resume

```bash
git status
git log -3 --oneline
npm run check:release
```

Then read this handoff and the spec artifact, and start with manual validation in
Obsidian before changing keyboard or focus behaviour again.

## References

- `.rpiv/artifacts/plans/2026-11-11_09-05-40_runner-keyboard-and-ui.md` — spec + implementation notes
- `src/runner/keymap.ts`, `src/runner/option-target.ts`
- `src/views/runner-session-host.ts` — registry, dispatch, focus, hints
- `src/runner/render/render-question.ts`, `render-loop-picker.ts` — registration points
- `src/styles/runner-session.css` — badges, hint row, title, focus rings
- `README.md` / `README.ru.md` — key table, EN/RU
- `.rpiv/guidance/src/runner/architecture.md`, `.rpiv/guidance/src/views/architecture.md`
