// views/snippet-manager-view.ts
// Phase 33 Plan 04 (TREE-01..04, FOLDER-01..03, SYNC-01..03, DEL-02/03, MODAL-04):
// Recursive folder-tree view for the snippet library. Replaces the legacy
// master-detail layout. All create/edit flows route through SnippetEditorModal;
// all destructive actions route through ConfirmModal. Vault watchers provide a
// 120ms-debounced redraw when files change under settings.snippetFolderPath
// (D-18 prefix filter). The chip editor extracted in Plan 02 is reached via
// the modal, not directly.
import { ItemView, Modal, Notice, WorkspaceLeaf, type EventRef } from 'obsidian';
import type RadiProtocolPlugin from '../main';
import type { Snippet } from '../snippets/snippet-model';
import type { SnippetSearchResult } from '../snippets/snippet-service';
import { SnippetEditorModal } from './snippet-editor-modal';
import { ConfirmModal } from './confirm-modal';
import { SnippetTreePicker } from './snippet-tree-picker';
import { SnippetManagerTreeRenderer } from './snippet-manager/tree-renderer';
import type { TreeNode, TreeNodeFolder, TreeNodeFile } from './snippet-manager/tree-renderer';
import { basenameNoExt } from './snippet-manager/tree-renderer';
// Slice 8 — library-managed snippets render read-only with an installed-package
// indicator. this.plugin.libraryService is wired in Slice 9 (forward reference,
// consistent with Slices 6-7).
import { isLibraryManagedPath } from '../library/library-paths';
import type { InstalledRecord } from '../library/library-model';

export const SNIPPET_MANAGER_VIEW_TYPE = 'radiprotocol-snippet-manager';

interface SnippetManagerModel {
  folderTree: TreeNodeFolder;
  snippets: TreeNodeFile[];
  selectedFolderPath: string;
  searchResults: SnippetSearchResult[];
  installedRecords: InstalledRecord[];
}

function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i > 0 ? path.slice(0, i) : '';
}

// ---------------------------------------------------------------------------
// SnippetManagerView
// ---------------------------------------------------------------------------
export class SnippetManagerView extends ItemView {
  private plugin: RadiProtocolPlugin;

  // DOM refs rebuilt on every render
  private folderRootEl!: HTMLElement;
  private snippetRootEl!: HTMLElement;

  // Tree model cache — folders-only left pane + flat snippet list for the
  // currently selected folder (right pane).
  private folderTreeData!: TreeNodeFolder;
  private snippetData: TreeNodeFile[] = [];

  // View-local selected folder. Resets to snippetFolderPath on every onOpen()
  // and is never persisted (discover decision: always start at root).
  // `selectedFolderPath` is the committed visible selection (only assigned
  // under the generation guard via commitModel); `requestedFolderPath` tracks
  // the latest requested target so a watcher refresh during navigation does
  // not supersede it.
  private selectedFolderPath: string;
  private requestedFolderPath: string;

  // Slice 8 — installed records for the library-managed read-only indicator.
  private installedRecords: InstalledRecord[] = [];

  // One invalidation generation owned by this view. Navigation, search,
  // mutations, and watcher refreshes increment it; post-await commits require
  // both `mounted` and generation equality so stale work is rejected.
  private searchGeneration = 0;
  private mounted = false;

  // Always-visible global search state. `searchQuery`/`searchResults` are
  // transient and discarded on close; `searchTimer` debounces input at 120ms.
  private searchWrapEl!: HTMLElement;
  private searchQuery = '';
  private searchTimer: number | null = null;
  private searchResults: SnippetSearchResult[] = [];

  // Track which file path (if any) is currently being edited in a modal, so
  // renderTree can highlight the row (data-editing=true). Cleared on close.
  private currentlyEditingPath: string | null = null;

  // Phase 82 SPLIT-01 — tree rendering + DnD + inline rename extracted to
  // SnippetManagerTreeRenderer.
  private treeRenderer!: SnippetManagerTreeRenderer;

  // Debounced redraw timer id (window.setTimeout handle).
  private redrawTimer: number | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: RadiProtocolPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.selectedFolderPath = plugin.settings.snippetFolderPath;
    this.requestedFolderPath = plugin.settings.snippetFolderPath;
  }

  getViewType(): string { return SNIPPET_MANAGER_VIEW_TYPE; }
  getDisplayText(): string { return 'Snippet manager'; }
  getIcon(): string { return 'scissors'; }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------
  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('radi-snippet-tree-root');
    this.selectedFolderPath = this.plugin.settings.snippetFolderPath;
    this.requestedFolderPath = this.selectedFolderPath;
    this.mounted = true;

    this.searchWrapEl = contentEl.createDiv({ cls: 'radi-snippet-manager-search' });
    const searchInput = this.searchWrapEl.createEl('input', {
      cls: 'radi-snippet-manager-search-input',
      attr: { type: 'text', 'aria-label': this.plugin.i18n.t('snippetManager.searchPlaceholder') },
    });
    searchInput.placeholder = this.plugin.i18n.t('snippetManager.searchPlaceholder');
    this.registerDomEvent(searchInput, 'input', () => this.onSearchInput(searchInput.value));

    const layout = contentEl.createDiv({ cls: 'radi-snippet-manager-layout' });
    this.folderRootEl = layout.createDiv({ cls: 'radi-snippet-manager-folders' });
    this.folderRootEl.setAttr('role', 'tree');
    this.snippetRootEl = layout.createDiv({ cls: 'radi-snippet-manager-snippets' });
    this.snippetRootEl.setAttr('role', 'list');

    this.treeRenderer = new SnippetManagerTreeRenderer({
      folderContainer: this.folderRootEl,
      snippetContainer: this.snippetRootEl,
      plugin: this.plugin,
      callbacks: {
        selectFolder: (path) => this.selectFolder(path),
        toggleFolder: (path) => this.toggleFolder(path),
        openEditModal: (path) => this.openEditModal(path),
        openCreateModal: (folderPath) => this.openCreateModal(folderPath),
        handleCreateSubfolder: (path) => this.handleCreateSubfolder(path),
        handleDeleteSnippet: (path, name) => this.handleDeleteSnippet(path, name),
        handleDeleteFolder: (path, name) => this.handleDeleteFolder(path, name),
        openMovePicker: (node) => this.openMovePicker(node),
        duplicateSnippet: (path) => this.duplicateSnippet(path),
        performMove: (srcPath, srcKind, dstFolder) => this.performMove(srcPath, srcKind, dstFolder),
        refresh: async () => {
          await this.refresh();
        },
        completeFolderRename: (oldPath, newPath) =>
          this.completeFolderRename(oldPath, newPath),
      },
    });

    this.registerDomEvent(layout, 'contextmenu', (event) => {
      event.preventDefault();
      this.treeRenderer.openRootContextMenu(event as MouseEvent);
    });

    await this.refresh();
    if (!this.mounted) return;

    // Vault watchers (SYNC-01..03 + D-18)
    this.registerEvent(
      this.app.vault.on('create', (file) => {
        if (this.shouldHandle(file.path)) this.scheduleRedraw();
      }) as EventRef,
    );
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (this.shouldHandle(file.path)) this.scheduleRedraw();
      }) as EventRef,
    );
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (this.shouldHandle(file.path) || this.shouldHandle(oldPath)) this.scheduleRedraw();
      }) as EventRef,
    );
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (this.shouldHandle(file.path)) this.scheduleRedraw();
      }) as EventRef,
    );
  }

  async onClose(): Promise<void> {
    this.mounted = false;
    this.searchGeneration++;
    this.searchQuery = '';
    this.searchResults = [];
    if (this.redrawTimer !== null) { window.clearTimeout(this.redrawTimer); this.redrawTimer = null; }
    if (this.searchTimer !== null) { window.clearTimeout(this.searchTimer); this.searchTimer = null; }
    this.contentEl.empty();
    // Vault event refs auto-detach via registerEvent; nothing else to release.
  }

  // -------------------------------------------------------------------------
  // Vault watcher — D-18 prefix filter + 120ms debounce
  // -------------------------------------------------------------------------
  private shouldHandle(filePath: string): boolean {
    const root = this.plugin.settings.snippetFolderPath;
    return filePath === root || filePath.startsWith(root + '/');
  }

  /** Slice 8 — true when the path lives under the managed library subtree of the
   *  snippet folder. Used by the defense-in-depth guards at the top of every
   *  mutating callback (the renderer already suppresses; this view is the backstop). */
  private isLibraryManagedSnippetPath(path: string): boolean {
    return isLibraryManagedPath(path, this.plugin.settings.snippetFolderPath);
  }

  private scheduleRedraw(): void {
    if (this.redrawTimer !== null) window.clearTimeout(this.redrawTimer);
    this.redrawTimer = window.setTimeout(() => {
      this.redrawTimer = null;
      void this.refresh();
    }, 120);
  }

  // -------------------------------------------------------------------------
  // Global search — debounced input + generation/lifecycle-guarded refresh
  // -------------------------------------------------------------------------
  private onSearchInput(value: string): void {
    this.searchQuery = value;
    this.searchGeneration++;
    if (this.searchTimer !== null) window.clearTimeout(this.searchTimer);
    this.searchTimer = window.setTimeout(() => {
      this.searchTimer = null;
      void this.refresh();
    }, 120) as unknown as number;
  }

  private async refresh(
    selectedFolderPath: string = this.requestedFolderPath,
  ): Promise<boolean> {
    if (!this.mounted) return false;
    this.requestedFolderPath = selectedFolderPath;
    const query = this.searchQuery.trim();
    const generation = ++this.searchGeneration;
    this.searchWrapEl.addClass('is-scanning');
    try {
      const nextModel = await this.loadModel(selectedFolderPath, query);
      if (!this.ownsRefresh(generation)) return false;
      await this.pruneStaleExpandedPaths(nextModel.folderTree);
      if (!this.ownsRefresh(generation)) return false;
      this.commitModel(nextModel);
      this.renderTree();
      return true;
    } catch (e) {
      if (!this.ownsRefresh(generation)) return false;
      new Notice(this.plugin.i18n.t('snippetManager.redrawError'));
      console.error('[Protocol Former] snippet manager refresh failed', e);
      return false;
    } finally {
      if (this.ownsRefresh(generation)) this.searchWrapEl.removeClass('is-scanning');
    }
  }

  private ownsRefresh(generation: number): boolean {
    return this.mounted && generation === this.searchGeneration;
  }

  private async loadModel(
    selectedFolderPath: string,
    query: string,
  ): Promise<SnippetManagerModel> {
    const folderTree = await this.loadFolderTree();
    const reconciledFolderPath = this.resolveSelectedFolder(folderTree, selectedFolderPath);
    const snippets = await this.loadSnippetData(reconciledFolderPath);
    const searchResults = query === ''
      ? []
      : await this.plugin.snippetService.searchSnippets(query);
    // Slice 8 — fetch installed records best-effort as part of the model so a
    // stale refresh cannot overwrite them independently of the generation guard.
    let installedRecords: InstalledRecord[] = [];
    try { installedRecords = await this.plugin.libraryService.listInstalled(); }
    catch { installedRecords = []; }
    return { folderTree, snippets, selectedFolderPath: reconciledFolderPath, searchResults, installedRecords };
  }

  private commitModel(model: SnippetManagerModel): void {
    this.folderTreeData = model.folderTree;
    this.snippetData = model.snippets;
    this.selectedFolderPath = model.selectedFolderPath;
    this.requestedFolderPath = model.selectedFolderPath;
    this.searchResults = model.searchResults;
    this.installedRecords = model.installedRecords;
  }

  private async loadFolderTree(): Promise<TreeNodeFolder> {
    const root = this.plugin.settings.snippetFolderPath;
    return {
      kind: 'folder',
      path: root,
      name: root.slice(root.lastIndexOf('/') + 1) || root,
      isRoot: true,
      children: await this.buildFolderChildren(root),
    };
  }

  // -------------------------------------------------------------------------
  // Tree model build (folders-only left pane + selected folder's snippets)
  // -------------------------------------------------------------------------
  private async buildFolderChildren(folderPath: string): Promise<TreeNodeFolder[]> {
    let listing: { folders: string[]; snippets: Snippet[] };
    try {
      listing = await this.plugin.snippetService.listFolder(folderPath);
    } catch {
      return [];
    }
    const folders: TreeNodeFolder[] = [];
    for (const name of listing.folders) {
      const path = `${folderPath}/${name}`;
      folders.push({
        kind: 'folder',
        path,
        name,
        isRoot: false,
        children: await this.buildFolderChildren(path),
      });
    }
    return folders.sort((a, b) => a.name.localeCompare(b.name));
  }

  private async loadSnippetData(folderPath: string): Promise<TreeNodeFile[]> {
    let snippets: Snippet[] = [];
    try {
      snippets = (await this.plugin.snippetService.listFolder(folderPath)).snippets;
    } catch {
      // Keep the selected folder navigable and render an empty right pane.
    }
    return snippets
      .map((snippet) => ({
        kind: 'file' as const,
        path: snippet.path,
        name: snippet.name || basenameNoExt(snippet.path),
        snippetKind: snippet.kind,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private async selectFolder(path: string): Promise<void> {
    await this.refresh(path);
  }

  private async toggleFolder(path: string): Promise<void> {
    const generation = this.searchGeneration;
    const list = this.plugin.settings.snippetTreeExpandedPaths;
    const index = list.indexOf(path);
    if (index >= 0) list.splice(index, 1);
    else list.push(path);
    await this.plugin.saveSettings();
    if (!this.ownsRefresh(generation)) return;
    this.renderTree();
  }

  private resolveSelectedFolder(folderTree: TreeNodeFolder, selectedFolderPath: string): string {
    const root = this.plugin.settings.snippetFolderPath;
    const findFolder = (node: TreeNodeFolder, target: string): boolean => {
      if (node.path === target) return true;
      return node.children.some((child) => findFolder(child, target));
    };
    let path = selectedFolderPath;
    while (path !== root && !findFolder(folderTree, path)) {
      const slash = path.lastIndexOf('/');
      if (slash <= root.length) return root;
      path = path.slice(0, slash);
    }
    return path;
  }

  private async pruneStaleExpandedPaths(
    folderTree: TreeNodeFolder = this.folderTreeData,
  ): Promise<void> {
    const expanded = this.plugin.settings.snippetTreeExpandedPaths;
    if (expanded.length === 0) return;
    const valid = new Set<string>();
    const collect = (node: TreeNodeFolder): void => {
      valid.add(node.path);
      for (const child of node.children) collect(child);
    };
    collect(folderTree);
    let mutated = false;
    for (let i = expanded.length - 1; i >= 0; i--) {
      if (!valid.has(expanded[i]!)) {
        expanded.splice(i, 1);
        mutated = true;
      }
    }
    if (mutated) await this.plugin.saveSettings();
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  private renderTree(): void {
    this.treeRenderer.setCurrentlyEditingPath(this.currentlyEditingPath);
    this.treeRenderer.render({
      folderTree: this.folderTreeData,
      snippets: this.snippetData,
      selectedFolderPath: this.selectedFolderPath,
      searchResults: this.searchQuery.trim() === '' ? undefined : this.searchResults,
      searchQuery: this.searchQuery,
      installedRecords: this.installedRecords,
    });
  }

  // -------------------------------------------------------------------------
  // Modal wiring — create / edit snippet
  // -------------------------------------------------------------------------
  private async openEditModal(path: string): Promise<void> {
    if (this.isLibraryManagedSnippetPath(path)) { new Notice(this.plugin.i18n.t('library.readOnlyNotice')); return; }
    // Capture ownership before the async load: a close or superseding refresh
    // during the read must not let a stale completion render, mutate edit
    // state, emit a notice, or open a modal into a detached pane.
    const generation = this.searchGeneration;
    const snippet = await this.plugin.snippetService.load(path);
    if (!this.ownsRefresh(generation)) return;
    if (snippet === null) {
      new Notice(this.plugin.i18n.t('snippetManager.notFound'));
      await this.refresh();
      return;
    }
    this.currentlyEditingPath = path;
    this.renderTree();
    const modal = new SnippetEditorModal(this.app, this.plugin, {
      mode: 'edit',
      initialFolder: dirname(path),
      snippet,
    });
    modal.open();
    const result = await modal.result;
    this.currentlyEditingPath = null;
    if (result.saved) {
      await this.refresh();
    } else if (this.mounted) {
      // Clear the editing highlight even if a watcher refresh superseded the
      // initiating generation while the modal was open; renderTree() is a
      // synchronous DOM update of current model state, not a model commit.
      this.renderTree();
    }
  }

  private async openCreateModal(folderPath: string): Promise<void> {
    if (this.isLibraryManagedSnippetPath(folderPath)) { new Notice(this.plugin.i18n.t('library.readOnlyNotice')); return; }
    const modal = new SnippetEditorModal(this.app, this.plugin, {
      mode: 'create',
      initialFolder: folderPath,
    });
    modal.open();
    const result = await modal.result;
    if (result.saved) await this.refresh();
  }

  // -------------------------------------------------------------------------
  // Duplicate — reached from the file-row context menu. The renderer only
  // invokes the callback; this view owns the service call, localized failure
  // notice, and the generation-guarded refresh so the selected-folder / active
  // search model reloads after success.
  // -------------------------------------------------------------------------
  private async duplicateSnippet(path: string): Promise<void> {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    if (this.isLibraryManagedSnippetPath(path)) { new Notice(this.plugin.i18n.t('library.readOnlyNotice')); return; }
    try {
      await this.plugin.snippetService.duplicateSnippet(path);
      await this.refresh();
    } catch (e) {
      const error = (e as Error)?.message ?? t('snippetManager.unknownError');
      new Notice(t('snippetEditor.duplicateError', { error }));
      console.error('[Protocol Former] duplicate snippet failed', e);
    }
  }

  // -------------------------------------------------------------------------
  // Folder operations
  // -------------------------------------------------------------------------
  private async handleCreateSubfolder(parentPath: string): Promise<void> {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    if (this.isLibraryManagedSnippetPath(parentPath)) { new Notice(this.plugin.i18n.t('library.readOnlyNotice')); return; }
    // Build a small form body with a text input for the subfolder name.
    const body = document.createElement('div');
    body.addClass('radi-snippet-subfolder-form');
    const label = body.createEl('label', { text: t('snippetManager.subfolderNameLabel') });
    const input = body.createEl('input', { type: 'text' });
    input.placeholder = t('snippetManager.subfolderNamePlaceholder');
    label.appendChild(input);

    const modal = new ConfirmModal(this.app, {
      title: t('snippetManager.createSubfolderTitle'),
      body,
      confirmLabel: t('snippetManager.createSubfolderConfirm'),
      cancelLabel: t('snippetManager.cancel'),
      destructive: false,
    });
    modal.open();
    // Focus the input after the modal opens
    setTimeout(() => { try { input.focus(); } catch { /* noop */ } }, 0);
    const result = await modal.result;
    if (result !== 'confirm') return;

    const trimmed = (input.value || '').trim();
    if (trimmed === '') {
      new Notice(t('snippetManager.subfolderEmptyName'));
      return;
    }
    if (/[\\/]/.test(trimmed) || trimmed === '..' || trimmed === '.') {
      new Notice(t('snippetManager.subfolderInvalidName'));
      return;
    }
    const newPath = parentPath + '/' + trimmed;
    try {
      await this.plugin.snippetService.createFolder(newPath);
      // Expand both parent and new subfolder so the user can see the result
      const expanded = this.plugin.settings.snippetTreeExpandedPaths;
      if (!expanded.includes(parentPath)) expanded.push(parentPath);
      if (!expanded.includes(newPath)) expanded.push(newPath);
      await this.plugin.saveSettings();
      await this.refresh();
    } catch (e) {
      const error = (e as Error)?.message ?? t('snippetManager.unknownError');
      new Notice(t('snippetManager.createFolderError', { error }));
    }
  }

  private async handleDeleteSnippet(path: string, name: string): Promise<void> {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    if (this.isLibraryManagedSnippetPath(path)) { new Notice(this.plugin.i18n.t('library.readOnlyNotice')); return; }
    const modal = new ConfirmModal(this.app, {
      title: t('snippetManager.deleteSnippetTitle'),
      body: t('snippetManager.deleteSnippetBody', { name }),
      confirmLabel: t('snippetManager.deleteConfirm'),
      cancelLabel: t('snippetManager.cancel'),
      destructive: true,
    });
    modal.open();
    const result = await modal.result;
    if (result !== 'confirm') return;
    try {
      await this.plugin.snippetService.delete(path);
      new Notice(t('snippetManager.deletedNotice'));
      await this.refresh();
    } catch (e) {
      const error = (e as Error)?.message ?? t('snippetManager.unknownError');
      new Notice(t('snippetManager.deleteError', { error }));
    }
  }

  private async handleDeleteFolder(path: string, name: string): Promise<void> {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    if (this.isLibraryManagedSnippetPath(path)) { new Notice(this.plugin.i18n.t('library.readOnlyNotice')); return; }
    const descendants = await this.plugin.snippetService.listFolderDescendants(path);
    const total = descendants.total;

    const body = document.createElement('div');
    body.addClass('radi-snippet-folder-delete-body');
    const intro = body.createEl('p');
    intro.setText(
      total === 0
        ? t('snippetManager.emptyFolderBody')
        : t('snippetManager.folderItemsBody', { count: String(total) }),
    );
    if (total > 0) {
      const allPaths = [...descendants.files, ...descendants.folders];
      const shown = allPaths.slice(0, 10);
      const list = body.createEl('ul');
      const rootPrefix = path + '/';
      for (const p of shown) {
        const rel = p.startsWith(rootPrefix) ? p.slice(rootPrefix.length) : p;
        const li = list.createEl('li');
        li.createEl('code', { text: rel });
      }
      if (total > 10) {
        const more = body.createEl('p', { cls: 'radi-muted' });
        more.setText(t('snippetManager.moreItems', { count: String(total - 10) }));
      }
    }

    const modal = new ConfirmModal(this.app, {
      title: t('snippetManager.deleteFolderTitle', { name }),
      body,
      confirmLabel: t('snippetManager.deleteFolderConfirm'),
      cancelLabel: t('snippetManager.cancel'),
      destructive: true,
    });
    modal.open();
    const result = await modal.result;
    if (result !== 'confirm') return;
    try {
      await this.plugin.snippetService.deleteFolder(path);
      new Notice(t('snippetManager.folderDeletedNotice'));
      await this.refresh();
    } catch (e) {
      const error = (e as Error)?.message ?? t('snippetManager.unknownError');
      new Notice(t('snippetManager.deleteFolderError', { error }));
    }
  }

  // -------------------------------------------------------------------------
  // Phase 34 Plan 01 — move-to flow
  // -------------------------------------------------------------------------
  private async openMovePicker(node: TreeNode): Promise<void> {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    if (this.isLibraryManagedSnippetPath(node.path)) { new Notice(this.plugin.i18n.t('library.readOnlyNotice')); return; }
    let allFolders: string[];
    try {
      allFolders = await this.plugin.snippetService.listAllFolders();
    } catch (e) {
      const error = (e as Error)?.message ?? t('snippetManager.unknownError');
      new Notice(t('snippetManager.listFoldersError', { error }));
      console.error('[Protocol Former] openMovePicker listAllFolders failed', e);
      return;
    }

    // Build allowed-destination list.
    let folders: string[];
    if (node.kind === 'file') {
      // For files: all folders are valid destinations except the current parent
      // (no-op move). Still keep the current parent filtered so the UI is clean.
      const currentParent = dirname(node.path);
      folders = allFolders.filter((f) => f !== currentParent);
    } else {
      // For folders: exclude the folder itself AND all descendants (self-nest).
      const src = node.path;
      const prefix = src + '/';
      folders = allFolders.filter((f) => f !== src && !f.startsWith(prefix));
    }

    const onChoose = async (chosen: string): Promise<void> => {
      try {
        await this.performMove(node.path, node.kind, chosen);
      } catch (e) {
        const error = (e as Error)?.message ?? t('snippetManager.unknownError');
        new Notice(t('snippetManager.moveError', { error }));
        console.error('[Protocol Former] openMovePicker move failed', e);
      }
    };

    // Phase 51 D-07 (PICKER-02) — inline Modal hosting a folder-only SnippetTreePicker
    // replaces the legacy flat-list picker.
    // Host wrapper class `rp-stp-modal-host` is defined in src/styles/snippet-tree-picker.css
    // (owned by Plan 02). This plan does NOT modify CSS.
    // See `docs/ARCHITECTURE-NOTES.md#snippet-node-binding-and-picker`.
    const rootPath = this.plugin.settings.snippetFolderPath;
    // `folders` is the whitelist of valid move destinations (verified at
    // snippet-manager-view.ts:642-654). Membership check: target is valid iff included
    // in the `folders` whitelist.
    const allowedSet = new Set(folders);

    const modal = new Modal(this.app);
    modal.setTitle(t('snippetManager.moveTitle'));
    let pickerInstance: SnippetTreePicker | null = null;

    const handleSelect = async (result: { kind: 'folder' | 'file'; relativePath: string }): Promise<void> => {
      const absPath = result.relativePath === '' ? rootPath : `${rootPath}/${result.relativePath}`;
      // Move-target safety guard (D-07): block source-self and source-descendant targets.
      if (absPath === node.path && node.kind === 'folder') {
        new Notice(t('snippetManager.moveSelfError'));
        return;
      }
      if (node.kind === 'folder' && absPath.startsWith(node.path + '/')) {
        new Notice(t('snippetManager.moveSelfDescendantError'));
        return;
      }
      // Whitelist membership: target must be in the allow-list of valid destinations.
      if (!allowedSet.has(absPath)) {
        new Notice(t('snippetManager.invalidTargetError'));
        return;
      }
      modal.close();
      await onChoose(absPath);
    };

    modal.onOpen = () => {
      const host = modal.contentEl.createDiv({ cls: 'rp-stp-modal-host' });
      pickerInstance = new SnippetTreePicker({
        app: this.app,
        snippetService: this.plugin.snippetService,
        container: host,
        mode: 'folder-only',
        rootPath,
        onSelect: (result) => { void handleSelect(result); },
        t,
      });
      void pickerInstance.mount();
    };
    modal.onClose = () => {
      if (pickerInstance !== null) {
        pickerInstance.unmount();
        pickerInstance = null;
      }
    };
    modal.open();
  }

  // -------------------------------------------------------------------------
  // Phase 34 Plan 02 — shared move orchestrator. Used by both context-menu
  // move-to (Plan 01) and DnD drop handler (Plan 02). Throws on
  // failure; callers are responsible for Notice/console.error on rejection.
  // -------------------------------------------------------------------------
  private async performMove(
    srcPath: string,
    srcKind: 'file' | 'folder',
    dstFolder: string,
  ): Promise<void> {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    if (this.isLibraryManagedSnippetPath(srcPath) || this.isLibraryManagedSnippetPath(dstFolder)) {
      new Notice(t('library.readOnlyNotice'));
      return;
    }
    if (srcKind === 'file') {
      if (dirname(srcPath) === dstFolder) return;
      await this.plugin.snippetService.moveSnippet(srcPath, dstFolder);
      await this.refresh();
      new Notice(t('snippetManager.pathChangedNotice'));
      return;
    }
    if (srcPath === dstFolder || dstFolder.startsWith(`${srcPath}/`)) {
      throw new Error(t('snippetManager.cannotMoveIntoSelf'));
    }
    const newPath = await this.plugin.snippetService.moveFolder(srcPath, dstFolder);
    await this.refreshAfterFolderPathChange(srcPath, newPath);
    new Notice(t('snippetManager.pathChangedNotice'));
  }

  private async refreshAfterFolderPathChange(oldPath: string, newPath: string): Promise<void> {
    const selectedFolderPath = this.rewriteSelectedPath(
      this.selectedFolderPath,
      oldPath,
      newPath,
    );
    // Commit the requested selection synchronously after storage succeeds so a
    // later refresh failure cannot pair a successful mutation with an obsolete
    // requested folder path. The guarded refresh below commits the visible model.
    this.requestedFolderPath = selectedFolderPath;
    try {
      await this.rewriteExpandState(oldPath, newPath);
    } catch (e) {
      if (this.mounted) new Notice(this.plugin.i18n.t('snippetManager.redrawError'));
      console.error('[Protocol Former] snippet manager path reconciliation failed', e);
    }
    await this.refresh(selectedFolderPath);
  }

  private async completeFolderRename(oldPath: string, newPath: string): Promise<void> {
    await this.refreshAfterFolderPathChange(oldPath, newPath);
  }

  // -------------------------------------------------------------------------
  // Phase 34 Plan 02 — HTML5 drag-and-drop handlers on tree rows.
  // Wired from `renderNode` via `registerDomEvent` for auto-cleanup.
  // D-04: `dragover.preventDefault()` is called ONLY when our custom MIME
  // is present in `dataTransfer.types`, so drops from OS, chip-editor, etc.
  // pass through unharmed.
  // -------------------------------------------------------------------------
  private async rewriteExpandState(oldPath: string, newPath: string): Promise<void> {
    const expanded = this.plugin.settings.snippetTreeExpandedPaths;
    let mutated = false;
    for (let i = 0; i < expanded.length; i++) {
      const entry = expanded[i]!;
      if (entry === oldPath) {
        expanded[i] = newPath;
        mutated = true;
      } else if (entry.startsWith(`${oldPath}/`)) {
        expanded[i] = `${newPath}${entry.slice(oldPath.length)}`;
        mutated = true;
      }
    }
    if (mutated) await this.plugin.saveSettings();
  }

  /**
   * Prefix-rewrite a selected folder path after a rename/move. Returns the
   * rewritten path; the caller commits it through the guarded refresh.
   */
  private rewriteSelectedPath(
    selectedFolderPath: string,
    oldPath: string,
    newPath: string,
  ): string {
    if (selectedFolderPath === oldPath) return newPath;
    if (selectedFolderPath.startsWith(`${oldPath}/`)) {
      return `${newPath}${selectedFolderPath.slice(oldPath.length)}`;
    }
    return selectedFolderPath;
  }
}
