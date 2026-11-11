# Library Layer Architecture

## Responsibility
Community-library bounded context: registry discovery/cache, package export, integrity/path validation, transactional install/uninstall, installed ownership, migration, and startup recovery.

## Dependencies
- **`protocol/`, `graph/`, `snippets/`**: composed document values, graph validation, and Markdown path/model rules.
- **Obsidian**: injected `App`/`Vault` and `requestUrl` transport at effectful boundaries.
- **`utils/WriteMutex`**: the single install lock and typed-store write serialization.
- **Web Crypto**: SHA-256 byte verification; this is integrity only.

## Consumers
`main.ts` constructs and recovers the service before views register. Library, protocol-picker, protocol-editor, and snippet-manager views consume the facade or pure ownership helpers, never the registry client directly.

## Module Structure
```
library-model.ts + registry-model.ts     # stored/wire shapes and guards
library-paths.ts + integrity.ts           # pure namespaces, paths, hashes
library-json-io.ts + *-store.ts           # typed vault persistence
registry-client.ts + library-service.ts   # transport and view-facing facade
transaction-journal.ts + library-installer.ts # commit/recovery boundary
```

## Versioned Models and Shape Guards
```typescript
const PACKAGE_SCHEMA = 'radiprotocol.package' as const;
const PACKAGE_VERSION = 1 as const;
function isPackageManifest(value: unknown): value is PackageManifest {
  return isRecord(value) && value.schema === PACKAGE_SCHEMA
    && value.version === PACKAGE_VERSION && isProtocolDocumentV1(value.protocol)
    && Array.isArray(value.snippetFiles) && value.snippetFiles.every(isSnippetFile);
}
```
Persisted and wire models use sentinel fields plus `is*` guards. `PackageManifest` composes `ProtocolDocumentV1` as a value; it does not extend or alter the protocol envelope.

## Explicit Result Boundaries
```typescript
type FetchResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'not-found'; reason: string }
  | { status: 'unavailable'; reason: string };

async fetchRelease(id: string, version: string): Promise<FetchResult<Bundle>> {
  if (this.baseUrls.length === 0) return { status: 'unavailable', reason: 'not configured' };
  try {
    const response = await this.requestUrl({ url: this.url(id, version), method: 'GET' });
    if (response.status === 404) return { status: 'not-found', reason: 'missing' };
    if (response.status < 200 || response.status >= 300) return { status: 'unavailable', reason: 'HTTP' };
    return isReleaseResponse(response.json)
      ? { status: 'ok', value: response.json }
      : { status: 'unavailable', reason: 'invalid shape' };
  } catch (error) {
    return { status: 'unavailable', reason: safeErrorMessage(error) };
  }
}
```
Registry/client, installer, and service APIs use explicit result unions. Typed stores throw `LibraryStoreError` for malformed/operational state; higher-level list operations may log and return safe empty values.

## Journal-Before-Write, Marker-Last Commit
```typescript
await installMutex.runExclusive('library-install', async () => {
  const plan = await planInstall(bundle); // no final-path mutation
  await journal.write(plan.journal);      // journal first
  await writeOwnedFiles(plan);
  await writeProtocol(plan);
  await writeMarker(plan.record);         // marker is the commit signal, last
  await journal.remove(plan.id);          // best effort after commit
});
```
Rollback and startup recovery are namespace-gated, deepest-first, and retain a journal when cleanup fails. A valid matching marker means committed; missing/malformed/mismatched markers roll back owned paths.

## Namespace Safety and Integrity Posture
```typescript
const hash = await sha256String(rawId);
const namespace = `${slugify(rawId)}-${hash.slice(0, 12)}`;
const relative = assertNoTraversal(bundlePath);
if (relative === null) return { status: 'failed', reason: 'unsafe path' };

const verified = await verifyIntegrity(content, expectedSha256);
// verified === true proves bytes match the manifest, not publisher identity.
```
Install planning validates closure, `.md` content, paths, hashes, parser output, and staged graph references before final writes. Registry endpoints are bundled in `REGISTRY_URLS` (custom domain first, `pages.dev` mirror second); an explicit settings override replaces the whole list, and an invalid/non-HTTPS override yields no endpoints. Signatures/publisher authentication remain deferred.

## Architectural Boundaries
- Preserve one global install lock across planning, journal, commit, rollback, recovery, and migration.
- Do not call ordinary snippet/protocol stores during the multi-file install commit; they would split the transaction boundary.
- Uninstall owns paths from the installed record, not current settings.
- Treat readiness/index timeout as committed-but-not-ready, not install failure.

<important if="you are adding a new library capability">
## Adding a Library Capability
1. Add a versioned model/guard or wire model.
2. Add pure path/reference/integrity planning and explicit result states.
3. Extend a typed store/client only when persistence/network is required.
4. Add all mutation validation to install planning; journal every owned path with the marker last.
5. Wire the service facade and consume it from views; add recovery/ownership handling where relevant.
6. Test corruption, traversal, collision, integrity failure, rollback, recovery, and readiness outcomes.
</important>

<important if="you are writing or modifying tests for the library layer">
- Test pure models/paths/integrity directly; inject `vi.fn()` transport and clocks for registry/service tests.
- Use in-memory vault maps for stores and installer bundles with production-derived hashes/paths.
- Assert marker ordering, zero final writes on preflight failure, namespace-gated rollback/uninstall, and integrity-not-authenticity wording.
</important>
