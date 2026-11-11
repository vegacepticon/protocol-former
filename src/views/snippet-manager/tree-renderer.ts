// views/snippet-manager/tree-renderer.ts
// Phase 82 SPLIT-01 — extracted tree rendering, DnD, and inline rename from
// SnippetManagerView so the original god-file shrinks by ≥30%.
//
// Phase two-pane: the renderer now renders SUPPLIED models (a folders-only
// tree for the left pane and a flat snippet list for the right pane) instead
// of rebuilding them itself. Folder selection is separated from chevron
// expansion; the synthetic root is rendered specially (non-draggable,
// non-renamable, drop-capable); right-pane snippet rows are name-only.

import { Menu, Notice, setIcon } from 'obsidian';
import type RadiProtocolPlugin from '../../main';
import { createButton } from '../../utils/dom-helpers';
// Slice 8 — library-managed read-only rendering.
import { isLibraryManagedPath, findInstalledRecordForPath } from '../../library/library-paths';
import type { InstalledRecord } from '../../library/library-model';

// Phase 34 Plan 02: HTML5 DnD custom MIME types.
const MIME_FILE = 'application/x-radi-snippet-file';
const MIME_FOLDER = 'application/x-radi-snippet-folder';

// ---------------------------------------------------------------------------
// Supplied tree model (built by the view)
// ---------------------------------------------------------------------------
export interface TreeNodeFolder {
  kind: 'folder';
  path: string;
  name: string;
  isRoot: boolean;
  children: TreeNodeFolder[];
}
export interface TreeNodeFile {
  kind: 'file';
  path: string;
  name: string;
  snippetKind: 'md' | 'md-template';
}
export type TreeNode = TreeNodeFolder | TreeNodeFile;

function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i > 0 ? path.slice(0, i) : '';
}

export function basenameNoExt(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

// ---------------------------------------------------------------------------
// Callback interface — SnippetManagerView implements these
// ---------------------------------------------------------------------------

interface TreeRendererCallbacks {
  selectFolder(path: string): Promise<void>;
  toggleFolder(path: string): Promise<void>;
  openEditModal(path: string): Promise<void>;
  openCreateModal(folderPath: string): Promise<void>;
  handleCreateSubfolder(path: string): Promise<void>;
  handleDeleteSnippet(path: string, name: string): Promise<void>;
  handleDeleteFolder(path: string, name: string): Promise<void>;
  openMovePicker(node: TreeNode): Promise<void>;
  duplicateSnippet(path: string): Promise<void>;
  performMove(srcPath: string, srcKind: 'file' | 'folder', dstFolder: string): Promise<void>;
  refresh(): Promise<void>;
  completeFolderRename(
    oldPath: string,
    newPath: string,
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// SnippetManagerTreeRenderer
// ---------------------------------------------------------------------------
export class SnippetManagerTreeRenderer {
  private readonly folderContainer: HTMLElement;
  private readonly snippetContainer: HTMLElement;
  private readonly plugin: RadiProtocolPlugin;
  private readonly callbacks: TreeRendererCallbacks;

  // Mutable state synced with the view
  private currentlyEditingPath: string | null = null;
  private currentlyRenamingPath: string | null = null;
  private rowLabelEls: Map<string, HTMLElement> = new Map();
  private selectedFolderPath = '';
  // Slice 8 — installed records for the library-managed indicator badge.
  private installedRecords: readonly InstalledRecord[] = [];

  constructor(options: {
    folderContainer: HTMLElement;
    snippetContainer: HTMLElement;
    plugin: RadiProtocolPlugin;
    callbacks: TreeRendererCallbacks;
  }) {
    this.folderContainer = options.folderContainer;
    this.snippetContainer = options.snippetContainer;
    this.plugin = options.plugin;
    this.callbacks = options.callbacks;
  }

  // ——— Public accessors ———

  getRowLabelEls(): Map<string, HTMLElement> {
    return this.rowLabelEls;
  }

  getCurrentlyRenamingPath(): string | null {
    return this.currentlyRenamingPath;
  }

  setCurrentlyEditingPath(path: string | null): void {
    this.currentlyEditingPath = path;
  }

  // ——— Render entry ———

  render(options: {
    folderTree: TreeNodeFolder;
    snippets: TreeNodeFile[];
    selectedFolderPath: string;
    searchResults?: import('../../snippets/snippet-service').SnippetSearchResult[];
    searchQuery?: string;
    installedRecords?: readonly InstalledRecord[];
  }): void {
    this.folderContainer.empty();
    this.snippetContainer.empty();
    this.rowLabelEls.clear();
    this.selectedFolderPath = options.selectedFolderPath;
    this.installedRecords = options.installedRecords ?? [];
    // Recreate visually-hidden accessible headings as the first child of each
    // pane on every render — the renderer owns pane contents (see empty() above),
    // so a one-time heading in onOpen() would not survive the initial refresh.
    this.folderContainer.createEl('h2', {
      cls: 'rp-sr-only',
      text: this.plugin.i18n.t('snippetManager.folderPaneAria'),
    });
    this.snippetContainer.createEl('h2', {
      cls: 'rp-sr-only',
      text: this.plugin.i18n.t('snippetManager.snippetPaneAria'),
    });
    this.renderNode(this.folderContainer, options.folderTree, 0);
    if (
      options.searchResults !== undefined &&
      options.searchQuery !== undefined &&
      options.searchQuery.trim() !== ''
    ) {
      this.renderSearchResults(options.searchResults);
      return;
    }
    if (options.snippets.length === 0) {
      this.snippetContainer.createDiv({
        cls: 'radi-snippet-list-empty',
        text: this.plugin.i18n.t('snippetManager.emptyFolderPlaceholder'),
      });
      return;
    }
    for (const snippet of options.snippets) this.renderNode(this.snippetContainer, snippet, 0);
  }

  private renderSearchResults(
    results: import('../../snippets/snippet-service').SnippetSearchResult[],
  ): void {
    if (results.length === 0) {
      this.snippetContainer.createDiv({
        cls: 'radi-snippet-list-empty',
        text: this.plugin.i18n.t('snippetManager.noSearchResults'),
      });
      return;
    }
    const root = this.plugin.settings.snippetFolderPath;
    for (const { snippet, folderPath } of results) {
      const node: TreeNodeFile = {
        kind: 'file',
        path: snippet.path,
        name: snippet.name,
        snippetKind: snippet.kind,
      };
      this.renderNode(this.snippetContainer, node, 0);
      const row = this.snippetContainer.children[
        this.snippetContainer.children.length - 1
      ] as HTMLElement;
      row.addClass('radi-snippet-search-result');
      const rel = folderPath === root ? '' : folderPath.slice(root.length + 1);
      row.createSpan({ cls: 'radi-snippet-search-path', text: rel === '' ? '/' : rel });
    }
  }

  // ——— Root empty-area context menu ———

  public openRootContextMenu(ev: MouseEvent): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const root = this.plugin.settings.snippetFolderPath;
    const menu = new Menu();
    menu.addItem((item) => item
      .setTitle(t('snippetManager.ctxCreateSnippetHere'))
      .setIcon('plus')
      .onClick(() => { void this.callbacks.openCreateModal(root); }));
    menu.addItem((item) => item
      .setTitle(t('snippetManager.ctxCreateSubfolder'))
      .setIcon('folder-plus')
      .onClick(() => { void this.callbacks.handleCreateSubfolder(root); }));
    menu.showAtMouseEvent(ev);
  }

  // ——— Expand state ———

  private isExpanded(node: TreeNodeFolder): boolean {
    return node.isRoot || this.plugin.settings.snippetTreeExpandedPaths.includes(node.path);
  }

  // ——— Node render ———

  private renderNode(container: HTMLElement, node: TreeNode, depth: number): void {
    const row = container.createDiv({ cls: 'radi-snippet-tree-row' });
    row.setAttribute('data-path', node.path);
    row.setAttribute('data-kind', node.kind);
    row.setAttribute('tabindex', '0');
    if (node.kind === 'folder') {
      row.setAttribute('role', 'treeitem');
      row.setAttribute('aria-selected', String(node.path === this.selectedFolderPath));
      if (node.path === this.selectedFolderPath) row.addClass('is-selected');
      const indent = row.createSpan({ cls: 'radi-snippet-tree-indent rp-snippet-tree-indent-inline' });
      indent.style.width = `${depth * 16}px`;
      const expanded = this.isExpanded(node);
      const chevron = row.createSpan({ cls: 'radi-snippet-tree-chevron' });
      setIcon(chevron, expanded ? 'chevron-down' : 'chevron-right');
      if (!node.isRoot) {
        chevron.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          void this.callbacks.toggleFolder(node.path);
        });
      }
      const icon = row.createSpan({ cls: 'radi-snippet-tree-icon' });
      setIcon(icon, expanded ? 'folder-open' : 'folder');
    } else {
      row.setAttribute('role', 'listitem');
      if (this.currentlyEditingPath === node.path) row.setAttribute('data-editing', 'true');
      // Right-pane snippet rows are name-only — no file icon, just a small
      // leading indent so the label aligns with the folder-pane rows.
      const snippetIndent = row.createSpan({ cls: 'radi-snippet-tree-indent rp-snippet-tree-indent-inline' });
      snippetIndent.style.width = `${0}px`;
    }

    const labelEl = row.createSpan({ cls: 'radi-snippet-tree-label', text: node.name });
    this.rowLabelEls.set(node.path, labelEl);

    // Slice 8 — library-managed nodes get an installed-package badge and are
    // rendered read-only (no add-button, suppressed edit/rename/drag, drop-into
    // library forbidden). The badge label is the managed indicator + the owning
    // packageId @ releaseVersion when an installed record is found.
    const snippetRoot = this.plugin.settings.snippetFolderPath;
    const managed = isLibraryManagedPath(node.path, snippetRoot);
    if (managed) {
      const record = findInstalledRecordForPath(this.installedRecords, node.path);
      const badge = row.createSpan({ cls: 'radi-snippet-tree-library-badge' });
      const badgeLabel = this.plugin.i18n.t('library.managedBadge');
      badge.setText(record !== null ? `${badgeLabel} · ${record.packageId} @ ${record.releaseVersion}` : badgeLabel);
      row.addClass('is-library-managed');
    }

    if (node.kind === 'folder' && !node.isRoot && !managed) {
      const actions = row.createSpan({ cls: 'radi-snippet-tree-actions' });
      const addBtn = createButton(actions, {
        cls: 'radi-snippet-tree-add-btn',
        attr: { 'aria-label': this.plugin.i18n.t('snippetManager.createInThisFolder') },
      });
      setIcon(addBtn, 'plus');
      addBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        void this.callbacks.openCreateModal(node.path);
      });
    }

    row.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      if (target !== null && target.closest('button') !== null && target !== row) return;
      if (node.kind === 'file') {
        if (managed) { new Notice(this.plugin.i18n.t('library.readOnlyNotice')); return; }
        void this.callbacks.openEditModal(node.path);
      } else {
        void this.callbacks.selectFolder(node.path);
      }
    });

    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (managed) { new Notice(this.plugin.i18n.t('library.readOnlyNotice')); return; }
      if (node.kind === 'folder' && node.isRoot) this.openRootContextMenu(event as MouseEvent);
      else this.openContextMenu(event as MouseEvent, node);
    });

    row.addEventListener('keydown', (event) => {
      const keyEvent = event as KeyboardEvent;
      if (keyEvent.key === 'Enter' || keyEvent.key === ' ') {
        keyEvent.preventDefault();
        if (node.kind === 'file') {
          if (managed) { new Notice(this.plugin.i18n.t('library.readOnlyNotice')); return; }
          void this.callbacks.openEditModal(node.path);
        } else {
          void this.callbacks.selectFolder(node.path);
          if (!node.isRoot) void this.callbacks.toggleFolder(node.path);
        }
      } else if (keyEvent.key === 'F2' && !(node.kind === 'folder' && node.isRoot) && !managed) {
        keyEvent.preventDefault();
        this.startInlineRename(node, labelEl);
      }
    });

    if (!(node.kind === 'folder' && node.isRoot) && !managed) {
      row.setAttribute('draggable', 'true');
      row.addEventListener('dragstart', (event) =>
        this.handleDragStart(row, node, event as DragEvent));
      row.addEventListener('dragend', () => this.handleDragEnd(row));
    }
    row.addEventListener('dragover', (event) => this.handleDragOver(row, node, event as DragEvent));
    row.addEventListener('dragleave', (event) => this.handleDragLeave(row, event as DragEvent));
    row.addEventListener('drop', (event) => {
      void this.handleDrop(node, row, event as DragEvent);
    });

    if (node.kind === 'folder' && this.isExpanded(node)) {
      if (node.children.length === 0 && !node.isRoot) {
        const empty = container.createDiv({ cls: 'radi-snippet-tree-row radi-snippet-tree-empty-placeholder' });
        const emptyIndent = empty.createSpan({ cls: 'radi-snippet-tree-indent rp-snippet-tree-indent-inline' });
        emptyIndent.style.width = `${(depth + 1) * 16}px`;
        empty.createSpan({
          text: this.plugin.i18n.t('snippetManager.emptyFolderPlaceholder'),
          cls: 'radi-snippet-tree-empty-label',
        });
      } else {
        for (const child of node.children) this.renderNode(container, child, depth + 1);
      }
    }
  }

  // ——— Context menu ———

  private openContextMenu(ev: MouseEvent, node: TreeNode): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const menu = new Menu();
    if (node.kind === 'file') {
      menu.addItem((item) =>
        item
          .setTitle(t('snippetManager.ctxEdit'))
          .setIcon('pencil')
          .onClick(() => { void this.callbacks.openEditModal(node.path); }),
      );
      menu.addItem((item) =>
        item
          .setTitle(t('snippetManager.ctxRename'))
          .setIcon('pencil-line')
          .onClick(() => {
            const labelEl = this.rowLabelEls.get(node.path);
            if (labelEl !== undefined) this.startInlineRename(node, labelEl);
          }),
      );
      menu.addItem((item) =>
        item
          .setTitle(t('snippetManager.ctxMove'))
          .setIcon('folder-input')
          .onClick(() => { void this.callbacks.openMovePicker(node); }),
      );
      menu.addItem((item) =>
        item
          .setTitle(t('snippetEditor.duplicate'))
          .setIcon('copy')
          .onClick(() => { void this.callbacks.duplicateSnippet(node.path); }),
      );
      menu.addSeparator();
      menu.addItem((item) =>
        item
          .setTitle(t('snippetManager.ctxDelete'))
          .setIcon('trash')
          .onClick(() => { void this.callbacks.handleDeleteSnippet(node.path, node.name); }),
      );
    } else {
      menu.addItem((item) =>
        item
          .setTitle(t('snippetManager.ctxCreateSnippetHere'))
          .setIcon('plus')
          .onClick(() => { void this.callbacks.openCreateModal(node.path); }),
      );
      menu.addItem((item) =>
        item
          .setTitle(t('snippetManager.ctxCreateSubfolder'))
          .setIcon('folder-plus')
          .onClick(() => { void this.callbacks.handleCreateSubfolder(node.path); }),
      );
      menu.addItem((item) =>
        item
          .setTitle(t('snippetManager.ctxRename'))
          .setIcon('pencil-line')
          .onClick(() => {
            const labelEl = this.rowLabelEls.get(node.path);
            if (labelEl !== undefined) this.startInlineRename(node, labelEl);
          }),
      );
      menu.addItem((item) =>
        item
          .setTitle(t('snippetManager.ctxMove'))
          .setIcon('folder-input')
          .onClick(() => { void this.callbacks.openMovePicker(node); }),
      );
      menu.addSeparator();
      menu.addItem((item) =>
        item
          .setTitle(t('snippetManager.ctxDeleteFolder'))
          .setIcon('trash')
          .onClick(() => { void this.callbacks.handleDeleteFolder(node.path, node.name); }),
      );
    }
    menu.showAtMouseEvent(ev);
  }

  // ——— DnD helpers ———

  private computeDropTarget(node: TreeNode): string {
    return node.kind === 'folder' ? node.path : dirname(node.path);
  }

  private isDropForbidden(
    srcPath: string,
    srcKind: 'file' | 'folder',
    targetFolder: string,
  ): boolean {
    if (srcPath === '') return false;
    if (srcKind === 'file') {
      return dirname(srcPath) === targetFolder;
    }
    return srcPath === targetFolder || targetFolder.startsWith(srcPath + '/');
  }

  private readDragSource(ev: DragEvent): { path: string; kind: 'file' | 'folder' } | null {
    const types = ev.dataTransfer?.types;
    if (!types) return null;
    const hasFile = Array.from(types as unknown as Iterable<string>).includes(MIME_FILE);
    const hasFolder = Array.from(types as unknown as Iterable<string>).includes(MIME_FOLDER);
    if (hasFile) {
      const p = ev.dataTransfer?.getData(MIME_FILE) ?? '';
      return p === '' ? { path: '', kind: 'file' } : { path: p, kind: 'file' };
    }
    if (hasFolder) {
      const p = ev.dataTransfer?.getData(MIME_FOLDER) ?? '';
      return p === '' ? { path: '', kind: 'folder' } : { path: p, kind: 'folder' };
    }
    return null;
  }

  private handleDragStart(row: HTMLElement, node: TreeNode, ev: DragEvent): void {
    if (ev.dataTransfer === null) return;
    const mime = node.kind === 'file' ? MIME_FILE : MIME_FOLDER;
    ev.dataTransfer.setData(mime, node.path);
    ev.dataTransfer.effectAllowed = 'move';
    row.addClass('is-dragging');
  }

  private handleDragOver(row: HTMLElement, node: TreeNode, ev: DragEvent): void {
    const src = this.readDragSource(ev);
    if (src === null) return;
    const target = this.computeDropTarget(node);
    // Slice 8 — drop-into-library is forbidden: a library-managed target never
    // accepts a drop (no preventDefault, so no drop event fires).
    if (isLibraryManagedPath(target, this.plugin.settings.snippetFolderPath)) {
      row.addClass('radi-snippet-tree-drop-forbidden');
      return;
    }
    const forbidden = this.isDropForbidden(src.path, src.kind, target);
    if (forbidden) {
      row.addClass('radi-snippet-tree-drop-forbidden');
      return;
    }
    ev.preventDefault();
    if (ev.dataTransfer !== null) ev.dataTransfer.dropEffect = 'move';
    row.addClass('radi-snippet-tree-drop-target');
  }

  private handleDragLeave(row: HTMLElement, ev: DragEvent): void {
    const rel = (ev as unknown as { relatedTarget: Node | null }).relatedTarget;
    if (rel !== null && typeof (row as unknown as { contains?: (n: Node) => boolean }).contains === 'function') {
      try {
        if ((row as unknown as { contains: (n: Node) => boolean }).contains(rel)) return;
      } catch { /* noop */ }
    }
    row.removeClass('radi-snippet-tree-drop-target');
    row.removeClass('radi-snippet-tree-drop-forbidden');
  }

  private async handleDrop(node: TreeNode, row: HTMLElement, ev: DragEvent): Promise<void> {
    const src = this.readDragSource(ev);
    if (src === null) return;
    ev.preventDefault();
    row.removeClass('radi-snippet-tree-drop-target');
    row.removeClass('radi-snippet-tree-drop-forbidden');
    const target = this.computeDropTarget(node);
    try {
      await this.callbacks.performMove(src.path, src.kind, target);
    } catch (e) {
      const t = this.plugin.i18n.t.bind(this.plugin.i18n);
      const error = (e as Error)?.message ?? t('snippetManager.unknownError');
      new Notice(t('snippetManager.moveError', { error }));
      console.error('[Protocol Former] drop move failed', e);
    }
  }

  private handleDragEnd(row: HTMLElement): void {
    row.removeClass('is-dragging');
    row.removeClass('radi-snippet-tree-drop-target');
    row.removeClass('radi-snippet-tree-drop-forbidden');
  }

  // ——— Inline rename ———

  startInlineRename(node: TreeNode, labelEl: HTMLElement): void {
    if (this.currentlyRenamingPath !== null) return;
    this.currentlyRenamingPath = node.path;

    const realParent = (labelEl as unknown as { parentElement?: HTMLElement | null }).parentElement;
    const mockParent = (labelEl as unknown as { parent?: HTMLElement | null }).parent;
    const rowEl: HTMLElement = (realParent ?? mockParent ?? labelEl) as HTMLElement;

    const initialValue = node.kind === 'file' ? basenameNoExt(node.path) : node.name;
    const input = (rowEl as unknown as { createEl: (t: string, o?: { cls?: string; type?: string }) => HTMLElement })
      .createEl('input', { cls: 'radi-snippet-tree-rename-input', type: 'text' });
    (input as unknown as { value: string }).value = initialValue;
    try {
      labelEl.toggleClass('rp-snippet-tree-label-hidden', true);
    } catch { /* noop */ }
    try {
      (input as unknown as { focus: () => void }).focus();
    } catch { /* noop */ }
    try {
      (input as unknown as { select: () => void }).select();
    } catch { /* noop */ }

    let settled = false;

    const cleanup = (): void => {
      try {
        (input as unknown as { removeEventListener: (t: string, h: (ev: unknown) => void) => void })
          .removeEventListener('keydown', onKeyDown as unknown as (ev: unknown) => void);
        (input as unknown as { removeEventListener: (t: string, h: (ev: unknown) => void) => void })
          .removeEventListener('blur', onBlur as unknown as (ev: unknown) => void);
      } catch { /* noop */ }
      try {
        (input as unknown as { remove: () => void }).remove();
      } catch { /* noop */ }
      try {
        labelEl.toggleClass('rp-snippet-tree-label-hidden', false);
      } catch { /* noop */ }
      this.currentlyRenamingPath = null;
    };

    const onKeyDown = (ev: KeyboardEvent): void => {
      ev.stopPropagation();
      if (ev.key === 'Enter') {
        ev.preventDefault();
        if (settled) return;
        settled = true;
        const value = (input as unknown as { value: string }).value;
        void this.commitInlineRename(node, value, cleanup);
        return;
      }
      if (ev.key === 'Escape') {
        ev.preventDefault();
        if (settled) return;
        settled = true;
        cleanup();
        return;
      }
    };

    const onBlur = (_ev: Event): void => {
      void _ev;
      if (settled) return;
      settled = true;
      const value = (input as unknown as { value: string }).value;
      const trimmed = value.trim();
      const initialTrimmed = initialValue.trim();
      if (trimmed === '' || trimmed === initialTrimmed) {
        cleanup();
        return;
      }
      void this.commitInlineRename(node, value, cleanup);
    };

    (input as unknown as { addEventListener: (t: string, h: (ev: unknown) => void) => void })
      .addEventListener('keydown', onKeyDown as unknown as (ev: unknown) => void);
    (input as unknown as { addEventListener: (t: string, h: (ev: unknown) => void) => void })
      .addEventListener('blur', onBlur as unknown as (ev: unknown) => void);
  }

  private async commitInlineRename(
    node: TreeNode,
    rawValue: string,
    cleanup: () => void,
  ): Promise<void> {
    const newValue = rawValue.trim();
    const oldBasename = node.kind === 'file' ? basenameNoExt(node.path) : node.name;
    if (newValue === '' || newValue === oldBasename) {
      cleanup();
      return;
    }
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    try {
      if (node.kind === 'file') {
        await this.plugin.snippetService.renameSnippet(node.path, newValue);
        cleanup();
        await this.callbacks.refresh();
        new Notice(t('snippetManager.snippetRenamedNotice'));
        return;
      }
      const oldPath = node.path;
      const newPath = await this.plugin.snippetService.renameFolder(oldPath, newValue);
      cleanup();
      await this.callbacks.completeFolderRename(oldPath, newPath);
      new Notice(t('snippetManager.pathChangedNotice'));
    } catch (e) {
      const error = (e as Error)?.message ?? t('snippetManager.unknownError');
      new Notice(t('snippetManager.renameError', { error }));
      cleanup();
    }
  }
}