---
date: 2026-11-12T16:17:25+0300
author: Roman Shulgha
commit: 4fc7840
branch: main
repository: protocol-former
topic: "Question-level placeholder navigation in the snippet fill-in modal"
tags: [handoff, snippet-fill, modal, keyboard, focus, accessibility, release, version-3.7.1]
status: complete
type: session_handoff
supersedes: .rpiv/artifacts/handoffs/2026-11-11_12-34-00_rebrand-and-conclusion-draft-preset.md
---

# Handoff: question-level placeholder navigation (3.7.1)

The user reported that choosing an option with `1`–`9` in the snippet fill-in
modal moved the roving Tab stop to that option, so reaching the next question
took two `Tab` presses. The modal now treats each placeholder as one focusable
question.

## Behaviour

- Each placeholder is one `Tab` stop. `Tab` / `Shift+Tab` move between whole
  questions; the active question is outlined, including free-text fields.
- A choice question uses its `fieldset` as the focus target (`tabindex="0"`);
  option pills and the `✎` Custom toggle are `tabindex="-1"`.
- Arrow keys enter the option list from the question (Right/Down at the first
  option, Left/Up at the toggle) and move/wrap between members as before.
- `1`–`9` toggle the numbered option without moving focus, so the next `Tab`
  leaves the question in one press. Digits typed in the Custom textarea still
  type themselves.
- At the edges, `Tab` from the last question focuses Cancel; `Shift+Tab` from
  the first focuses the modal close button. Modified Tab chords are ignored.
- CSS paints one accent frame on `.rp-snippet-modal-field:focus-within`; the
  inner textarea's host focus ring is suppressed so a free-text question shows a
  single rectangle around the label and field.

## Files

- `src/views/snippet-fill-in-modal.ts` — `questionStops`, `handleQuestionTab()`,
  question focus targets, fieldset focus/arrow handling.
- `src/styles/snippet-fill-modal.css` — question frame, fieldset reset, pill
  focus marker, textarea focus-ring suppression.
- `src/__tests__/views/snippet-fill-in-modal.test.ts` — question-level Tab,
  digit-then-Tab regression, mixed question navigation, edge focus, arrow
  navigation, modified Tab chords, CSS tripwire.
- `README.md` / `README.ru.md` — keyboard description.
- `.rpiv/guidance/src/views/architecture.md` — modal reference updated.

## Release state

- Version `3.7.1` in `package.json`, `manifest.json`, `package-lock.json`;
  `versions.json` maps `3.7.1 → 1.5.7`.
- Feature commit `42f3571`; version commit and annotated tag `3.7.1` point at
  `4fc7840`. `main` and the tag are pushed.
- Release published (not draft, not prerelease):
  <https://github.com/vegacepticon/protocol-former/releases/tag/3.7.1>
- Release assets match the local `npm run build` output byte-for-byte:
  - `main.js` — 582486 bytes, sha256 `edb08361a1e0a1af2879d23581fecae74f21f6cb5ca8845e384ee4a87e7c9e99`
  - `styles.css` — 95643 bytes, sha256 `0391e261fce2f81b4ce06de7f6ce52426c260e63a4f34cd4a917b454425f5b59`
  - `manifest.json` — 301 bytes, sha256 `90135a7c9d3b85e71bca2fc824a2528a97f9ce4b54f08107b6f87dfd14449b89`
- Release workflow and CI on `main` are green. The prune step kept the three
  newest releases: `3.7.1`, `3.7.0`, `3.6.24`.

## Release-mechanics note

Do **not** use `git push --follow-tags` in this repository. The remote keeps only
the three newest releases (older tags are pruned), while the local clone still
has the old annotated tags; `--follow-tags` re-pushed them and briefly created
tags that no longer had releases. Push the branch and the new tag explicitly
instead, then verify:

```sh
git push origin main
git push origin refs/tags/3.7.1
gh run watch <release-run-id> --exit-status
gh release view 3.7.1 --json isDraft,isPrerelease,assets
```

If a tag push does not start the Release workflow (observed when a branch and
several tags were pushed together), delete and re-push only that tag:

```sh
git push origin :refs/tags/3.7.1
git push origin refs/tags/3.7.1
```

## Manual checks still worth doing in Obsidian

1. Open a snippet with a multi-option choice as the first question: the whole
   question is outlined and no individual pill is focused.
2. Press `3`, then `Tab` once: focus reaches the next question. `Shift+Tab`
   returns to the previous one.
3. In a free-text question, the frame surrounds the label and field, and the
   caret sits inside the textarea.
4. Arrow keys still move from the question into the options and the `✎` toggle;
   `Enter` on `✎` opens Custom.
