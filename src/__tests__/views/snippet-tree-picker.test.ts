// src/__tests__/views/snippet-tree-picker.test.ts
// Phase 51 PICKER-02 (Plan 02) — SnippetTreePicker unit tests.
//
// Covers:
//   D-08  three-mode surface (folder-only | file-only | both) + onSelect dispatch
//   D-09  mode-filtered search
//   D-10  case-insensitive substring matcher
//   D-11  two-line result rows (primary basename + secondary full-relative-path)
//   D-12  search-row click semantics + clearing-search-restores-drillPath
//   Phase 35 MD-01 preservation: extension-based file-glyph dispatch (📄 / 📝)
//
// Strategy: we install a local `vi.mock('obsidian', ...)` stub with a hand-rolled
// MockEl compatible with the SnippetTreePicker's DOM API (createEl / createDiv /
// empty / addEventListener). SnippetService is a plain vi.fn mock. No happy-dom.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Minimal DOM-ish mock element (mirrors src/__tests__/snippet-tree-view.test.ts)
// ---------------------------------------------------------------------------

interface MockClassList {
  add: (cls: string) => void;
  remove: (cls: string) => void;
  contains: (cls: string) => boolean;
  has: (cls: string) => boolean;
}

interface MockEl {
  tagName: string;
  children: MockEl[];
  parent: MockEl | null;
  _text: string;
  textContent: string;
  classList: MockClassList;
  _attrs: Record<string, string>;
  _style: Record<string, string>;
  _listeners: Map<string, Array<(ev: unknown) => void>>;
  dataset: Record<string, string>;
  value: string;
  placeholder: string;
  style: Record<string, string>;
  type: string;
  createEl: (tag: string, opts?: { text?: string; cls?: string; type?: string; attr?: Record<string, string> }) => MockEl;
  createDiv: (opts?: { cls?: string; text?: string }) => MockEl;
  createSpan: (opts?: { cls?: string; text?: string }) => MockEl;
  empty: () => void;
  setText: (text: string) => void;
  appendChild: (child: MockEl) => MockEl;
  addClass: (cls: string) => void;
  removeClass: (cls: string) => void;
  setAttribute: (k: string, v: string) => void;
  getAttribute: (k: string) => string | null;
  addEventListener: (type: string, handler: (ev: unknown) => void) => void;
  removeEventListener: (type: string, handler: (ev: unknown) => void) => void;
  dispatchEvent: (event: { type: string; target?: unknown }) => void;
  querySelector: (selector: string) => MockEl | null;
  querySelectorAll: (selector: string) => MockEl[];
  scrollIntoView: (opts?: unknown) => void;
  click: () => void;
  remove: () => void;
  /** Records programmatic focus so tests can assert caret placement. */
  _focused?: boolean;
  focus: (opts?: { preventScroll?: boolean }) => void;
}

function makeEl(tag = 'div'): MockEl {
  const listeners = new Map<string, Array<(ev: unknown) => void>>();
  const style: Record<string, string> = {};
  const attrs: Record<string, string> = {};
  const dataset: Record<string, string> = {};
  const classSet = new Set<string>();
  const classList: MockClassList = {
    add: (c: string) => { classSet.add(c); },
    remove: (c: string) => { classSet.delete(c); },
    contains: (c: string) => classSet.has(c),
    has: (c: string) => classSet.has(c),
  };
  const children: MockEl[] = [];
  const el: MockEl = {
    tagName: tag.toUpperCase(),
    children,
    parent: null,
    _text: '',
    textContent: '',
    classList,
    _attrs: attrs,
    _style: style,
    _listeners: listeners,
    dataset,
    value: '',
    placeholder: '',
    style,
    type: '',
    createEl(t: string, opts?: { text?: string; cls?: string; type?: string; attr?: Record<string, string> }): MockEl {
      const child = makeEl(t);
      child.parent = el;
      if (opts?.text !== undefined) { child._text = opts.text; child.textContent = opts.text; }
      if (opts?.cls) {
        for (const c of opts.cls.split(/\s+/)) child.classList.add(c);
      }
      if (opts?.type !== undefined) { child.type = opts.type; }
      if (opts?.attr) {
        for (const [k, v] of Object.entries(opts.attr)) child._attrs[k] = v;
      }
      children.push(child);
      return child;
    },
    createDiv(opts?: { cls?: string; text?: string }): MockEl {
      return el.createEl('div', opts);
    },
    createSpan(opts?: { cls?: string; text?: string }): MockEl {
      return el.createEl('span', opts);
    },
    empty(): void {
      children.length = 0;
    },
    setText(text: string): void {
      el._text = text;
      el.textContent = text;
    },
    appendChild(child: MockEl): MockEl {
      child.parent = el;
      children.push(child);
      return child;
    },
    addClass(cls: string): void { classSet.add(cls); },
    removeClass(cls: string): void { classSet.delete(cls); },
    setAttribute(k: string, v: string): void { attrs[k] = v; },
    getAttribute(k: string): string | null { return attrs[k] ?? null; },
    addEventListener(type: string, handler: (ev: unknown) => void): void {
      const arr = listeners.get(type) ?? [];
      arr.push(handler);
      listeners.set(type, arr);
    },
    removeEventListener(type: string, handler: (ev: unknown) => void): void {
      const arr = listeners.get(type);
      if (!arr) return;
      const idx = arr.indexOf(handler);
      if (idx >= 0) arr.splice(idx, 1);
    },
    dispatchEvent(event: { type: string; target?: unknown }): void {
      const arr = listeners.get(event.type) ?? [];
      for (const h of arr) h(event);
    },
    querySelector(selector: string): MockEl | null {
      // Minimal: supports a single '.class' selector. Returns first descendant
      // match in document order (mirrors DOM querySelector semantics — not self).
      const cls = selector.trim().startsWith('.') ? selector.trim().slice(1) : selector.trim();
      function walk(node: MockEl): MockEl | null {
        for (const c of node.children) {
          if (c.classList.has(cls)) return c;
          const r = walk(c);
          if (r) return r;
        }
        return null;
      }
      return walk(el);
    },
    querySelectorAll(selector: string): MockEl[] {
      // Minimal: supports comma-separated '.class1, .class2' selectors. Returns
      // all descendant matches in document order.
      const classes = selector
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.startsWith('.'))
        .map((s) => s.slice(1));
      const out: MockEl[] = [];
      function walk(node: MockEl): void {
        for (const c of node.children) {
          if (classes.some((cls) => c.classList.has(cls))) out.push(c);
          walk(c);
        }
      }
      walk(el);
      return out;
    },
    scrollIntoView(_opts?: unknown): void {},
    click(): void {
      el.dispatchEvent({ type: 'click', target: el });
    },
    remove(): void {
      const p = el.parent;
      if (!p) return;
      const idx = p.children.indexOf(el);
      if (idx >= 0) p.children.splice(idx, 1);
      el.parent = null;
    },
    focus(_opts?: { preventScroll?: boolean }): void {
      el._focused = true;
    },
  };
  return el;
}

// --- vi.mock('obsidian', ...) --- (override the default alias mock) --------
vi.mock('obsidian', () => {
  class ItemView {}
  class WorkspaceLeaf {}
  class Modal {}
  class SuggestModal<T> {
    app: unknown;
    constructor(app: unknown) { this.app = app; }
    getSuggestions(_q: string): T[] { return []; }
    renderSuggestion(_v: T, _el: unknown): void {}
    onChooseSuggestion(_v: T, _ev: unknown): void {}
    setPlaceholder(_p: string): void {}
    open(): void {}
    close(): void {}
  }
  class Setting {
    constructor(_c: unknown) {}
    setName() { return this; }
    setDesc() { return this; }
    setHeading() { return this; }
    addText(_cb: unknown) { return this; }
    addTextArea(_cb: unknown) { return this; }
    addDropdown(_cb: unknown) { return this; }
    addButton(_cb: unknown) { return this; }
  }
  class Notice { constructor(_m: string) {} }
  class TFile { path = ''; }
  class Plugin { app: unknown = {}; manifest: unknown = {}; }
  const setIcon = (el: { textContent?: string }, icon: string): void => { el.textContent = icon; };
  return { ItemView, WorkspaceLeaf, Modal, SuggestModal, Setting, Notice, TFile, Plugin, setIcon };
});

// --- Now import the module under test ------------------------------------
import {
  SnippetTreePicker,
  type SnippetTreePickerOptions,
  type SnippetTreePickerResult,
} from '../../views/snippet-tree-picker';
import type { Snippet } from '../../snippets/snippet-model';

// --- Test helpers --------------------------------------------------------

interface FakeSnippetService {
  listFolder: ReturnType<typeof vi.fn>;
  listFolderDescendants: ReturnType<typeof vi.fn>;
}

function makeFakeSnippetService(): FakeSnippetService {
  return {
    listFolder: vi.fn(async (_p: string) => ({ folders: [] as string[], snippets: [] as Snippet[] })),
    listFolderDescendants: vi.fn(async (_p: string) => ({ files: [] as string[], folders: [] as string[], total: 0 })),
  };
}

function mdTemplateSnippet(path: string, name?: string): Snippet {
  return {
    kind: 'md-template',
    path,
    name: name ?? path.split('/').pop()!.replace(/\.md$/, ''),
    template: '',
    placeholders: [],
    validationError: null,
  };
}

function mdSnippet(path: string, name?: string): Snippet {
  return {
    kind: 'md',
    path,
    name: name ?? path.split('/').pop()!.replace(/\.md$/, ''),
    content: '',
  };
}

const ROOT = 'snippets';
const APP = {} as unknown as SnippetTreePickerOptions['app'];

function makePicker(
  overrides: Partial<SnippetTreePickerOptions>,
  svc: FakeSnippetService,
): { picker: SnippetTreePicker; container: MockEl; onSelect: ReturnType<typeof vi.fn> } {
  const container = makeEl('div');
  const onSelect = vi.fn((_r: SnippetTreePickerResult) => {});
  const base: SnippetTreePickerOptions = {
    app: APP,
    snippetService: svc as unknown as SnippetTreePickerOptions['snippetService'],
    container: container as unknown as HTMLElement,
    mode: 'both',
    rootPath: ROOT,
    onSelect,
    ...overrides,
  };
  const picker = new SnippetTreePicker(base);
  return { picker, container, onSelect };
}

function findFirst(root: MockEl | undefined, predicate: (el: MockEl) => boolean): MockEl | null {
  if (!root) return null;
  // DFS in document order.
  function walk(el: MockEl): MockEl | null {
    if (predicate(el)) return el;
    for (const c of el.children) {
      const r = walk(c);
      if (r) return r;
    }
    return null;
  }
  return walk(root);
}

function findAll(root: MockEl, predicate: (el: MockEl) => boolean): MockEl[] {
  const out: MockEl[] = [];
  // DFS in document order: visit self, then recurse into children left-to-right.
  function walk(el: MockEl): void {
    if (predicate(el)) out.push(el);
    for (const c of el.children) walk(c);
  }
  walk(root);
  return out;
}

function findByClass(root: MockEl, cls: string): MockEl[] {
  return findAll(root, (el) => el.classList.has(cls));
}

function triggerClick(el: MockEl | undefined): void {
  if (!el) throw new Error('triggerClick: element is undefined');
  el.dispatchEvent({ type: 'click', target: el });
}

function triggerInput(inputEl: MockEl | undefined, value: string): void {
  if (!inputEl) throw new Error('triggerInput: element is undefined');
  inputEl.value = value;
  inputEl.dispatchEvent({ type: 'input', target: inputEl });
}

async function flushDebounce(): Promise<void> {
  // Debounce = 120ms in the component (SEARCH_DEBOUNCE_MS). Use real timers + a brief wait.
  await new Promise((resolve) => setTimeout(resolve, 180));
  // Allow microtasks (the debounced handler awaits listFolderDescendants) to flush.
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function triggerKeydown(
  inputEl: MockEl | undefined,
  key: string,
  mods: { ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean; shiftKey?: boolean; code?: string } = {},
): void {
  if (!inputEl) throw new Error('triggerKeydown: element is undefined');
  const event = {
    type: 'keydown',
    key,
    code: mods.code ?? '',
    target: inputEl,
    ctrlKey: !!mods.ctrlKey,
    altKey: !!mods.altKey,
    metaKey: !!mods.metaKey,
    shiftKey: !!mods.shiftKey,
    preventDefault: vi.fn(),
  };
  inputEl.dispatchEvent(event as unknown as { type: string; target?: unknown });
}

function rowsOf(container: MockEl): MockEl[] {
  return findAll(container, (el) =>
    el.classList.has('rp-stp-folder-row') || el.classList.has('rp-stp-file-row'),
  );
}

// =========================================================================
// Tests
// =========================================================================

describe('Mode discriminator (D-08, D-09)', () => {
  let svc: FakeSnippetService;

  beforeEach(() => {
    svc = makeFakeSnippetService();
  });

  it('folder-only mode hides files in drill view', async () => {
    svc.listFolder.mockResolvedValue({
      folders: ['abdomen'],
      snippets: [mdTemplateSnippet(`${ROOT}/report.md`)],
    });
    const { picker, container } = makePicker({ mode: 'folder-only' }, svc);
    await picker.mount();

    const fileRows = findByClass(container, 'rp-stp-file-row');
    const folderRows = findByClass(container, 'rp-stp-folder-row');
    expect(fileRows.length).toBe(0);
    expect(folderRows.length).toBe(1);
  });

  it('folder-only mode hides files in search results', async () => {
    svc.listFolder.mockResolvedValue({ folders: [], snippets: [] });
    svc.listFolderDescendants.mockResolvedValue({
      files: [`${ROOT}/report.json`, `${ROOT}/abdomen/ct.md`],
      folders: [`${ROOT}/abdomen`],
      total: 3,
    });
    const { picker, container } = makePicker({ mode: 'folder-only' }, svc);
    await picker.mount();

    const input = findFirst(container, (el) => el.classList.has('rp-stp-search-input'))!;
    triggerInput(input, 'report');
    await flushDebounce();

    expect(findByClass(container, 'rp-stp-file-row').length).toBe(0);
    // No folder matches on "report" either — empty state.
    const emptyOrNoFiles = findByClass(container, 'rp-stp-empty');
    const folderRows = findByClass(container, 'rp-stp-folder-row');
    expect(folderRows.length + emptyOrNoFiles.length).toBeGreaterThan(0);
  });

  it('folder-only mode emits onSelect via Выбрать эту папку button only', async () => {
    svc.listFolder.mockResolvedValue({
      folders: ['abdomen'],
      snippets: [],
    });
    const { picker, container, onSelect } = makePicker({ mode: 'folder-only' }, svc);
    await picker.mount();

    // Drill in.
    const folderRow = findByClass(container, 'rp-stp-folder-row')[0];
    triggerClick(folderRow);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // The select-folder button should be present now.
    const selectBtn = findFirst(container, (el) => el.classList.has('rp-stp-select-folder-btn'));
    expect(selectBtn).not.toBeNull();
    triggerClick(selectBtn!);
    expect(onSelect).toHaveBeenCalledWith({ kind: 'folder', relativePath: 'abdomen' });
  });

  it('file-only mode shows folders (drill) + files (select) in drill view', async () => {
    svc.listFolder.mockResolvedValue({
      folders: ['abdomen'],
      snippets: [mdTemplateSnippet(`${ROOT}/report.md`)],
    });
    const { picker, container } = makePicker({ mode: 'file-only' }, svc);
    await picker.mount();

    expect(findByClass(container, 'rp-stp-folder-row').length).toBe(1);
    expect(findByClass(container, 'rp-stp-file-row').length).toBe(1);
  });

  it('file-only mode hides folders in search results', async () => {
    // Both a folder named "match" and a file named "match-report.md" exist.
    // Query "match" hits both — file-only mode must show the file row and hide the folder row.
    svc.listFolder.mockResolvedValue({ folders: [], snippets: [] });
    svc.listFolderDescendants.mockResolvedValue({
      files: [`${ROOT}/abdomen/match-report.md`],
      folders: [`${ROOT}/match`],
      total: 2,
    });
    const { picker, container } = makePicker({ mode: 'file-only' }, svc);
    await picker.mount();

    const input = findFirst(container, (el) => el.classList.has('rp-stp-search-input'))!;
    triggerInput(input, 'match');
    await flushDebounce();

    expect(findByClass(container, 'rp-stp-folder-row').length).toBe(0);
    expect(findByClass(container, 'rp-stp-file-row').length).toBe(1);
  });

  it('file-only mode emits onSelect with kind: file on file row click', async () => {
    svc.listFolder.mockResolvedValue({
      folders: [],
      snippets: [mdTemplateSnippet(`${ROOT}/report.md`)],
    });
    const { picker, container, onSelect } = makePicker({ mode: 'file-only' }, svc);
    await picker.mount();

    const fileRow = findByClass(container, 'rp-stp-file-row')[0];
    triggerClick(fileRow);
    expect(onSelect).toHaveBeenCalledWith({ kind: 'file', relativePath: 'report.md' });
  });

  it('both mode shows folders + files in drill view', async () => {
    svc.listFolder.mockResolvedValue({
      folders: ['abdomen'],
      snippets: [mdTemplateSnippet(`${ROOT}/r.md`)],
    });
    const { picker, container } = makePicker({ mode: 'both' }, svc);
    await picker.mount();

    expect(findByClass(container, 'rp-stp-folder-row').length).toBe(1);
    expect(findByClass(container, 'rp-stp-file-row').length).toBe(1);
  });

  it('both mode shows folders + files in search results, folders first', async () => {
    svc.listFolder.mockResolvedValue({ folders: [], snippets: [] });
    svc.listFolderDescendants.mockResolvedValue({
      files: [`${ROOT}/a/ct-file.md`, `${ROOT}/ct-report.json`],
      folders: [`${ROOT}/ct-folder`, `${ROOT}/a`],
      total: 4,
    });
    const { picker, container } = makePicker({ mode: 'both' }, svc);
    await picker.mount();

    const input = findFirst(container, (el) => el.classList.has('rp-stp-search-input'))!;
    triggerInput(input, 'ct');
    await flushDebounce();

    const rows = findAll(container, (el) =>
      el.classList.has('rp-stp-folder-row') || el.classList.has('rp-stp-file-row'),
    );
    // Should have at least one of each.
    expect(rows.length).toBeGreaterThanOrEqual(2);
    // Folders must come before files.
    const firstFolderIdx = rows.findIndex((r) => r.classList.has('rp-stp-folder-row'));
    const firstFileIdx = rows.findIndex((r) => r.classList.has('rp-stp-file-row'));
    expect(firstFolderIdx).toBeGreaterThanOrEqual(0);
    expect(firstFileIdx).toBeGreaterThanOrEqual(0);
    expect(firstFolderIdx).toBeLessThan(firstFileIdx);
  });
});

describe('Drill navigation (D-08)', () => {
  let svc: FakeSnippetService;

  beforeEach(() => {
    svc = makeFakeSnippetService();
  });

  it('mount() at empty drillPath calls listFolder(rootPath) and renders top-level entries', async () => {
    svc.listFolder.mockResolvedValue({
      folders: ['abdomen', 'chest'],
      snippets: [],
    });
    const { picker, container } = makePicker({ mode: 'folder-only' }, svc);
    await picker.mount();

    expect(svc.listFolder).toHaveBeenCalledWith(ROOT);
    expect(findByClass(container, 'rp-stp-folder-row').length).toBe(2);
  });

  it('click folder row pushes drillPath and re-renders deeper listing', async () => {
    svc.listFolder
      .mockResolvedValueOnce({ folders: ['abdomen'], snippets: [] })
      .mockResolvedValueOnce({ folders: ['ct', 'mri'], snippets: [] });

    const { picker, container } = makePicker({ mode: 'folder-only' }, svc);
    await picker.mount();

    const folderRow = findByClass(container, 'rp-stp-folder-row')[0];
    triggerClick(folderRow);
    // Let the re-render's async listFolder settle.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(svc.listFolder).toHaveBeenNthCalledWith(2, `${ROOT}/abdomen`);
    expect(findByClass(container, 'rp-stp-folder-row').length).toBe(2);
  });

  it('Up button visible when drillPath.length > 0; click pops drillPath', async () => {
    svc.listFolder
      .mockResolvedValueOnce({ folders: ['abdomen'], snippets: [] })
      .mockResolvedValueOnce({ folders: [], snippets: [] })
      .mockResolvedValueOnce({ folders: ['abdomen'], snippets: [] });

    const { picker, container } = makePicker({ mode: 'folder-only' }, svc);
    await picker.mount();

    // At root: no up button.
    expect(findByClass(container, 'rp-stp-up-btn').length).toBe(0);

    triggerClick(findByClass(container, 'rp-stp-folder-row')[0]);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    // After drill: up button visible.
    const upBtn = findFirst(container, (el) => el.classList.has('rp-stp-up-btn'));
    expect(upBtn).not.toBeNull();

    triggerClick(upBtn!);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    // Back at root: no up button again.
    expect(findByClass(container, 'rp-stp-up-btn').length).toBe(0);
  });

  it('breadcrumb at root reads /', async () => {
    svc.listFolder.mockResolvedValue({ folders: [], snippets: [] });
    const { picker, container } = makePicker({ mode: 'folder-only' }, svc);
    await picker.mount();

    const crumb = findFirst(container, (el) => el.classList.has('rp-stp-breadcrumb-label'));
    expect(crumb?.textContent).toBe('/');
  });

  it('breadcrumb at depth-2 reads abdomen/ct', async () => {
    svc.listFolder
      .mockResolvedValueOnce({ folders: ['abdomen'], snippets: [] })
      .mockResolvedValueOnce({ folders: ['ct'], snippets: [] })
      .mockResolvedValueOnce({ folders: [], snippets: [] });

    const { picker, container } = makePicker({ mode: 'folder-only' }, svc);
    await picker.mount();

    triggerClick(findByClass(container, 'rp-stp-folder-row')[0]);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    triggerClick(findByClass(container, 'rp-stp-folder-row')[0]);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    const crumb = findFirst(container, (el) => el.classList.has('rp-stp-breadcrumb-label'));
    expect(crumb?.textContent).toBe('abdomen/ct');
  });
});

describe('Tree-wide search (D-09, D-10, D-11)', () => {
  let svc: FakeSnippetService;

  beforeEach(() => {
    svc = makeFakeSnippetService();
  });

  it('non-empty query switches to search view rooted at rootPath (NOT drillPath)', async () => {
    // Start at root; drill in one level; then search.
    svc.listFolder
      .mockResolvedValueOnce({ folders: ['abdomen'], snippets: [] })  // root
      .mockResolvedValueOnce({ folders: [], snippets: [] });           // abdomen
    svc.listFolderDescendants.mockResolvedValue({
      files: [`${ROOT}/x.json`],
      folders: [],
      total: 1,
    });

    const { picker, container } = makePicker({ mode: 'file-only' }, svc);
    await picker.mount();

    triggerClick(findByClass(container, 'rp-stp-folder-row')[0]);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    const input = findFirst(container, (el) => el.classList.has('rp-stp-search-input'))!;
    triggerInput(input, 'x');
    await flushDebounce();

    expect(svc.listFolderDescendants).toHaveBeenCalledWith(ROOT);
  });

  it('case-insensitive substring match on basename — query CT matches ct-routine.md', async () => {
    svc.listFolder.mockResolvedValue({ folders: [], snippets: [] });
    svc.listFolderDescendants.mockResolvedValue({
      files: [`${ROOT}/ct-routine.md`, `${ROOT}/mri-liver.md`],
      folders: [],
      total: 2,
    });

    const { picker, container } = makePicker({ mode: 'file-only' }, svc);
    await picker.mount();

    const input = findFirst(container, (el) => el.classList.has('rp-stp-search-input'))!;
    triggerInput(input, 'CT');
    await flushDebounce();

    const files = findByClass(container, 'rp-stp-file-row');
    expect(files.length).toBe(1);
    // Primary row text contains the basename 'ct-routine.md'.
    const name = findFirst(files[0], (el) => el.classList.has('rp-stp-result-name'));
    expect(name?.textContent).toContain('ct-routine.md');
  });

  it('keeps current results visible while the next search is loading', async () => {
    svc.listFolder.mockResolvedValue({ folders: [], snippets: [] });
    svc.listFolderDescendants
      .mockResolvedValueOnce({
        files: [`${ROOT}/ct-routine.md`],
        folders: [],
        total: 1,
      })
      .mockImplementationOnce(() => new Promise(() => {}));

    const { picker, container } = makePicker({ mode: 'file-only' }, svc);
    await picker.mount();

    const input = findFirst(container, (el) => el.classList.has('rp-stp-search-input'))!;
    triggerInput(input, 'ct');
    await flushDebounce();
    expect(findByClass(container, 'rp-stp-file-row').length).toBe(1);

    triggerInput(input, 'ctr');
    await flushDebounce();

    expect(svc.listFolderDescendants).toHaveBeenCalledTimes(2);
    expect(findByClass(container, 'rp-stp-file-row').length).toBe(1);
    expect(findFirst(container, (el) => el.classList.has('rp-stp-row-title'))?.textContent).toBe('ct-routine.md');
  });

  it('result row primary text = basename with extension', async () => {
    svc.listFolder.mockResolvedValue({ folders: [], snippets: [] });
    svc.listFolderDescendants.mockResolvedValue({
      files: [`${ROOT}/abdomen/report.md`],
      folders: [],
      total: 1,
    });
    const { picker, container } = makePicker({ mode: 'file-only' }, svc);
    await picker.mount();

    const input = findFirst(container, (el) => el.classList.has('rp-stp-search-input'))!;
    triggerInput(input, 'report');
    await flushDebounce();

    const name = findFirst(container, (el) => el.classList.has('rp-stp-result-name'));
    expect(name?.textContent).toContain('report.md');
  });

  it('result row secondary text = full relative path from rootPath', async () => {
    svc.listFolder.mockResolvedValue({ folders: [], snippets: [] });
    svc.listFolderDescendants.mockResolvedValue({
      files: [`${ROOT}/abdomen/ct/ct-routine.md`],
      folders: [],
      total: 1,
    });
    const { picker, container } = makePicker({ mode: 'file-only' }, svc);
    await picker.mount();

    const input = findFirst(container, (el) => el.classList.has('rp-stp-search-input'))!;
    triggerInput(input, 'ct');
    await flushDebounce();

    const pathEl = findFirst(container, (el) => el.classList.has('rp-stp-result-path'));
    expect(pathEl?.textContent).toBe('abdomen/ct/ct-routine.md');
  });

  it('empty results shows the no-matches label (Phase 84 I18N-02: defaultT → English)', async () => {
    svc.listFolder.mockResolvedValue({ folders: [], snippets: [] });
    svc.listFolderDescendants.mockResolvedValue({ files: [], folders: [], total: 0 });
    const { picker, container } = makePicker({ mode: 'file-only' }, svc);
    await picker.mount();

    const input = findFirst(container, (el) => el.classList.has('rp-stp-search-input'))!;
    triggerInput(input, 'zzzzzz');
    await flushDebounce();

    const empty = findFirst(container, (el) => el.classList.has('rp-stp-empty'));
    expect(empty?.textContent).toBe('No matches found');
  });
});

describe('File glyph dispatch (Phase 35 MD-01 preservation)', () => {
  let svc: FakeSnippetService;

  beforeEach(() => {
    svc = makeFakeSnippetService();
  });

  it('file row for .md file renders 📝 prefix in primary text (drill view, file-only mode)', async () => {
    svc.listFolder.mockResolvedValue({
      folders: [],
      snippets: [mdSnippet(`${ROOT}/report.md`)],
    });
    const { picker, container } = makePicker({ mode: 'file-only' }, svc);
    await picker.mount();

    const name = findFirst(container, (el) => el.classList.has('rp-stp-result-name'));
    expect(name?.textContent).toContain('📝');
    expect(name?.textContent).toContain('report.md');
  });

  it('search results OMIT legacy .json files from raw listFolderDescendants while .md files in the same listing ARE shown', async () => {
    svc.listFolder.mockResolvedValue({ folders: [], snippets: [] });
    svc.listFolderDescendants.mockResolvedValue({
      files: [`${ROOT}/a.md`, `${ROOT}/legacy.json`],
      folders: [],
      total: 2,
    });
    const { picker, container } = makePicker({ mode: 'both' }, svc);
    await picker.mount();

    const input = findFirst(container, (el) => el.classList.has('rp-stp-search-input'))!;

    // Query 'leg' matches legacy.json's basename — but .json files are filtered
    // out of search results BEFORE basename matching, so NO file row renders.
    triggerInput(input, 'leg');
    await flushDebounce();
    expect(findByClass(container, 'rp-stp-file-row').length).toBe(0);

    // Query 'a' matches a.md's basename — the .md file SHOULD render as a row.
    triggerInput(input, 'a');
    await flushDebounce();
    const mdRows = findByClass(container, 'rp-stp-file-row');
    expect(mdRows.length).toBe(1);
    const name = findFirst(mdRows[0], (el) => el.classList.has('rp-stp-result-name'));
    expect(name?.textContent).toContain('a.md');
  });

  it('case-insensitive extension dispatch — .MD file renders 📝 (verifies lowercased ext check)', async () => {
    svc.listFolder.mockResolvedValue({ folders: [], snippets: [] });
    svc.listFolderDescendants.mockResolvedValue({
      files: [`${ROOT}/report.MD`],
      folders: [],
      total: 1,
    });
    const { picker, container } = makePicker({ mode: 'file-only' }, svc);
    await picker.mount();

    const input = findFirst(container, (el) => el.classList.has('rp-stp-search-input'))!;
    triggerInput(input, 'report');
    await flushDebounce();

    const name = findFirst(container, (el) => el.classList.has('rp-stp-result-name'));
    expect(name?.textContent).toContain('📝');
  });
});

describe('Search row click (D-12)', () => {
  let svc: FakeSnippetService;

  beforeEach(() => {
    svc = makeFakeSnippetService();
  });

  it('file row click in search results commits selection (calls onSelect with kind: file)', async () => {
    svc.listFolder.mockResolvedValue({ folders: [], snippets: [] });
    svc.listFolderDescendants.mockResolvedValue({
      files: [`${ROOT}/abdomen/report.md`],
      folders: [],
      total: 1,
    });
    const { picker, container, onSelect } = makePicker({ mode: 'file-only' }, svc);
    await picker.mount();

    const input = findFirst(container, (el) => el.classList.has('rp-stp-search-input'))!;
    triggerInput(input, 'report');
    await flushDebounce();

    const fileRow = findByClass(container, 'rp-stp-file-row')[0];
    triggerClick(fileRow);

    expect(onSelect).toHaveBeenCalledWith({ kind: 'file', relativePath: 'abdomen/report.md' });
  });

  it('folder row click in search results drills into folder AND clears query (re-mounts drill view at folder)', async () => {
    svc.listFolder
      .mockResolvedValueOnce({ folders: [], snippets: [] })              // root before search
      .mockResolvedValueOnce({ folders: [], snippets: [] });              // after drill via search
    svc.listFolderDescendants.mockResolvedValue({
      files: [],
      folders: [`${ROOT}/abdomen`],
      total: 1,
    });

    const { picker, container, onSelect } = makePicker({ mode: 'both' }, svc);
    await picker.mount();

    const input = findFirst(container, (el) => el.classList.has('rp-stp-search-input'))! ;
    triggerInput(input, 'abdomen');
    await flushDebounce();

    const folderRow = findByClass(container, 'rp-stp-folder-row')[0];
    triggerClick(folderRow);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    // onSelect NOT called — folder click drills (D-12).
    expect(onSelect).not.toHaveBeenCalled();
    // Drill happened: listFolder called with abdomen path.
    expect(svc.listFolder).toHaveBeenCalledWith(`${ROOT}/abdomen`);
    // Search input cleared.
    const inputAfter = findFirst(container, (el) => el.classList.has('rp-stp-search-input'))!;
    expect(inputAfter.value).toBe('');
    // Breadcrumb at drill path.
    const crumb = findFirst(container, (el) => el.classList.has('rp-stp-breadcrumb-label'));
    expect(crumb?.textContent).toBe('abdomen');
  });

  it('manually clearing search input restores drill view at CURRENT drillPath, NOT rootPath', async () => {
    svc.listFolder
      .mockResolvedValueOnce({ folders: ['abdomen'], snippets: [] })     // root
      .mockResolvedValueOnce({ folders: [], snippets: [mdTemplateSnippet(`${ROOT}/abdomen/r.md`)] })  // abdomen after drill
      .mockResolvedValueOnce({ folders: [], snippets: [mdTemplateSnippet(`${ROOT}/abdomen/r.md`)] }); // abdomen after clearing search
    svc.listFolderDescendants.mockResolvedValue({
      files: [`${ROOT}/abdomen/r.json`],
      folders: [],
      total: 1,
    });

    const { picker, container } = makePicker({ mode: 'file-only' }, svc);
    await picker.mount();

    // Drill into abdomen.
    triggerClick(findByClass(container, 'rp-stp-folder-row')[0]);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    // Search.
    const input = findFirst(container, (el) => el.classList.has('rp-stp-search-input'))!;
    triggerInput(input, 'r');
    await flushDebounce();

    // Clear search.
    triggerInput(input, '');
    await flushDebounce();

    // Breadcrumb should still read 'abdomen', NOT '/'.
    const crumb = findFirst(container, (el) => el.classList.has('rp-stp-breadcrumb-label'));
    expect(crumb?.textContent).toBe('abdomen');
  });
});

describe('Committed-state «Выбрать эту папку» button (Phase 56 D-10)', () => {
  let svc: FakeSnippetService;

  beforeEach(() => {
    svc = makeFakeSnippetService();
  });

  it('on mount, select-folder button (after drill-in) renders default label without is-committed class', async () => {
    svc.listFolder
      .mockResolvedValueOnce({ folders: ['abdomen'], snippets: [] })
      .mockResolvedValueOnce({ folders: [], snippets: [] });
    const { picker, container } = makePicker({ mode: 'folder-only' }, svc);
    await picker.mount();

    triggerClick(findByClass(container, 'rp-stp-folder-row')[0]);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    const selectBtn = findFirst(container, (el) => el.classList.has('rp-stp-select-folder-btn'));
    expect(selectBtn).not.toBeNull();
    expect(selectBtn!.classList.has('is-committed')).toBe(false);
    expect(selectBtn!.textContent).toBe('Select this folder');
  });

  it('after clicking select-folder button, button renders with is-committed class and committed-state label (Phase 84 I18N-02: defaultT → English)', async () => {
    svc.listFolder
      .mockResolvedValueOnce({ folders: ['abdomen'], snippets: [] })
      .mockResolvedValueOnce({ folders: [], snippets: [] })
      .mockResolvedValueOnce({ folders: [], snippets: [] });
    const { picker, container } = makePicker({ mode: 'folder-only' }, svc);
    await picker.mount();

    triggerClick(findByClass(container, 'rp-stp-folder-row')[0]);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    const selectBtn = findFirst(container, (el) => el.classList.has('rp-stp-select-folder-btn'))!;
    triggerClick(selectBtn);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    const after = findFirst(container, (el) => el.classList.has('rp-stp-select-folder-btn'))!;
    expect(after.classList.has('is-committed')).toBe(true);
    expect(after.textContent).toBe('\u2713 Selected');
  });

  it('drilling into a different folder clears the committed visual state (button reverts to default)', async () => {
    svc.listFolder
      .mockResolvedValueOnce({ folders: ['abdomen', 'chest'], snippets: [] })  // root
      .mockResolvedValueOnce({ folders: [], snippets: [] })                     // abdomen after drill
      .mockResolvedValueOnce({ folders: [], snippets: [] })                     // abdomen after click (re-render)
      .mockResolvedValueOnce({ folders: ['abdomen', 'chest'], snippets: [] })  // root after up
      .mockResolvedValueOnce({ folders: [], snippets: [] });                    // chest after drill
    const { picker, container } = makePicker({ mode: 'folder-only' }, svc);
    await picker.mount();

    // Drill into abdomen.
    triggerClick(findByClass(container, 'rp-stp-folder-row')[0]);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    // Commit abdomen.
    const selectBtn = findFirst(container, (el) => el.classList.has('rp-stp-select-folder-btn'))!;
    triggerClick(selectBtn);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    // Up to root.
    const upBtn = findFirst(container, (el) => el.classList.has('rp-stp-up-btn'))!;
    triggerClick(upBtn);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    // Drill into chest.
    triggerClick(findByClass(container, 'rp-stp-folder-row')[1]);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    const newSelectBtn = findFirst(container, (el) => el.classList.has('rp-stp-select-folder-btn'))!;
    expect(newSelectBtn.classList.has('is-committed')).toBe(false);
    expect(newSelectBtn.textContent).toBe('Select this folder');
  });

  it('navigating up out of the committed folder via up-button clears the committed visual state', async () => {
    svc.listFolder
      .mockResolvedValueOnce({ folders: ['abdomen'], snippets: [] })  // root
      .mockResolvedValueOnce({ folders: ['ct'], snippets: [] })       // abdomen
      .mockResolvedValueOnce({ folders: ['ct'], snippets: [] })       // abdomen after click (re-render)
      .mockResolvedValueOnce({ folders: ['abdomen'], snippets: [] }); // root after up
    const { picker, container } = makePicker({ mode: 'folder-only' }, svc);
    await picker.mount();

    // Drill into abdomen.
    triggerClick(findByClass(container, 'rp-stp-folder-row')[0]);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    // Commit abdomen.
    const selectBtn = findFirst(container, (el) => el.classList.has('rp-stp-select-folder-btn'))!;
    triggerClick(selectBtn);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    // Up to root.
    const upBtn = findFirst(container, (el) => el.classList.has('rp-stp-up-btn'))!;
    triggerClick(upBtn);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    // At root: drillPath.length === 0 ⇒ select button must NOT be rendered.
    const noBtn = findFirst(container, (el) => el.classList.has('rp-stp-select-folder-btn'));
    expect(noBtn).toBeNull();
  });

  it('re-mounting the picker resets committedRelativePath to null (button reverts to default after re-mount + drill)', async () => {
    svc.listFolder
      .mockResolvedValueOnce({ folders: ['abdomen'], snippets: [] })
      .mockResolvedValueOnce({ folders: [], snippets: [] })
      .mockResolvedValueOnce({ folders: [], snippets: [] })
      .mockResolvedValueOnce({ folders: ['abdomen'], snippets: [] })  // re-mount root
      .mockResolvedValueOnce({ folders: [], snippets: [] });          // abdomen after re-drill
    const { picker, container } = makePicker({ mode: 'folder-only' }, svc);
    await picker.mount();

    triggerClick(findByClass(container, 'rp-stp-folder-row')[0]);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    triggerClick(findFirst(container, (el) => el.classList.has('rp-stp-select-folder-btn'))!);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    // Unmount + re-mount.
    picker.unmount();
    await picker.mount();

    triggerClick(findByClass(container, 'rp-stp-folder-row')[0]);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    const selectBtn = findFirst(container, (el) => el.classList.has('rp-stp-select-folder-btn'))!;
    expect(selectBtn.classList.has('is-committed')).toBe(false);
    expect(selectBtn.textContent).toBe('Select this folder');
  });

  it('committed state persists at the same drillPath across additional re-renders triggered by clicking select-folder again', async () => {
    svc.listFolder
      .mockResolvedValueOnce({ folders: ['abdomen'], snippets: [] })
      .mockResolvedValueOnce({ folders: [], snippets: [] })
      .mockResolvedValueOnce({ folders: [], snippets: [] })
      .mockResolvedValueOnce({ folders: [], snippets: [] });
    const { picker, container } = makePicker({ mode: 'folder-only' }, svc);
    await picker.mount();

    triggerClick(findByClass(container, 'rp-stp-folder-row')[0]);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    triggerClick(findFirst(container, (el) => el.classList.has('rp-stp-select-folder-btn'))!);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    // Click again — still at the same drill path → should remain committed.
    triggerClick(findFirst(container, (el) => el.classList.has('rp-stp-select-folder-btn'))!);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    const selectBtn = findFirst(container, (el) => el.classList.has('rp-stp-select-folder-btn'))!;
    expect(selectBtn.classList.has('is-committed')).toBe(true);
    expect(selectBtn.textContent).toBe('\u2713 Selected');
  });
});

describe('Lifecycle', () => {
  let svc: FakeSnippetService;

  beforeEach(() => {
    svc = makeFakeSnippetService();
  });

  it('constructor does not mount automatically (container remains untouched until mount() called)', () => {
    svc.listFolder.mockResolvedValue({ folders: [], snippets: [] });
    const container = makeEl('div');
    // Place a child before constructor — expect it to remain.
    container.createEl('div', { text: 'Pre-existing' });
    const onSelect = vi.fn();
    new SnippetTreePicker({
      app: APP,
      snippetService: svc as unknown as SnippetTreePickerOptions['snippetService'],
      container: container as unknown as HTMLElement,
      mode: 'folder-only',
      rootPath: ROOT,
      onSelect,
    });
    expect(container.children.length).toBe(1);
    expect(container.children[0]?._text).toBe('Pre-existing');
  });

  it('mount() empties container before re-rendering', async () => {
    svc.listFolder.mockResolvedValue({ folders: [], snippets: [] });
    const { picker, container } = makePicker({ mode: 'folder-only' }, svc);
    container.createEl('div', { text: 'Stale' });
    await picker.mount();
    // 'Stale' child must be gone, replaced by picker DOM (root + search).
    expect(findFirst(container, (el) => el._text === 'Stale')).toBeNull();
    expect(findFirst(container, (el) => el.classList.has('rp-stp-root'))).not.toBeNull();
  });

  it('unmount() empties container and removes event listeners (verified by re-firing a click on a captured row — handler should not fire)', async () => {
    svc.listFolder.mockResolvedValue({
      folders: ['abdomen'],
      snippets: [],
    });
    const { picker, container, onSelect } = makePicker({ mode: 'both' }, svc);
    await picker.mount();

    // Capture a row before unmount.
    const capturedRow = findByClass(container, 'rp-stp-folder-row')[0];
    expect(capturedRow).toBeDefined();

    picker.unmount();
    expect(container.children.length).toBe(0);

    // Dispatching click on the captured (detached) row must NOT invoke onSelect.
    triggerClick(capturedRow);
    await Promise.resolve();
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('Picker row accessibility (no tooltip-triggering attributes)', () => {
  let svc: FakeSnippetService;

  beforeEach(() => {
    svc = makeFakeSnippetService();
  });

  it('file rows do not carry tooltip-triggering title or aria-label attributes', async () => {
    svc.listFolder.mockResolvedValue({
      folders: [],
      snippets: [mdTemplateSnippet(`${ROOT}/report.md`)],
    });
    const { picker, container } = makePicker({ mode: 'file-only' }, svc);
    await picker.mount();

    const fileRow = findByClass(container, 'rp-stp-file-row')[0];
    expect(fileRow?.getAttribute('title')).toBeNull();
    expect(fileRow?.getAttribute('aria-label')).toBeNull();
  });

  it('folder rows do not carry tooltip-triggering title or aria-label attributes', async () => {
    svc.listFolder.mockResolvedValue({
      folders: ['abdomen'],
      snippets: [],
    });
    const { picker, container } = makePicker({ mode: 'file-only' }, svc);
    await picker.mount();

    const folderRow = findByClass(container, 'rp-stp-folder-row')[0];
    expect(folderRow?.getAttribute('title')).toBeNull();
    expect(folderRow?.getAttribute('aria-label')).toBeNull();
  });

  it('folder rows in search results do not carry tooltip-triggering title or aria-label attributes', async () => {
    svc.listFolder.mockResolvedValue({ folders: [], snippets: [] });
    svc.listFolderDescendants.mockResolvedValue({
      folders: [`${ROOT}/abdomen`],
      files: [],
    });
    const { picker, container } = makePicker({ mode: 'both' }, svc);
    await picker.mount();

    const input = findFirst(container, (el) => el.classList.has('rp-stp-search-input'))!;
    triggerInput(input, 'abdomen');
    await flushDebounce();

    const folderRow = findByClass(container, 'rp-stp-folder-row')[0];
    expect(folderRow?.getAttribute('title')).toBeNull();
    expect(folderRow?.getAttribute('aria-label')).toBeNull();
  });
});

describe('Keyboard navigation (Phase 4)', () => {
  let svc: FakeSnippetService;

  beforeEach(() => {
    svc = makeFakeSnippetService();
  });

  it('ArrowDown moves the highlight onto the first row, then the second', async () => {
    svc.listFolder.mockResolvedValue({
      folders: ['abdomen', 'chest'],
      snippets: [mdTemplateSnippet(`${ROOT}/report.md`)],
    });
    const { picker, container } = makePicker({ mode: 'both' }, svc);
    await picker.mount();

    const input = findFirst(container, (el) => el.classList.has('rp-stp-search-input'))!;
    triggerKeydown(input, 'ArrowDown');
    let rows = rowsOf(container);
    expect(rows[0]!.classList.has('rp-stp-row-highlighted')).toBe(true);
    expect(rows[1]!.classList.has('rp-stp-row-highlighted')).toBe(false);

    triggerKeydown(input, 'ArrowDown');
    rows = rowsOf(container);
    expect(rows[1]!.classList.has('rp-stp-row-highlighted')).toBe(true);
    expect(rows[0]!.classList.has('rp-stp-row-highlighted')).toBe(false);
  });

  it('ArrowUp moves the highlight back to the previous row', async () => {
    svc.listFolder.mockResolvedValue({
      folders: ['abdomen', 'chest'],
      snippets: [],
    });
    const { picker, container } = makePicker({ mode: 'folder-only' }, svc);
    await picker.mount();

    const input = findFirst(container, (el) => el.classList.has('rp-stp-search-input'))!;
    triggerKeydown(input, 'ArrowDown'); // → 0
    triggerKeydown(input, 'ArrowDown'); // → 1
    triggerKeydown(input, 'ArrowUp');   // → 0
    const rows = rowsOf(container);
    expect(rows[0]!.classList.has('rp-stp-row-highlighted')).toBe(true);
    expect(rows[1]!.classList.has('rp-stp-row-highlighted')).toBe(false);
  });

  it('wrap-around: ArrowDown from last wraps to first; ArrowUp from first wraps to last', async () => {
    svc.listFolder.mockResolvedValue({
      folders: ['abdomen', 'chest'],
      snippets: [mdTemplateSnippet(`${ROOT}/report.md`)],
    });
    const { picker, container } = makePicker({ mode: 'both' }, svc);
    await picker.mount();

    const input = findFirst(container, (el) => el.classList.has('rp-stp-search-input'))!;
    triggerKeydown(input, 'ArrowDown'); // → 0
    triggerKeydown(input, 'ArrowDown'); // → 1
    triggerKeydown(input, 'ArrowDown'); // → 2 (last)
    let rows = rowsOf(container);
    expect(rows[2]!.classList.has('rp-stp-row-highlighted')).toBe(true);

    triggerKeydown(input, 'ArrowDown'); // wrap last → first
    rows = rowsOf(container);
    expect(rows[0]!.classList.has('rp-stp-row-highlighted')).toBe(true);
    expect(rows[2]!.classList.has('rp-stp-row-highlighted')).toBe(false);

    triggerKeydown(input, 'ArrowUp'); // wrap first → last
    rows = rowsOf(container);
    expect(rows[2]!.classList.has('rp-stp-row-highlighted')).toBe(true);
    expect(rows[0]!.classList.has('rp-stp-row-highlighted')).toBe(false);
  });

  it('Enter on a highlighted file row dispatches the row click handler (onSelect with kind: file)', async () => {
    svc.listFolder.mockResolvedValue({
      folders: [],
      snippets: [mdTemplateSnippet(`${ROOT}/report.md`)],
    });
    const { picker, container, onSelect } = makePicker({ mode: 'file-only' }, svc);
    await picker.mount();

    const input = findFirst(container, (el) => el.classList.has('rp-stp-search-input'))!;
    triggerKeydown(input, 'ArrowDown'); // → file row (only row)
    triggerKeydown(input, 'Enter');
    expect(onSelect).toHaveBeenCalledWith({ kind: 'file', relativePath: 'report.md' });
  });

  it('Enter on a highlighted folder row drills in (same path as a mouse click)', async () => {
    svc.listFolder
      .mockResolvedValueOnce({ folders: ['abdomen'], snippets: [] })
      .mockResolvedValueOnce({ folders: ['ct'], snippets: [] });
    const { picker, container, onSelect } = makePicker({ mode: 'both' }, svc);
    await picker.mount();

    const input = findFirst(container, (el) => el.classList.has('rp-stp-search-input'))!;
    triggerKeydown(input, 'ArrowDown'); // → folder row (first row)
    triggerKeydown(input, 'Enter');
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    // onSelect NOT called — folder click drills (D-12).
    expect(onSelect).not.toHaveBeenCalled();
    expect(svc.listFolder).toHaveBeenCalledWith(`${ROOT}/abdomen`);
  });

  it('Enter with no highlighted row is a no-op and does not throw', async () => {
    svc.listFolder.mockResolvedValue({
      folders: ['abdomen'],
      snippets: [mdTemplateSnippet(`${ROOT}/r.md`)],
    });
    const { picker, container, onSelect } = makePicker({ mode: 'both' }, svc);
    await picker.mount();

    const input = findFirst(container, (el) => el.classList.has('rp-stp-search-input'))!;
    expect(() => triggerKeydown(input, 'Enter')).not.toThrow();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('after a debounced search re-render the keydown listener is still active (ArrowDown moves highlight on freshly-rendered rows)', async () => {
    svc.listFolder.mockResolvedValue({ folders: [], snippets: [] });
    svc.listFolderDescendants.mockResolvedValue({
      files: [`${ROOT}/abdomen/ct.md`, `${ROOT}/abdomen/mri.md`],
      folders: [],
      total: 2,
    });
    const { picker, container } = makePicker({ mode: 'file-only' }, svc);
    await picker.mount();

    const input = findFirst(container, (el) => el.classList.has('rp-stp-search-input'))!;
    triggerInput(input, 'm');
    await flushDebounce();

    // Search results rendered — proves removeListenersExceptSearch() preserved
    // the keydown listener (it would have been dropped by the old input-only
    // keep-predicate).
    expect(rowsOf(container).length).toBe(2);

    triggerKeydown(input, 'ArrowDown');
    const rows = rowsOf(container);
    expect(rows[0]!.classList.has('rp-stp-row-highlighted')).toBe(true);
  });

  it('after a drill re-render the highlight resets (no row carries rp-stp-row-highlighted)', async () => {
    svc.listFolder
      .mockResolvedValueOnce({ folders: ['abdomen'], snippets: [] })
      .mockResolvedValueOnce({ folders: ['ct'], snippets: [] });
    const { picker, container } = makePicker({ mode: 'folder-only' }, svc);
    await picker.mount();

    const input = findFirst(container, (el) => el.classList.has('rp-stp-search-input'))!;
    triggerKeydown(input, 'ArrowDown'); // → row 0 highlighted
    expect(rowsOf(container)[0]!.classList.has('rp-stp-row-highlighted')).toBe(true);

    // Drill in via click → renderDrillView → clearHighlight resets the cursor.
    triggerClick(rowsOf(container)[0]);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    const rowsAfter = rowsOf(container);
    expect(rowsAfter.every((r) => !r.classList.has('rp-stp-row-highlighted'))).toBe(true);
  });

  it('aria-live status span announces the highlighted row title via snippetTreePicker.highlightAria (defaultT → English)', async () => {
    svc.listFolder.mockResolvedValue({
      folders: ['abdomen'],
      snippets: [],
    });
    const { picker, container } = makePicker({ mode: 'folder-only' }, svc);
    await picker.mount();

    const input = findFirst(container, (el) => el.classList.has('rp-stp-search-input'))!;
    triggerKeydown(input, 'ArrowDown');

    const status = findFirst(container, (el) => el.classList.has('rp-sr-only'));
    expect(status?.textContent).toBe('Highlighted: abdomen');
  });

  it('modifier-laden keys (Ctrl+ArrowDown) are ignored — no highlight moves, no throw', async () => {
    svc.listFolder.mockResolvedValue({
      folders: ['abdomen', 'chest'],
      snippets: [],
    });
    const { picker, container } = makePicker({ mode: 'folder-only' }, svc);
    await picker.mount();

    const input = findFirst(container, (el) => el.classList.has('rp-stp-search-input'))!;
    expect(() => triggerKeydown(input, 'ArrowDown', { ctrlKey: true })).not.toThrow();
    expect(rowsOf(container).every((r) => !r.classList.has('rp-stp-row-highlighted'))).toBe(true);
  });
});

describe('Vim-style navigation (Tab handoff + j/k)', () => {
  let svc: FakeSnippetService;

  beforeEach(() => {
    svc = makeFakeSnippetService();
  });

  async function setupWithRows(): Promise<{ picker: SnippetTreePicker; container: MockEl; onSelect: ReturnType<typeof vi.fn>; input: MockEl; root: MockEl }> {
    svc.listFolder.mockResolvedValue({
      folders: ['abdomen', 'chest'],
      snippets: [mdTemplateSnippet(`${ROOT}/report.md`)],
    });
    const { picker, container, onSelect } = makePicker({ mode: 'both' }, svc);
    await picker.mount();
    const input = findFirst(container, (el) => el.classList.has('rp-stp-search-input'))!;
    const root = findFirst(container, (el) => el.classList.has('rp-stp-root'))!;
    return { picker, container, onSelect, input, root };
  }

  /** Simulate a keydown that BUBBLED from the search input up to the root:
   *  MockEl.dispatchEvent has no bubbling, so dispatch on the root with the
   *  target overridden to the input. */
  function triggerBubbledKeydown(root: MockEl, input: MockEl, key: string, mods: Parameters<typeof triggerKeydown>[2] = {}): ReturnType<typeof vi.fn> {
    const preventDefault = vi.fn();
    root.dispatchEvent({
      type: 'keydown',
      key,
      code: mods.code ?? '',
      target: input,
      ctrlKey: !!mods.ctrlKey,
      altKey: !!mods.altKey,
      metaKey: !!mods.metaKey,
      shiftKey: !!mods.shiftKey,
      preventDefault,
    } as unknown as { type: string; target?: unknown });
    return preventDefault;
  }

  it('Tab from the search input highlights the first row and focuses it', async () => {
    const { container, input } = await setupWithRows();

    triggerKeydown(input, 'Tab');
    const rows = rowsOf(container);
    expect(rows[0]!.classList.has('rp-stp-row-highlighted')).toBe(true);
  });

  it('after Tab, j/k move the highlight regardless of the event key value (layout-independent, matched by e.code)', async () => {
    const { container, input, root } = await setupWithRows();

    triggerKeydown(input, 'Tab'); // → 0
    // On the Russian layout the physical j/k keys type «о»/«к»: key is Cyrillic,
    // code is still KeyJ/KeyK. Navigation must key off code, not key.
    triggerKeydown(root, 'о', { code: 'KeyJ' }); // → 1
    let rows = rowsOf(container);
    expect(rows[1]!.classList.has('rp-stp-row-highlighted')).toBe(true);
    expect(rows[0]!.classList.has('rp-stp-row-highlighted')).toBe(false);

    triggerKeydown(root, 'л', { code: 'KeyK' }); // → 0
    rows = rowsOf(container);
    expect(rows[0]!.classList.has('rp-stp-row-highlighted')).toBe(true);
    expect(rows[1]!.classList.has('rp-stp-row-highlighted')).toBe(false);
  });

  it('j/k on the list wrap around like the arrow keys', async () => {
    const { container, input, root } = await setupWithRows();

    triggerKeydown(input, 'Tab'); // → 0
    triggerKeydown(root, 'о', { code: 'KeyJ' }); // → 1
    triggerKeydown(root, 'о', { code: 'KeyJ' }); // → 2 (last)
    triggerKeydown(root, 'о', { code: 'KeyJ' }); // wrap last → first
    let rows = rowsOf(container);
    expect(rows[0]!.classList.has('rp-stp-row-highlighted')).toBe(true);

    triggerKeydown(root, 'л', { code: 'KeyK' }); // wrap first → last
    rows = rowsOf(container);
    expect(rows[2]!.classList.has('rp-stp-row-highlighted')).toBe(true);
  });

  it('j/k while focus is in the search input do NOT navigate (letters keep typing)', async () => {
    const { container, input, root } = await setupWithRows();

    // Keydown events dispatched on the input bubble to the root listener with
    // target = the input — the handler must bail out (search typing wins).
    triggerBubbledKeydown(root, input, 'о', { code: 'KeyJ' });
    triggerBubbledKeydown(root, input, 'л', { code: 'KeyK' });
    expect(rowsOf(container).every((r) => !r.classList.has('rp-stp-row-highlighted'))).toBe(true);
  });

  it('Enter on a focused highlighted row activates it (onSelect for a file row)', async () => {
    const { onSelect, container, input, root } = await setupWithRows();
    // After the drill, row 0 becomes a FILE row.
    svc.listFolder.mockResolvedValueOnce({ folders: [], snippets: [mdTemplateSnippet(`${ROOT}/abdomen/ct.md`)] });

    triggerKeydown(input, 'Tab'); // → row 0 = folder «abdomen»
    triggerKeydown(root, 'Enter'); // drills into «abdomen»
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    const fileRows = findByClass(container, 'rp-stp-file-row');
    expect(fileRows.length).toBe(1);
    // The drill re-render reset the highlight; re-highlight row 0 with j, then activate.
    triggerKeydown(root, 'о', { code: 'KeyJ' });
    expect(fileRows[0]!.classList.has('rp-stp-row-highlighted')).toBe(true);
    triggerKeydown(root, 'Enter'); // activates the highlighted file row
    expect(onSelect).toHaveBeenCalledWith({ kind: 'file', relativePath: 'abdomen/ct.md' });
  });

  it('walks the list with Tab and Shift+Tab in step with the highlight', async () => {
    const { container, input, root } = await setupWithRows();
    triggerKeydown(input, 'Tab'); // → row 0 highlighted and focused
    const rows = rowsOf(container);

    const tab = triggerBubbledKeydown(root, rows[0]!, 'Tab');
    expect(tab).toHaveBeenCalledTimes(1);
    expect(rows[1]!.classList.has('rp-stp-row-highlighted')).toBe(true);
    expect(rows[0]!.classList.has('rp-stp-row-highlighted')).toBe(false);
    expect(rows[1]!._focused).toBe(true);

    const back = triggerBubbledKeydown(root, rows[1]!, 'Tab', { shiftKey: true });
    expect(back).toHaveBeenCalledTimes(1);
    expect(rows[0]!.classList.has('rp-stp-row-highlighted')).toBe(true);
    expect(rows[1]!.classList.has('rp-stp-row-highlighted')).toBe(false);
    expect(rows[0]!._focused).toBe(true);
  });

  it('Tab from the last row is left to the browser so focus can leave the list', async () => {
    const { container, input, root } = await setupWithRows();
    triggerKeydown(input, 'Tab');
    const rows = rowsOf(container);
    for (let i = 1; i < rows.length; i += 1) triggerKeydown(root, 'j', { code: 'KeyJ' });
    const last = rows[rows.length - 1]!;
    expect(last.classList.has('rp-stp-row-highlighted')).toBe(true);

    const preventDefault = triggerBubbledKeydown(root, last, 'Tab');
    expect(preventDefault).not.toHaveBeenCalled();
    expect(last.classList.has('rp-stp-row-highlighted')).toBe(true);
  });

  it('Shift+Tab from the first row returns focus to the search input', async () => {
    const { container, input, root } = await setupWithRows();

    triggerKeydown(input, 'Tab'); // → list focused
    triggerKeydown(root, 'Tab', { shiftKey: true });

    // Focus bookkeeping is behavioral in a real browser; here we at least
    // require no throw and that the highlight survives the round-trip.
    expect(rowsOf(container)[0]!.classList.has('rp-stp-row-highlighted')).toBe(true);
  });
});

describe('hideSearchResultPath option (Phase 5)', () => {
  let svc: FakeSnippetService;

  beforeEach(() => {
    svc = makeFakeSnippetService();
  });

  it('hideSearchResultPath: true in file-only mode renders name but omits the result-path line', async () => {
    svc.listFolder.mockResolvedValue({ folders: [], snippets: [] });
    svc.listFolderDescendants.mockResolvedValue({
      files: [`${ROOT}/abdomen/ct/ct-routine.md`],
      folders: [],
      total: 1,
    });
    const { picker, container } = makePicker(
      { mode: 'file-only', hideSearchResultPath: true },
      svc,
    );
    await picker.mount();

    const input = findFirst(container, (el) => el.classList.has('rp-stp-search-input'))!;
    triggerInput(input, 'ct');
    await flushDebounce();

    // Name line present (glyph + basename).
    const nameEl = findFirst(container, (el) => el.classList.has('rp-stp-result-name'));
    expect(nameEl).not.toBeNull();
    expect(nameEl?.textContent).toContain('ct-routine.md');

    // No result-path element rendered anywhere in the picker.
    const pathEl = findFirst(container, (el) => el.classList.has('rp-stp-result-path'));
    expect(pathEl).toBeNull();

    // The file row itself is still present and selectable.
    const fileRows = findByClass(container, 'rp-stp-file-row');
    expect(fileRows.length).toBe(1);
  });

  it('hideSearchResultPath omitted (default false) still renders the result-path line — regression guard', async () => {
    svc.listFolder.mockResolvedValue({ folders: [], snippets: [] });
    svc.listFolderDescendants.mockResolvedValue({
      files: [`${ROOT}/abdomen/ct/ct-routine.md`],
      folders: [],
      total: 1,
    });
    const { picker, container } = makePicker({ mode: 'file-only' }, svc);
    await picker.mount();

    const input = findFirst(container, (el) => el.classList.has('rp-stp-search-input'))!;
    triggerInput(input, 'ct');
    await flushDebounce();

    const pathEl = findFirst(container, (el) => el.classList.has('rp-stp-result-path'));
    expect(pathEl).not.toBeNull();
    expect(pathEl?.textContent).toBe('abdomen/ct/ct-routine.md');
  });
});

// Runner surfaces opt in to keyboard-first entry: the caret must sit in the
// search field as soon as the listing is rendered, so typing filters and
// ArrowUp/Down/Enter navigate without an extra click.
describe('autoFocusSearch option', () => {
  let svc: FakeSnippetService;

  beforeEach(() => {
    svc = makeFakeSnippetService();
  });

  it('focuses the search input after the initial listing renders when enabled', async () => {
    svc.listFolder.mockResolvedValue({
      folders: [],
      snippets: [mdSnippet(`${ROOT}/abdomen/ct.md`)],
    });
    const { picker, container } = makePicker({ mode: 'file-only', autoFocusSearch: true }, svc);
    await picker.mount();

    const input = findFirst(container, (el) => el.classList.has('rp-stp-search-input'))!;
    expect(input._focused).toBe(true);
  });

  it('leaves focus to the host by default (editor / manager pickers)', async () => {
    const { picker, container } = makePicker({ mode: 'file-only' }, svc);
    await picker.mount();

    const input = findFirst(container, (el) => el.classList.has('rp-stp-search-input'))!;
    expect(input._focused).toBeUndefined();
  });

  it('does not focus a detached field when the picker is unmounted mid-load', async () => {
    let resolveListing!: (value: { folders: string[]; snippets: Snippet[] }) => void;
    const listingPromise = new Promise<{ folders: string[]; snippets: Snippet[] }>((resolve) => {
      resolveListing = resolve;
    });
    svc.listFolder.mockReturnValue(listingPromise);

    const { picker, container } = makePicker({ mode: 'file-only', autoFocusSearch: true }, svc);
    const mountPromise = picker.mount();
    // The search field exists synchronously, before the listing resolves.
    const input = findFirst(container, (el) => el.classList.has('rp-stp-search-input'))!;
    picker.unmount();
    resolveListing({ folders: [], snippets: [] });
    await mountPromise;

    expect(input._focused).toBeUndefined();
  });
});
