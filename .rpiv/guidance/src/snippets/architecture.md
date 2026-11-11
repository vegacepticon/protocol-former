# Snippets Layer Architecture

## Responsibility
`src/snippets/` contains the Markdown snippet domain plus vault CRUD and cross-protocol reference reconciliation. `snippet-model.ts` and `md-template.ts` are pure; `snippet-service.ts` and `protocol-ref-sync.ts` own vault effects.

## Dependencies
- **`i18n/Translator`**: injected validation and UI copy.
- **`protocol/`**: V1 envelope guard/types for reference synchronization.
- **`utils/WriteMutex` and vault helpers**: serialized writes and folder creation.
- **Obsidian**: injected `App`, `Vault`, `TFile`, and `FileManager` at the effectful boundary.

## Consumers
`main.ts` constructs the service; snippet manager/editor/pickers and the runner consume it. Library package paths reuse pure slug/path behavior. Reference sync is owned by SnippetService after every file/folder path change; views only reconcile their selected/expanded paths.

## Module Structure
```
snippet-model.ts  # tagged variants, validation, literal template rendering
md-template.ts    # strict front-matter parser/serializer
snippet-service.ts# rooted vault CRUD, search, resolution, moves
protocol-ref-sync.ts # best-effort .rp.json reference rewrite
```

## Tagged Variants and Path Identity
```typescript
export type Snippet = MdSnippet | MdTemplateSnippet;
interface MdSnippet {
  readonly kind: 'md'; readonly path: string; // sole identity
  readonly name: string; readonly content: string;
}
interface MdTemplateSnippet {
  readonly kind: 'md-template'; readonly path: string;
  readonly template: string; readonly placeholders: SnippetPlaceholder[];
  readonly validationError: string | null;
}
```
Never key or rewrite by display name/front-matter ID. JSON files remain on disk only as an unsupported `legacy-json` resolution result; they are not a `Snippet` variant.

## Strict Markdown Template Codec
```typescript
function isTemplate(text: string): boolean {
  return text.startsWith('---\n') && text.indexOf('\n---\n', 4) > 0;
}

function render(template: string, placeholders: Placeholder[], values: Record<string, string>): string {
  let output = template;
  for (const placeholder of placeholders) {
    // ES6-compatible literal replacement; missing values become empty.
    output = output.split(`{{${placeholder.id}}}`).join(values[placeholder.id] ?? '');
  }
  return output;
}
```
The parser intentionally supports a small YAML-like subset, requires delimiters at byte zero with LF newlines, preserves raw Markdown for plain files, and returns validation errors as data. Choice values are joined by the fill UI before rendering.

## Rooted Vault Mutation
```typescript
const safe = assertInsideRoot(inputPath);
if (safe === null) return; // reads: null/empty; mutations: throw

await mutex.runExclusive(safe, async () => {
  await ensureFolderPath(vault, parentOf(safe));
  const data = snippet.kind === 'md'
    ? snippet.content
    : serializeMarkdownTemplate(snippet);
  await vault.adapter.write(safe, data);
});
```
The root gate rejects absolute/traversal/sibling-prefix escapes before any adapter call. Mutations check collisions and throw; deletes use `trashFile`; browsing/loading favors safe empty/null results.

## Best-Effort Reference Reconciliation
```typescript
const result = { updated: [] as string[], skipped: [] as Array<{path: string; reason: string}> };
for (const file of app.vault.getFiles().filter(f => f.path.endsWith('.rp.json'))) {
  // Rewrite only snippet fields, exact match first, then longest slash-boundary prefix.
  // Skip unchanged documents and record one-file failures without aborting the pass.
}
return result;
```
`renameSnippet`, `moveSnippet`, `relocateSnippet`, `renameFolder`, and `moveFolder` await the physical rename and reference repair together. `relocateSnippet(oldPath, newPath)` performs simultaneous folder/name changes with one rename, avoiding an intermediate identity. A per-vault/root lock serializes path changes across service instances, including destination collision checks and the repair pass. Paths keep the `.md` extension. The configured root cannot itself be renamed/moved.

Reference repair is best-effort: a successful rename may leave skipped protocol rewrites. The injected report callback receives updated/skipped paths and production presents skipped-file warnings; callback failures never reject an already completed rename. The synchronizer shares the per-vault, per-path lock in `protocol/protocol-file-lock.ts` with protocol stores, holding it across read, rewrite, and write. It writes canonical pretty JSON with a trailing newline. Move/rename plus the vault-wide rewrite pass remain non-atomic.

## Architectural Boundaries
- Keep pure model/codec code free of Obsidian imports and vault state.
- Preserve `.md` extension-bearing protocol references; do not revive JSON insertion.
- Only `protocol-ref-sync.ts` crosses from snippets into protocol documents.
- Library installation is a separate journaled transaction and deliberately bypasses ordinary snippet CRUD during commit.

<important if="you are adding a new snippet variant or placeholder capability">
## Adding a Snippet Capability
1. Extend the tagged model and every exhaustive consumer branch.
2. Add deterministic Markdown detection/parsing/serialization and validation.
3. Update service listing/loading/saving/duplication/resolution and picker/editor/fill flows.
4. Preserve root containment and path identity; update reference sync/library allowlists if paths change.
5. Add pure model/codec, vault, UI, runner, and package tests; keep JSON legacy-only.
</important>

<important if="you are writing or modifying tests for the snippets layer">
- Construct model/codec directly; use `makeVault()`/`makeApp()` for service tests.
- Assert unsafe paths cause zero vault I/O, raw Markdown is byte-preserved, and valid/invalid templates carry `null`/string validation errors.
- Ref-sync tests cover exact, boundary-prefix, longest-prefix, unchanged/no-write, malformed-file isolation, and partial failure behavior.
</important>
