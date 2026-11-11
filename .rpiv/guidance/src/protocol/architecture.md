# Protocol Layer Architecture

## Responsibility
`src/protocol/` is the boundary between canonical `.rp.json` documents and runtime `ProtocolGraph` values. The document model, parser, and migration are pure; the store and resolver are the Obsidian vault shell.

## Dependencies
- **`graph/`**: runtime node kinds, graph result types, and topology.
- **`i18n/Translator`**: injected parser diagnostics.
- **`utils/WriteMutex` and vault helpers**: serialized writes and parent-folder creation.
- **Obsidian**: `App`, `Vault`, `TFile`, and `TFolder` only in store/resolver modules.

## Consumers
`main.ts` wires the store/parser/resolver; views edit or execute documents; snippets rewrite references; library packages compose a document value and revalidate installed copies.

## Module Structure
```
protocol-document.ts          # V1 schema, factory, shallow envelope guard
protocol-document-parser.ts   # pure JSON/record → ProtocolGraph parser
protocol-document-migration.ts# pure, idempotent legacy-loop conversion
protocol-document-store.ts    # vault CRUD, migration persistence, atomic update
protocol-file-lock.ts         # shared per-vault, per-path serialization
protocol-file-resolver.ts     # normalized recursive .rp.json enumeration
```

## Versioned Envelope and Shallow Guard
```typescript
export const PROTOCOL_SCHEMA = 'radiprotocol.protocol' as const;
export const PROTOCOL_VERSION = 1 as const;
interface ProtocolDocumentV1 {
  schema: typeof PROTOCOL_SCHEMA; version: typeof PROTOCOL_VERSION;
  id: string; title: string; createdAt: string; updatedAt: string;
  nodes: ProtocolNodeRecord[]; edges: ProtocolEdgeRecord[];
  // Optional runner extras read by RunnerSessionHost from the same file:
  selfCheckEnabled?: boolean; selfCheckItems?: string[];
  conclusionDraftItems?: string[];
}
function isProtocolDocumentV1(value: unknown): value is ProtocolDocumentV1 {
  // Envelope/arrays only; node semantics are downstream.
  return isRecord(value) && value.schema === PROTOCOL_SCHEMA
    && value.version === PROTOCOL_VERSION && typeof value.id === 'string'
    && Array.isArray(value.nodes) && Array.isArray(value.edges);
}
```
The factory seeds a Start record and duplicates editor defaults intentionally; protocol code must not import `views/`.

## Pure Parse and Migration Boundary
```typescript
class ProtocolDocumentParser {
  constructor(private readonly t: Translator = defaultT) {}
  parse(raw: string, filePath: string): ParseResult {
    let value: unknown;
    try { value = JSON.parse(raw); }
    catch { return { success: false, error: this.t('protocol.parseFailed') }; }
    if (!isProtocolDocumentV1(value)) return { success: false, error: this.t('protocol.invalidDocument') };
    return this.parseDocument(value, filePath); // skip untyped; collect recognized errors
  }
}
const { document, changed } = migrateProtocolDocument(value, now);
// Store persists changed legacy records before parsing.
```
The source catches JSON decoding only. Because the envelope guard is shallow, malformed nested array elements can still throw inside `parseDocument()`; do not promise total protection for arbitrary nested input. Modern field keys win over `radiprotocol_*` compatibility keys by checking `!== undefined`. Standalone loop records and prefixed exit labels are converted only by the pure migration; `loop-start`/`loop-end` remain parseable so validation can report migration-required data.

## Vault Store and Atomicity Boundary
```typescript
async update(path: string, mutate: Mutator): Promise<ProtocolDocumentV1> {
  return withProtocolFileLock(this.app.vault, path, async () => {
    const next = mutate(await this.readUnlocked(path));
    await this.writeUnlocked(path, next);
    return next;
  });
}
```
`read()`, `write()`, `update()`, `delete()`, and snippet reference rewrites share `withProtocolFileLock()` keyed by vault identity and file path. `update()` holds the lock across read, migration persistence, mutation, and write. Multiple store instances for one vault share the same lock; other paths and vaults remain independent.

Private `readUnlocked()` and `writeUnlocked()` require the caller to hold the lock. Migration writes directly through `writeUnlocked()` to avoid re-acquiring a non-reentrant lock. `read()` returns `null` for missing, malformed, or migration-persistence failure; writes and mutator errors propagate and release the lock. A whole-document `write()` still replaces the document supplied by its caller; use `update()` for edits that must preserve concurrent changes. External vault edits and the separate journaled library installer do not participate in this lock.

## Normalize-Then-Walk Resolution
```typescript
function resolveProtocolDocumentFiles(vault: Vault, configured: string): TFile[] {
  const root = normalizeProtocolFolderPath(configured);
  if (root === '') return []; // empty setting disables selection
  const folder = vault.getAbstractFileByPath(root);
  return folder instanceof TFolder
    ? walk(folder).filter(file => file.path.endsWith('.rp.json'))
    : vault.getFiles().filter(file => file.path.startsWith(root + '/')
        && file.path.endsWith('.rp.json'));
}
```
The resolver normalizes separators and edge slashes, prefers a folder-child walk, and falls back to the vault index. It enumerates files only; parsing, migration, and graph validation happen later.

## Architectural Boundaries
- Do not import Obsidian into the document, parser, or migration modules.
- Do not put graph semantics in the shallow envelope guard.
- Store deletes use Obsidian trash; all vault writes go through a keyed mutex.
- `ProtocolDocumentV1` is composed as a value by library manifests, never extended.

<important if="you are adding a protocol field or node capability">
## Adding a Protocol Field
1. Choose document-level state versus `node.fields` and add the typed runtime property if needed.
2. Extract the canonical key in the parser; preserve explicit `false`, empty arrays, and empty strings.
3. Add a compatibility alias only for a real legacy document and use migration for structural rewrites.
4. Update graph validation, runner/render/view consumers, reference sync, locales, and tests as applicable.
5. Do not bump version for a genuinely optional backward-compatible field.
</important>

<important if="you are writing or modifying tests for the protocol layer">
- Test document/parser/migration directly with typed builders and deterministic clocks.
- Store tests use `makeVault()`/`makeApp()` and assert both returned values and persisted bytes/call counts.
- Cover canonical-first compatibility, collected parse errors, dangling-edge filtering, migration idempotence, resolver suffix/path behavior, concurrent updates, migration without deadlock, and concurrent snippet reference rewrites.
</important>
