# RadiProtocol

[Русская версия](README.ru.md)

RadiProtocol is an [Obsidian](https://obsidian.md) plugin for radiologists who want to run structured examination protocols inside their reporting vault. It turns a protocol into a guided clinical checklist: choose the relevant branch, insert prepared report text or snippets, repeat sections for multiple findings, and write the generated text into the note bound to the session.

Protocols are authored as **`.rp.json`** files in the built-in visual protocol editor.

## What RadiProtocol helps with

- **Standardized radiology reporting.** Encode local protocols, modality workflows, follow-up recommendations, or structured report templates as reusable decision trees.
- **Guided branching.** Question and answer nodes let the radiologist choose the clinically appropriate path without searching through long static templates.
- **Reusable report fragments.** Snippet nodes insert prepared text from a configurable snippet folder. Markdown templates can ask for placeholders such as free text or choice, filled during protocol execution.
- **Repeated findings.** Loop nodes support workflows such as multiple lesions, multiple nodules, repeated measurements, or several anatomical levels.
- **Note-anchored execution.** The runner opens as a floating panel or an optional right-sidebar session bound to the active Markdown note, and appends the selected protocol output to that note.
- **Visual protocol authoring.** The protocol editor supports start, question, answer, snippet, and loop nodes connected as a graph. (Existing text-block nodes from older versions remain supported — see the compatibility note below.)

## Typical clinical workflow

1. Open or create the Markdown note for the examination report.
2. Choose **Run protocol** from the command palette.
3. Select a protocol from the configured protocol folder.
4. Answer each clinical question in the runner.
5. Fill snippet placeholders when prompted.
6. Review the generated text appended to the note and edit it as needed before final reporting.

RadiProtocol is a documentation aid. The radiologist remains responsible for clinical judgment, wording, and final report validation.

## Installation

RadiProtocol is a desktop-only plugin.

### BRAT (recommended)

1. Install the [Obsidian BRAT plugin](https://github.com/TfTHacker/obsidian42-brat).
2. In BRAT settings, choose **Add Beta plugin** and paste the GitHub URL of this repository.
3. Enable **RadiProtocol** in Obsidian's Community plugins list.

### Manual installation

1. Download `main.js`, `styles.css`, and `manifest.json` from the [GitHub Releases](https://github.com/vegacepticon/RadiProtocol/releases) page.
2. Copy those files into `<your-vault>/.obsidian/plugins/radiprotocol/`.
3. Reload Obsidian.
4. Enable **RadiProtocol** in Obsidian's Community plugins list.

## Setup

1. Open RadiProtocol settings.
2. Set **Protocol folder** to the vault-relative folder that contains `.rp.json` protocol files. The default is `Protocols`; an empty value disables the protocol picker.
3. Set **Snippet folder** to the vault-relative folder that contains snippet Markdown files. The default is `Snippets`.
4. Choose the preferred text separator for accumulated report text: newline or space.
5. Select the interface language if needed.
6. Optionally enable **Run protocols in the right sidebar** and/or **Conclusion draft in runner**.

## Commands

RadiProtocol adds the following commands. No command has a default global hotkey.

| Command | What it does |
|---|---|
| **Run protocol** | Choose a `.rp.json` file and start a session bound to the active Markdown note. The session opens in the floating panel or the right sidebar, depending on the setting. |
| **Start from specific node** | Choose a protocol and a start node, then start a session from that node. Useful for testing one branch. Requires an active Markdown note. |
| **Open protocol editor** | Choose or create a `.rp.json` file and open the visual editor. |
| **Insert snippet** | Pick a snippet and insert it at the cursor of the active Markdown note, or append it when no editor is available. |
| **Create snippet from selection** | Create a new snippet using the current editor selection as the initial template. |
| **Open snippet manager** | Open the snippet manager view. |
| **Open community library** | Open the community library view. |
| **Export protocol as library package** | Choose a protocol and open the export modal: save a release bundle to the vault, or submit it to the community library. |
| **Open plugin menu** | Reveal the persistent RadiProtocol menu in the right sidebar. |

To assign a hotkey, open **Settings → Hotkeys**, search for the command name (for example, `Run protocol`), and click the **+** button. Obsidian stores hotkeys separately for each vault.

### Keyboard shortcuts inside the runner

The runner takes focus when it opens and returns focus to itself after each action, so the next key lands in the runner. It never takes focus back while you are typing in the note. Typing in a text field is never intercepted. Letters and digits match physical key positions, so the Russian layout works without remapping, and a small hint row above the runner buttons lists the shortcuts available right now.

| Key | Action |
|---|---|
| `1`–`9` | Choose the matching option: answers, question transitions, snippet branches, loop body or exit. Each option shows its number. A free-text option focuses its field instead of submitting it. |
| `Z` | Back one step. |
| `X` | Redo the undone step. |
| `S` | Skip the current question (when it has preset answers). |
| `Backspace` | Alias of `Z`. |
| `Ctrl+←` or `Alt+←` | Back one step (legacy alias). |
| `Ctrl+→` or `Alt+→` | Redo the undone step (legacy alias). |
| `F` | Focus the free-text answer field; when a question has several, the first blank one. |
| `C` | Focus the conclusion draft. |
| `V` | Insert the conclusion draft into the bound note. |
| `H` | Show or hide the hint row. |
| `Esc` | Close the runner when focus is not in a text field. If the conclusion draft contains uninserted text, RadiProtocol asks before discarding it. |
| `Ctrl+Space` | Submit a free-text answer, or confirm the snippet fill-in modal. One-handed chord: it never inserts a character, so it is safe inside a field. |
| `Shift+Enter` | Legacy alias of `Ctrl+Space` in free-text fields and in the fill-in modal. |
| `Enter` | Add the current line as an item in the conclusion draft. |
| `Shift+Enter` in the draft | Insert a line break instead of adding an item. |
| `Tab` / `Shift+Tab` | Move focus forward or backward. |
| `j` / `k` / `Tab` / `Shift+Tab` | Move through snippet picker results when the result list has focus. `Tab` from the last row and `Shift+Tab` from the first row leave the list for the next control (the first row hands focus back to the search field). |

Only the first nine options of a step are numbered; longer lists stay reachable with `Tab` and the mouse. Keys with `Ctrl`, `Alt` or `Cmd` are left to Obsidian except for the arrow aliases and `Ctrl+Space`. The hint row is session state: it is not saved in settings.

Inside the snippet fill-in modal the caret starts in the first placeholder, so no `Tab` is needed to begin typing. A choice field is a single `Tab` stop: the arrow keys move between its options and the `✎` Custom toggle, `1`–`9` toggle the numbered option without leaving the group (each pill shows its number, and digits still type themselves inside a text field), and `Tab` leaves the group for the next field. `Ctrl+Space` confirms from anywhere in the modal; `Shift+Enter` keeps working as a legacy alias.

### Floating panel or right sidebar

Both presentations use the same runner and the same conclusion draft.

- **Floating panel (default).** The runner is a draggable, resizable panel over the note. Its position and size are remembered across sessions. Several sessions for different protocols or notes can be open at once.
- **Right sidebar.** Enable **Run protocols in the right sidebar**. Each note gets at most one sidebar runner: launching another protocol for the same note reveals the existing runner instead of stacking a second tab. Close the runner to start a new session for that note. When you switch back to a note that has a runner, its tab is revealed automatically; if the active note differs from the bound note, the runner shows a **Focus note** button.

Runner sessions are transient: they are not restored after Obsidian restarts, and their state is not saved in plugin settings.

## Conclusion draft

The runner includes a session-only conclusion draft below the answer choices. Type a line and press **Enter** to turn it into an item. Edit or delete individual items, or reorder them using the drag handle. The compact editor has no heading, help text or hover tooltips; single-line fields match the drag-handle height and expand for longer text. The insert button is centered.

**Insert conclusion** inserts the entire draft, including uncommitted input, at the last cursor position **in the note bound to this Runner**. That note must be open in editing mode. Items are joined with newlines, without a heading or list markers. The draft remains visible after insertion; pressing the button again inserts the entire text again rather than updating an earlier insertion.

Protocol navigation, Back and Redo leave the draft unchanged. Uninserted text prevents automatic close on protocol or self-check completion. Closing through the Runner button, Escape outside a text field, the tab X or middle-click asks before discarding uninserted text. The native tab gesture guard depends on Obsidian's UI; command/menu closes, plugin unload and application exit are not intercepted.

Drafts exist **only for the current run**. They are not saved in protocol files or settings, and do not survive a restart. The feature is enabled by default; the **Conclusion draft in runner** setting applies to new runs.

## Text expansion

RadiProtocol can expand typed triggers into longer text, so a separate Substitutions or Text Snippets plugin is no longer needed. It works in the runner's free-text answers, loop free-text targets, the conclusion draft, the snippet fill-in fields, and — optionally — the note editor.

Enable it in **Settings → RadiProtocol → Text expansion**. Two modes:

- **As you type (auto-replace)** — the trigger is replaced the moment it is complete: `-->` becomes `→`. This is the Substitutions behaviour.
- **On Space (snippets)** — type a whole word and press Space to replace it: `;sig` becomes your signature, and the space is consumed. This is the Text Snippets behaviour.

Rules are one per line as `trigger => replacement` (`→` also works as the separator):

```text
--> => →
<-- => ←
!= => ≠
;sig => Best regards,$nl$Roman$end$
```

In a replacement, `\n`, `\t`, `\b` and `\\` are character escapes, `$nl$` inserts a line break, and `$end$` marks where the caret lands after expansion (default: the end). Lines starting with `#` are comments, and triggers cannot contain spaces. Lines that cannot be parsed are counted under the rules field and ignored.

Notes and limits:

- Expansion applies to direct typing only; pasted text is never rewritten.
- In plugin text fields the replacement bypasses the browser's native undo (one Ctrl+Z does not restore the trigger). The note editor keeps its normal undo history.
- Tab is not a delimiter: it moves focus in modals and indents lists in the editor. Only Space expands snippets.
- If another expansion plugin is still enabled, turn it off to avoid double expansion in the note editor.

## Self-check

A protocol can define a completion checklist. In the protocol editor, open the checklist button in the floating toolbar to enable the self-check and add items. After the final question, the runner shows the checklist instead of closing immediately. The runner closes when every item is checked — unless the conclusion draft still has uninserted text.

## Community library

The community library lets you browse and install published protocols without leaving Obsidian. The catalog and moderation service are external to this repository: RadiProtocol is the client, not the registry host.

RadiProtocol ships with bundled catalog endpoints (`https://library.radiprotocol.pro`, with `https://radiprotocol.pages.dev` as a mirror), so the library works without configuration. An explicit **Advanced → Library registry URL** replaces the bundled endpoints; leave it empty to use them. Invalid or non-HTTPS values make the catalog unavailable.

If the registry cannot be reached, the view shows an unavailable banner and serves the last cached catalog when one exists.

### Installing a package

1. Run **Open community library**.
2. Browse, search, or filter the catalog, then open a package to review its protocol title and snippet paths with their SHA-256 hashes.
3. Choose **Install**. RadiProtocol downloads the full release again, verifies its hashes and protocol graph, and commits snippets, protocol, then the Installed marker.
4. Wait for the progress dialog to report success. The package appears under **Installed**, and its protocol becomes available in the normal protocol pickers once Obsidian indexes the new file.
5. If the dialog reports that indexing is still pending, the package is already committed; do not reinstall it. It may appear in the picker shortly. Refresh the Community library view to confirm the Installed record.

Installed package files live under a managed `library/<package>/<version>/` namespace inside the configured protocol and snippet folders. They are read-only in RadiProtocol; use **Uninstall** from the Installed section to remove only package-owned files.

**Import from file…** installs a release bundle JSON from the vault through the same verification and transaction path. This is useful for offline sharing and for reviewing a package before publication.

### Publishing a package

**Export protocol as library package** opens the export modal for a selected protocol. The modal offers two paths:

- **Save to this vault** writes the release bundle as a JSON file into the chosen folder.
- **Send to the Community Library** submits the bundle for moderation.

Submission requires explicit confirmation that the package may be published publicly and that you hold the rights to distribute it. The Community Library is public: never include patient data or real case identifiers. A moderator reviews every submission; the plugin records the submission locally and links to the moderation PR.

The **My submissions** section of the library view shows attempts made from this vault. It is local bookkeeping, not an account sync. Use **Check status** to reconcile an attempt against the registry, **Retry** for a failed or unknown attempt, and **Delete record** to remove only the local record; it does not affect the moderation PR.

> **Trust boundary.** SHA-256 verifies that downloaded contents match the release manifest. It does **not** authenticate the publisher or prove who created the package.

## Creating a protocol

1. Run **Open protocol editor**.
2. Create or open a `.rp.json` protocol file in the configured protocol folder. New protocols already contain a Start node.
3. Add clinical **Question** nodes and connect them to **Answer** nodes or other protocol nodes.
4. Chain **Answer** nodes for fixed pass-through report text (`Question → Answer1 → Answer2`): select Answer1 to append it, and downstream Answer2 is appended automatically without another click.
5. Use **Snippet** nodes to insert reusable report fragments from a file or folder.
6. Use **Loop** nodes when the same reporting section may need to be repeated.
7. Optionally define a self-check checklist in the editor toolbar.
8. Save the protocol and test it with **Run protocol** on a Markdown note.

> **Text block compatibility.** New protocols no longer offer a **Text block** node type in the creation menu — chain **Answer** nodes instead. Existing protocols that contain `text-block` nodes (including snippet-backed ones) continue to load, run, edit, and appear in **Start from specific node**; you do not need to migrate them.

## Snippets

RadiProtocol supports two Markdown snippet formats, both stored as `.md` files in the snippet folder:

- **Plain Markdown snippets**: the file contents are inserted as written, with no placeholder substitution.
- **Markdown templates**: a `.md` file with a YAML-like frontmatter block that declares placeholders. Supported placeholder types are **free text** and **choice** (with optional predefined options). Placeholders are filled during protocol execution and substituted into the template body via `{{id}}` tokens.

A snippet node can point to a specific snippet file or to a directory. When it points to a directory, the runner lets the user choose one snippet from that directory during execution.

> **Legacy JSON snippets.** Older versions stored snippets as `.json` files. These legacy files are **not converted or deleted** — they are left untouched on disk but are no longer listed, searchable, or insertable. To keep using their content, recreate them as frontmatter-backed Markdown templates and update the protocol's snippet references.

## Where data lives

- Protocol files live in the configured **Protocol folder**; snippets live in the configured **Snippet folder**.
- Installed library packages live in `library/<package>/<version>/` inside those folders.
- Library bookkeeping (installed records, catalog cache, submissions, transaction journal) lives in `.radiprotocol/library/`.
- Plugin settings live in `.obsidian/plugins/radiprotocol/data.json` and are managed by Obsidian.

Back up the vault normally; RadiProtocol keeps no separate database.

## For contributors

Requirements: Node.js 22 and npm.

```bash
npm ci
npm run build   # strict TypeScript check, then production bundle
npm test        # Vitest suite
npm run check   # build, lint, tests, planning/consistency/agent-docs checks
npm run check:release  # check + CSS-class and i18n UI-text audits
```

For a live development vault, copy `.env.example` to `.env` and set `OBSIDIAN_DEV_VAULT_PATH`. `npm run dev` watches the source and copies `main.js`, `styles.css`, and `manifest.json` into that vault's plugin folder. The dev build does not run `tsc`; run `npm run build` before committing.

Repository hooks live in `.githooks/` and are optional for each local clone. To enable them, run:

`git config core.hooksPath .githooks`

The pre-commit hook runs staged TypeScript/CSS lint plus affected Vitest tests. The pre-push hook runs `npm run check`. Bypass hooks only when you have a clear reason and run the equivalent checks manually before opening a pull request.

Architecture notes live in `.rpiv/guidance/`; keep them in sync when a layer boundary changes. Release assets are `main.js`, `styles.css`, and `manifest.json`.

For releases, use `npm version X.Y.Z` so `manifest.json` and `versions.json` are updated by the version lifecycle. Git tags are numeric because `.npmrc` sets an empty tag prefix. Push the tag to let the release workflow create the GitHub Release.

## License

Released under the terms of the [LICENSE](LICENSE) file in this repository.
