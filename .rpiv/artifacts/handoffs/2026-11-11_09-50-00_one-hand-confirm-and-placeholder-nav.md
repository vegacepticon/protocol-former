---
date: 2026-11-11T09:50:00+0300
author: Roman Shulgha
commit: beb5ea3
branch: main
repository: RadiProtocol
topic: "Release 3.6.19: one-hand Ctrl+Space confirm, placeholder navigation, and phrase-plugin research spike"
tags: [handoff, release, brat, runner, keyboard, snippet-fill, modal, placeholders, research, backlog]
status: complete
last_updated: 2026-11-11T09:50:00+0300
last_updated_by: Roman Shulgha
type: session_handoff
supersedes: .rpiv/artifacts/handoffs/2026-11-11_09-40-00_session-close-and-backlog.md
---

# Handoff: release 3.6.19 + backlog item C decision

This file supersedes `2026-11-11_09-40-00_session-close-and-backlog.md`. Items A and B
from that backlog are shipped; the research spike for item C is done and is now a
product decision, not an investigation.

## Since the previous handoff

- Backlog **A (one-hand confirm)** and **B (placeholder navigation)** are implemented
  and released as **3.6.19**.
- Backlog **C (phrase-substitution plugins)** was researched, not coded. Findings:
  `.rpiv/artifacts/research/2026-11-11_09-50-00_phrase-substitution-plugins-in-runner-fields.md`.

## Current state

- Branch `main`, clean tree, local == origin, HEAD = `beb5ea3` (`3.6.19`).
- Version `3.6.19` in `package.json` / `manifest.json` / `package-lock.json`;
  `versions.json` maps `3.6.19 → 1.5.7`.
- Release published: `https://github.com/vegacepticon/RadiProtocol/releases/tag/3.6.19`
  with `main.js`, `styles.css`, `manifest.json`. Not draft, not prerelease. Release
  and CI workflows both green. Old releases pruned to the last three.
- `npm run check:release` green at the tag: build, ESLint + Stylelint, **1445 tests
  (2 skipped)**, planning freshness, consistency (468 i18n keys at parity), agent docs,
  knip, CSS audit, i18n audit.

### Release mechanics (unchanged)

```bash
npm run check:release          # must be green first
npm version X.Y.Z -m "X.Y.Z"   # bumps pkg + lock, runs version-bump.mjs, commits, tags
git push origin main
git push origin X.Y.Z          # tag push triggers .github/workflows/release.yml
gh run watch <id> --exit-status
gh release view X.Y.Z --json assets
```

Repo convention is a **patch** bump even for features (3.6.18 → 3.6.19).
BRAT install `vegacepticon/RadiProtocol`, update via **Check for updates**.

## What shipped in 3.6.19

### A. Ctrl+Space confirm/submit

- `isConfirmChord(input)` in `src/runner/keymap.ts` is the single definition of the
  chord. Ctrl+Space, no Meta/Alt, IME-guarded, matched on `code` so the Russian layout
  works.
- New action `submit-free-text`. It resolves **before** the text-entry guard (the one
  deliberate exception), because the caret is expected inside a field.
- `RunnerOptionTarget.submit?()` (`src/runner/option-target.ts`). Free-text renderers
  (`render-question.ts`, `render-loop-picker.ts`) pass the same function to the Submit
  button, the Shift+Enter alias, and `registerOption`. The host finds the option whose
  `keyboardElement === event.target` and calls it, so the chord is inert on the root,
  on buttons, and in the conclusion draft.
- The snippet fill-in modal imports the same helper; `Shift+Enter` still confirms
  there and in the free-text fields as a legacy alias.
- `Ctrl+Space` is deliberately not in the hint row (space is tight); it is documented
  in both READMEs instead.

### B. Fill-in modal navigation

- Focuses the first placeholder field on open, and re-asserts it on the next tick
  because Obsidian re-focuses the modal container after `onOpen` (skipped if the modal
  was already resolved).
- Each choice `fieldset` is one roving `tabindex` stop over the option pills **plus**
  the `✎` Custom toggle; arrow keys move and wrap, `Tab` leaves the group for the next
  field. The collapsed Custom row stays out of the set; the expanded textarea is its
  own tab stop.
- `1`–`9` toggles the Nth option **only while focus is inside that group**. The Custom
  textarea keeps digits for typing. Toggling goes through the same `toggleOption()`
  used by clicks, so `aria-pressed`, `is-selected`, the value map, and the preview stay
  in sync; the roving stop follows the toggled option.

## Backlog item C — decision needed

The research artifact is the source of truth. In short:

- **Substitutions** is a global CM6 extension with no API; it only reacts to
  CM6 transactions, so DOM events cannot trigger it.
- **Text-Snippets** uses the removed CM5 `registerCodeMirror` (a no-op now) and targets
  `activeLeaf`; unusable.
- The public typings have **no** inline-editor factory (`MarkdownEditor`,
  `EmbeddedEditor`, `MarkdownScrollableEditView` are absent from `obsidian.d.ts`).
  Embedding means internal APIs (`app.embedRegistry…`, prototype patches,
  `setActiveLeaf`), which the architecture deliberately avoids.
- Global CM6 extensions **do** reach Obsidian's own embedded editor (verified in the
  1.14.4 bundle), so an embed would give users their existing rules — at high
  maintenance cost (keymap precedence for Enter/Shift+Enter/Escape, auto-grow height,
  focus/scope, mobile, IME, 1.15 iframe churn).

**Options:** (1) own lightweight expansion in the runner's text areas — recommended,
no internal APIs, users retype their rules; (2) bridge — closed, no API; (3) embed
Obsidian's editor — only path to existing rules, high risk; (4) document that phrase
plugins apply to notes only.

**Ask the user:** is retyping rules acceptable (option 1), or is inheriting existing
Substitutions rules a hard requirement (option 3)? If option 1, pick the trigger style
(expand on Space/Enter vs a suggestion popup). If option 3, get an explicit decision
and pin supported Obsidian versions.

## Architecture reminders (carry forward)

- Renderers **register** options; the host **dispatches**. `keymap.ts` stays pure and
  DOM-free; new chords go there as actions (`isConfirmChord` is the shared definition,
  also used by the fill modal).
- `render()` = `renderState()` + `finalizeRender()`; post-render work (badges, hints,
  focus) belongs in `finalizeRender`.
- The fill modal is a separate Obsidian `Modal` with its own `contentEl` keydown
  listener; do not duplicate its keys in `runner-session-host.ts`.
- Every UI string needs `en.json` + `ru.json` (parity enforced). 3.6.19 added none.

## Gotchas

- Never edit `main.js` / `styles.css`; edit `src/` then `npm run build`. CI builds the
  release assets from the tag.
- The fill modal's mock `MockEl` has no bubbling: dispatch on the listener owner and
  override `target` (see `dispatchKeydownOn` in
  `src/__tests__/views/snippet-fill-in-modal.test.ts`).
- `focusFirstField()` leaves a `setTimeout(…, 0)` behind; tests assert focus with the
  per-element `focusCount` (never a global "last focused" variable) to stay isolated.
- `stepBack()` has a per-tick double-click guard; tests must `await` a microtask
  between rapid undo calls.
- The node test environment has no `document`; use `currentActiveElement()` rather than
  touching `document` directly.
- Conventional commits; `npm run check:release` before every commit that touches
  source, and definitely before a release tag.

## How to resume

```bash
git status
git log -3 --oneline
npm run check:release
```

Then read this handoff. The next session starts with the user's answer on item C; do
not start an embedded editor without an explicit decision.

## References

- Release: `https://github.com/vegacepticon/RadiProtocol/releases/tag/3.6.19`
- Research spike (item C):
  `.rpiv/artifacts/research/2026-11-11_09-50-00_phrase-substitution-plugins-in-runner-fields.md`
- Previous handoff (superseded):
  `.rpiv/artifacts/handoffs/2026-11-11_09-40-00_session-close-and-backlog.md`
- `src/runner/keymap.ts` — `isConfirmChord`, `submit-free-text`
- `src/views/snippet-fill-in-modal.ts` — `focusFirstField`, roving tabindex, digit
  toggles, `onContentKeydown`
- `src/views/runner-session-host.ts` — `submit-free-text` dispatch by event target
- `README.md` / `README.ru.md` — runner key table and fill-modal paragraph
- `.rpiv/guidance/src/runner/architecture.md`, `.rpiv/guidance/src/views/architecture.md`
