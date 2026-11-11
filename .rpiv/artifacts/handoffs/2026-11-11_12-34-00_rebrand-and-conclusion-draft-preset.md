---
date: 2026-11-11T12:34:34+0300
author: Roman Shulgha
commit: be4a606
branch: main
repository: protocol-former
topic: "Rebrand to Protocol Former and per-protocol conclusion draft preset"
tags: [handoff, rebrand, protocol-former, protocol-editor, runner, conclusion-draft, i18n, version-3.7.0]
status: complete
type: session_handoff
supersedes: .rpiv/artifacts/handoffs/2026-11-11_12-03-00_phrase-search-and-top-add.md
---

# Handoff: Protocol Former rebrand + conclusion draft preset

This file supersedes `2026-11-11_12-03-00_phrase-search-and-top-add.md` for session
continuity. It records two user-requested changes: the visible rebrand from
RadiProtocol to **Protocol Former**, and a per-protocol conclusion draft preset
authored in the Protocol Editor and seeded into the Runner.

## User decisions

- **Rebrand scope:** visible name + package/docs now; plugin id later. The user
  explicitly asked to defer the id rename and to leave a note about it.
- **Repository links:** the GitHub repository is now `vegacepticon/protocol-former`
  (renamed by the user); README and handoff links point to it.
- **Draft preset:** a button in the Protocol Editor opens an editor for the preset;
  its lines appear in the Runner's conclusion draft as soon as a session starts.

## 1. Rebrand (visible name only)

Changed:

- `manifest.json` → `"name": "Protocol Former"`; `"id"` stays `radiprotocol`.
- `package.json` / `package-lock.json` → package name `protocol-former`.
- `README.md` / `README.ru.md` → product name, repo URLs, install/release links,
  and new rebrand-status notes; the manual install folder remains
  `.obsidian/plugins/radiprotocol/`.
- `LICENSE` → “Protocol Former Contributors”.
- `.githooks/pre-commit`, `.githooks/pre-push` → gate banners.
- `esbuild.config.mjs` → log prefix `[protocol-former]`; the dev-vault folder
  argument stays `radiprotocol` because that is still the plugin id.
- `src/**` console prefixes `[RadiProtocol]` → `[Protocol Former]`, plus comments.
- `src/i18n/locales/{en,ru}.json` → menu title, donation, expansion-disabled and
  update-required strings. 512 keys at parity.
- `.rpiv/guidance/architecture.md` → title/overview and a rebrand note.

Deliberately **unchanged** (backward compatibility):

- `manifest.id` (`radiprotocol`), install folder, `data.json` path.
- View type ids (`radiprotocol-*`) and command ids (`radiprotocol:*`).
- `.rp.json` schema (`radiprotocol.protocol`) and legacy `radiprotocol_*` field keys.
- CSS prefix `rp-`, i18n key namespaces, internal class names
  `RadiProtocolPlugin` / `RadiProtocolSettings`.

The deferred id rename is noted in:

- `README.md` / `README.ru.md` — “Rebrand status” block after manual installation.
- `.rpiv/guidance/architecture.md` — Rebrand note under Overview.
- `src/main.ts` — comment directly above the plugin class.

### Deferred plugin-id rename — scope for a future release

1. `manifest.json` → `id: "protocol-former"`; change the dev-vault folder in
   `esbuild.config.mjs`; update README install paths.
2. Migrate the old `.obsidian/plugins/radiprotocol/data.json` (best-effort read of
   the old folder, then save under the new id) and document that Obsidian does not
   move plugin folders by itself.
3. Rename view types and `PLUGIN_MENU_ACTIONS` command ids in
   `src/views/plugin-menu-view.ts`; old workspace leaves must degrade gracefully.
4. Keep the `.rp.json` schema, `.radiprotocol/` bookkeeping folder, CSS prefix, and
   legacy field readers unless a separate data migration is designed.
5. Re-test BRAT install/update and the working vault after the id change.

## 2. Conclusion draft preset

### Data model

- `ProtocolDocumentV1.conclusionDraftItems?: string[]` in
  `src/protocol/protocol-document.ts`. One array entry = one draft line; the array
  is optional and is preserved by the parser, migration, store, and library package
  wrapper (all top-level spreads keep it).

### Protocol Editor

- New pencil floating action next to self-check/minimap/layout with localized
  `aria-label` (`protocolEditor.conclusionDraftTitle`).
- `openConclusionDraftModal()` in `src/views/protocol-editor-view.ts`:
  - multiline textarea, one item per line, blank lines ignored, edges trimmed;
  - prefilled from `doc.conclusionDraftItems`;
  - save is debounced (400 ms) through the document-owner lease and flushed on
    **Save** or backdrop close; the timer is registered with `owner.own()` so a
    stale view cannot write;
  - an empty textarea removes the optional field (`undefined`) instead of storing
    `[]`;
  - library-managed protocols stay read-only through the same guard as other
    editor writes.
- New i18n keys `protocolEditor.conclusionDraft{Title,Label,Help,Placeholder}` in
  both locales; new localized `.rp-protocol-editor-conclusion-draft-modal` CSS.

### Runner

- `RunnerSessionHost.readSelfCheckConfiguration()` became
  `readRunnerConfiguration()`, which reads both `selfCheck*` and
  `conclusionDraftItems` from the raw protocol JSON.
- After parse and validation succeed, the host calls
  `RunnerConclusionDraft.setPresetLines()`; the draft panel is created earlier in
  `mount()`.
- `setPresetLines()` never clobbers text typed before the protocol finished
  loading, ignores blank input, and sets the insertion baseline to the seeded
  text. An untouched preset therefore:
  - does not block completion/self-check auto-close;
  - does not trigger the “discard conclusion draft?” close confirmation;
  - still inserts normally with **Insert conclusion**.
  Any edit after startup makes the draft uninserted again.

## Verification

`npm run check:release` at `3.7.0` is green:

- build + strict TypeScript; ESLint + Stylelint;
- **1536 tests passed (2 skipped)**, 102 files passed / 1 skipped;
- planning freshness, consistency (10 commands, 512 i18n keys at parity), agent docs;
- CSS audit: 258 classes, no orphaned/missing classes;
- i18n UI-text audit: pass.

New/updated tests:

- `src/__tests__/views/runner-conclusion-draft.test.ts` — preset seeding, trimming,
  baseline behavior, no-clobber, empty preset.
- `src/__tests__/views/runner-session-host.test.ts` — preset lines seed the draft
  during bootstrap; absent preset starts blank.
- `src/__tests__/views/protocol-editor-keyboard.test.ts` — floating button label;
  modal trims/split lines, persists through `owner.update()`, updates `this.doc`,
  and closes on Save.
- `src/__tests__/views/plugin-menu-view.test.ts` — updated localized menu title.

## Release state

- Version `3.7.0` in `package.json`, `manifest.json`, `package-lock.json`;
  `versions.json` maps `3.7.0 → 1.5.7`.
- All rebrand + feature changes are committed as `be4a606`
  (`feat: rebrand to Protocol Former and seed runner draft from protocol preset`).
- Annotated tag `3.7.0` points at `be4a606`; `main` and the tag are pushed to
  `https://github.com/vegacepticon/protocol-former`.
- Release published (not draft, not prerelease):
  `https://github.com/vegacepticon/protocol-former/releases/tag/3.7.0`.
  - `main.js` — 581584 bytes, sha256 `5decedd3ad910904ad15ea6ba353e60eab07ebe3236225af94da9da3765aa4cd`
  - `styles.css` — 93743 bytes, sha256 `345b6c06f0d853991e5a055da6156594019b851b5a3269d1ff86aae9da795cff`
  - `manifest.json` — 301 bytes, sha256 `42340ec28ce1b7f4f0a13897150a06625d8935cca394ff0d8daecd1ad44cb8f8`
  - The three assets are byte-identical to the local `npm run build` output.
- Release workflow and CI on `main` are green. The prune step kept the three
  newest releases: `3.7.0`, `3.6.24`, `3.6.23`.
- Release mechanics are unchanged; the repo URL in the documentation points to
  `vegacepticon/protocol-former`; the GitHub repository has already been renamed.
- BRAT install/update path is now `vegacepticon/protocol-former`; existing BRAT
  entries that still name `vegacepticon/RadiProtocol` should follow the GitHub
  rename redirect or be re-added.

## Manual checks still worth doing in Obsidian

1. Protocol Editor → pencil button → enter 2–3 lines → Save; reopen the modal and
   confirm the lines persist in the `.rp.json` file.
2. Run that protocol in both the floating and sidebar Runner; confirm the lines
   appear immediately, can be edited/reordered, and insert into the bound note.
3. Close an untouched preset session; confirm there is no discard confirmation.
   Edit a line, then close; confirm the confirmation appears.
4. Check that the community-plugins list and settings header show **Protocol
   Former** while the folder remains `radiprotocol`.

## Files touched

- Rebrand: `manifest.json`, `package.json`, `package-lock.json`, `README.md`,
  `README.ru.md`, `LICENSE`, `.githooks/*`, `esbuild.config.mjs`, i18n locales,
  guidance docs, console prefixes across `src/**`.
- Feature: `src/protocol/protocol-document.ts`,
  `src/views/protocol-editor-view.ts`, `src/views/runner-session-host.ts`,
  `src/views/runner-conclusion-draft.ts`, `src/styles/protocol-editor.css`,
  i18n locales and the tests listed above.
- `versions.json`.
