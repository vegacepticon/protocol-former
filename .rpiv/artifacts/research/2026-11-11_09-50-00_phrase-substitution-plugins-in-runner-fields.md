---
date: 2026-11-11T09:50:00+0300
author: Roman Shulgha
commit: c0c1de4
branch: main
repository: RadiProtocol
topic: "Interop with community phrase-substitution plugins inside runner text fields (backlog item C)"
tags: [research, runner, textarea, codemirror, interop, substitutions, text-snippets, obsidian]
status: ready
last_updated: 2026-11-11T09:50:00+0300
last_updated_by: Roman Shulgha
---

# Research: phrase-substitution plugins inside runner text fields

## Research Question

Users want their existing Substitutions / Text-Snippets rules to fire while typing
free-text answers, loop free-text targets, and the conclusion draft. Those are plain
`<textarea>` elements. Can RadiProtocol forward events, call a plugin API, or host a
real editor that inherits the rules — and what does each route cost?

## Summary

Neither plugin exposes an interop surface, and neither can be driven from a plain
DOM field. Substitutions is a global CodeMirror 6 extension; Text-Snippets uses the
removed CodeMirror 5 API and is effectively broken for anything but the active note.
The public Obsidian typings have no inline-editor factory. The only route that gives
users their existing rules is embedding Obsidian's own markdown editor, which does
receive globally registered CM6 extensions — but that is an internal-API path with
high maintenance cost.

**Recommendation:** keep the textareas and (if the feature is wanted) ship an
in-plugin expansion layer. Do not attempt to call or read the other plugins' state.
Start item C only after an explicit product decision, because the cheapest viable
option is not "make their plugins work" but "offer our own expansion".

## Detailed Findings

### 1. Substitutions — CM6 extension only, no API

- **VERIFIED.** Registers via `ExtensionHandler.replaceAndRegister` →
  `plugin.registerEditorExtension(extensions)`; the extension is a `StateField` plus
  `EditorView.inputHandler.of(...)`. Not an `EditorSuggest`, no DOM/textarea listener.
  Source: `src/substitutions/extensionHandler.ts`, `codemirror/extension/characterInputHandler.ts`.
- **VERIFIED.** Nothing is exported for third parties; no global or plugin API. The
  runtime object `app.plugins.plugins['substitutions']` exists (internal) but exposes
  no documented callable method.
- **Consequence.** Forwarding DOM events at a textarea cannot trigger it: it never
  observes DOM inputs, only CM6 transactions.

### 2. Text-Snippets — legacy CM5, dead hook

- **VERIFIED.** Uses `this.registerCodeMirror(cm => cm.on('keydown', ...))`. In
  current Obsidian `registerCodeMirror` is a documented no-op, and CM5 was removed
  in 1.5.
- **VERIFIED.** Replacement paths hardcode
  `app.workspace.activeLeaf.view.sourceMode.cmEditor`; no exported API, no
  `EditorSuggest`, no CM6 extension.
- **REPORTED.** Open issues for Canvas text cards and Canvas-embedded notes match the
  code reading. Triggering it from a modal would act on the note behind the modal
  (inferred, not tested).
- **Consequence.** Not usable as an integration target at all in current versions.

### 3. Public API for an embedded editor — nothing suitable

- **VERIFIED (obsidian.d.ts).** Present: `MarkdownView`, `MarkdownEditView`,
  `MarkdownRenderer`, `Editor`, `Modal`, `Plugin.registerEditorExtension`,
  `Workspace.activeEditor`.
- **VERIFIED (absent, grep count 0).** `MarkdownEditor`, `EmbeddedEditor`,
  `EmbeddedEditorView`, `MarkdownScrollableEditView`, `ScrollableMarkdownEditor`.
- `Editor` is an abstract CM5-shaped wrapper with no `cm` / `EditorView` accessor, so
  there is no public per-editor extension injection. `openLinkText` opens a file in a
  leaf; `MarkdownRenderer` is read-only.
- **Consequence.** Embedding means reaching into internals (`app.embedRegistry.embedByExtension.md`,
  prototype walking, `setActiveLeaf` / `buildLocalExtensions` patches), which the
  project's architectural boundaries avoid.

### 4. Do globally registered CM6 extensions reach an embedded editor? Yes

- **VERIFIED (Obsidian 1.14.4 bundle).** `registerEditorExtension` pushes into
  `workspace.editorExtensions`, applied to all CM instances. The base markdown
  editor's `getDynamicExtensions()` appends them, and the embedded editor class
  (`MarkdownScrollableEditView`, `IFramedMarkdownEditor` in newer typings) overrides
  it and calls super. An editor created after plugin load therefore gets
  Substitutions' extension and its `inputHandler` fires.
- **Caveat A.** Only Obsidian's own editor class does this; a bare CM6 `EditorView`
  built by RadiProtocol would not inherit the extensions.
- **Caveat B.** `Workspace.updateOptions()` iterates `MarkdownView` leaves only, so
  later rule edits do not reach an existing embed; the editor must be recreated.
- **UNKNOWN.** Propagation in Obsidian 1.15 iframe-based editable embeds.

### 5. Cost of embedding a real editor

- Internal class acquisition and monkey patches (`setActiveLeaf`,
  `buildLocalExtensions`), `activeEditor` patching, `Scope` push/pop.
- Keymap precedence (`Prec.highest`) for Enter / Shift+Enter / Escape; Escape must be
  intercepted or the modal closes. `Mod+Enter` collides with a core hotkey.
- Auto-growing height is not provided — container CSS with min/max height is needed.
- Lifecycle (`destroy`/`unload`, blur, container cleanup), ~5 ms construction.
- Mobile: toolbar updates, keyboard callbacks, extra submit button; typings note the
  editable embed experience is unstable, and 1.15 iframe churn is a risk.
- IME: input handlers must bail during composition (Substitutions checks
  `view.compositionStarted`).

## Options and Recommendation

1. **Own lightweight phrase expansion in the runner's text fields** (settings list +
   trigger on input, optional popup). No third-party interop, lowest risk, no
   internal APIs; users retype their phrase library. **Recommended.**
2. **Bridge to the other plugins** — not feasible: no public API and their rules are
   not exposed. (Keeping it here so the option is clearly closed.)
3. **Embed Obsidian's markdown editor** — the only path to the user's existing rules.
   Technically feasible (verified extension propagation), maintenance risk high, and
   it interacts with the new keyboard model (`Ctrl+Space`, roving focus, Escape).
   Not to be started without an explicit decision.
4. **Document that phrase plugins apply to notes only** — zero risk, zero work.

## Open Questions for the User

- Is "retype my phrases in RadiProtocol" acceptable (option 1), or is inheriting the
  existing Substitutions rules a hard requirement (only option 3)?
- If option 1: which trigger style — typed abbreviation expanding on Space/Enter, or
  a suggestion popup like the snippet picker?
- If option 3: acceptable to pin supported Obsidian versions and carry internal-API
  patches?

## References

- Substitutions: https://github.com/BambusControl/obsidian-substitutions
- Text-Snippets: CM5 `registerCodeMirror` is a no-op in current Obsidian
- Public typings: https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts
- `workspace.editorExtensions` semantics:
  https://obsidian-typings.github.io/obsidian-typings/public/api/obsidian/augmentations/Workspace/editorExtensions/
- Embed recipe (community gist):
  https://gist.github.com/Fevol/caa478ce303e69eabede7b12b2323838
- Forum thread "editor inside a modal":
  https://forum.obsidian.md/t/how-to-get-obsidian-editor-inside-modal/89603
- Handoff that raised the item:
  `.rpiv/artifacts/handoffs/2026-11-11_09-40-00_session-close-and-backlog.md`
