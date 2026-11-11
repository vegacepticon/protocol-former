---
date: 2026-11-11T08:59:03+0300
author: Roman Shulgha
commit: c3d24d3
branch: main
repository: RadiProtocol
topic: "Documentation actualization, knip/CSS advisory cleanup, and next runner keyboard/UI track"
tags: [handoff, documentation, knip, css, runner, keyboard, ui, library]
status: complete
last_updated: 2026-11-11T08:59:03+0300
last_updated_by: Roman Shulgha
type: session_handoff
---

# Handoff: documentation actualization + advisory cleanup

## Task(s)

- **Completed — documentation actualization.** README EN/RU, architecture guidance, settings copy, and repository helper text were aligned with the actual code and current product behavior. Command names, runner presentations, library registry behavior, self-check, data locations, and contributor setup are now documented.
- **Completed — knip advisory.** `npx knip --reporter compact` exits 0 with no findings. Removed or un-exported 24 dead exports/types; no behavior changed.
- **Completed — CSS class drift advisory.** `node scripts/check-css-classes.mjs` reports no orphaned or missing classes.
- **Completed — documentation drift guard.** `scripts/check-consistency.mjs` now has “Check 8: documented commands”: every `this.addCommand` name in `src/main.ts` must appear in both README files, and two stale phrases fail the check.
- **Deferred — runner keyboard/UI track.** This was the original recommended next track; the user chose documentation first. No hotkey/UI implementation has started.
- **Deferred — community library backend/registry/moderation.** The user considers this the unfinished part of the library. It is external to this repository; no client changes were made. The docs now state this boundary explicitly.

## Current state

- Branch `main`, clean working tree, HEAD = `c3d24d3` (`docs: actualize documentation and clear advisories`).
- Base before this session: `a54a3f6` (`chore(deps): clear npm audit advisories`), pulled from origin; local was behind by that one commit.
- Version: `3.6.17` in `package.json` / `manifest.json`; `versions.json` maps `3.6.17 → 1.5.7`.
- Dependencies were refreshed with `npm ci` (esbuild `0.28.2`).
- Generated `main.js` / `styles.css` are build outputs and remain gitignored; `src/` is the source of truth.

### Verification at handoff

`npm run check:release` exits 0:

- build (strict `tsc -noEmit -skipLibCheck` + esbuild production) — passed
- ESLint + Stylelint — passed
- Vitest: 96 test files passed, 1 skipped; **1358 tests passed**, 2 skipped
- planning freshness, consistency, agent-docs — passed
- knip — exit 0, no unused exports/files/dependencies
- CSS class audit — no orphaned or missing classes
- i18n UI-text audit — passed
- Both bundled catalog endpoints were checked manually and returned HTTP 200 with JSON: `https://library.radiprotocol.pro/catalog` and `https://radiprotocol.pages.dev/catalog`.

## What changed in `c3d24d3`

### Documentation

- `README.md` / `README.ru.md`: synchronized EN/RU structure; added all 9 commands with descriptions; added current in-runner keys; documented floating vs right-sidebar presentations; documented self-check; corrected library registry/install/import/publish/submission behavior; added “Where data lives”; expanded contributor/dev setup.
- Fixed stale facts: command is **Run protocol** (not “Run protocol in inline”); new protocols seed a Start node; empty library registry setting means “use bundled endpoints”, not “disable catalog”; dev build copies `main.js`, `styles.css`, and `manifest.json`.
- `.rpiv/guidance/architecture.md`: no longer claims “inline runner rather than a sidebar runner”; notes the external catalog/moderation service.
- `.rpiv/guidance/src/library/architecture.md`: bundled `REGISTRY_URLS` and override semantics replace the old “registry deployment deferred” claim.
- `.rpiv/guidance/src/views/architecture.md`, `runner/architecture.md`, `runner/render/architecture.md`, `snippets/architecture.md`, `__tests__` guidance: `RunnerSessionHost` is the shared host; sidebar is a first-class presentation; test module list includes `sidebar-runner-view.test.ts`.
- `src/i18n/locales/en.json` / `ru.json`: corrected `libraryRegistryUrlDesc`, `protocolFolderDesc`, `submitUnavailable`; keys remain at parity (461).
- `src/library/registry-client.ts` and `src/settings.ts`: corrected comments about bundled endpoints and empty overrides.
- `src/main.ts`: corrected the Phase 54 command comment to “Run protocol”.
- `scripts/check-consistency.mjs`: Check 8 validates documented command names and stale phrases; it also fails if the command extractor misses an `addCommand` call.

### Advisory cleanup

- Removed unused `exportFileName` (`package-metadata.ts`), `ParsedMarkdownTemplate` (`md-template.ts`), `SubmissionReviewState` and `LibrarySubmitFormMeta` (submission code), `CssClass`, `RunnerStatus`.
- Un-exported types/functions used only inside their own module: `requestUrlStatusTransport`, `PickerMockInstance`, `Locale`, `MigrationReport`, `LibraryInstallerOptions`, `MigrationPlan`, `CatalogQuery`, `PackageBuildMeta`, `RegistryClientOptions`, `NewSubmissionInput`, `ErrorListOptions`, `RunnerFooterOptions`, `SnippetFillNotFoundOptions`, `SnippetPickerCopy`, `SnippetPickerRenderOptions`, modal result types (`LibraryExportResult`, `LibraryImportResult`, `LibraryInstallProgressResult`, `LibraryItemDetailResult`, `LibrarySubmitResult`, `LibrarySubmitModalOptions`), `OptionOrderChipEditorHandle`, `SidebarRunnerLaunchContext`, `SidebarRunnerEphemeralState`, `TreeRendererCallbacks`.
- Updated the static test regex in `src/__tests__/snippet-tree-view.test.ts` to match the non-exported `TreeRendererCallbacks` interface.
- Removed orphaned `.rp-snippet-tree-spacer` CSS rules from `src/styles/snippet-manager.css`.
- Removed the unstyled `rp-option-order-chip-host` class from the protocol editor container (no CSS or query depended on it).

## Architecture assessment (carry forward)

Overall the project is in good shape; this is not a “rewrite it” situation.

**Strengths**

- Clear composition root and layer direction: `graph/protocol/runner` pure cores → `render` DOM adapters → `views` orchestration; services injected.
- Mature async ownership: lifecycle/operation generations, `WriteMutex`, journal-before-write/marker-last library installs.
- Strong test base: 1358 tests; dedicated keyboard/lifecycle/rollback/i18n coverage.
- Real quality gates: build, lint, stylelint, tests, consistency, agent-docs, CSS, i18n, knip.
- Architecture decisions documented in `.rpiv/guidance/`.

**Debt / risks**

- `src/views` is the largest layer (~536K); `protocol-editor-view.ts` ~2923 lines, `runner-session-host.ts` ~1261, `snippet-manager-view.ts` ~781. Risk is concentrated in large view files, not in the layer model.
- Floating runner and sidebar runner are two shells around the same host; they can drift visually/behaviorally.
- Keyboard handling is fragmented across shell, host, pickers, modals, and editor; there is no single keymap source.
- UI changes currently have no visual/E2E regression harness; manual Obsidian validation is required.
- Library depends on external registry/moderation/content.

**Recommendation:** do not big-bang refactor. Extract seams as the runner keyboard/UI work touches them (keymap/action registry first; possibly shell/host extraction later).

## Next track: runner keyboard + UI

This is the intended next session. No implementation exists yet.

### Current keyboard state (already documented)

- Commands have no default global hotkeys; users assign them in Obsidian.
- Runner: `Ctrl/Alt+←` back, `Ctrl/Alt+→` redo, `Esc` close outside text fields.
- Snippet picker: arrows, `j/k`, `Enter`, `Tab/Shift+Tab`.
- Free-text answers / fill modal: `Shift+Enter`.
- Answer buttons are mouse/Enter/Tab only; no numeric selection.
- Floating runner only receives keys when focus is inside it — this is an unsolved UX problem.

### Draft left-hand keymap (not approved; discuss with user)

| Key | Action |
|---|---|
| `1–9` | Choose Nth option (answer, question branch, snippet branch, loop body/exit); free-text option focuses its field |
| `Enter` / `Space` | Confirm focused/primary action |
| `Tab` / `Shift+Tab` | Move focus |
| `Z` | Back |
| `X` | Redo |
| `S` | Skip (when available) |
| `F` | Focus free-text answer |
| `C` | Focus conclusion draft |
| `V` | Insert conclusion (outside inputs) |
| `H` | Toggle key hint/help |
| `Esc` | Close runner (outside inputs) |

Keep `Ctrl/Alt+←/→`, `Backspace` as aliases. Use `event.code` for layout independence (Russian layout), ignore `isComposing`, never intercept plain keys inside `INPUT`/`TEXTAREA`.

### Focus problem to solve

The floating panel is non-modal; its keydown listener is on its container. Decide one of:

- auto-focus the runner on open/step and after actions; or
- a global command/hotkey “Focus runner” to return control; or
- an explicit keyboard-control mode with a visible indicator.

Do not silently steal typing from the note editor. The sidebar presentation already has focus when active.

### Proposed UI direction

- Number badges on answer/branch buttons, plus a compact hint row (`1–9`, `Z`, `X`, `S`, `H`).
- Header with protocol title/step, not only a progress bar.
- Clearer action hierarchy, sticky action area, 40–44px targets, visible focus rings.
- Collapsible conclusion draft in narrow panels; consistent styling for floating and sidebar.
- Optional local HTML preview harness using real CSS classes for fast visual iteration (Chromium is available on this machine).

### Proposed first slice (spec → code)

1. Write a one-page interaction spec: states, actions, key table, focus policy, input/IME/layout rules, acceptance criteria.
2. Add a pure `src/runner/keymap.ts` (or similar) with `resolveRunnerKey(event, context)`; unit tests for layout, modifiers, composing, input focus, no-op/disabled states.
3. Integrate with `RunnerSessionHost`: action registry for current rendered options, numeric dispatch, back/redo/skip/focus.
4. Add number badges/hint UI and accessibility attributes.
5. Add host tests and manual checklist for Obsidian.
6. Update README/RU keyboard section and architecture guidance after behavior is agreed.

Likely files: `src/views/runner-session-host.ts`, `src/runner/render/render-question.ts`, `render-loop-picker.ts`, `snippet-tree-picker.ts`, `src/styles/runner-session.css`, `src/i18n/locales/en.json` + `ru.json`, `src/__tests__/views/*`.

## Library status / constraints

- User identified the unfinished part as **backend/registry/moderation**, not the client. That service is outside this repository.
- The client already has catalog, install/uninstall, import/export, submission with moderation PR, “My submissions”, retry/reconcile. Docs now describe these and explicitly say the catalog/moderation are external.
- Do not start library client work until the user defines a concrete gap (publisher UX, moderation statuses, package updates, etc.). A backend/registry decision is a product/infrastructure task, not a plugin-only change.

## Important constraints / gotchas for the next session

- Do not edit generated `main.js` / `styles.css`; edit `src/` and `src/styles/`, then run `npm run build`.
- Commands are English string literals in `src/main.ts`; Check 8 requires their exact names in both README files. If command display names are localized later, update the check accordingly.
- `scripts/check-consistency.mjs` forbids README links containing `docs/` because no `docs/` directory exists. Use `.rpiv/guidance/...` or create `docs/` and update the check.
- Every UI string needs keys in both `en.json` and `ru.json`; `check:consistency` enforces parity.
- Run `npm run check:release` before committing; it includes build, lint, tests, docs checks, CSS and i18n audits.
- The repo convention is conventional commits; version bumps only at release via `npm version X.Y.Z`.
- Working tree was clean after the handoff commit; this file is committed separately.

## How to resume

```bash
git status
git log -1 --oneline
npm ci          # only if node_modules is stale
npm run check:release
```

Then read this handoff and start with the interaction spec for the runner keymap. Ask the user to confirm:

1. the keymap draft (especially `Z`/`X` vs `Backspace`, and `V` for insert);
2. the focus model (auto-focus vs explicit “Focus runner” hotkey);
3. whether they have a separate test vault with 2–3 real protocols and can share screenshots/video for UI iteration.

## References

- `README.md` — commands, keys, presentations, library, data, contributors
- `README.ru.md` — Russian parity
- `.rpiv/guidance/architecture.md`, `.rpiv/guidance/src/runner/architecture.md`, `.rpiv/guidance/src/views/architecture.md`
- `src/views/runner-session-host.ts`, `src/views/inline-runner-modal.ts`, `src/views/sidebar-runner-view.ts`
- `src/runner/render/render-question.ts`, `src/views/snippet-tree-picker.ts`
- `src/main.ts` — command registration and presentation selection
- `scripts/check-consistency.mjs`, `scripts/check-css-classes.mjs`
