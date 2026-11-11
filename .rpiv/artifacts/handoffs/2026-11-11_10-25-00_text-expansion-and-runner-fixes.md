---
date: 2026-11-11T10:25:00+0300
author: Roman Shulgha
commit: fc8daf1
branch: main
repository: RadiProtocol
topic: "Release 3.6.21: built-in text expansion, 3.6.20 runner fixes, and license findings"
tags: [handoff, release, brat, expansion, substitutions, text-snippets, runner, keyboard, snippet-picker, license, backlog]
status: complete
last_updated: 2026-11-11T10:25:00+0300
last_updated_by: Roman Shulgha
type: session_handoff
supersedes: .rpiv/artifacts/handoffs/2026-11-11_09-50-00_one-hand-confirm-and-placeholder-nav.md
---

# Handoff: built-in text expansion (3.6.21) + runner fixes (3.6.20)

This file supersedes `2026-11-11_09-50-00_one-hand-confirm-and-placeholder-nav.md`. Backlog item C
(phrase plugins) is now implemented as a built-in feature instead of an interop bridge.

## Since the previous handoff

### 3.6.20 — fixes for the 3.6.19 release (user-reported)

- **Ctrl+Space did not submit free-text answers in the runner.** Both shells
  (`inline-runner-modal.ts`, `sidebar-runner-view.ts`) dropped every keydown whose target was an
  `INPUT`/`TEXTAREA`, so the chord never reached the host keymap; it only worked in the snippet fill
  modal, which has its own listener. The shells now forward `isConfirmChord(event)` and keep bailing
  out for every other key (typing stays native, Escape in a field still cannot close the runner).
  Regression tests cover both shells.
- Fill-in modal option pills show the digit that toggles them (`data-rp-key` + `aria-keyshortcuts`,
  first nine only), matching the runner's badge.
- Snippet picker `Tab`/`Shift+Tab` now walk the list in step with the highlight. Before, native Tab
  moved focus while the highlight (and therefore Enter) stayed behind. Tab from the last row still
  leaves the list; Shift+Tab from the first row returns to the search field.

### 3.6.21 — built-in text expansion

User decision: one global mode toggle, one rules list as a text field, no import from the other
plugins. Implemented in `src/expansion/` (see `.rpiv/guidance/src/expansion/architecture.md`):

- `rules.ts` — pure rule-line parsing (`trigger => replacement`, `→` also accepted), `$nl$`, `$end$`,
  `\n`/`\t`/`\b`/`\\` escapes, `#` comments, optional start-up defaults (`--> →` etc.).
- `engine.ts` — pure matching and document-coordinate plans for both modes: auto (suffix, while
  typing) and delimiter (whole word, on Space).
- `config.ts` — one parsed snapshot pushed by `main.applyTextExpansionSettings()` from `saveSettings()`;
  adapters read it at event time, so the feature toggles without a restart.
- `textarea.ts` — `attachTextExpansion()` for the runner free-text answers, loop targets, conclusion
  draft (input + per-item editors), and snippet fill-in fields. Paste and IME are never rewritten; a
  replacement dispatches one synthetic `input` event so drafts and the live preview update normally.
- `editor.ts` — CodeMirror 6 extension registered through the public `registerEditorExtension` API.
  Auto mode uses `EditorView.inputHandler`; delimiter mode binds Space with `Prec.high` and consumes
  the key only when a rule matches.
- Settings → RadiProtocol → **Text expansion**: enable toggle, mode dropdown, "expand in the note
  editor" toggle, rules textarea, and an invalid-line counter. 13 new i18n keys (481 total at parity).
- Off by default. README EN/RU has a "Text expansion" section documenting the format and limits.

### License findings (asked by the user)

- **Substitutions** is Apache-2.0 (github.com/BambusControl/obsidian-substitutions). Its code *could*
  be reused with notices, but nothing was copied: the implementation is independent and only the
  documented behaviour was reimplemented.
- **Text-Snippets** (github.com/ArianaKhit/text-snippets-obsidian) has **no license file** → all
  rights reserved, code must not be copied. Its behaviour (`$end$`, `$nl$`, expansion on Space) was
  reimplemented from scratch; `$tb$` tabstops are not implemented.

## Current state

- Branch `main`, clean tree, local == origin, HEAD = `fc8daf1` (dependency pin on top of `3.6.21`).
- Version `3.6.21` in `package.json` / `manifest.json` / `package-lock.json`; `versions.json` maps
  `3.6.21 → 1.5.7`.
- Releases 3.6.19 (one-hand confirm + placeholder navigation), 3.6.20 (fixes), 3.6.21 (text expansion)
  are published with assets; CI and Release workflows are green. Old releases pruned to the last three.
- `npm run check:release` green at the tag: build, ESLint + Stylelint, **1489 tests (2 skipped)**,
  planning freshness, consistency (481 i18n keys at parity), agent docs, knip, CSS audit, i18n audit.

### Release mechanics (unchanged)

```bash
npm run check:release          # must be green first
npm version X.Y.Z -m "X.Y.Z"
git push origin main
git push origin X.Y.Z
gh run watch <id> --exit-status
gh release view X.Y.Z --json assets
```

**New gotcha — peer-pinned CodeMirror.** `obsidian@1.12.3` pins `@codemirror/state` **6.5.0** and
`@codemirror/view` **6.38.6** as exact peers. A caret range (`^6.7.6`) installs locally but makes
`npm ci` fail with ERESOLVE in CI, which broke the first 3.6.21 tag. The devDependencies are now
pinned to those exact versions; `npm ci` was verified locally after pinning. If CM6 is ever bumped,
pin to whatever the current `obsidian` package declares and re-run `npm ci` before tagging.

## Obsidian 1.15.0 compatibility (checked 2026-11-11)

The user runs Obsidian **1.15.0 Desktop** (early access, released 2026-10-22). The local CI machine has
1.14.4-2, so this was a static check against the changelog plus a source audit, not a runtime test.

1.15.0 developer-facing changes and whether they touch RadiProtocol:

- Closing formatting tokens gained `formatting-*-end` syntax-tree node names (e.g. inline code now
  `formatting_formatting-code_formatting-code-end_inline-code`). Plugins matching full node names are
  affected — **we do not**: no `syntaxTree` usage anywhere in `src/`.
- `prepareFuzzySearch` / `prepareSimpleSearch` now ignore accents — **not used** by RadiProtocol
  (custom pickers do their own filtering).
- Mermaid replaced by Pele, `PIXI` now lazy-loaded — **not used**.
- Community plugins load faster at start-up; no API change.

Editor integration is limited to the public `registerEditorExtension` (text expansion), which is
unchanged. `minAppVersion` stays `1.5.7`, so 1.15.0 installs fine. Typings are `obsidian@1.12.3` while
the runtime is 1.15.0; that is acceptable because only long-stable APIs are used. Bumping the typed
dependency to the latest published `obsidian` (1.14.4, peers `@codemirror/state` 6.7.6 /
`@codemirror/view` 6.43.13) is optional and would require re-pinning CM6 + `npm ci` verification —
no functional gain found, so it was not done.

If a 1.15-specific problem appears, the most likely area is the CM6 text-expansion extension; ask for
the developer-console error before changing anything.

## Known limits and backlog

1. **Editor extension is not covered by automated tests.** The pure plans are tested; the CM adapter is
   a thin `view.dispatch` call. Verify in a real vault: auto-replace `-->`, then delimiter mode with a
   `;sig` rule, in both Live Preview and Source mode. If a test is wanted later, it needs jsdom, which
   the suite deliberately avoids.
2. **No `$tb$` tabstops** (Text-Snippets' multi-stop jump), no regex rules, no import from the two
   plugins, no "Backspace undoes the last replacement". These were out of scope for the chosen design.
3. **Textarea replacement bypasses native undo** (one Ctrl+Z does not restore the trigger); the editor
   keeps CM history. Documented in README.
4. Tab is not a delimiter in either surface (focus/navigation conflict); only Space expands snippets.
5. Settings rules editor is one text field (per user's choice), not a row-per-rule table with
   enable/search/swap controls.
6. If Substitutions or Text-Snippets stays enabled, the note editor expands twice. README asks the
   user to disable them; no detection is attempted.

## Architecture reminders (carry forward)

- Renderers **register** options; the host **dispatches**. `keymap.ts` stays pure; `isConfirmChord` is
  the shared chord definition for the runner and the fill modal.
- Shells must forward keys to the host except while typing — and must let `isConfirmChord` through
  from text fields (3.6.20 regression).
- Text expansion: pure core in `rules.ts`/`engine.ts`; adapters attach where elements are created; the
  only settings reader is `config.ts`. Do not add settings parameters to renderer/host interfaces.
- `render()` = `renderState()` + `finalizeRender()`; post-render work belongs in `finalizeRender`.
- Every UI string needs `en.json` + `ru.json` (parity enforced). Settings textarea CSS lives in
  `src/styles/expansion.css` (registered in `esbuild.config.mjs` `CSS_FILES`).

## Gotchas

- Never edit `main.js` / `styles.css` by hand; edit `src/` and `src/styles/` then `npm run build`.
- Adding a stylesheet requires an entry in `esbuild.config.mjs` `CSS_FILES`.
- `npm ci` is the CI install path; run it after any dependency change that touches the lockfile.
- The settings-tab mock (`src/__mocks__/obsidian.ts`) needs any new component API used by the tab
  (e.g. `inputEl.addClass` was added for the rules textarea). Component counts in
  `settings-tab.test.ts` are order-sensitive: the expansion section sits between the conclusion-draft
  toggle and the Storage group.
- Tests run in Node without a DOM; expansion adapter tests use a local `FakeTextarea`
  (`src/__tests__/expansion/textarea.test.ts`).
- The fill modal's MockEl has no bubbling: dispatch on the listener owner and override `target`.
- `stepBack()` has a per-tick double-click guard; tests must `await` a microtask between undo calls.
- Conventional commits; `npm run check:release` before any source commit and before every tag.

## How to resume

```bash
git status
git log -3 --oneline
npm ci
npm run check:release
```

Then read this handoff. Ask the user to confirm the editor side of text expansion in a real vault
(item 1 above) before building on it. The next likely feature work is backlog items 2–5, in whatever
order the user prefers.

## References

- Releases: `3.6.21` (text expansion), `3.6.20` (runner fixes), `3.6.19` (one-hand confirm)
- `src/expansion/` + `.rpiv/guidance/src/expansion/architecture.md`
- `src/views/inline-runner-modal.ts` / `src/views/sidebar-runner-view.ts` — chord forwarding fix
- `src/views/snippet-tree-picker.ts` — Tab/Shift+Tab highlight sync
- `src/views/snippet-fill-in-modal.ts` — digit badges, roving tabindex, Ctrl+Space
- Previous handoff (superseded):
  `.rpiv/artifacts/handoffs/2026-11-11_09-50-00_one-hand-confirm-and-placeholder-nav.md`
- Research that informed the decision:
  `.rpiv/artifacts/research/2026-11-11_09-50-00_phrase-substitution-plugins-in-runner-fields.md`
