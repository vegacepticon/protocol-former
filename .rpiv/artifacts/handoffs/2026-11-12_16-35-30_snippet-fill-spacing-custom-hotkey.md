---
date: 2026-11-12T16:35:30+0300
author: Roman Shulgha
commit: bd8e5df
branch: main
repository: protocol-former
topic: "Snippet fill-in spacing and the 0 Custom hotkey"
tags: [handoff, snippet-fill, modal, keyboard, focus, spacing, custom-override, release, version-3.7.2]
status: complete
type: session_handoff
supersedes: .rpiv/artifacts/handoffs/2026-11-12_16-17-25_snippet-fill-question-navigation.md
---

# Handoff: fill-in spacing + 0 Custom hotkey (3.7.2)

Follow-up to the question-level navigation release. The user tested `3.7.1`,
confirmed the behaviour, and asked for two refinements: more vertical space
between questions and a `0` shortcut for the Custom override.

## Behaviour

- `.rp-snippet-modal` gap is now 16px (was 8px). The question frame extends 6px
  past the field (2px outline + 4px offset), so the 8px gap let it crowd the
  neighbouring label/options; 16px leaves clear space.
- Pressing `0` while a choice question has focus (the `fieldset` itself, an
  option pill, or the `✎` toggle) opens the Custom row and focuses its textarea.
  It never toggles the first option. `Digit0` and `Numpad0` both work.
- The Custom textarea keeps digits for typing: the keydown handler already
  returns early when the event target is the Custom input, so `0` types itself.
- The `✎` toggle carries `data-rp-key="0"` / `aria-keyshortcuts="0"` and paints a
  small `0` badge, mirroring the numbered option pills.

## Files

- `src/views/snippet-fill-in-modal.ts` — `data-rp-key`/`aria-keyshortcuts` on the
  toggle; digit regex widened to `[0-9]`; `0` calls `setCustomOpen(true)`.
- `src/styles/snippet-fill-modal.css` — 16px modal gap; Custom-toggle `0` badge.
- `src/__tests__/views/snippet-fill-in-modal.test.ts` — 0-from-question,
  0-from-option/Numpad0, 0-typed-in-Custom, badge/tripwire assertions.
- `README.md` / `README.ru.md` — `0` shortcut documented.
- `.rpiv/guidance/src/views/architecture.md` — modal reference mentions `0`.

## Release state

- Version `3.7.2` in `package.json`, `manifest.json`, `package-lock.json`;
  `versions.json` maps `3.7.2 → 1.5.7`.
- Feature commit `5dbb63b`; version commit and annotated tag `3.7.2` point at
  `bd8e5df`. `main` and the tag are pushed.
- Release published (not draft, not prerelease):
  <https://github.com/vegacepticon/protocol-former/releases/tag/3.7.2>
- Release assets match the local `npm run build` output byte-for-byte:
  - `main.js` — 582598 bytes, sha256 `aec878d0c724b0cd8d96b41658e3f32311b4e482b47caf197e7e4e8e32ad047c`
  - `styles.css` — 96436 bytes, sha256 `6c5a916ccf47ba5fe9f0d8ba7b2bae969c007a421465ddf482993132f8159e90`
  - `manifest.json` — 301 bytes, sha256 `964783a9c93d0b6485cc0e9e94bdd729a4277a5a7bd971f9a6728d78699c1021`
- Release workflow and CI on `main` are green. The prune step kept the three
  newest releases: `3.7.2`, `3.7.1`, `3.7.0`; remote tags match.
- Release mechanics worked as documented: push `main`, then push
  `refs/tags/3.7.2` explicitly (no `--follow-tags`). The tag push started the
  Release workflow; it finished in ~1m31s.

## Manual check for the next session

1. A question with the focus frame should have clear space above and below; the
   frame must not touch the next question's label or options.
2. With a choice question focused, press `0`: Custom opens and the caret is in
   its field. Type `0` there and confirm it types normally.
3. Check the small `0` badge on `✎` is visible in both light and dark themes.

## Session close

- The user confirmed the `3.7.2` result visually (“Теперь смотрится
  замечательно”), so item 1 above is accepted.
- The `0` hotkey is implemented and covered by the modal tests; manual checks 2
  and 3 remain optional follow-ups in Obsidian.
- Working tree is clean, `main` matches `origin/main`, the `3.7.2` tag is pushed,
  and there is no open background work.
