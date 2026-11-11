// snippets/snippet-service.ts
// Receives App and settings as constructor parameters — no direct Obsidian imports (NFR-01)
import type { App } from 'obsidian';
import type { RadiProtocolSettings } from '../settings';
import type { Snippet, MdTemplateSnippet, MdSnippet } from './snippet-model';
import { parseMarkdownTemplate, serializeMarkdownTemplate, hasMarkdownTemplateFrontmatter } from './md-template';
import { rewriteProtocolSnippetRefs, type ProtocolSyncResult } from './protocol-ref-sync';
import { WriteMutex } from '../utils/write-mutex';
import { ensureFolderPath } from '../utils/vault-utils';
import { defaultT, type Translator } from '../i18n';

/**
 * Phase 2 (JSON-removal): Discriminated result of resolving a runner snippet
 * reference. The view switches on `status` and delegates presentation to
 * `render-snippet-fill.ts`; no path probing or vault scans remain in views.
 */
export type SnippetResolution =
  | { status: 'found'; snippet: MdSnippet | MdTemplateSnippet }
  | { status: 'legacy-json'; path: string }
  | { status: 'missing' };

/**
 * Phase search: a single global search hit. `snippet` is the parsed Markdown
 * snippet; `folderPath` is the vault-relative folder that directly contains
 * it (used by the manager to render a secondary path label under flat results).
 */
export interface SnippetSearchResult {
  snippet: Snippet;
  folderPath: string;
}

/**
 * Phase 34 (D-03): Build a canvas-ref mapping key from a vault-relative path.
 * - Strips `snippetRoot + '/'` prefix if present
 * - Strips trailing `.md` (case-insensitive), once
 * - Returns '' when vaultPath === snippetRoot
 *
 * This is the single source of truth for converting between vault-relative
 * paths (what SnippetService deals in) and the snippet-root-relative,
 * extension-less display/key format. Protocol reference repair preserves `.md`.
 */
export function toSnippetRelativePath(vaultPath: string, snippetRoot: string): string {
  if (vaultPath === snippetRoot) return '';
  const prefix = snippetRoot + '/';
  let rel = vaultPath.startsWith(prefix) ? vaultPath.slice(prefix.length) : vaultPath;
  rel = rel.replace(/\.(md)$/i, '');
  return rel;
}

/**
 * Rooted Markdown snippet CRUD and service-owned path/reference reconciliation.
 * Every vault.modify() / vault.adapter.write() is wrapped in WriteMutex.runExclusive().
 * Folder existence is guaranteed via ensureFolderPath() before every write.
 */
const pathChangeLocks = new WeakMap<App['vault'], WriteMutex>();

export class SnippetService {
  private readonly app: App;
  private readonly settings: RadiProtocolSettings;
  private readonly mutex = new WriteMutex();
  /** Phase 84 (I18N-01): translator used for thrown error messages and
   *  validatePlaceholders forwarding. Defaults to English (defaultT) so the
   *  service can be constructed without a plugin reference in unit tests. */
  private readonly t: Translator;

  constructor(app: App, settings: RadiProtocolSettings, t: Translator = defaultT,
    private readonly onReferenceSync: (result: ProtocolSyncResult) => void = () => {},
  ) {
    this.app = app;
    this.settings = settings;
    this.t = t;
  }

  /**
   * Phase 32 (D-10): Pre-I/O path-safety gate. Normalises and validates that
   * `path` is inside `this.settings.snippetFolderPath`. Returns the normalised
   * path on success, or null on rejection. Callers MUST return a safe
   * empty/null result when this returns null.
   */
  private assertInsideRoot(path: string): string | null {
    const root = this.settings.snippetFolderPath;
    const stripped = path.replace(/^\/+/, '');
    const rawSegments = stripped.split('/');
    const hasTraversal = rawSegments.some((s) => s === '..' || s === '.');
    const isAbsolute = path.startsWith('/');
    const normalized = rawSegments.filter((s) => s !== '').join('/');
    const insideRoot =
      !hasTraversal &&
      !isAbsolute &&
      (normalized === root || normalized.startsWith(root + '/'));
    if (!insideRoot) {
      console.error('[Protocol Former] snippet-service rejected unsafe path:', path);
      return null;
    }
    return normalized;
  }

  /**
   * Phase 32: basename of a vault-relative path with its extension stripped.
   * Used to derive snippet `name` when loading/listing.
   */
  private basenameNoExt(path: string): string {
    const base = path.slice(path.lastIndexOf('/') + 1);
    const dot = base.lastIndexOf('.');
    return dot > 0 ? base.slice(0, dot) : base;
  }

  /**
   * List direct children of a folder within the snippet root.
   * Phase 30 D-18..D-21. Used by the runner picker.
   *
   * @param folderPath Full vault-relative path (D-19). Caller composes
   *   `${settings.snippetFolderPath}/${node.subfolderPath}` when subfolderPath is set.
   * @returns Direct-children folders (basenames, sorted) and parsed Snippet objects (sorted by name).
   *   Missing folder → empty. Corrupt JSON → skipped silently.
   *   Path outside snippet root → silently rejected (T-30-01).
   */
  async listFolder(
    folderPath: string,
  ): Promise<{ folders: string[]; snippets: Snippet[] }> {
    // Phase 32 (D-10): path-safety gate via assertInsideRoot helper.
    const normalized = this.assertInsideRoot(folderPath);
    if (normalized === null) return { folders: [], snippets: [] };

    const exists = await this.app.vault.adapter.exists(normalized);
    if (!exists) return { folders: [], snippets: [] };

    let listing: { files: string[]; folders: string[] };
    try {
      listing = await this.app.vault.adapter.list(normalized);
    } catch {
      return { folders: [], snippets: [] };
    }

    // Folder basenames (strip `${normalized}/` prefix). Only direct children.
    const folders: string[] = [];
    for (const f of listing.folders) {
      const rel = f.slice(normalized.length + 1);
      if (rel !== '' && !rel.includes('/')) folders.push(rel);
    }
    folders.sort((a, b) => a.localeCompare(b));

    // Phase 2 (JSON-removal): only `.md` snippets are parsed and listed.
    // Legacy `.json` files are skipped here so they never render as selectable
    // rows; `listFolderDescendants()` stays extension-agnostic so folder-delete
    // counts still include every physical file. basename is authoritative for
    // `name`; corrupt files skipped silently.
    const snippets: Snippet[] = [];
    for (const filePath of listing.files) {
      if (!filePath.endsWith('.md')) continue;
      const basename = this.basenameNoExt(filePath);
      try {
        const raw = await this.app.vault.adapter.read(filePath);
        if (hasMarkdownTemplateFrontmatter(raw)) {
          snippets.push(parseMarkdownTemplate(filePath, raw, basename, this.t));
        } else {
          snippets.push({
            kind: 'md',
            path: filePath,
            name: basename,
            content: raw,
          });
        }
      } catch {
        // Unreadable — skip silently.
      }
    }
    snippets.sort((a, b) => a.name.localeCompare(b.name));

    return { folders, snippets };
  }

  /**
   * Global recursive snippet search. Composes `listFolder()` so the path
   * gate, lowercase `.md` filtering, parsing, sorting, and unreadable-file
   * policy all apply. Matches snippet names, parsed bodies (`content` for
   * plain Markdown, frontmatter-free `template` for Markdown templates), and
   * real descendant folder names. A matching real folder promotes every
   * snippet beneath it at any depth; the synthetic configured root basename
   * is excluded so searching for the root name does not return the library.
   * Failed parses, unreadable Markdown, legacy JSON, and non-Markdown files
   * are skipped without aborting the scan. Empty/whitespace query → no reads.
   */
  async searchSnippets(query: string): Promise<SnippetSearchResult[]> {
    const normalizedQuery = query.trim().toLowerCase();
    if (normalizedQuery === '') return [];

    const root = this.assertInsideRoot(this.settings.snippetFolderPath);
    if (root === null) return [];

    const results: SnippetSearchResult[] = [];
    const walk = async (folderPath: string, ancestorFolderMatched: boolean): Promise<void> => {
      const listing = await this.listFolder(folderPath);
      const folderName = folderPath.slice(folderPath.lastIndexOf('/') + 1);
      const currentFolderMatched =
        ancestorFolderMatched ||
        (folderPath !== root && folderName.toLowerCase().includes(normalizedQuery));

      for (const snippet of listing.snippets) {
        const body = snippet.kind === 'md-template' ? snippet.template : snippet.content;
        if (
          currentFolderMatched ||
          snippet.name.toLowerCase().includes(normalizedQuery) ||
          body.toLowerCase().includes(normalizedQuery)
        ) {
          results.push({ snippet, folderPath });
        }
      }

      for (const folderName of listing.folders) {
        await walk(`${folderPath}/${folderName}`, currentFolderMatched);
      }
    };

    await walk(root, false);
    return results.sort(
      (a, b) =>
        a.snippet.name.localeCompare(b.snippet.name) ||
        a.snippet.path.localeCompare(b.snippet.path),
    );
  }

  /**
   * Phase 32 (D-03): Load a snippet by full vault-relative path.
   * Routes by extension: `.md` → MdSnippet / MdTemplateSnippet.
   * Phase 2 (JSON-removal): `.json` (and any non-`.md` path) returns `null` —
   * legacy JSON files are no longer loadable as snippets. Runner ID resolution
   * is owned by `resolveSnippet`, which reports legacy `.json` refs explicitly.
   * Returns null if path is unsafe, file missing, or read/parse fails.
   */
  async load(path: string): Promise<Snippet | null> {
    const normalized = this.assertInsideRoot(path);
    if (normalized === null) return null;
    if (!normalized.endsWith('.md')) return null;
    const exists = await this.app.vault.adapter.exists(normalized);
    if (!exists) return null;
    try {
      const raw = await this.app.vault.adapter.read(normalized);
      const basename = this.basenameNoExt(normalized);
      if (hasMarkdownTemplateFrontmatter(raw)) {
        return parseMarkdownTemplate(normalized, raw, basename, this.t);
      }
      return { kind: 'md', path: normalized, name: basename, content: raw };
    } catch {
      return null;
    }
  }

  /**
   * Phase 32 (D-03): Save a snippet. Branches on `kind`:
   *   - `md-template` → serialize frontmatter + body
   *   - `md`         → write raw content (free-text, no sanitisation)
   * Wraps write in WriteMutex per-path (D-11). Ensures parent folder exists.
   * Throws on unsafe path (D-10).
   */
  async save(snippet: Snippet): Promise<void> {
    const normalized = this.assertInsideRoot(snippet.path);
    if (normalized === null) {
      throw new Error(`[Protocol Former] save rejected unsafe path: ${snippet.path}`);
    }
    await this.mutex.runExclusive(normalized, async () => {
      await ensureFolderPath(this.app.vault, this.settings.snippetFolderPath);
      const lastSlash = normalized.lastIndexOf('/');
      const parent = lastSlash > 0 ? normalized.slice(0, lastSlash) : '';
      if (parent !== '' && parent !== this.settings.snippetFolderPath) {
        await ensureFolderPath(this.app.vault, parent);
      }
      const payload = snippet.kind === 'md-template'
        ? serializeMarkdownTemplate(snippet)
        : snippet.content;
      const exists = await this.app.vault.adapter.exists(normalized);
      if (exists) {
        await this.app.vault.adapter.write(normalized, payload);
      } else {
        await this.app.vault.create(normalized, payload);
      }
    });
  }

  /**
   * Phase 32 (D-03, D-08, D-11): Delete a snippet file by path.
   * Uses `fileManager.trashFile(file)` so Obsidian respects the user's
   * configured deletion preference. No-op on unsafe path or missing file.
   * Wrapped in WriteMutex per-path.
   */
  async delete(path: string): Promise<void> {
    const normalized = this.assertInsideRoot(path);
    if (normalized === null) return;
    await this.mutex.runExclusive(normalized, async () => {
      const file = this.app.vault.getAbstractFileByPath(normalized);
      if (file === null) return;
      // D-08: route deletion through Obsidian FileManager user preference.
      await this.app.fileManager.trashFile(file);
    });
  }

  /**
   * Phase 32 (D-03): Check if a snippet file exists at the given path.
   * Returns false on unsafe path.
   */
  async exists(path: string): Promise<boolean> {
    const normalized = this.assertInsideRoot(path);
    if (normalized === null) return false;
    return this.app.vault.adapter.exists(normalized);
  }

  /**
   * Phase 33 (D-17): Create an empty folder inside the snippet root.
   * Path-safety gated via assertInsideRoot; rejects unsafe path by throwing.
   * Idempotent — ensureFolderPath is a no-op when the folder already exists.
   * Wrapped in WriteMutex per normalized path.
   */
  async createFolder(path: string): Promise<void> {
    const normalized = this.assertInsideRoot(path);
    if (normalized === null) {
      throw new Error(`[Protocol Former] createFolder rejected unsafe path: ${path}`);
    }
    await this.mutex.runExclusive(normalized, async () => {
      await ensureFolderPath(this.app.vault, normalized);
    });
  }

  /**
   * Phase 33 (D-16, D-17): Trash a folder recursively via FileManager.
   * Path-safety gated; unsafe path or missing folder → silent no-op (no throw).
   * Per D-17 refined: does NOT call rewriteProtocolSnippetRefs — deletes leave canvas refs broken.
   * Wrapped in WriteMutex per normalized path.
   */
  async deleteFolder(path: string): Promise<void> {
    const normalized = this.assertInsideRoot(path);
    if (normalized === null) return;
    await this.mutex.runExclusive(normalized, async () => {
      const folder = this.app.vault.getAbstractFileByPath(normalized);
      if (folder === null) return;
      // D-08: route deletion through Obsidian FileManager user preference.
      await this.app.fileManager.trashFile(folder);
    });
  }

  /**
   * Phase 33 (D-15): Recursively walk a folder and return every descendant
   * file + subfolder (vault-relative paths as adapter.list returns them).
   * Used by the folder-delete confirm dialog to display the exact count of
   * items that will be trashed.
   * Unsafe path → { files: [], folders: [], total: 0 }.
   */
  async listFolderDescendants(
    path: string,
  ): Promise<{ files: string[]; folders: string[]; total: number }> {
    const normalized = this.assertInsideRoot(path);
    if (normalized === null) return { files: [], folders: [], total: 0 };
    const files: string[] = [];
    const folders: string[] = [];
    const queue: string[] = [normalized];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      let listing: { files: string[]; folders: string[] };
      try {
        listing = await this.app.vault.adapter.list(current);
      } catch {
        continue;
      }
      for (const f of listing.files) files.push(f);
      for (const sub of listing.folders) {
        folders.push(sub);
        queue.push(sub);
      }
    }
    return { files, folders, total: files.length + folders.length };
  }

  async duplicateSnippet(path: string): Promise<string> {
    const original = await this.load(path);
    if (original === null) throw new Error(this.t('snippetService.fileNotFound', { path }));

    const dot = path.lastIndexOf('.');
    const base = dot >= 0 ? path.slice(0, dot) : path;
    const ext = dot >= 0 ? path.slice(dot) : '';
    let candidate = `${base}-copy${ext}`;
    let index = 2;
    while (await this.exists(candidate)) {
      candidate = `${base}-copy-${index}${ext}`;
      index += 1;
    }

    const duplicate: Snippet = original.kind === 'md-template'
      ? { ...original, path: candidate, name: this.basenameNoExt(candidate), placeholders: original.placeholders.map((p) => ({ ...p })) }
      : { ...original, path: candidate, name: this.basenameNoExt(candidate) };
    await this.save(duplicate);
    return candidate;
  }

  /**
   * Phase 34 (MOVE-01, RENAME-03): Rename a snippet file in place (same folder).
   * Preserves the Markdown extension. Rejects basenames that
   * contain slashes or are empty/whitespace-only. Collision-checks destination
   * before touching the source. Wrapped in WriteMutex per normalized source.
   * Returns the new normalized path. No-op (returns unchanged path) when the
   * normalized old and new paths are identical.
   */
  async renameSnippet(oldPath: string, newBasename: string): Promise<string> {
    const normalizedOld = this.assertInsideRoot(oldPath);
    if (normalizedOld === null) {
      throw new Error(`[Protocol Former] renameSnippet rejected unsafe path: ${oldPath}`);
    }
    // Phase 2 (JSON-removal): reject every non-`.md` source before computing a
    // destination or touching the vault, so legacy JSON bytes can never be
    // relabeled as Markdown.
    if (!normalizedOld.toLowerCase().endsWith('.md')) {
      throw new Error(this.t('snippetService.invalidName'));
    }
    if (/[\\/]/.test(newBasename) || newBasename.trim() === '') {
      throw new Error(this.t('snippetService.invalidName'));
    }
    const lastSlash = normalizedOld.lastIndexOf('/');
    const parent = lastSlash > 0 ? normalizedOld.slice(0, lastSlash) : '';
    const ext = '.md';
    const newPath = parent === '' ? `${newBasename}${ext}` : `${parent}/${newBasename}${ext}`;
    const normalizedNew = this.assertInsideRoot(newPath);
    if (normalizedNew === null) {
      throw new Error(`[Protocol Former] renameSnippet rejected unsafe new path: ${newPath}`);
    }
    return this.relocateSnippet(normalizedOld, normalizedNew);
  }

  /**
   * Phase 34 (MOVE-01): Move a snippet file into another folder under the
   * snippet root, preserving its basename + extension. Ensures the destination
   * folder exists before the rename. Collision-checks destination.
   */
  async moveSnippet(oldPath: string, newFolder: string): Promise<string> {
    const normalizedOld = this.assertInsideRoot(oldPath);
    if (normalizedOld === null) {
      throw new Error(`[Protocol Former] moveSnippet rejected unsafe path: ${oldPath}`);
    }
    const normalizedFolder = this.assertInsideRoot(newFolder);
    if (normalizedFolder === null) {
      throw new Error(`[Protocol Former] moveSnippet rejected unsafe destination: ${newFolder}`);
    }
    const basename = normalizedOld.slice(normalizedOld.lastIndexOf('/') + 1);
    const normalizedNew =
      normalizedFolder === '' ? basename : `${normalizedFolder}/${basename}`;
    return this.relocateSnippet(normalizedOld, normalizedNew);
  }

  /** One relocation for simultaneous folder and basename changes; no intermediate identity. */
  async relocateSnippet(oldPath: string, newPath: string): Promise<string> {
    const normalizedOld = this.assertInsideRoot(oldPath);
    const normalizedNew = this.assertInsideRoot(newPath);
    if (normalizedOld === null || normalizedNew === null) {
      throw new Error('[Protocol Former] relocateSnippet rejected unsafe path');
    }
    if (!normalizedOld.toLowerCase().endsWith('.md') || !normalizedNew.endsWith('.md')) {
      throw new Error(this.t('snippetService.invalidName'));
    }
    if (normalizedOld === normalizedNew) return normalizedNew;
    return this.changePath(normalizedOld, normalizedNew, async () => {
      if (await this.app.vault.adapter.exists(normalizedNew)) {
        throw new Error(this.t('snippetService.pathExists', { path: normalizedNew }));
      }
      await this.mutex.runExclusive(normalizedOld, async () => {
        const file = this.app.vault.getAbstractFileByPath(normalizedOld);
        if (file === null) throw new Error(this.t('snippetService.fileNotFound', { path: normalizedOld }));
        await ensureFolderPath(this.app.vault, normalizedNew.slice(0, normalizedNew.lastIndexOf('/')));
        await this.app.vault.rename(file, normalizedNew);
      });
    });
  }

  /**
   * Phase 34 (RENAME-03): Rename a folder in place (within the same parent).
   * Rejects basenames with slashes. Collision-checks destination.
   */
  async renameFolder(oldPath: string, newBasename: string): Promise<string> {
    const normalizedOld = this.assertInsideRoot(oldPath);
    if (normalizedOld === null || normalizedOld === this.settings.snippetFolderPath) {
      throw new Error(`[Protocol Former] renameFolder rejected unsafe path: ${oldPath}`);
    }
    if (/[\\/]/.test(newBasename) || newBasename.trim() === '') {
      throw new Error(this.t('snippetService.invalidName'));
    }
    const lastSlash = normalizedOld.lastIndexOf('/');
    const parent = lastSlash > 0 ? normalizedOld.slice(0, lastSlash) : '';
    const newPath = parent === '' ? newBasename : `${parent}/${newBasename}`;
    const normalizedNew = this.assertInsideRoot(newPath);
    if (normalizedNew === null) {
      throw new Error(`[Protocol Former] renameFolder rejected unsafe new path: ${newPath}`);
    }
    if (normalizedOld === normalizedNew) return normalizedNew;
    // Self-descendant guard: renaming into own subtree is nonsensical but
    // guard defensively (e.g. parent == '' edge cases).
    if (
      normalizedNew === normalizedOld ||
      normalizedNew.startsWith(normalizedOld + '/')
    ) {
      throw new Error(this.t('snippetService.cannotMoveIntoSelf'));
    }
    return this.changePath(normalizedOld, normalizedNew, async () => {
      if (await this.app.vault.adapter.exists(normalizedNew)) {
        throw new Error(this.t('snippetService.pathExists', { path: normalizedNew }));
      }
      await this.mutex.runExclusive(normalizedOld, async () => {
        const folder = this.app.vault.getAbstractFileByPath(normalizedOld);
        if (folder === null) throw new Error(this.t('snippetService.folderNotFound', { path: normalizedOld }));
        await this.app.vault.rename(folder, normalizedNew);
      });
    });
  }

  /**
   * Phase 34 (MOVE-02): Move a folder into another parent folder under the
   * snippet root. Guards against moving a folder into itself or into any of
   * its descendants. Ensures the new parent exists. Collision-checks destination.
   */
  async moveFolder(oldPath: string, newParent: string): Promise<string> {
    const normalizedOld = this.assertInsideRoot(oldPath);
    if (normalizedOld === null || normalizedOld === this.settings.snippetFolderPath) {
      throw new Error(`[Protocol Former] moveFolder rejected unsafe path: ${oldPath}`);
    }
    const normalizedParent = this.assertInsideRoot(newParent);
    if (normalizedParent === null) {
      throw new Error(`[Protocol Former] moveFolder rejected unsafe destination: ${newParent}`);
    }
    const basename = normalizedOld.slice(normalizedOld.lastIndexOf('/') + 1);
    const normalizedNew =
      normalizedParent === '' ? basename : `${normalizedParent}/${basename}`;
    // Self-descendant guard: reject move onto self OR into any descendant.
    // Also reject when the target parent IS the source or inside the source
    // subtree, since the resulting path would be nested under itself.
    if (
      normalizedParent === normalizedOld ||
      normalizedParent.startsWith(normalizedOld + '/') ||
      normalizedNew === normalizedOld ||
      normalizedNew.startsWith(normalizedOld + '/')
    ) {
      throw new Error(this.t('snippetService.cannotMoveIntoSelf'));
    }
    return this.changePath(normalizedOld, normalizedNew, async () => {
      if (await this.app.vault.adapter.exists(normalizedNew)) {
        throw new Error(this.t('snippetService.pathExists', { path: normalizedNew }));
      }
      await this.mutex.runExclusive(normalizedOld, async () => {
        await ensureFolderPath(this.app.vault, normalizedParent);
        const folder = this.app.vault.getAbstractFileByPath(normalizedOld);
        if (folder === null) throw new Error(this.t('snippetService.folderNotFound', { path: normalizedOld }));
        await this.app.vault.rename(folder, normalizedNew);
      });
    });
  }

  /** All entry points await relocation and best-effort reference repair together. */
  private async changePath(oldPath: string, newPath: string, relocate: () => Promise<void>): Promise<string> {
    let lock = pathChangeLocks.get(this.app.vault);
    if (!lock) {
      lock = new WriteMutex();
      pathChangeLocks.set(this.app.vault, lock);
    }
    const root = this.settings.snippetFolderPath;
    return lock.runExclusive(root, async () => {
      const prefix = root + '/';
      await relocate();
      const mapping = new Map([[oldPath.slice(prefix.length), newPath.slice(prefix.length)]]);
      let result: ProtocolSyncResult;
      try {
        result = await rewriteProtocolSnippetRefs(this.app, mapping);
      } catch (error) {
        result = { updated: [], skipped: [{ path: oldPath, reason: String(error) }] };
      }
      // Reporting must never turn a completed rename into an apparent failure.
      try { this.onReferenceSync(result); } catch (error) {
        console.error('[Protocol Former] Reference sync reporting failed', error);
      }
      return newPath;
    });
  }

  /**
   * Phase 34 (D-06): Return the sorted list of every folder under the snippet
   * root, including the root itself. Used by SnippetEditorModal's folder field
   * and SnippetTreePicker. Delegates to listFolderDescendants.
   */
  async listAllFolders(): Promise<string[]> {
    const root = this.settings.snippetFolderPath;
    const { folders } = await this.listFolderDescendants(root);
    const set = new Set<string>([root, ...folders]);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }

  /**
   * Phase 2 (JSON-removal): Discriminated result of resolving a runner snippet
   * reference. `found` carries a loaded Markdown snippet; `legacy-json` reports
   * a `.json` file matched on disk (no longer supported); `missing` means no
   * `.md`/`.json` match exists. The view switches on `status` and delegates
   * presentation to `render-snippet-fill.ts`.
   */
  async resolveSnippet(snippetId: string): Promise<SnippetResolution> {
    const root = this.settings.snippetFolderPath;
    const normalizedRoot = this.assertInsideRoot(root);
    if (normalizedRoot === null) return { status: 'missing' };

    const isFullPath = snippetId.includes('/') || snippetId.endsWith('.md') || snippetId.endsWith('.json');

    // Direct full-path reference: probe `${root}/${id}` when id is relative,
    // or the id itself when it is already anchored under the snippet root.
    if (isFullPath) {
      const candidate = snippetId.startsWith(normalizedRoot + '/')
        ? snippetId
        : `${normalizedRoot}/${snippetId}`;
      const safe = this.assertInsideRoot(candidate);
      if (safe === null) return { status: 'missing' };
      const exists = await this.app.vault.adapter.exists(safe);
      if (exists) {
        if (safe.toLowerCase().endsWith('.json')) {
          return { status: 'legacy-json', path: safe };
        }
        const snippet = await this.load(safe);
        if (snippet !== null) return { status: 'found', snippet };
      }
      return { status: 'missing' };
    }

    // Extensionless id: probe the snippet root for `${id}.md` then `${id}.json`.
    const mdCandidate = this.assertInsideRoot(`${normalizedRoot}/${snippetId}.md`);
    if (mdCandidate !== null) {
      if (await this.app.vault.adapter.exists(mdCandidate)) {
        const snippet = await this.load(mdCandidate);
        if (snippet !== null) return { status: 'found', snippet };
      }
    }
    const jsonCandidate = this.assertInsideRoot(`${normalizedRoot}/${snippetId}.json`);
    if (jsonCandidate !== null) {
      if (await this.app.vault.adapter.exists(jsonCandidate)) {
        return { status: 'legacy-json', path: jsonCandidate };
      }
    }

    // Fallback: unique-subdirectory scan via vault.getFiles() scoped to the
    // snippet root. Try `.md` first, then `.json`.
    const mdMatch = await this.findUniqueSubdirMatch(snippetId, '.md');
    if (mdMatch !== null) {
      const snippet = await this.load(mdMatch);
      if (snippet !== null) return { status: 'found', snippet };
    }
    const jsonMatch = await this.findUniqueSubdirMatch(snippetId, '.json');
    if (jsonMatch !== null) {
      return { status: 'legacy-json', path: jsonMatch };
    }

    return { status: 'missing' };
  }

  /**
   * Phase 2 (JSON-removal): scan vault files under the snippet root for a
   * basename of `${snippetId}${ext}`. Returns the unique matching path when
   * exactly one candidate exists, otherwise null. Every considered path is
   * re-checked through `assertInsideRoot` so traversal-escaping ids never reach
   * the vault adapter.
   */
  private async findUniqueSubdirMatch(snippetId: string, ext: string): Promise<string | null> {
    const root = this.settings.snippetFolderPath;
    const targetBasename = `${snippetId}${ext}`;
    const candidates = this.app.vault.getFiles().filter((f) => {
      if (!f.path.startsWith(root + '/')) return false;
      const parts = f.path.split('/');
      return parts[parts.length - 1] === targetBasename;
    });
    if (candidates.length !== 1) return null;
    const safe = this.assertInsideRoot(candidates[0]!.path);
    return safe;
  }
}
