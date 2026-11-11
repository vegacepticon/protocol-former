// Phase 33 Plan 04 — SnippetTreeView tests (TREE-01..04, FOLDER-01..03,
// DEL-02/03, MODAL-04).
//
// Strategy: We mock 'obsidian' locally so ItemView exposes a DOM-ish
// contentEl and registerDomEvent/registerEvent spies. We also mock
// snippet-editor-modal and confirm-modal so we can observe constructor args
// without running their internals.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// --- Menu item capture (shared with dnd/inline-rename suites) -----------
interface CapturedMenuItem { title: string; icon?: string; cb: () => void }
let lastMenuItems: CapturedMenuItem[] = [];

// Stub browser globals used by snippet-manager-view.ts
// (document.createElement for modal form bodies; window.setTimeout/clearTimeout
// for debounced redraw).
(globalThis as any).window = globalThis;
(globalThis as any).document = {
  createElement: (_tag: string) => makeEl(_tag),
};

// --- Minimal DOM-ish mock element ----------------------------------------
interface MockEl {
  tagName: string;
  children: MockEl[];
  parent: MockEl | null;
  textContent: string;
  _text: string;
  classList: Set<string>;
  _attrs: Record<string, string>;
  _style: Record<string, string>;
  _listeners: Map<string, Array<(ev: unknown) => void>>;
  dataset: Record<string, string>;
  value: string;
  placeholder: string;
  createEl: (tag: string, opts?: { text?: string; cls?: string; type?: string; attr?: Record<string, string> }) => MockEl;
  createDiv: (opts?: { cls?: string; text?: string }) => MockEl;
  createSpan: (opts?: { cls?: string; text?: string }) => MockEl;
  empty: () => void;
  setText: (text: string) => void;
  appendChild: (child: MockEl) => MockEl;
  addClass: (cls: string) => void;
  removeClass: (cls: string) => void;
  setAttribute: (k: string, v: string) => void;
  setAttr: (name: string, value: string) => void;
  getAttribute: (k: string) => string | null;
  addEventListener: (type: string, handler: (ev: unknown) => void) => void;
  dispatchEvent: (event: { type: string; target?: unknown; preventDefault?: () => void; stopPropagation?: () => void }) => void;
  closest: (sel: string) => MockEl | null;
  querySelector: (sel: string) => MockEl | null;
  querySelectorAll: (sel: string) => MockEl[];
  focus: () => void;
  style: Record<string, string>;
}

function makeEl(tag = 'div'): MockEl {
  const listeners = new Map<string, Array<(ev: unknown) => void>>();
  const style: Record<string, string> = {};
  const attrs: Record<string, string> = {};
  const dataset: Record<string, string> = {};
  const classSet = new Set<string>();
  const children: MockEl[] = [];
  const el = {
    tagName: tag.toUpperCase(),
    children,
    parent: null as MockEl | null,
    _text: '',
    textContent: '',
    classList: classSet,
    _attrs: attrs,
    _style: style,
    _listeners: listeners,
    dataset,
    value: '',
    placeholder: '',
    style,
    createEl(t: string, opts?: { text?: string; cls?: string; type?: string; attr?: Record<string, string> }): MockEl {
      const child = makeEl(t);
      child.parent = el as unknown as MockEl;
      if (opts?.text !== undefined) { child._text = opts.text; child.textContent = opts.text; }
      if (opts?.cls) {
        for (const c of opts.cls.split(/\s+/)) child.classList.add(c);
      }
      if (opts?.attr) {
        for (const [k, v] of Object.entries(opts.attr)) child._attrs[k] = v;
      }
      children.push(child);
      return child;
    },
    createDiv(opts?: { cls?: string; text?: string }): MockEl {
      return (this as unknown as MockEl).createEl('div', opts);
    },
    createSpan(opts?: { cls?: string; text?: string }): MockEl {
      return (this as unknown as MockEl).createEl('span', opts);
    },
    empty(): void {
      children.length = 0;
    },
    setText(text: string): void {
      el._text = text;
      el.textContent = text;
    },
    appendChild(child: MockEl): MockEl {
      child.parent = el as unknown as MockEl;
      children.push(child);
      return child;
    },
    addClass(cls: string): void { classSet.add(cls); },
    removeClass(cls: string): void { classSet.delete(cls); },
    setAttribute(k: string, v: string): void { attrs[k] = v; },
    setAttr(name: string, value: string): void { attrs[name] = value; },
    getAttribute(k: string): string | null { return attrs[k] ?? null; },
    addEventListener(type: string, handler: (ev: unknown) => void): void {
      const arr = listeners.get(type) ?? [];
      arr.push(handler);
      listeners.set(type, arr);
    },
    dispatchEvent(event: { type: string; target?: unknown; preventDefault?: () => void; stopPropagation?: () => void }): void {
      const arr = listeners.get(event.type) ?? [];
      for (const h of arr) h(event);
    },
    closest(_sel: string): MockEl | null { return null; },
    querySelector(_sel: string): MockEl | null { return null; },
    querySelectorAll(_sel: string): MockEl[] { return []; },
    focus(): void {},
  };
  return el;
}

// Collect every row ever created during render (deep walk)
function walkRows(root: MockEl, acc: MockEl[] = []): MockEl[] {
  for (const c of root.children) {
    if (c.classList.has('radi-snippet-tree-row')) acc.push(c);
    walkRows(c, acc);
  }
  return acc;
}

// Rows in a single pane, excluding empty-folder placeholders.
function rowsIn(root: MockEl): MockEl[] {
  return walkRows(root).filter((row) =>
    !row.classList.has('radi-snippet-tree-empty-placeholder'),
  );
}

// --- vi.mock('obsidian', ...) --------------------------------------------
let noticeMessages: string[] = [];

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

vi.mock('obsidian', () => {
  class ItemView {
    leaf: unknown;
    contentEl: MockEl;
    app: { vault: { on: (ev: string, cb: unknown) => { ref: string } } };
    _registeredEvents: Array<{ ref: string }> = [];
    _registeredDomEvents: Array<{ el: MockEl; type: string; handler: (ev: unknown) => void }> = [];
    constructor(leaf: unknown) {
      this.leaf = leaf;
      this.contentEl = makeEl('div');
      // Capture vault.on registrations so tests can fire them later.
      this.app = { vault: { on: vi.fn((_ev: string, _cb: unknown) => ({ ref: _ev })) } };
    }
    registerEvent(ref: { ref: string }): void { this._registeredEvents.push(ref); }
    registerDomEvent(el: MockEl, type: string, handler: (ev: unknown) => void): void {
      this._registeredDomEvents.push({ el, type, handler });
      el.addEventListener(type, handler);
    }
    getViewType(): string { return ''; }
    getDisplayText(): string { return ''; }
    getIcon(): string { return ''; }
  }
  class WorkspaceLeaf {}
  class Notice {
    message: string;
    constructor(msg: string) {
      this.message = msg;
      noticeMessages.push(msg);
    }
  }
  const setIcon = vi.fn((_el: unknown, _icon: string) => {});
  class Menu {
    items: CapturedMenuItem[] = [];
    addItem(cb: (item: { setTitle: (t: string) => any; setIcon: (i: string) => any; onClick: (c: () => void) => any }) => void): this {
      const state: CapturedMenuItem = { title: '', cb: () => {} };
      const api = {
        setTitle: (t: string) => { state.title = t; return api; },
        setIcon: (i: string) => { state.icon = i; return api; },
        onClick: (c: () => void) => { state.cb = c; return api; },
      };
      cb(api);
      this.items.push(state);
      lastMenuItems = this.items;
      return this;
    }
    addSeparator(): this { return this; }
    showAtMouseEvent(_ev: unknown): void {}
  }
  // Phase 34: SuggestModal stub — folder-picker-modal.ts imports it transitively
  class SuggestModal<T> {
    app: unknown;
    constructor(app: unknown) { this.app = app; }
    setPlaceholder(_p: string): void {}
    getSuggestions(_q: string): T[] | Promise<T[]> { return []; }
    renderSuggestion(_v: T, _el: unknown): void {}
    onChooseSuggestion(_v: T, _ev: unknown): void {}
    open(): void {}
    close(): void {}
  }
  return { ItemView, WorkspaceLeaf, Notice, setIcon, Menu, SuggestModal };
});

// --- Mock SnippetEditorModal & ConfirmModal ------------------------------
const snippetEditorModalCtorSpy = vi.fn();
let snippetEditorModalNextResult: { saved: boolean } = { saved: false };
// Optional deferred result: when set, the next-constructed modal awaits this
// promise instead of resolving immediately, so a test can interleave work
// between modal.open() and modal.result settlement.
let snippetEditorModalResultPromise: Promise<{ saved: boolean }> | null = null;
vi.mock('../views/snippet-editor-modal', () => ({
  SnippetEditorModal: class {
    readonly result: Promise<{ saved: boolean }>;
    constructor(app: unknown, plugin: unknown, options: unknown) {
      snippetEditorModalCtorSpy(app, plugin, options);
      this.result = snippetEditorModalResultPromise ?? Promise.resolve(snippetEditorModalNextResult);
    }
    open(): void {}
    close(): void {}
  },
}));

const confirmModalCtorSpy = vi.fn();
let confirmModalNextResult: 'confirm' | 'cancel' | 'discard' = 'cancel';
vi.mock('../views/confirm-modal', () => ({
  ConfirmModal: class {
    readonly result: Promise<'confirm' | 'cancel' | 'discard'>;
    constructor(_app: unknown, options: unknown) {
      confirmModalCtorSpy(options);
      this.result = Promise.resolve(confirmModalNextResult);
    }
    open(): void {}
    close(): void {}
  },
}));

// --- Now import the module under test ------------------------------------
import { SnippetManagerView } from '../views/snippet-manager-view';
import type { Snippet } from '../snippets/snippet-model';
// Phase 84 (I18N-02): SnippetManagerView reads plugin.i18n.t(...) for copy.
import { I18nService } from '../i18n';

// --- Mock plugin factory --------------------------------------------------
interface MockService {
  listFolder: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  deleteFolder: ReturnType<typeof vi.fn>;
  createFolder: ReturnType<typeof vi.fn>;
  listFolderDescendants: ReturnType<typeof vi.fn>;
  searchSnippets: ReturnType<typeof vi.fn>;
  duplicateSnippet: ReturnType<typeof vi.fn>;
}

function makeSnippet(kind: 'md-template' | 'md', p: string, name: string): Snippet {
  if (kind === 'md-template') {
    return { kind: 'md-template', path: p, name, template: '', placeholders: [], validationError: null };
  }
  return { kind: 'md', path: p, name, content: '' };
}

function makePlugin(opts: {
  listings?: Record<string, { folders: string[]; snippets: Snippet[] }>;
  expanded?: string[];
  descendants?: { files: string[]; folders: string[]; total: number };
} = {}): { plugin: any; service: MockService } {
  const listings = opts.listings ?? {
    '.radiprotocol/snippets': { folders: [], snippets: [] },
  };
  const service: MockService = {
    listFolder: vi.fn((p: string) => Promise.resolve(listings[p] ?? { folders: [], snippets: [] })),
    load: vi.fn((p: string) => {
      for (const l of Object.values(listings)) {
        const found = l.snippets.find((s) => s.path === p);
        if (found) return Promise.resolve(found);
      }
      return Promise.resolve(null);
    }),
    delete: vi.fn().mockResolvedValue(undefined),
    deleteFolder: vi.fn().mockResolvedValue(undefined),
    createFolder: vi.fn().mockResolvedValue(undefined),
    listFolderDescendants: vi
      .fn()
      .mockResolvedValue(opts.descendants ?? { files: [], folders: [], total: 0 }),
    searchSnippets: vi.fn().mockResolvedValue([]),
    duplicateSnippet: vi.fn((sp: string) => Promise.resolve(sp.replace(/\.md$/, '-copy.md'))),
  };
  const plugin = {
    app: { vault: { on: vi.fn((_ev: string) => ({ ref: _ev })) } },
    settings: {
      snippetFolderPath: '.radiprotocol/snippets',
      snippetTreeExpandedPaths: opts.expanded ?? [],
    },
    snippetService: service,
    saveSettings: vi.fn().mockResolvedValue(undefined),
    i18n: new I18nService('en'),
  };
  return { plugin, service };
}

function makeView(plugin: any): SnippetManagerView {
  const leaf = {} as any;
  const view = new SnippetManagerView(leaf, plugin);
  // The mocked ItemView constructor wires contentEl + app (a local vault mock).
  // Replace view.app with our plugin.app so vault.on handlers use the plugin's
  // vault spy.
  (view as any).app = plugin.app;
  return view;
}

// ============================================================================
// TREE-01..04, FOLDER-01..03, DEL-02/03, MODAL-04
// ============================================================================
describe('SnippetManagerView — tree rendering and interactions', () => {
  beforeEach(() => {
    snippetEditorModalCtorSpy.mockClear();
    confirmModalCtorSpy.mockClear();
    snippetEditorModalNextResult = { saved: false };
    snippetEditorModalResultPromise = null;
    confirmModalNextResult = 'cancel';
    lastMenuItems = [];
    noticeMessages = [];
  });

  it('TREE-01: renders a visible selected root, folders only on the left, and direct root snippets on the right', async () => {
    const root = '.radiprotocol/snippets';
    const { plugin } = makePlugin({
      listings: {
        [root]: {
          folders: ['fldA'],
          snippets: [makeSnippet('md-template', `${root}/a.md`, 'a')],
        },
        [`${root}/fldA`]: {
          folders: [],
          snippets: [makeSnippet('md', `${root}/fldA/nested.md`, 'nested')],
        },
      },
    });
    const view = makeView(plugin);
    await view.onOpen();

    const folderRows = rowsIn((view as any).folderRootEl as MockEl);
    const snippetRows = rowsIn((view as any).snippetRootEl as MockEl);
    expect(folderRows.map((row) => row._attrs['data-path'])).toEqual([root, `${root}/fldA`]);
    expect(folderRows.every((row) => row._attrs['data-kind'] === 'folder')).toBe(true);
    expect(folderRows[0]!._attrs['aria-selected']).toBe('true');
    expect(snippetRows.map((row) => row._attrs['data-path'])).toEqual([`${root}/a.md`]);
    expect(snippetRows[0]!.children.some((child) => child.classList.has('radi-snippet-tree-icon'))).toBe(false);
  });

  it('TREE-02: removes all header action buttons and renders the two-pane shell', async () => {
    const { plugin } = makePlugin();
    const view = makeView(plugin);
    await view.onOpen();
    const content = (view as any).contentEl as MockEl;
    expect(content.children.some((child) => child.classList.has('radi-snippet-tree-header'))).toBe(false);
    expect(content.children.some((child) => child.classList.has('radi-snippet-manager-layout'))).toBe(true);
    // Pane roots carry no hover-tooltip aria-label; screen-reader names come from
    // visually-hidden <h2> headings recreated as the first child of each pane.
    const folderRoot = (view as any).folderRootEl as MockEl;
    const snippetRoot = (view as any).snippetRootEl as MockEl;
    expect(folderRoot._attrs['aria-label']).toBeUndefined();
    expect(snippetRoot._attrs['aria-label']).toBeUndefined();
    expect(folderRoot.children[0]!.tagName).toBe('H2');
    expect(folderRoot.children[0]!.classList.has('rp-sr-only')).toBe(true);
    expect(folderRoot.children[0]!._text).toBe(plugin.i18n.t('snippetManager.folderPaneAria'));
    expect(snippetRoot.children[0]!.tagName).toBe('H2');
    expect(snippetRoot.children[0]!.classList.has('rp-sr-only')).toBe(true);
    expect(snippetRoot.children[0]!._text).toBe(plugin.i18n.t('snippetManager.snippetPaneAria'));
  });

  it('TREE-03: clicking a folder selects it without changing expansion and refreshes direct snippets', async () => {
    const root = '.radiprotocol/snippets';
    const { plugin } = makePlugin({
      listings: {
        [root]: { folders: ['fldA'], snippets: [] },
        [`${root}/fldA`]: { folders: [], snippets: [makeSnippet('md', `${root}/fldA/nested.md`, 'nested')] },
      },
    });
    const view = makeView(plugin);
    await view.onOpen();
    const folderRow = rowsIn((view as any).folderRootEl as MockEl)
      .find((row) => row._attrs['data-path'] === `${root}/fldA`)!;
    folderRow.dispatchEvent({ type: 'click', target: folderRow });
    await flushAsync();

    expect(plugin.settings.snippetTreeExpandedPaths).toEqual([]);
    expect((view as any).selectedFolderPath).toBe(`${root}/fldA`);
    expect(rowsIn((view as any).snippetRootEl as MockEl).map((row) => row._attrs['data-path']))
      .toEqual([`${root}/fldA/nested.md`]);
  });

  it('TREE-04: clicking a folder chevron toggles expansion without changing selection', async () => {
    const root = '.radiprotocol/snippets';
    const { plugin } = makePlugin({
      listings: {
        [root]: { folders: ['fldA'], snippets: [] },
        [`${root}/fldA`]: { folders: [], snippets: [] },
      },
    });
    const view = makeView(plugin);
    await view.onOpen();
    const folderRow = rowsIn((view as any).folderRootEl as MockEl)
      .find((row) => row._attrs['data-path'] === `${root}/fldA`)!;
    const chevron = folderRow.children.find((child) => child.classList.has('radi-snippet-tree-chevron'))!;
    chevron.dispatchEvent({
      type: 'click',
      target: chevron,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });
    await Promise.resolve();

    expect(plugin.settings.snippetTreeExpandedPaths).toContain(`${root}/fldA`);
    expect((view as any).selectedFolderPath).toBe(root);
  });

  it('ROOT-01: empty-area context menu offers root-targeted snippet and folder creation', async () => {
    const { plugin } = makePlugin();
    const view = makeView(plugin);
    await view.onOpen();
    const layout = ((view as any).contentEl as MockEl).children
      .find((child) => child.classList.has('radi-snippet-manager-layout'))!;
    layout.dispatchEvent({
      type: 'contextmenu',
      target: layout,
      preventDefault: vi.fn(),
    });
    expect(lastMenuItems.map((item) => item.title)).toEqual([
      'Create snippet here',
      'Create subfolder',
    ]);
  });

  it('FOLDER-01: confirming the «Создать подпапку» flow calls service.createFolder with parent + name', async () => {
    const root = '.radiprotocol/snippets';
    const { plugin, service } = makePlugin({
      listings: {
        [root]: { folders: ['parent'], snippets: [] },
        [`${root}/parent`]: { folders: [], snippets: [] },
      },
    });
    const view = makeView(plugin);
    await view.onOpen();

    // Directly invoke the private handler via cast (context menu → item onClick)
    const handleCreateSubfolder = (view as any).handleCreateSubfolder.bind(view);
    confirmModalNextResult = 'confirm';
    // Synchronously patch the next ConfirmModal construction so that the
    // input inside the body is pre-filled with 'sub' before the confirm
    // result resolves. Our ConfirmModal mock captures `options` via spy —
    // the input MockEl is body's first input child.
    const original = confirmModalCtorSpy;
    original.mockImplementationOnce((options: any) => {
      // Walk options.body children to find the input we created
      const body = options.body as MockEl;
      const input = body.children.find((c: MockEl) => c.tagName === 'LABEL')?.children.find((c: MockEl) => c.tagName === 'INPUT');
      if (input) input.value = 'sub';
    });

    await handleCreateSubfolder(`${root}/parent`);
    expect(service.createFolder).toHaveBeenCalledWith(`${root}/parent/sub`);
  });

  it('FOLDER-02: folder delete confirm body lists first 10 descendants + «…и ещё N» tail', async () => {
    const root = '.radiprotocol/snippets';
    const files: string[] = [];
    for (let i = 0; i < 12; i++) files.push(`${root}/big/f${i}.json`);
    const { plugin, service } = makePlugin({
      descendants: { files, folders: [], total: 12 },
      listings: {
        [root]: { folders: ['big'], snippets: [] },
        [`${root}/big`]: { folders: [], snippets: [] },
      },
    });
    const view = makeView(plugin);
    await view.onOpen();
    confirmModalNextResult = 'confirm';

    const handleDeleteFolder = (view as any).handleDeleteFolder.bind(view);
    await handleDeleteFolder(`${root}/big`, 'big');

    // ConfirmModal was constructed with a body containing up to 10 items + tail
    expect(confirmModalCtorSpy).toHaveBeenCalled();
    const options = confirmModalCtorSpy.mock.calls[0]![0] as any;
    expect(options.title).toContain('big');
    expect(options.destructive).toBe(true);
    const bodyText = JSON.stringify(collectTextNodes(options.body as MockEl));
    expect(bodyText).toContain('…and 2 more items.');
    // First 10 items listed
    for (let i = 0; i < 10; i++) {
      expect(bodyText).toContain(`f${i}.json`);
    }
    // Service was called on confirm
    expect(service.deleteFolder).toHaveBeenCalledWith(`${root}/big`);
  });

  it('FOLDER-03: hover-action «+» button opens SnippetEditorModal in create mode pre-filled to folder path', async () => {
    const root = '.radiprotocol/snippets';
    const { plugin } = makePlugin({
      listings: {
        [root]: { folders: ['sub'], snippets: [] },
        [`${root}/sub`]: { folders: [], snippets: [] },
      },
    });
    const view = makeView(plugin);
    await view.onOpen();

    // Directly invoke openCreateModal(sub) — the code path triggered by the
    // hover «+» button. We test the outcome (modal constructed with correct
    // options) rather than re-simulating the full listener chain.
    const openCreateModal = (view as any).openCreateModal.bind(view);
    await openCreateModal(`${root}/sub`);
    expect(snippetEditorModalCtorSpy).toHaveBeenCalled();
    const call = snippetEditorModalCtorSpy.mock.calls[0]!;
    const options = call[2];
    expect((options as any).mode).toBe('create');
    expect((options as any).initialFolder).toBe(`${root}/sub`);
  });

  it('DEL-02: deleting a snippet opens ConfirmModal then calls service.delete on confirm', async () => {
    const root = '.radiprotocol/snippets';
    const { plugin, service } = makePlugin({
      listings: {
        [root]: { folders: [], snippets: [makeSnippet('md-template', `${root}/gone.md`, 'gone')] },
      },
    });
    const view = makeView(plugin);
    await view.onOpen();
    confirmModalNextResult = 'confirm';

    const handleDeleteSnippet = (view as any).handleDeleteSnippet.bind(view);
    await handleDeleteSnippet(`${root}/gone.md`, 'gone');

    expect(confirmModalCtorSpy).toHaveBeenCalled();
    const options = confirmModalCtorSpy.mock.calls[0]![0] as any;
    expect(options.title).toBe('Delete snippet?');
    expect(String(options.body)).toContain('gone');
    expect(options.destructive).toBe(true);
    expect(service.delete).toHaveBeenCalledWith(`${root}/gone.md`);
  });

  it('DEL-03: after delete, rebuild omits the deleted path from listFolder results', async () => {
    const root = '.radiprotocol/snippets';
    const listings: Record<string, { folders: string[]; snippets: Snippet[] }> = {
      [root]: { folders: [], snippets: [makeSnippet('md-template', `${root}/x.md`, 'x')] },
    };
    const { plugin, service } = makePlugin({ listings });
    // Service.delete mutates the fixture to emulate disk-level removal.
    service.delete.mockImplementation(async (p: string) => {
      const bucket = listings[root]!;
      bucket.snippets = bucket.snippets.filter((s) => s.path !== p);
    });
    const view = makeView(plugin);
    await view.onOpen();
    confirmModalNextResult = 'confirm';

    await (view as any).handleDeleteSnippet(`${root}/x.md`, 'x');
    // After the handler, service.listFolder should no longer see the path.
    const listing = (await (service.listFolder as unknown as (p: string) => Promise<{ folders: string[]; snippets: Snippet[] }>)(root));
    expect(listing.snippets.find((s: Snippet) => s.path === `${root}/x.md`)).toBeUndefined();
    // And the rendered tree should not include it either
    const rows = walkRows((view as any).contentEl as MockEl);
    expect(rows.find((r) => r._attrs['data-path'] === `${root}/x.md`)).toBeUndefined();
  });
  it('DUPLICATE-CTX: file context menu offers Duplicate after Move and before Delete; invoking it calls the service and refreshes', async () => {
    const root = '.radiprotocol/snippets';
    const snippetPath = `${root}/gone.md`;
    const { plugin, service } = makePlugin({
      listings: {
        [root]: { folders: [], snippets: [makeSnippet('md-template', snippetPath, 'gone')] },
      },
    });
    const view = makeView(plugin);
    await view.onOpen();
    const fileRow = rowsIn((view as any).snippetRootEl as MockEl)
      .find((row) => row._attrs['data-path'] === snippetPath)!;
    fileRow.dispatchEvent({
      type: 'contextmenu',
      target: fileRow,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });
    const titles = lastMenuItems.map((item) => item.title);
    // Edit → Rename → Move → Duplicate → (separator) → Delete
    const moveIdx = titles.indexOf('Move to…');
    const dupIdx = titles.indexOf('Duplicate snippet');
    const deleteIdx = titles.indexOf('Delete');
    expect(dupIdx).toBeGreaterThanOrEqual(0);
    expect(moveIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeGreaterThanOrEqual(0);
    expect(moveIdx).toBeLessThan(dupIdx);
    expect(dupIdx).toBeLessThan(deleteIdx);
    // Invoke the Duplicate menu item.
    const dupItem = lastMenuItems[dupIdx]!;
    dupItem.cb();
    await flushAsync();
    expect(service.duplicateSnippet).toHaveBeenCalledWith(snippetPath);
  });

  it('DUPLICATE-CTX: service failure surfaces the localized duplicateError Notice', async () => {
    const root = '.radiprotocol/snippets';
    const snippetPath = `${root}/gone.md`;
    const { plugin, service } = makePlugin({
      listings: {
        [root]: { folders: [], snippets: [makeSnippet('md-template', snippetPath, 'gone')] },
      },
    });
    service.duplicateSnippet = vi.fn().mockRejectedValue(new Error('boom'));
    const view = makeView(plugin);
    await view.onOpen();
    const fileRow = rowsIn((view as any).snippetRootEl as MockEl)
      .find((row) => row._attrs['data-path'] === snippetPath)!;
    fileRow.dispatchEvent({
      type: 'contextmenu',
      target: fileRow,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });
    const dupItem = lastMenuItems.find((item) => item.title === 'Duplicate snippet')!;
    dupItem.cb();
    await flushAsync();
    expect(service.duplicateSnippet).toHaveBeenCalledWith(snippetPath);
    expect(noticeMessages.some((m) => m.includes('Failed to duplicate snippet'))).toBe(true);
  });

  it('MODAL-04: global "+ Новый" opens create modal pre-filled to snippetFolderPath (root)', async () => {
    const { plugin } = makePlugin();
    const view = makeView(plugin);
    await view.onOpen();
    const openCreateModal = (view as any).openCreateModal.bind(view);
    await openCreateModal(plugin.settings.snippetFolderPath);
    expect(snippetEditorModalCtorSpy).toHaveBeenCalled();
    const call = snippetEditorModalCtorSpy.mock.calls[0]!;
    const options = call[2];
    expect((options as any).mode).toBe('create');
    expect((options as any).initialFolder).toBe('.radiprotocol/snippets');
  });

  it('DELETE-FALLBACK: deleting the selected folder falls back to the nearest surviving ancestor and prunes stale expansion descendants', async () => {
    const root = '.radiprotocol/snippets';
    const listings: Record<string, { folders: string[]; snippets: Snippet[] }> = {
      [root]: { folders: ['a'], snippets: [] },
      [`${root}/a`]: { folders: ['sub'], snippets: [] },
      [`${root}/a/sub`]: { folders: [], snippets: [] },
    };
    const { plugin, service } = makePlugin({
      listings,
      expanded: [`${root}/a`, `${root}/a/sub`],
    });
    service.listFolder.mockImplementation(async (p: string) =>
      Promise.resolve(listings[p] ?? { folders: [], snippets: [] }),
    );
    service.deleteFolder.mockImplementation(async (p: string) => {
      const parent = p.slice(0, p.lastIndexOf('/'));
      const base = p.slice(p.lastIndexOf('/') + 1);
      if (listings[parent]) {
        listings[parent].folders = listings[parent].folders.filter((f: string) => f !== base);
      }
      for (const key of Object.keys(listings)) {
        if (key === p || key.startsWith(`${p}/`)) delete listings[key];
      }
    });
    const view = makeView(plugin);
    await view.onOpen();
    await (view as any).selectFolder(`${root}/a/sub`);
    confirmModalNextResult = 'confirm';
    await (view as any).handleDeleteFolder(`${root}/a`, 'a');

    expect((view as any).selectedFolderPath).toBe(root);
    expect(plugin.settings.snippetTreeExpandedPaths).not.toContain(`${root}/a`);
    expect(plugin.settings.snippetTreeExpandedPaths).not.toContain(`${root}/a/sub`);
  });
});

// ============================================================================
// Phase 4: global search — flat results, stale rejection, close-during-search
// ============================================================================
describe('SnippetManagerView — global search (Phase 4)', () => {
  beforeEach(() => {
    snippetEditorModalCtorSpy.mockClear();
    confirmModalCtorSpy.mockClear();
    snippetEditorModalNextResult = { saved: false };
    snippetEditorModalResultPromise = null;
    confirmModalNextResult = 'cancel';
    lastMenuItems = [];
    noticeMessages = [];
  });

  function findSearchInput(view: any): MockEl {
    return ((view as any).contentEl as MockEl).children
      .find((child) => child.classList.has('radi-snippet-manager-search'))!
      .children.find((child) => child.tagName === 'INPUT')!;
  }

  it('SEARCH: global search shows flat results with folder paths; clearing restores the selected folder list', async () => {
    const root = '.radiprotocol/snippets';
    const { plugin, service } = makePlugin({
      listings: {
        [root]: { folders: ['Chest'], snippets: [makeSnippet('md', `${root}/root.md`, 'root')] },
        [`${root}/Chest`]: { folders: [], snippets: [makeSnippet('md', `${root}/Chest/ct.md`, 'ct')] },
      },
    });
    service.searchSnippets = vi.fn(async () => [
      { snippet: { kind: 'md', path: `${root}/Chest/ct.md`, name: 'ct', content: '' }, folderPath: `${root}/Chest` },
    ]);
    const view = makeView(plugin);
    await view.onOpen();
    const searchInput = findSearchInput(view);
    searchInput.value = 'ct';
    searchInput.dispatchEvent({ type: 'input', target: searchInput });
    await new Promise((resolve) => setTimeout(resolve, 180));
    expect(service.searchSnippets).toHaveBeenCalledWith('ct');
    expect(walkRows((view as any).snippetRootEl as MockEl).map((row) => row._attrs['data-path']))
      .toEqual([`${root}/Chest/ct.md`]);
    // Headings survive the search-result redraw.
    expect(((view as any).folderRootEl as MockEl).children[0]!.tagName).toBe('H2');
    expect(((view as any).snippetRootEl as MockEl).children[0]!.tagName).toBe('H2');
    searchInput.value = '';
    searchInput.dispatchEvent({ type: 'input', target: searchInput });
    await new Promise((resolve) => setTimeout(resolve, 180));
    expect(walkRows((view as any).snippetRootEl as MockEl).map((row) => row._attrs['data-path']))
      .toEqual([`${root}/root.md`]);
    // Headings survive the restore-to-folder redraw as well.
    expect(((view as any).folderRootEl as MockEl).children[0]!.tagName).toBe('H2');
    expect(((view as any).snippetRootEl as MockEl).children[0]!.tagName).toBe('H2');
  });

  it('SEARCH: stale completion does not overwrite newer results', async () => {
    const root = '.radiprotocol/snippets';
    const { plugin, service } = makePlugin({ listings: { [root]: { folders: [], snippets: [] } } });
    let resolveFirst: () => void;
    const first = new Promise<void>((resolve) => { resolveFirst = resolve; });
    service.searchSnippets = vi.fn()
      .mockReturnValueOnce(first.then(() => [{ snippet: { kind: 'md' as const, path: `${root}/old.md`, name: 'old', content: '' }, folderPath: root }]))
      .mockReturnValueOnce(Promise.resolve([{ snippet: { kind: 'md' as const, path: `${root}/new.md`, name: 'new', content: '' }, folderPath: root }]));
    const view = makeView(plugin);
    await view.onOpen();
    const searchInput = findSearchInput(view);
    searchInput.value = 'a'; searchInput.dispatchEvent({ type: 'input', target: searchInput });
    await new Promise((resolve) => setTimeout(resolve, 180));
    searchInput.value = 'b'; searchInput.dispatchEvent({ type: 'input', target: searchInput });
    await new Promise((resolve) => setTimeout(resolve, 180));
    resolveFirst!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(walkRows((view as any).snippetRootEl as MockEl).map((row) => row._attrs['data-path']))
      .toEqual([`${root}/new.md`]);
  });

  it('SEARCH: close during in-flight search does not mutate DOM', async () => {
    const root = '.radiprotocol/snippets';
    const { plugin, service } = makePlugin({ listings: { [root]: { folders: [], snippets: [] } } });
    let resolveSearch: () => void;
    service.searchSnippets = vi.fn().mockReturnValue(new Promise((resolve) => { resolveSearch = () => resolve([{ snippet: { kind: 'md' as const, path: `${root}/late.md`, name: 'late', content: '' }, folderPath: root }]); }));
    const view = makeView(plugin);
    await view.onOpen();
    const searchInput = findSearchInput(view);
    searchInput.value = 'late'; searchInput.dispatchEvent({ type: 'input', target: searchInput });
    await new Promise((resolve) => setTimeout(resolve, 180));
    const rowsBeforeClose = walkRows((view as any).snippetRootEl as MockEl).length;
    await view.onClose();
    resolveSearch!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(walkRows((view as any).snippetRootEl as MockEl).length).toBe(rowsBeforeClose);
  });

  it('SEARCH: keeps prior results visible and scanning owned until replacement completes', async () => {
    const root = '.radiprotocol/snippets';
    const { plugin, service } = makePlugin();
    const view = makeView(plugin);
    await view.onOpen();
    service.searchSnippets.mockResolvedValueOnce([
      { snippet: makeSnippet('md', `${root}/old.md`, 'old'), folderPath: root },
    ]);
    (view as any).searchQuery = 'old';
    await (view as any).refresh();
    const replacement = deferred<Array<{ snippet: Snippet; folderPath: string }>>();
    service.searchSnippets.mockReturnValueOnce(replacement.promise);
    (view as any).searchQuery = 'new';
    const pending = (view as any).refresh() as Promise<boolean>;
    await flushAsync();
    expect(rowsIn((view as any).snippetRootEl as MockEl).map((row) => row._attrs['data-path']))
      .toEqual([`${root}/old.md`]);
    expect(((view as any).searchWrapEl as MockEl).classList.has('is-scanning')).toBe(true);
    replacement.resolve([
      { snippet: makeSnippet('md', `${root}/new.md`, 'new'), folderPath: root },
    ]);
    await pending;
    expect(rowsIn((view as any).snippetRootEl as MockEl).map((row) => row._attrs['data-path']))
      .toEqual([`${root}/new.md`]);
    expect(((view as any).searchWrapEl as MockEl).classList.has('is-scanning')).toBe(false);
  });

  it('SEARCH: rejects the first completion in an A→B→A race', async () => {
    const root = '.radiprotocol/snippets';
    const { plugin, service } = makePlugin();
    const firstA = deferred<Array<{ snippet: Snippet; folderPath: string }>>();
    const secondA = deferred<Array<{ snippet: Snippet; folderPath: string }>>();
    service.searchSnippets
      .mockReturnValueOnce(firstA.promise)
      .mockResolvedValueOnce([
        { snippet: makeSnippet('md', `${root}/b.md`, 'b'), folderPath: root },
      ])
      .mockReturnValueOnce(secondA.promise);
    const view = makeView(plugin);
    await view.onOpen();
    (view as any).searchQuery = 'a';
    const pendingFirstA = (view as any).refresh() as Promise<boolean>;
    await flushAsync();
    (view as any).searchQuery = 'b';
    await (view as any).refresh();
    (view as any).searchQuery = 'a';
    const pendingSecondA = (view as any).refresh() as Promise<boolean>;
    await flushAsync();
    secondA.resolve([
      { snippet: makeSnippet('md', `${root}/new-a.md`, 'new-a'), folderPath: root },
    ]);
    await pendingSecondA;
    firstA.resolve([
      { snippet: makeSnippet('md', `${root}/old-a.md`, 'old-a'), folderPath: root },
    ]);
    await pendingFirstA;
    expect((view as any).searchResults.map((result: { snippet: Snippet }) => result.snippet.path))
      .toEqual([`${root}/new-a.md`]);
    expect(rowsIn((view as any).snippetRootEl as MockEl).map((row) => row._attrs['data-path']))
      .toEqual([`${root}/new-a.md`]);
  });

  it('TREE-03-RACE: concurrent folder selections cannot leave stale shared models for a later render', async () => {
    const root = '.radiprotocol/snippets';
    const folderA = `${root}/a`;
    const folderB = `${root}/b`;
    const listings = {
      [root]: { folders: ['a', 'b'], snippets: [] },
      [folderA]: { folders: [], snippets: [makeSnippet('md', `${folderA}/a.md`, 'a')] },
      [folderB]: { folders: [], snippets: [makeSnippet('md', `${folderB}/b.md`, 'b')] },
    };
    const { plugin, service } = makePlugin({ listings });
    const view = makeView(plugin);
    await view.onOpen();
    const staleFolderLoad = deferred<{ folders: string[]; snippets: Snippet[] }>();
    let deferFirstA = true;
    service.listFolder.mockImplementation((path: string) => {
      if (path === folderA && deferFirstA) {
        deferFirstA = false;
        return staleFolderLoad.promise;
      }
      return Promise.resolve(listings[path as keyof typeof listings] ?? { folders: [], snippets: [] });
    });
    const pendingA = (view as any).selectFolder(folderA) as Promise<void>;
    await flushAsync();
    await (view as any).selectFolder(folderB);
    staleFolderLoad.resolve(listings[folderA]);
    await pendingA;
    await (view as any).toggleFolder(folderB);
    expect((view as any).selectedFolderPath).toBe(folderB);
    expect((view as any).snippetData.map((node: { path: string }) => node.path))
      .toEqual([`${folderB}/b.md`]);
    expect(rowsIn((view as any).snippetRootEl as MockEl).map((row) => row._attrs['data-path']))
      .toEqual([`${folderB}/b.md`]);
  });

  it('TREE-03-WATCHER: watcher refresh preserves the latest requested folder', async () => {
    const root = '.radiprotocol/snippets';
    const folder = `${root}/a`;
    const listings = {
      [root]: { folders: ['a'], snippets: [] },
      [folder]: { folders: [], snippets: [makeSnippet('md', `${folder}/a.md`, 'a')] },
    };
    const { plugin, service } = makePlugin({ listings });
    const view = makeView(plugin);
    await view.onOpen();
    const staleRoot = deferred<{ folders: string[]; snippets: Snippet[] }>();
    service.listFolder.mockImplementationOnce(() => staleRoot.promise);

    const selecting = (view as any).selectFolder(folder) as Promise<void>;
    await flushAsync();
    await (view as any).refresh();
    staleRoot.resolve(listings[root]);
    await selecting;

    expect((view as any).requestedFolderPath).toBe(folder);
    expect((view as any).selectedFolderPath).toBe(folder);
    expect((view as any).snippetData.map((node: { path: string }) => node.path))
      .toEqual([`${folder}/a.md`]);
  });

  it('SEARCH: folder selection during a scan restarts the unchanged query and owns cleanup', async () => {
    const root = '.radiprotocol/snippets';
    const folder = `${root}/a`;
    const { plugin, service } = makePlugin({
      listings: {
        [root]: { folders: ['a'], snippets: [] },
        [folder]: { folders: [], snippets: [] },
      },
    });
    const staleSearch = deferred<Array<{ snippet: Snippet; folderPath: string }>>();
    service.searchSnippets
      .mockReturnValueOnce(staleSearch.promise)
      .mockResolvedValueOnce([
        { snippet: makeSnippet('md', `${folder}/fresh.md`, 'fresh'), folderPath: folder },
      ]);
    const view = makeView(plugin);
    await view.onOpen();
    (view as any).searchQuery = 'ct';
    const pending = (view as any).refresh() as Promise<boolean>;
    await flushAsync();
    await (view as any).selectFolder(folder);
    expect(service.searchSnippets).toHaveBeenLastCalledWith('ct');
    expect(service.searchSnippets).toHaveBeenCalledTimes(2);
    expect((view as any).selectedFolderPath).toBe(folder);
    expect(((view as any).searchWrapEl as MockEl).classList.has('is-scanning')).toBe(false);
    expect(rowsIn((view as any).snippetRootEl as MockEl).map((row) => row._attrs['data-path']))
      .toEqual([`${folder}/fresh.md`]);
    staleSearch.resolve([
      { snippet: makeSnippet('md', `${root}/stale.md`, 'stale'), folderPath: root },
    ]);
    await pending;
    expect(rowsIn((view as any).snippetRootEl as MockEl).map((row) => row._attrs['data-path']))
      .toEqual([`${folder}/fresh.md`]);
  });

  it('SEARCH: stale failures emit no Notice, log, or cleanup of the owning scan', async () => {
    const root = '.radiprotocol/snippets';
    const { plugin, service } = makePlugin();
    const staleSearch = deferred<Array<{ snippet: Snippet; folderPath: string }>>();
    const currentSearch = deferred<Array<{ snippet: Snippet; folderPath: string }>>();
    service.searchSnippets
      .mockReturnValueOnce(staleSearch.promise)
      .mockReturnValueOnce(currentSearch.promise);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = makeView(plugin);
    await view.onOpen();
    (view as any).searchQuery = 'old';
    const stale = (view as any).refresh() as Promise<boolean>;
    await flushAsync();
    (view as any).searchQuery = 'new';
    const current = (view as any).refresh() as Promise<boolean>;
    await flushAsync();
    staleSearch.reject(new Error('stale failure'));
    await stale;
    expect(noticeMessages).toEqual([]);
    expect(consoleSpy).not.toHaveBeenCalled();
    expect(((view as any).searchWrapEl as MockEl).classList.has('is-scanning')).toBe(true);
    currentSearch.resolve([
      { snippet: makeSnippet('md', `${root}/new.md`, 'new'), folderPath: root },
    ]);
    await current;
    expect(((view as any).searchWrapEl as MockEl).classList.has('is-scanning')).toBe(false);
    consoleSpy.mockRestore();
  });

  it('LIFECYCLE: close during initial load cannot assign the first shared model', async () => {
    const { plugin, service } = makePlugin();
    const initialRoot = deferred<{ folders: string[]; snippets: Snippet[] }>();
    service.listFolder.mockReturnValueOnce(initialRoot.promise);
    const view = makeView(plugin);
    const opening = view.onOpen();
    await flushAsync();
    await view.onClose();
    initialRoot.resolve({ folders: [], snippets: [] });
    await opening;
    expect((view as any).folderTreeData).toBeUndefined();
    expect((view as any).snippetData).toEqual([]);
    expect(noticeMessages).toEqual([]);
    expect(((view as any).contentEl as MockEl).children).toEqual([]);
  });

  it('LIFECYCLE: close during folder selection cannot assign its local model', async () => {
    const root = '.radiprotocol/snippets';
    const folder = `${root}/a`;
    const listings = {
      [root]: { folders: ['a'], snippets: [] },
      [folder]: { folders: [], snippets: [makeSnippet('md', `${folder}/a.md`, 'a')] },
    };
    const { plugin, service } = makePlugin({ listings });
    const view = makeView(plugin);
    await view.onOpen();
    const originalFolderTree = (view as any).folderTreeData;
    const originalSnippetData = (view as any).snippetData;
    const pendingRoot = deferred<{ folders: string[]; snippets: Snippet[] }>();
    service.listFolder.mockReturnValueOnce(pendingRoot.promise);
    const selecting = (view as any).selectFolder(folder) as Promise<void>;
    await flushAsync();
    await view.onClose();
    pendingRoot.resolve(listings[root]);
    await selecting;
    expect((view as any).folderTreeData).toBe(originalFolderTree);
    expect((view as any).snippetData).toBe(originalSnippetData);
    expect((view as any).selectedFolderPath).toBe(root);
    expect(noticeMessages).toEqual([]);
    expect(((view as any).contentEl as MockEl).children).toEqual([]);
  });

  it('LIFECYCLE: close during edit load cannot render or open a modal', async () => {
    const root = '.radiprotocol/snippets';
    const snippetPath = `${root}/edit.md`;
    const listings = {
      [root]: { folders: [], snippets: [makeSnippet('md', snippetPath, 'edit')] },
    };
    const { plugin, service } = makePlugin({ listings });
    const view = makeView(plugin);
    await view.onOpen();
    snippetEditorModalCtorSpy.mockClear();
    const pendingLoad = deferred<Snippet | null>();
    service.load.mockReturnValueOnce(pendingLoad.promise);
    const editing = (view as any).openEditModal(snippetPath) as Promise<void>;
    await flushAsync();
    await view.onClose();
    pendingLoad.resolve(listings[root]!.snippets[0]!);
    await editing;
    expect((view as any).currentlyEditingPath).toBeNull();
    expect(snippetEditorModalCtorSpy).not.toHaveBeenCalled();
    expect(noticeMessages).toEqual([]);
    expect(((view as any).contentEl as MockEl).children).toEqual([]);
  });

  it('LIFECYCLE: a superseded edit load cannot render or open a modal', async () => {
    const root = '.radiprotocol/snippets';
    const snippetPath = `${root}/edit.md`;
    const listings = {
      [root]: { folders: [], snippets: [makeSnippet('md', snippetPath, 'edit')] },
    };
    const { plugin, service } = makePlugin({ listings });
    const view = makeView(plugin);
    await view.onOpen();
    snippetEditorModalCtorSpy.mockClear();
    const pendingLoad = deferred<Snippet | null>();
    service.load.mockReturnValueOnce(pendingLoad.promise);
    const editing = (view as any).openEditModal(snippetPath) as Promise<void>;
    await flushAsync();
    // Supersede the edit load with a navigation to the same root; the refresh
    // increments the generation, so the stale edit completion cannot render or
    // open a modal.
    await (view as any).selectFolder(root);
    pendingLoad.resolve(listings[root]!.snippets[0]!);
    await editing;
    expect((view as any).currentlyEditingPath).toBeNull();
    expect(snippetEditorModalCtorSpy).not.toHaveBeenCalled();
  });

  it('LIFECYCLE: a watcher refresh while the edit modal is open still clears the editing highlight on cancel', async () => {
    const root = '.radiprotocol/snippets';
    const snippetPath = `${root}/edit.md`;
    const listings = {
      [root]: { folders: [], snippets: [makeSnippet('md', snippetPath, 'edit')] },
    };
    const { plugin } = makePlugin({ listings });
    const view = makeView(plugin);
    await view.onOpen();
    const modalResult = deferred<{ saved: boolean }>();
    snippetEditorModalResultPromise = modalResult.promise;
    const editing = (view as any).openEditModal(snippetPath) as Promise<void>;
    await flushAsync();
    // The modal is open with the editing highlight on; a watcher refresh
    // supersedes the initiating generation while the modal remains open.
    await (view as any).refresh();
    expect((view as any).currentlyEditingPath).toBe(snippetPath);
    modalResult.resolve({ saved: false });
    await editing;
    expect((view as any).currentlyEditingPath).toBeNull();
    const rows = rowsIn((view as any).snippetRootEl as MockEl);
    expect(rows.every((row) => row._attrs['data-editing'] !== 'true')).toBe(true);
  });
});

// Walk a MockEl subtree and flatten visible text (_text + child recursion).
function collectTextNodes(root: MockEl): string[] {
  const out: string[] = [];
  const walk = (el: MockEl): void => {
    if (el._text) out.push(el._text);
    if ((el as any).textContent && !el._text) out.push((el as any).textContent);
    for (const c of el.children) walk(c);
  };
  walk(root);
  return out;
}

// ============================================================================
// Phase 2 — mutation routing, lifecycle, and supersession regressions
// ============================================================================
describe('SnippetManagerView — guarded mutation completion (Phase 2)', () => {
  beforeEach(() => {
    snippetEditorModalCtorSpy.mockClear();
    confirmModalCtorSpy.mockClear();
    snippetEditorModalNextResult = { saved: false };
    confirmModalNextResult = 'cancel';
    lastMenuItems = [];
    noticeMessages = [];
  });

  it('MUTATION-ROUTING: every model-changing completion calls the guarded refresh surface', () => {
    const viewSource = fs.readFileSync(path.resolve(__dirname, '../views/snippet-manager-view.ts'), 'utf8').replace(/\r\n/g, '\n');
    const rendererSource = fs.readFileSync(path.resolve(__dirname, '../views/snippet-manager/tree-renderer.ts'), 'utf8').replace(/\r\n/g, '\n');
    const methodSource = (source: string, name: string): string => {
      const start = source.indexOf(`private async ${name}(`);
      expect(start).toBeGreaterThanOrEqual(0);
      const end = source.indexOf('\n  private ', start + 1);
      return source.slice(start, end < 0 ? source.length : end);
    };
    for (const name of [
      'openEditModal',
      'openCreateModal',
      'handleCreateSubfolder',
      'handleDeleteSnippet',
      'handleDeleteFolder',
    ]) {
      expect(methodSource(viewSource, name)).toContain('await this.refresh()');
    }
    const moveSource = methodSource(viewSource, 'performMove');
    expect(moveSource).toContain('await this.refresh()');
    expect(moveSource).toContain('await this.refreshAfterFolderPathChange');
    const renameSource = methodSource(rendererSource, 'commitInlineRename');
    expect(renameSource).toContain('await this.callbacks.refresh()');
    expect(renameSource).toContain('await this.callbacks.completeFolderRename');

    const callbackInterface = rendererSource.match(
      /interface TreeRendererCallbacks\s*\{([\s\S]*?)\n\}/,
    )?.[1] ?? '';
    const callbackNames = [...callbackInterface.matchAll(/^\s*(\w+)\s*\(/gm)]
      .map((match) => match[1]!);
    const callbackAssignments = viewSource.slice(
      viewSource.indexOf('callbacks: {'),
      viewSource.indexOf('\n      },\n    });', viewSource.indexOf('callbacks: {')),
    );
    expect(callbackNames.length).toBeGreaterThan(0);
    for (const name of callbackNames) {
      expect(callbackAssignments).toMatch(new RegExp(`\\b${name}:`));
      expect(rendererSource).toContain(`this.callbacks.${name}(`);
    }
    expect(viewSource).not.toMatch(/rebuild(TreeModel|SelectedSnippets)/);
  });

  it('MUTATION-LIFECYCLE: close during delete completion cannot commit or render a model', async () => {
    const root = '.radiprotocol/snippets';
    const { plugin, service } = makePlugin({ listings: {
      [root]: { folders: [], snippets: [makeSnippet('md', `${root}/gone.md`, 'gone')] },
    } });
    const view = makeView(plugin);
    await view.onOpen();
    const originalFolderTree = (view as any).folderTreeData;
    const originalSnippetData = (view as any).snippetData;
    const deleting = deferred<void>();
    service.delete.mockReturnValueOnce(deleting.promise);
    confirmModalNextResult = 'confirm';
    const completion = (view as any).handleDeleteSnippet(`${root}/gone.md`, 'gone') as Promise<void>;
    await flushAsync();
    await view.onClose();
    deleting.resolve(undefined);
    await completion;
    expect((view as any).folderTreeData).toBe(originalFolderTree);
    expect((view as any).snippetData).toBe(originalSnippetData);
    expect(((view as any).contentEl as MockEl).children).toEqual([]);
  });

  it('MUTATION-RACE: a superseded delete refresh cannot overwrite newer navigation', async () => {
    const root = '.radiprotocol/snippets';
    const folderA = `${root}/a`;
    const folderB = `${root}/b`;
    const listings = {
      [root]: { folders: ['a', 'b'], snippets: [makeSnippet('md', `${root}/gone.md`, 'gone')] },
      [folderA]: { folders: [], snippets: [] },
      [folderB]: { folders: [], snippets: [makeSnippet('md', `${folderB}/current.md`, 'current')] },
    };
    const { plugin, service } = makePlugin({ listings });
    const view = makeView(plugin);
    await view.onOpen();
    const staleRoot = deferred<{ folders: string[]; snippets: Snippet[] }>();
    service.listFolder.mockImplementationOnce(() => staleRoot.promise);
    confirmModalNextResult = 'confirm';
    const deleting = (view as any).handleDeleteSnippet(`${root}/gone.md`, 'gone') as Promise<void>;
    await flushAsync();
    await (view as any).selectFolder(folderB);
    staleRoot.resolve(listings[root]);
    await deleting;
    expect((view as any).selectedFolderPath).toBe(folderB);
    expect((view as any).snippetData.map((node: { path: string }) => node.path))
      .toEqual([`${folderB}/current.md`]);
    expect(rowsIn((view as any).snippetRootEl as MockEl).map((row) => row._attrs['data-path']))
      .toEqual([`${folderB}/current.md`]);
  });
});
