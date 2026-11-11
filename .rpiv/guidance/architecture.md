# RadiProtocol — Obsidian Plugin for Interactive Protocols

## Overview
RadiProtocol is a TypeScript Obsidian plugin for authoring and running structured radiology documentation protocols. It bundles with esbuild, tests with Vitest, and keeps domain/runtime logic separate from Obsidian-facing persistence and UI where practical.

## Project Map
- `src/main.ts`, `src/settings.ts` — composition root, lifecycle, commands, settings, and service rebuilding.
- `src/graph/`, `src/protocol/`, `src/runner/` — graph kernel, `.rp.json` boundary, and pure execution state machine.
- `src/snippets/`, `src/library/` — Markdown snippets/reference sync and community-library transactions.
- `src/views/`, `src/runner/render/` — Obsidian UI/orchestration and runner DOM adapters.
- `src/i18n/`, `src/utils/`, `src/constants/`, `src/styles/` — cross-cutting capabilities/assets.
- `src/__tests__/` — centralized tests; see its child guidance for shared, fixture, runner, and view rules.
- `scripts/`, `.github/workflows/`, `.githooks/` — repository checks, CI/release, and optional local hooks.

## Architecture
This is a single-package, feature-grouped modular plugin rather than MVC, clean architecture, or a monorepo. `main.ts` is the composition root: it constructs long-lived services, performs library recovery, registers views/commands, and closes transient UI on unload.

```text
Obsidian host
    ↓
src/main.ts (composition root)
    ├── views/ → protocol, runner, graph, snippets, library, utils, i18n
    ├── vault/network shells → protocol store, snippet service, library installer
    └── pure cores → graph, protocol parser/migration, runner, models/paths
```

The normal direction is views/host → lower layers. Current intentional exceptions are `runner/render/render-snippet-picker.ts → views/SnippetTreePicker`, `snippets/protocol-ref-sync.ts → protocol` for reference rewriting, and view-owned editor/note-output orchestration. Pure modules receive translators, probes, transports, clocks, and settings through narrow injection seams.

Production protocol selection is `.rp.json`; `.canvas` is test-only compatibility data. Generated `main.js` and `styles.css` are build outputs—edit `src/` and `src/styles/`, never generated assets.

## Commands
| Command | What it does |
|---|---|
| `npm run dev` | esbuild watch/dev bundle; does **not** run `tsc` |
| `npm run build` | strict TypeScript check, then production esbuild bundle |
| `npm test` | Vitest suite in Node |
| `npm run lint` | ESLint plus Stylelint, read-only |
| `npm run check` | build, lint, tests, planning, consistency, and guidance checks |
| `npm run check:release` | `check` plus CSS-class and i18n UI-text audits |
| `npm run knip` | dead-code advisory |
| `npx eslint . --fix` | repo-wide ESLint auto-fix |
| `npx eslint path/to/file.ts --fix` | path-scoped ESLint auto-fix |
| `npx stylelint 'src/styles/**/*.css' --fix` | repo-wide stylesheet auto-fix |
| `npx stylelint path/to/file.css --fix` | path-scoped stylesheet auto-fix |

## Business Context
The plugin is a radiology documentation aid, not a diagnostic or decision-authority system; the radiologist remains responsible for clinical judgment and final validation. It has no bundled account/authentication system, supports both a floating note-anchored runner and an optional right-sidebar presentation, and treats library SHA-256 as integrity—not publisher authenticity. The community catalog and moderation service are external; the plugin is a client.

<important if="you are adding a feature that crosses protocol, graph, runner, render, views, snippets, or library">
## Cross-Layer Feature Checklist
1. Define runtime types/invariants in `.rpiv/guidance/src/graph/architecture.md`.
2. Add document parsing/migration in `.rpiv/guidance/src/protocol/architecture.md`.
3. Wire pure traversal/state in `.rpiv/guidance/src/runner/architecture.md`.
4. Add DOM projection in `.rpiv/guidance/src/runner/render/architecture.md`.
5. Add host/editor/UI orchestration in `.rpiv/guidance/src/views/architecture.md`.
6. Follow `.rpiv/guidance/src/snippets/architecture.md` or `src/library/architecture.md` for those bounded contexts.
7. Route tests through `.rpiv/guidance/src/__tests__/architecture.md` and its specialized children; add both locale keys and feature CSS where needed.
</important>

<important if="you are writing or modifying i18n strings">
- Use namespaced keys and add them to both `src/i18n/locales/en.json` and `ru.json`.
- Bind `plugin.i18n.t`; pure modules may default to `defaultT`.
- Never translate user-authored protocol text, snippet content, labels, package metadata, or server-controlled identifiers.
</important>

<important if="you are modifying generated output or releasing">
- Generate `main.js`/`styles.css` with `npm run build`; do not edit them directly.
- `npm version X.Y.Z` updates `manifest.json` and `versions.json`; numeric tags are the local convention.
- Configure optional hooks with `git config core.hooksPath .githooks`.
</important>
