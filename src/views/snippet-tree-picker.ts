// views/snippet-tree-picker.ts
// Phase 51 PICKER-02 — unified hierarchical navigator for snippet/folder selection.
// Replaces flat-list pickers in Node Editor (case 'snippet'), Snippet Manager
// (move-to flow), Snippet Editor (folder field), and Runner (awaiting-snippet-pick).
//
// Design contract: `docs/ARCHITECTURE-NOTES.md#snippet-node-binding-and-picker` (Shared Pattern H).
// Decisions: D-08 surface, D-09 mode-filtered search, D-10 substring matcher, D-11 two-line rows,
// D-12 search-row click semantics + clearing-search-restores-drillPath.
//
// File-row glyphs: .md → 📝, otherwise → 📄 (default). Legacy .json files are
// filtered from listing and search before reaching this glyph dispatch, so the
// .json glyph branch is removed.
//
// Public API: SnippetTreePicker class. Owns drill-state + search-state — reset on each mount().
// No global state. No localStorage. No singleton.

import { setIcon, type App } from 'obsidian';
import type { SnippetService } from '../snippets/snippet-service';
import type { Snippet } from '../snippets/snippet-model';
import { createButton, createInput } from '../utils/dom-helpers';
import { defaultT, type Translator } from '../i18n';

// ── Constants ────────────────────────────────────────────────────────────

const SEARCH_DEBOUNCE_MS = 120;
// Phase 84 (I18N-02): user-visible copy is resolved at render time via the
// picker's translator (defaults to defaultT for English). Keys live in
// snippetTreePicker.* of the i18n locale files.
const SELECT_FOLDER_KEY = 'snippetTreePicker.selectFolder';
const SELECT_FOLDER_COMMITTED_KEY = 'snippetTreePicker.selectFolderCommitted';
const EMPTY_RESULTS_KEY = 'snippetTreePicker.emptyResults';
const EMPTY_FOLDER_KEY = 'snippetTreePicker.emptyFolder';
const SEARCH_PLACEHOLDER_KEY = 'snippetTreePicker.searchPlaceholder';

// Phase 35 MD-01 preservation — extension-based glyph dispatch.
const GLYPH_FOLDER = '\uD83D\uDCC1';  // 📁
const GLYPH_FILE = '\uD83D\uDCC4';    // 📄
const GLYPH_MD = '\uD83D\uDCDD';      // 📝

/** Dispatch file row glyph by extension.
 *  .md → 📝, otherwise → 📄 (default). Case-insensitive on extension. */
function fileGlyph(basename: string): string {
  const lower = basename.toLowerCase();
  if (lower.endsWith('.md')) return GLYPH_MD;
  return GLYPH_FILE;  // default fallback (legacy .json never reaches here)
}

function basenameOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx >= 0 ? path.slice(idx + 1) : path;
}

// ── Public surface (D-08) ────────────────────────────────────────────────

export type SnippetTreePickerMode = 'folder-only' | 'file-only' | 'both';

export interface SnippetTreePickerResult {
  kind: 'folder' | 'file';
  /** Path relative to options.rootPath (NOT vault-relative). */
  relativePath: string;
}

export interface SnippetTreePickerOptions {
  app: App;
  snippetService: SnippetService;
  container: HTMLElement;
  mode: SnippetTreePickerMode;
  /** Vault-relative root path the picker is anchored at. */
  rootPath: string;
  initialSelection?: string;
  onSelect: (result: SnippetTreePickerResult) => void;
  /** Phase 84 (I18N-02): translator for user-visible copy. Optional —
   *  unit tests and standalone callers fall back to the English defaultT. */
  t?: Translator;
  /** Phase 5: when true, search-result file rows omit the secondary
   *  `.rp-stp-result-path` line and render basename-only. Default `false`
   *  preserves the prior two-line behavior (basename + full relative path).
   *  Drill-view rows never render the path line regardless of this flag. */
  hideSearchResultPath?: boolean;
  /** Runner surfaces: put the caret in the search field as soon as the initial
   *  listing is rendered, so typing filters immediately and ArrowUp/Down/Enter
   *  navigate without an extra click. Default `false` — embedding pickers
   *  (node editor, snippet manager/editor) keep the host's own focus. */
  autoFocusSearch?: boolean;
}

// ── Implementation ───────────────────────────────────────────────────────

interface TrackedListener {
  el: HTMLElement;
  type: string;
  handler: EventListener;
}

export class SnippetTreePicker {
  private readonly options: SnippetTreePickerOptions;
  /** Phase 84 (I18N-02): resolved translator (options.t ?? defaultT). */
  private readonly t: Translator;

  // Instance-private state — reset on each mount().
  private drillPath: string[] = [];
  private currentQuery: string = '';
  private searchDebounceTimer: number | null = null;
  private containerEl: HTMLElement | null = null;
  private listeners: TrackedListener[] = [];
  private searchInputEl: HTMLInputElement | null = null;

  /** Phase 4 — keyboard-nav highlight cursor. -1 = nothing highlighted.
   *  Reset on each mount() and on every body re-render via clearHighlight(). */
  private highlightedIndex: number = -1;
  /** The currently-highlighted row DOM node. Detached by removeBody() on the
   *  next re-render, so clearHighlight() only resets the cursor (no class
   *  removal needed — the old element is gone). */
  private highlightedRowEl: HTMLElement | null = null;
  /** Visually-hidden aria-live="polite" status span created in mount(); survives
   *  removeBody() because it lives inside .rp-stp-search. Updated by moveHighlight(). */
  private highlightStatusEl: HTMLElement | null = null;

  /** Phase 56 D-10 (PICKER-01 follow-up): relative path (drillPath.join('/'))
   *  of the folder the user has "committed" via the select-folder button.
   *  null when no commit has occurred in the current drill session, or when
   *  drillPath no longer equals this value (drilled elsewhere / navigated up). */
  private committedRelativePath: string | null = null;

  constructor(options: SnippetTreePickerOptions) {
    this.options = options;
    this.t = options.t ?? defaultT;
  }

  async mount(): Promise<void> {
    this.clearContainer();
    this.drillPath = [];
    this.currentQuery = '';
    this.searchInputEl = null;
    this.committedRelativePath = null;
    this.highlightedIndex = -1;
    this.highlightedRowEl = null;
    this.highlightStatusEl = null;

    const container = this.options.container;
    this.containerEl = container;
    container.empty();

    // Root wrapper.
    const root = container.createDiv({ cls: 'rp-stp-root rp-stack-lg' });

    // Search input row (always rendered above breadcrumb).
    const searchWrap = root.createDiv({ cls: 'rp-stp-search' });
    const searchInput = createInput(searchWrap, {
      cls: 'rp-stp-search-input',
      type: 'text',
    });
    searchInput.placeholder = this.t(SEARCH_PLACEHOLDER_KEY);
    this.searchInputEl = searchInput;
    this.addListener(searchInput, 'input', () => {
      const value = searchInput.value;
      this.onSearchInput(value);
    });
    // Phase 4 — keyboard navigation (ArrowUp/Down + Enter) on the search input.
    // Tracked via addListener so unmount()/clearContainer() tear it down, and
    // preserved across body re-renders by removeListenersExceptSearch().
    this.addListener(searchInput, 'keydown', (e) => {
      this.handleSearchKeydown(e as KeyboardEvent);
    });

    // Phase 4 — visually-hidden aria-live="polite" status span for screen-reader
    // announcements of the highlighted row title. Lives inside .rp-stp-search so
    // removeBody() (which keeps .rp-stp-search) preserves it across re-renders.
    const statusSpan = searchWrap.createEl('span', {
      cls: 'rp-sr-only',
      attr: { 'aria-live': 'polite', role: 'status' },
    });
    this.highlightStatusEl = statusSpan;

    // Vim-style navigation handoff: one keydown listener on the STABLE root
    // element (never replaced until unmount — removeBody keeps the search wrap
    // and re-renders only the body). It branches on whether focus currently
    // sits in the search input: while it does, j/k must keep typing letters
    // (Russian layout: the physical j/k keys type «о»/«к»); once focus moves
    // onto the list (Tab), j/k/Enter navigate regardless of keyboard layout
    // (matched by physical key via e.code).
    this.addListener(root, 'keydown', (e) => {
      this.handleListKeydown(e as KeyboardEvent);
    });

    // Breadcrumb + list host container. Both drill and search views render into here.
    // We keep the search input fixed above so typing never blows away focus.
    await this.renderDrillView(root);

    // Keyboard-first entry for the runner (see `autoFocusSearch`): land the caret
    // in the search field once the listing exists. Optional-chained because the
    // host may unmount the picker while the initial folder load is in flight.
    if (this.options.autoFocusSearch === true) {
      this.searchInputEl?.focus({ preventScroll: true });
    }
  }

  unmount(): void {
    if (this.searchDebounceTimer !== null) {
      clearTimeout(this.searchDebounceTimer);
      this.searchDebounceTimer = null;
    }
    this.removeAllListeners();
    if (this.containerEl) {
      this.containerEl.empty();
    }
    this.containerEl = null;
    this.searchInputEl = null;
    this.committedRelativePath = null;
    this.highlightedIndex = -1;
    this.highlightedRowEl = null;
    this.highlightStatusEl = null;
  }

  // ── Listener tracking ─────────────────────────────────────────────────

  private addListener(el: HTMLElement, type: string, handler: EventListener): void {
    el.addEventListener(type, handler);
    this.listeners.push({ el, type, handler });
  }

  private removeAllListeners(): void {
    for (const { el, type, handler } of this.listeners) {
      el.removeEventListener(type, handler);
    }
    this.listeners = [];
  }

  private removeListenersExceptSearch(): void {
    // Keep the search-input 'input'/'keydown' listeners AND the root-level
    // vim-navigation keydown listener across re-renders; drop all others.
    const keep: TrackedListener[] = [];
    const drop: TrackedListener[] = [];
    const root = this.rootEl();
    for (const entry of this.listeners) {
      if (
        entry.el === (this.searchInputEl as unknown as HTMLElement) &&
        (entry.type === 'input' || entry.type === 'keydown')
      ) {
        keep.push(entry);
      } else if (root !== null && entry.el === root && entry.type === 'keydown') {
        keep.push(entry);
      } else {
        drop.push(entry);
      }
    }
    for (const { el, type, handler } of drop) {
      el.removeEventListener(type, handler);
    }
    this.listeners = keep;
  }

  private clearContainer(): void {
    if (this.containerEl) {
      this.removeAllListeners();
      this.containerEl.empty();
    }
  }

  // ── Rendering ─────────────────────────────────────────────────────────

  private rootEl(): HTMLElement | null {
    // The root div is the direct child of container (after clearContainer).
    const c = this.containerEl;
    if (!c) return null;
    for (const child of Array.from(c.children)) {
      if ((child as HTMLElement).classList?.contains('rp-stp-root')) {
        return child as HTMLElement;
      }
    }
    return null;
  }

  /** Current vault-relative path based on drillPath + rootPath. */
  private currentAbsPath(): string {
    if (this.drillPath.length === 0) return this.options.rootPath;
    return `${this.options.rootPath}/${this.drillPath.join('/')}`;
  }

  /** Re-render the non-search body (breadcrumb + list). Keeps the search input. */
  private async renderDrillView(root?: HTMLElement): Promise<void> {
    const host = root ?? this.rootEl();
    if (!host) return;

    // Remove any body (everything except the search wrap) + reset listeners EXCEPT the search input.
    this.removeListenersExceptSearch();
    this.removeBody(host);
    this.clearHighlight();

    // ── Body wrapper (stabilises layout across folder changes) ───────────
    const body = host.createDiv({ cls: 'rp-stp-body' });

    // Accessible breadcrumb navigation with aria-label and semantic markup.
    const breadcrumb = body.createEl('nav', {
      cls: 'rp-stp-breadcrumb',
      attr: { 'aria-label': this.t('snippetTreePicker.breadcrumbNavLabel') },
    });
    breadcrumb.setAttribute('role', 'list');
    if (this.drillPath.length === 0) {
      breadcrumb.createEl('span', {
        cls: 'rp-stp-breadcrumb-label',
        attr: { 'aria-current': 'location' },
        text: '/',
      });
    } else {
      breadcrumb.createEl('span', {
        cls: 'rp-stp-breadcrumb-label',
        text: this.drillPath.join('/'),
      });
      const upBtn = createButton(breadcrumb, { cls: 'rp-stp-up-btn', attr: { 'aria-label': this.t('snippetPicker.goToRoot') } });
      setIcon(upBtn, 'arrow-up');
      this.addListener(upBtn, 'click', () => {
        this.drillPath = [];
        void this.renderDrillView();
      });
    }
    this.drillPath.forEach((segment, index) => {
      breadcrumb.createEl('span', { cls: 'rp-stp-crumb-separator', text: '/', attr: { 'role': 'presentation' } });
      const isLast = index === this.drillPath.length - 1;
      const crumb = createButton(breadcrumb, {
        cls: 'rp-stp-crumb',
        text: segment,
        attr: {
          'aria-label': this.t('snippetTreePicker.crumbAria', { name: segment }),
          ...(isLast ? { 'aria-current': 'location' } : {}),
        },
      });
      this.addListener(crumb, 'click', () => {
        this.drillPath = this.drillPath.slice(0, index + 1);
        void this.renderDrillView();
      });
    });

    // "Select this folder" button — only in folder-only / both modes, and only when drilled in
    // (we don't emit folder-of-root selection from the button; rootPath selection is not in scope).
    if (
      (this.options.mode === 'folder-only' || this.options.mode === 'both') &&
      this.drillPath.length > 0
    ) {
      const currentRel = this.drillPath.join('/');
      const isCommitted = this.committedRelativePath === currentRel;
      const selectBtn = createButton(body, {
        cls: isCommitted ? 'rp-stp-select-folder-btn is-committed' : 'rp-stp-select-folder-btn',
        text: isCommitted ? this.t(SELECT_FOLDER_COMMITTED_KEY) : this.t(SELECT_FOLDER_KEY),
        attr: { 'aria-label': this.t('snippetTreePicker.selectFolderAria') },
      });
      this.addListener(selectBtn, 'click', () => {
        this.committedRelativePath = currentRel;
        this.options.onSelect({
          kind: 'folder',
          relativePath: currentRel,
        });
        void this.renderDrillView();
      });
    }

    // Listing.
    const listEl = body.createDiv({ cls: 'rp-stp-list' });

    const listing = await this.options.snippetService.listFolder(this.currentAbsPath());

    // Defensive: component may have been unmounted during the await.
    if (this.containerEl === null) return;

    // Folders first (reuse existing Phase 30 D-03 convention).
    if (this.options.mode !== 'file-only' || this.options.mode === 'file-only') {
      // In file-only mode folders are still visible (for drill); folder rows do NOT call onSelect.
      for (const folderName of listing.folders) {
        this.renderFolderRow(listEl, folderName, /* isSearchResult */ false);
      }
    }

    // Files — hidden in folder-only mode.
    if (this.options.mode !== 'folder-only') {
      for (const snippet of listing.snippets) {
        this.renderFileRow(listEl, snippet, /* isSearchResult */ false);
      }
    }

    if (listEl.children.length === 0) {
      listEl.createEl('div', { cls: 'rp-stp-empty', text: this.t(EMPTY_FOLDER_KEY) });
    }
  }

  private removeBody(host: HTMLElement): void {
    // Keep only the search wrap; remove everything else.
    const children = Array.from(host.children) as HTMLElement[];
    for (const child of children) {
      if (child.classList?.contains('rp-stp-search')) continue;
      child.remove();
    }
  }

  private renderFolderRow(
    listEl: HTMLElement,
    folderName: string,
    isSearchResult: boolean,
  ): void {
    const row = createButton(listEl, { cls: 'rp-stp-folder-row' });
    const nameEl = row.createEl('div', { cls: 'rp-stp-result-name' });
    nameEl.setText(`${GLYPH_FOLDER} ${basenameOf(folderName)}`);
    nameEl.empty();
    nameEl.createEl('span', { cls: 'rp-stp-row-glyph', text: GLYPH_FOLDER });
    nameEl.createEl('span', { cls: 'rp-stp-row-title', text: basenameOf(folderName) });
    if (isSearchResult) {
      // Secondary line: full relative-from-rootPath path.
      // folderName here is the relative path from rootPath (for search-result rows).
      const pathEl = row.createEl('div', { cls: 'rp-stp-result-path' });
      pathEl.setText(folderName);
      this.addListener(row, 'click', () => {
        // Drill into the folder (D-12). Split by '/' to build drillPath.
        this.drillPath = folderName.split('/').filter((s) => s !== '');
        this.currentQuery = '';
        if (this.searchInputEl) this.searchInputEl.value = '';
        void this.renderDrillView();
      });
    } else {
      this.addListener(row, 'click', () => {
        // Drill view: click folder → drill.
        this.drillPath.push(folderName);
        void this.renderDrillView();
      });
    }
  }

  private renderFileRow(
    listEl: HTMLElement,
    snippetOrBasename: Snippet | { basename: string; relativePath: string },
    isSearchResult: boolean,
  ): void {
    let basename: string;
    let relativePath: string;
    if ('kind' in snippetOrBasename) {
      // Drill-view row: Snippet object. Basename from path. Relative path = drillPath + basename.
      basename = basenameOf(snippetOrBasename.path);
      relativePath = this.drillPath.length === 0
        ? basename
        : `${this.drillPath.join('/')}/${basename}`;
    } else {
      basename = snippetOrBasename.basename;
      relativePath = snippetOrBasename.relativePath;
    }

    const row = createButton(listEl, { cls: 'rp-stp-file-row' });
    const nameEl = row.createEl('div', { cls: 'rp-stp-result-name' });
    nameEl.setText(`${fileGlyph(basename)} ${basename}`);
    nameEl.empty();
    nameEl.createEl('span', { cls: 'rp-stp-row-glyph', text: fileGlyph(basename) });
    nameEl.createEl('span', { cls: 'rp-stp-row-title', text: basename });
    if (isSearchResult && !this.options.hideSearchResultPath) {
      const pathEl = row.createEl('div', { cls: 'rp-stp-result-path' });
      pathEl.setText(relativePath);
    }

    const relPathAtClickTime = relativePath;
    this.addListener(row, 'click', () => {
      this.options.onSelect({ kind: 'file', relativePath: relPathAtClickTime });
    });
  }

  // ── Search handling ──────────────────────────────────────────────────

  private onSearchInput(value: string): void {
    this.currentQuery = value;
    if (this.searchDebounceTimer !== null) {
      clearTimeout(this.searchDebounceTimer);
      this.searchDebounceTimer = null;
    }
    this.searchDebounceTimer = setTimeout(() => {
      this.searchDebounceTimer = null;
      void this.applySearch();
    }, SEARCH_DEBOUNCE_MS) as unknown as number;
  }

  private async applySearch(): Promise<void> {
    const trimmed = this.currentQuery.trim();
    if (trimmed === '') {
      // Restore drill view at CURRENT drillPath (D-12) — NOT rootPath.
      await this.renderDrillView();
      return;
    }
    await this.renderSearchResults(trimmed);
  }

  private async renderSearchResults(query: string): Promise<void> {
    const host = this.rootEl();
    if (!host) return;

    // Tree-wide search is rooted at options.rootPath (NOT the drill cursor).
    // Keep the current rendered body in place while the async vault scan runs:
    // clearing it before await produces a visible blank/list jump on each keystroke.
    const { files, folders } = await this.options.snippetService.listFolderDescendants(
      this.options.rootPath,
    );

    // Defensive: component may have been unmounted or superseded by a newer query
    // while the async search was in flight.
    if (this.containerEl === null) return;
    if (this.currentQuery.trim() !== query) return;

    this.removeListenersExceptSearch();
    this.removeBody(host);
    this.clearHighlight();

    const lowerQ = query.toLowerCase();
    const rootPrefix = `${this.options.rootPath}/`;

    // Collect matches by basename.
    const folderMatches: Array<{ basename: string; relativePath: string }> = [];
    for (const abs of folders) {
      const relative = abs.startsWith(rootPrefix) ? abs.slice(rootPrefix.length) : abs;
      if (relative === '') continue;
      const base = basenameOf(relative);
      if (base.toLowerCase().includes(lowerQ)) {
        folderMatches.push({ basename: base, relativePath: relative });
      }
    }
    const fileMatches: Array<{ basename: string; relativePath: string }> = [];
    for (const abs of files) {
      // Phase 2 (JSON-removal): filter to `.md` before basename matching so
      // legacy `.json` files returned by the raw recursive listing never
      // render as selectable search rows. `listFolderDescendants()` stays
      // extension-agnostic so folder-delete counts include all physical files.
      if (!abs.toLowerCase().endsWith('.md')) continue;
      const relative = abs.startsWith(rootPrefix) ? abs.slice(rootPrefix.length) : abs;
      if (relative === '') continue;
      const base = basenameOf(relative);
      if (base.toLowerCase().includes(lowerQ)) {
        fileMatches.push({ basename: base, relativePath: relative });
      }
    }

    // Mode filter (D-09).
    const showFolders = this.options.mode !== 'file-only';
    const showFiles = this.options.mode !== 'folder-only';

    const listEl = host.createDiv({ cls: 'rp-stp-list' });

    if (showFolders) {
      for (const m of folderMatches) {
        // For search-result folder rows, folderName passed in is the relative path — the row
        // renderer uses it both as the secondary-line text AND to build drillPath on click.
        this.renderFolderRow(listEl, m.relativePath, /* isSearchResult */ true);
      }
    }
    if (showFiles) {
      for (const m of fileMatches) {
        this.renderFileRow(listEl, m, /* isSearchResult */ true);
      }
    }

    if (listEl.children.length === 0) {
      listEl.createEl('div', { cls: 'rp-stp-empty', text: this.t(EMPTY_RESULTS_KEY) });
    }
  }

  // ── Keyboard navigation (Phase 4) ──────────────────────────────────────

  private handleSearchKeydown(e: KeyboardEvent): void {
    // Ignore modifier-laden keys (Ctrl/Cmd/Alt+Arrow etc.) — those belong to the
    // host (e.g. InlineRunnerModal Ctrl+← / Ctrl+→ / Esc) and must pass through
    // unchanged. The runner's handleKeydown INPUT/TEXTAREA bail holds regardless.
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const rows = this.currentRows();
      if (rows.length === 0) return;
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      this.moveHighlight(rows, delta);
      return;
    }

    if (e.key === 'Enter') {
      // No-op + no-throw when nothing is highlighted.
      if (this.highlightedIndex === -1 || this.highlightedRowEl === null) return;
      e.preventDefault();
      // Dispatch the row's registered click handler — same path as a mouse click
      // (file row → onSelect, folder row → drill).
      this.highlightedRowEl.click();
      return;
    }

    // Vim-style handoff: Tab moves focus from the search input onto the list
    // (highlighting the first row if nothing is highlighted yet). Shift+Tab is
    // left alone so the browser's reverse focus cycle still works.
    if (e.key === 'Tab' && !e.shiftKey) {
      const rows = this.currentRows();
      if (rows.length === 0) return; // nothing to land on — keep default Tab
      e.preventDefault();
      if (this.highlightedIndex === -1 || this.highlightedRowEl === null) {
        this.moveHighlight(rows, 1);
      }
      this.highlightedRowEl?.focus({ preventScroll: true });
      return;
    }
  }

  /**
   * Vim-style list navigation (lives on the stable picker root; see mount()).
   * Active only when focus is NOT in the search input — while it is, j/k must
   * keep typing letters (on the Russian layout the physical j/k keys type
   * «о»/«к»). j/k are matched by physical key (e.code 'KeyJ'/'KeyK') so they
   * work identically on any keyboard layout.
   */
  private handleListKeydown(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // Focus inside the search input: this event is (or bubbles from) typing —
    // let handleSearchKeydown semantics apply, do not navigate.
    const target = e.target as HTMLElement | null;
    if (target !== null && target === this.searchInputEl) return;

    const rows = this.currentRows();

    // Tab / Shift+Tab walk the list in step with the highlight, like j/k. The
    // rows are real buttons, so without this native Tab moved focus while the
    // highlight (and therefore Enter) stayed on the old row. At the boundaries
    // focus is handed back to the search input (Shift+Tab from the first row)
    // or left to the browser's order (Tab from the last row), so the list never
    // traps focus.
    if (e.key === 'Tab') {
      if (rows.length === 0) return;
      const focusedIndex = rows.indexOf(target as HTMLElement);
      const from = focusedIndex !== -1 ? focusedIndex : this.highlightedIndex;
      if (e.shiftKey) {
        e.preventDefault();
        if (from <= 0) {
          this.searchInputEl?.focus({ preventScroll: true });
          return;
        }
        this.applyHighlight(rows, from - 1);
        this.highlightedRowEl?.focus({ preventScroll: true });
        return;
      }
      if (from === rows.length - 1) return;
      e.preventDefault();
      this.applyHighlight(rows, from + 1);
      this.highlightedRowEl?.focus({ preventScroll: true });
      return;
    }

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (rows.length === 0) return;
      e.preventDefault();
      this.moveHighlight(rows, e.key === 'ArrowDown' ? 1 : -1);
      return;
    }

    if (e.code === 'KeyJ' || e.code === 'KeyK') {
      if (rows.length === 0) return;
      e.preventDefault();
      this.moveHighlight(rows, e.code === 'KeyJ' ? 1 : -1);
      return;
    }

    if (e.key === 'Enter') {
      // No-op + no-throw when nothing is highlighted.
      if (this.highlightedIndex === -1 || this.highlightedRowEl === null) return;
      e.preventDefault();
      this.highlightedRowEl.click();
      return;
    }
  }

  /** All visible folder/file rows under the current root, in document order.
   *  Never cached — always re-queried so a fresh re-render's rows are used. */
  private currentRows(): HTMLElement[] {
    const root = this.rootEl();
    if (!root) return [];
    return Array.from(root.querySelectorAll<HTMLElement>('.rp-stp-folder-row, .rp-stp-file-row'));
  }

  /** Move the highlight cursor by `delta` with wrap-around modulo rows.length. */
  private moveHighlight(rows: HTMLElement[], delta: number): void {
    const count = rows.length;
    if (count === 0) return;

    let next: number;
    if (this.highlightedIndex === -1) {
      // Nothing highlighted: ArrowDown → first (0), ArrowUp → last (count-1).
      next = delta === 1 ? 0 : count - 1;
    } else {
      next = (this.highlightedIndex + delta + count) % count;
    }
    this.applyHighlight(rows, next);
  }

  /** Put the highlight on `next`, re-anchoring an out-of-sync focus, and announce it. */
  private applyHighlight(rows: HTMLElement[], next: number): void {
    // Toggle the old highlight off (the old element is still live at this point).
    if (this.highlightedRowEl !== null) {
      this.highlightedRowEl.classList.remove('rp-stp-row-highlighted');
    }

    const row = rows[next];
    if (row === undefined) return;

    row.classList.add('rp-stp-row-highlighted');
    row.scrollIntoView({ block: 'nearest' });

    this.highlightedIndex = next;
    this.highlightedRowEl = row;

    // Announce the highlighted row title via the aria-live status span.
    const titleEl = row.querySelector<HTMLElement>('.rp-stp-row-title');
    const name = titleEl?.textContent ?? '';
    if (this.highlightStatusEl !== null) {
      this.highlightStatusEl.textContent = this.t('snippetTreePicker.highlightAria', { name });
    }
  }

  /** Reset the highlight cursor. Called at the top of every body re-render
   *  (renderDrillView / renderSearchResults) right after removeBody(host) —
   *  the previously-highlighted row is already detached by removeBody(), so
   *  no class removal is needed; just reset the cursor. */
  private clearHighlight(): void {
    this.highlightedIndex = -1;
    this.highlightedRowEl = null;
  }
}
