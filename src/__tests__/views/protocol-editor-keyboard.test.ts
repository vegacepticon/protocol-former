import { TFile } from 'obsidian';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProtocolEditorView, appendEdgeIdToOptionOrder } from '../../views/protocol-editor-view';
import type { ProtocolDocumentV1, ProtocolNodeRecord } from '../../protocol/protocol-document';

// Hoisted so the hoisted obsidian mock factory can write captured Menu items.
const menuCapture = vi.hoisted(() => ({
  items: [] as Array<{ title: string; cb: () => void }>,
  event: null as unknown,
}));

// ── Traversable MockEl with closest / querySelector / style.setProperty ──────

interface MockEl {
  tagName: string;
  children: MockEl[];
  parent: MockEl | null;
  _text: string;
  classList: Set<string>;
  _attrs: Record<string, string>;
  _listeners: Map<string, Array<(ev: unknown) => void>>;
  _value: string;
  value: string;
  _placeholder: string;
  _type: string;
  disabled: boolean;
  style: { setProperty: (prop: string, value: string) => void };
  setCssProps: (props: Record<string, string>) => void;
  _cssProps: Record<string, string>;
  createEl: (tag: string, opts?: { text?: string; cls?: string; type?: string; attr?: Record<string, string | number | boolean> }) => MockEl;
  createDiv: (opts?: { cls?: string; text?: string; attr?: Record<string, string | number | boolean> }) => MockEl;
  createSvg: (tag: string, opts?: { cls?: string; attr?: Record<string, string | number | boolean> }) => MockEl;
  appendChild: (child: MockEl) => MockEl;
  empty: () => void;
  setText: (text: string) => void;
  setAttr: (name: string, value: string | number | boolean) => void;
  addClass: (cls: string) => void;
  removeClass: (cls: string) => void;
  hasClass: (cls: string) => boolean;
  setAttribute: (k: string, v: string) => void;
  getAttribute: (k: string) => string | null;
  textContent: string;
  dataset: Record<string, string>;
  getAttr: (name: string) => string | null;
  querySelectorAll: (selector: string) => MockEl[];
  contains: (node: Node | null) => boolean;
  addEventListener: (type: string, handler: (ev: unknown) => void) => void;
  removeEventListener: (type: string, handler: (ev: unknown) => void) => void;
  toggleClass: (cls: string, force?: boolean) => void;
  closest: (selector: string) => MockEl | null;
  querySelector: (sel: string) => MockEl | null;
  createSpan: (opts?: { cls?: string; text?: string }) => MockEl;
  isConnected: boolean;
  remove: () => void;
  focus: (opts?: { preventScroll?: boolean }) => void;
  select: () => void;
  toggleAttribute: (name: string, force?: boolean) => void;
  appendText: (text: string) => void;
}

function makeEl(tag = 'div'): MockEl {
  const children: MockEl[] = [];
  const listeners = new Map<string, Array<(ev: unknown) => void>>();
  const classList = new Set<string>();
  const attrs: Record<string, string> = {};
  const el: MockEl = {
    tagName: tag.toUpperCase(),
    children,
    parent: null,
    _text: '',
    classList,
    _attrs: attrs,
    _listeners: listeners,
    _value: '',
    value: '',
    _placeholder: '',
    _type: '',
    disabled: false,
    isConnected: true,
    style: { setProperty() {} },
    _cssProps: {} as Record<string, string>,
    setCssProps(props: Record<string, string>): void {
      for (const [k, v] of Object.entries(props)) el._cssProps[k] = v;
    },
    createEl(subtag: string, opts?: { text?: string; cls?: string; type?: string; attr?: Record<string, string | number | boolean> }): MockEl {
      const child = makeEl(subtag);
      child.parent = el;
      if (opts?.text !== undefined) {
        child._text = opts.text;
        child.value = opts.text;
      }
      if (opts?.cls) {
        for (const c of opts.cls.split(' ').filter(Boolean)) child.classList.add(c);
      }
      if (opts?.type) child._type = opts.type;
      if (opts?.attr) {
        for (const [k, v] of Object.entries(opts.attr)) {
          child._attrs[k] = String(v);
          if (k === 'value') child.value = String(v);
        }
      }
      children.push(child);
      return child;
    },
    createDiv(opts?: { cls?: string; text?: string; attr?: Record<string, string | number | boolean> }): MockEl {
      return el.createEl('div', opts as { text?: string; cls?: string; attr?: Record<string, string | number | boolean> } | undefined);
    },
    createSvg(tag: string, opts?: { cls?: string; attr?: Record<string, string | number | boolean> }): MockEl {
      const child = makeEl(tag);
      child.parent = el;
      if (opts?.cls) for (const c of opts.cls.split(' ').filter(Boolean)) child.classList.add(c);
      if (opts?.attr) for (const [k, v] of Object.entries(opts.attr)) child._attrs[k] = String(v);
      children.push(child);
      return child;
    },
    appendChild(child: MockEl): MockEl {
      child.parent = el;
      children.push(child);
      return child;
    },
    createSpan(opts?: { cls?: string; text?: string }): MockEl {
      return el.createEl('span', opts as { text?: string; cls?: string } | undefined);
    },
    empty(): void { children.length = 0; },
    setText(text: string): void { el._text = text; },
    setAttr(name: string, value: string | number | boolean): void { attrs[name] = String(value); },
    addClass(cls: string): void { classList.add(cls); },
    removeClass(cls: string): void { classList.delete(cls); },
    hasClass(cls: string): boolean { return classList.has(cls); },
    setAttribute(k: string, v: string): void { attrs[k] = v; },
    getAttribute(k: string): string | null { return attrs[k] ?? null; },
    get textContent(): string { return el._text; },
    set textContent(value: string) { el._text = value; },
    dataset: {} as Record<string, string>,
    getAttr(name: string): string | null { return attrs[name] ?? null; },
    querySelectorAll(selector: string): MockEl[] {
      const want = selector.startsWith('.') ? selector.slice(1) : selector;
      const out: MockEl[] = [];
      const visit = (e: MockEl): void => {
        if (e.classList.has(want)) out.push(e);
        for (const c of e.children) visit(c);
      };
      for (const c of children) visit(c);
      return out;
    },
    contains(_node: Node | null): boolean { return false; },
    addEventListener(type: string, handler: (ev: unknown) => void): void {
      const arr = listeners.get(type) ?? [];
      arr.push(handler);
      listeners.set(type, arr);
    },
    removeEventListener(type: string, handler: (ev: unknown) => void): void {
      const arr = listeners.get(type);
      if (arr) listeners.set(type, arr.filter((h) => h !== handler));
    },
    toggleClass(cls: string, force?: boolean): void {
      if (force === true) classList.add(cls);
      else if (force === false) classList.delete(cls);
      else if (classList.has(cls)) classList.delete(cls);
      else classList.add(cls);
    },
    closest(selector: string): MockEl | null {
      if (selector.startsWith('.')) {
        const cls = selector.slice(1);
        let cur: MockEl | null = el;
        while (cur !== null) {
          if (cur.classList.has(cls)) return cur;
          cur = cur.parent ?? null;
        }
      }
      return null;
    },
    querySelector(selector: string): MockEl | null {
      const stack: MockEl[] = [el];
      while (stack.length > 0) {
        const cur = stack.pop()!;
        if (selector.startsWith('.')) {
          if (cur.classList.has(selector.slice(1))) return cur;
        }
        for (const child of cur.children) stack.push(child);
      }
      return null;
    },
    focus: vi.fn(),
    select: vi.fn(),
    appendText(text: string): void { el._text += text; },
    toggleAttribute(name: string, force?: boolean): void {
      const enabled = force ?? !attrs[name];
      if (enabled) attrs[name] = '';
      else delete attrs[name];
      if (name === 'disabled') el.disabled = enabled;
    },
    remove(): void {
      const markDisconnected = (node: MockEl): void => {
        node.isConnected = false;
        for (const child of node.children) markDisconnected(child);
      };
      markDisconnected(el);
      if (el.parent) {
        const idx = el.parent.children.indexOf(el);
        if (idx >= 0) el.parent.children.splice(idx, 1);
        el.parent = null;
      }
    },
  };
  return el;
}

function findAllByClass(root: MockEl, cls: string): MockEl[] {
  const results: MockEl[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur.classList.has(cls)) results.push(cur);
    for (const child of cur.children) stack.push(child);
  }
  return results;
}

function findAllByTag(root: MockEl, tagName: string): MockEl[] {
  const results: MockEl[] = [];
  const normalized = tagName.toUpperCase();
  const stack = [root];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur.tagName === normalized) results.push(cur);
    for (const child of cur.children) stack.push(child);
  }
  return results;
}

function dispatchKeyDown(el: MockEl, key: string, target?: MockEl): void {
  const handlers = el._listeners.get('keydown') ?? [];
  for (const handler of handlers) {
    handler({ key, target: target ?? el, preventDefault: () => {}, stopPropagation: () => {} });
  }
}

function nodeKindsInPicker(root: MockEl): string[] {
  const kinds: string[] = [];
  const stack: MockEl[] = [root];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const k = cur.getAttribute('data-node-kind');
    if (k !== null) kinds.push(k);
    // Push children in reverse so document order is preserved.
    for (let i = cur.children.length - 1; i >= 0; i--) stack.push(cur.children[i]!);
  }
  return kinds;
}

// ── Mock dom-helpers ───────────────────────────────────────────────────────

vi.mock('../../utils/dom-helpers', () => ({
  createButton: (parent: MockEl, opts: { cls?: string; text?: string; attr?: Record<string, string | number | boolean> } = {}): MockEl => {
    return parent.createEl('button', { cls: opts.cls, text: opts.text, attr: opts.attr });
  },
  createInput: (parent: MockEl, opts: { cls?: string; type?: string; placeholder?: string; value?: string; attr?: Record<string, string | number | boolean> } = {}): MockEl => {
    const input = parent.createEl('input', {
      cls: opts.cls,
      type: opts.type,
      attr: { ...opts.attr ?? {}, ...(opts.placeholder ? { placeholder: opts.placeholder } : {}) },
    });
    input._value = opts.value ?? '';
    input.value = opts.value ?? '';
    input._placeholder = opts.placeholder ?? '';
    input._type = opts.type ?? 'text';
    return input;
  },
}));

// ── Mock obsidian ──────────────────────────────────────────────────────────

vi.mock('obsidian', () => ({
  ItemView: class {
    leaf = {};
    containerEl = makeEl('div');
    contentEl = makeEl('div');
    constructor() {}
    getViewType() { return ''; }
    getDisplayText() { return ''; }
    getIcon() { return ''; }
    onOpen() {}
    onClose() {}
    registerDomEvent() {}
  },
  Modal: class {
    contentEl = makeEl('div');
    title = '';
    setTitle(title: string): void { this.title = title; }
    open(): void { this.onOpen(); }
    close(): void { this.onClose(); }
    onOpen(): void {}
    onClose(): void {}
  },
  WorkspaceLeaf: class {},
  Notice: class { constructor() {} },
  setIcon: () => {},
  Menu: class {
    items: Array<{ title: string; cb: () => void }> = [];
    addItem(cb: (item: { setTitle: (t: string) => any; setIcon: (i: string) => any; onClick: (c: () => void) => any }) => void): this {
      const state: { title: string; cb: () => void } = { title: '', cb: () => {} };
      const api = {
        setTitle: (t: string) => { state.title = t; return api; },
        setIcon: (_i: string) => api,
        onClick: (c: () => void) => { state.cb = c; return api; },
      };
      cb(api);
      this.items.push(state);
      menuCapture.items = this.items;
      return this;
    }
    showAtMouseEvent(ev: unknown): void { menuCapture.event = ev; }
  },
  App: class {},
  TFile: class { path = ''; extension = ''; basename = ''; constructor(p = '') { this.path = p; } },
}));;

// ── Mock SnippetTreePicker (imported by protocol-editor-view) ────────────────
const pickerSpies = vi.hoisted(() => ({
  ctor: vi.fn(),
  mount: vi.fn(),
  unmount: vi.fn(),
  instances: [] as Array<{ options: any }>,
}));

vi.mock('../../views/snippet-tree-picker', () => ({
  SnippetTreePicker: class {
    constructor(options: any) {
      pickerSpies.ctor(options);
      pickerSpies.instances.push({ options });
    }
    mount() { pickerSpies.mount(); return Promise.resolve(); }
    unmount() { pickerSpies.unmount(); }
  },
}));

// ── Mock plugin i18n ───────────────────────────────────────────────────────

const t = (key: string, _params?: Record<string, string>): string => {
  const map: Record<string, string> = {
    'protocolEditor.displayText': 'Protocol editor',
    'protocolEditor.untyped': 'untyped',
    'protocolEditor.inputPortLabel': 'Input port',
    'protocolEditor.outputPortLabel': 'Output port',
    'protocolEditor.resizeNodeLabel': 'Resize node',
    'protocolEditor.editNode': 'Edit Node',
    'protocolEditor.close': 'Close',
    'protocolEditor.kindLabel': 'Kind',
    'protocolEditor.save': 'Save',
    'protocolEditor.cancel': 'Cancel',
    'protocolEditor.delete': 'Delete',
    'protocolEditor.nodeKind.start': 'Start',
    'protocolEditor.nodeKind.question': 'Question',
    'protocolEditor.nodeKind.answer': 'Answer',
    'protocolEditor.nodeKind.text-block': 'Text block',
    'protocolEditor.nodeKind.snippet': 'Snippet',
    'protocolEditor.questionTextLabel': 'Question text',
    'protocolEditor.answerTextLabel': 'Answer text',
    'protocolEditor.freeTextAnswerLabel': 'Collect a free-text response',
    'protocolEditor.freeTextAnswerHelp': 'Use the Answer label or text as the prompt; the radiologist enters multiline report text during the run.',
    'protocolEditor.loopToggleLabel': 'Loop',
    'protocolEditor.loopBadgeAriaLabel': 'Loop question',
    'protocolEditor.freeTextBadgeAriaLabel': 'Free-text answer',
    'protocolEditor.startPointCustomLabelLabel': 'Custom label for the “start from node” picker',
    'protocolEditor.startPointCustomLabelPlaceholder': 'Leave empty to use the node\'s own label',
    'protocolEditor.contentLabel': 'Content',
    'protocolEditor.snippetSeparatorLabel': 'Separator',
    'protocolEditor.noNodes': 'No nodes',
    'protocolEditor.snippetNodeLabelLabel': 'Snippet label',
    'protocolEditor.startPointEnabledLabel': 'Start point',
    'selfCheck.title': 'Self-check',
    'protocolEditor.conclusionDraftTitle': 'Conclusion draft preset',
    'protocolEditor.conclusionDraftLabel': 'Draft items (one per line)',
    'protocolEditor.conclusionDraftHelp': 'These lines prefill the Runner conclusion draft.',
    'protocolEditor.conclusionDraftPlaceholder': 'One draft item per line',
    'protocolEditor.toggleMinimap': 'Minimap',
    'protocolEditor.autoLayout': 'Auto layout',
    'protocolEditor.autoLayoutVertical': 'Vertical layout',
    'protocolEditor.autoLayoutHorizontal': 'Horizontal layout',
    'protocolEditor.noEditableFields': 'No editable fields',
    'protocolEditor.openPickerPlaceholder': 'Open…',
    'protocolEditor.edgeFromLabel': 'From',
    'protocolEditor.edgeToLabel': 'To',
    'protocolEditor.edgeLabelLabel': 'Label',
    'protocolEditor.edgeLabelPlaceholder': 'Label',
    'protocolEditor.answerButtonLabelLabel': 'Answer label',
    'protocolEditor.snippetTargetLabel': 'Snippet target',
    'protocolEditor.browseSnippetTarget': 'Browse',
    'protocolEditor.browseSnippetTargetTitle': 'Browse snippet target',
    'protocolEditor.noSnippetTarget': 'No target',
    'protocolEditor.snippetTargetHelp': 'Choose a folder or snippet',
    'protocolEditor.snippetFolderTarget': 'Folder',
    'protocolEditor.snippetFileTarget': 'Snippet',
    'protocolEditor.snippetFolderPlaceholder': 'Folder',
    'protocolEditor.snippetFilePlaceholder': 'File',
    'protocolEditor.clearSnippetTarget': 'Clear',
    'protocolEditor.chooseNodeType': 'Choose node type',
    'protocolEditor.minimapLabel': 'Minimap — click or drag to pan',
    'protocolEditor.useGlobalSeparator': 'Use global',
    'settings.newline': 'Newline',
    'settings.space': 'Space',
    'protocolEditor.edgeLabelHelp': 'Shown beside the edge',
    'protocolEditor.loopExitLabel': 'Loop exit',
    'protocolEditor.deleteEdgeLabel': 'Delete edge',
    'protocolEditor.edgeSaved': 'Edge saved',
    'protocolEditor.deleteNodeConfirm': 'Delete this node?',
    'protocolEditor.confirmDelete': 'Confirm delete',
    'protocolEditor.nodeDeleted': 'Node deleted',
  };
  return map[key] ?? key;
};

// ── Test helper: create a minimally-wired view ──────────────────────────────

function createTestView(): { view: ProtocolEditorView; surfaceEl: MockEl; openEditModalCalls: ProtocolNodeRecord[] } {
  const openEditModalCalls: ProtocolNodeRecord[] = [];

  const mockPlugin = {
    i18n: { t },
    settings: { snippetFolderPath: '.radiprotocol/snippets' },
    protocolDocumentStore: {},
  } as any;

  const leaf = {} as any;
  const view = new ProtocolEditorView(leaf, mockPlugin);

  (view as any).openEditModal = (node: ProtocolNodeRecord) => openEditModalCalls.push(node);

  const surfaceEl = makeEl('div');
  const svgEl = makeEl('svg');
  const viewportEl = makeEl('div');
  const rootEl = makeEl('div');

  (view as any).surfaceEl = surfaceEl;
  (view as any).svgEl = svgEl;
  (view as any).viewportEl = viewportEl;
  (view as any).rootEl = rootEl;
  (view as any).protocolPath = 'test.rp.json';
  (view as any).zoom = 1;

  const doc: ProtocolDocumentV1 = {
    schema: 'radiprotocol.protocol',
    version: 1,
    id: 'test-doc',
    title: 'Test Protocol',
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    nodes: [
      {
        id: 'node-1',
        kind: 'question',
        x: 100,
        y: 100,
        width: 200,
        height: 80,
        text: 'Where is the pain?',
        fields: { questionText: 'Where is the pain?' },
      },
    ],
    edges: [],
  };
  (view as any).doc = doc;

  return { view, surfaceEl, openEditModalCalls };
}

// Helper: create a view with a start node that has no explicit text label
function createStartNodeView(): { view: ProtocolEditorView; surfaceEl: MockEl } {
  const mockPlugin = {
    i18n: { t },
    settings: { snippetFolderPath: '.radiprotocol/snippets' },
    protocolDocumentStore: {},
  } as any;

  const leaf = {} as any;
  const view = new ProtocolEditorView(leaf, mockPlugin);

  const surfaceEl = makeEl('div');
  const svgEl = makeEl('svg');
  const viewportEl = makeEl('div');
  const rootEl = makeEl('div');

  (view as any).surfaceEl = surfaceEl;
  (view as any).svgEl = svgEl;
  (view as any).viewportEl = viewportEl;
  (view as any).rootEl = rootEl;
  (view as any).protocolPath = 'test.rp.json';
  (view as any).zoom = 1;

  const doc: ProtocolDocumentV1 = {
    schema: 'radiprotocol.protocol',
    version: 1,
    id: 'test-doc',
    title: 'Test Protocol',
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    nodes: [
      {
        id: 'node-start',
        kind: 'start',
        x: 100,
        y: 100,
        width: 160,
        height: 60,
        text: undefined as any,
        fields: {},
      },
    ],
    edges: [],
  };
  (view as any).doc = doc;

  return { view, surfaceEl };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('ProtocolEditorView: node keyboard activation', () => {
  it('opens edit modal on keydown Enter', () => {
    const { view, surfaceEl, openEditModalCalls } = createTestView();
    (view as any).renderDocument();

    const nodes = findAllByClass(surfaceEl, 'rp-protocol-editor-node');
    expect(nodes.length).toBeGreaterThanOrEqual(1);

    dispatchKeyDown(nodes[0]!, 'Enter');
    expect(openEditModalCalls.length).toBe(1);
    expect(openEditModalCalls[0]!.id).toBe('node-1');
  });

  it('opens edit modal on keydown Space', () => {
    const { view, surfaceEl, openEditModalCalls } = createTestView();
    (view as any).renderDocument();

    const nodes = findAllByClass(surfaceEl, 'rp-protocol-editor-node');
    dispatchKeyDown(nodes[0]!, ' ');

    expect(openEditModalCalls.length).toBe(1);
    expect(openEditModalCalls[0]!.id).toBe('node-1');
  });

  it('does not open edit modal when keydown originates from a port element', () => {
    const { view, surfaceEl, openEditModalCalls } = createTestView();
    (view as any).renderDocument();

    const nodes = findAllByClass(surfaceEl, 'rp-protocol-editor-node');
    const ports = findAllByClass(surfaceEl, 'rp-protocol-editor-port');
    expect(ports.length).toBeGreaterThanOrEqual(1);

    dispatchKeyDown(nodes[0]!, 'Enter', ports[0]!);
    expect(openEditModalCalls.length).toBe(0);
  });

  it('does not open edit modal for unrelated keys', () => {
    const { view, surfaceEl, openEditModalCalls } = createTestView();
    (view as any).renderDocument();

    const nodes = findAllByClass(surfaceEl, 'rp-protocol-editor-node');
    dispatchKeyDown(nodes[0]!, 'Tab');
    dispatchKeyDown(nodes[0]!, 'Escape');
    dispatchKeyDown(nodes[0]!, 'a');

    expect(openEditModalCalls.length).toBe(0);
  });

  it('renders node with tabindex=0 for keyboard focus', () => {
    const { view, surfaceEl } = createTestView();
    (view as any).renderDocument();

    const nodes = findAllByClass(surfaceEl, 'rp-protocol-editor-node');
    expect(nodes[0]!._attrs['tabindex']).toBe('0');
  });

  it('renders node with role=group', () => {
    const { view, surfaceEl } = createTestView();
    (view as any).renderDocument();

    const nodes = findAllByClass(surfaceEl, 'rp-protocol-editor-node');
    expect(nodes[0]!._attrs['role']).toBe('group');
  });

  it('renders node with aria-label from node title', () => {
    const { view, surfaceEl } = createTestView();
    (view as any).renderDocument();

    const nodes = findAllByClass(surfaceEl, 'rp-protocol-editor-node');
    expect(nodes[0]!._attrs['aria-label']).toBe('Where is the pain?');
  });

  it('start node without explicit text does not render the default i18n key as label', () => {
    const { view, surfaceEl } = createStartNodeView();
    (view as any).renderDocument();

    const nodes = findAllByClass(surfaceEl, 'rp-protocol-editor-node');
    expect(nodes.length).toBe(1);
    const titles = findAllByClass(nodes[0]!, 'rp-protocol-editor-node-title');
    expect(titles.length).toBe(0);
    const kinds = findAllByClass(nodes[0]!, 'rp-protocol-editor-node-kind');
    expect(kinds.length).toBe(1);
  });
});

describe('ProtocolEditorView: floating action button aria-labels', () => {
  let savedWindow: unknown;
  let savedRAF: unknown;
  beforeEach(() => {
    savedWindow = (globalThis as any).window;
    savedRAF = (globalThis as any).requestAnimationFrame;
    (globalThis as any).window = globalThis;
    (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => { cb(0); return 0; };
  });
  afterEach(() => {
    (globalThis as any).window = savedWindow;
    (globalThis as any).requestAnimationFrame = savedRAF;
  });

  function createShellView(): { view: ProtocolEditorView; rootEl: MockEl } {
    const mockPlugin = {
      i18n: { t },
      settings: { snippetFolderPath: '.radiprotocol/snippets' },
      protocolDocumentStore: {},
    } as any;

    const leaf = {} as any;
    const view = new ProtocolEditorView(leaf, mockPlugin);

    const containerEl = makeEl('div');
    containerEl.createDiv({ cls: 'nav-region' });
    const contentArea = containerEl.createDiv({ cls: 'content-area' });
    (view as any).containerEl = containerEl;

    const doc: ProtocolDocumentV1 = {
      schema: 'radiprotocol.protocol',
      version: 1,
      id: 'test-doc',
      title: 'Test Protocol',
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
      nodes: [],
      edges: [],
    };
    (view as any).doc = doc;
    (view as any).protocolPath = 'test.rp.json';
    (view as any).zoom = 1;

    (view as any).renderShell();
    const rootEl = contentArea.children.find((c: MockEl) => c.classList.has('rp-protocol-editor'))!;
    return { view, rootEl };
  }

  it('self-check floating button has localized aria-label', () => {
    const { rootEl } = createShellView();
    const workspace = rootEl.children.find((c: MockEl) => c.classList.has('rp-protocol-editor-workspace'))!;
    const floatingActions = workspace.children.find((c: MockEl) => c.classList.has('rp-protocol-editor-floating-actions'))!;
    const buttons = floatingActions.children.filter((c: MockEl) => c.tagName === 'BUTTON');
    const selfCheckBtn = buttons.find((b: MockEl) => b._attrs['aria-label'] === 'Self-check')!;
    expect(selfCheckBtn._attrs['aria-label']).toBe('Self-check');
  });

  it('conclusion draft floating button has localized aria-label', () => {
    const { rootEl } = createShellView();
    const workspace = rootEl.children.find((c: MockEl) => c.classList.has('rp-protocol-editor-workspace'))!;
    const floatingActions = workspace.children.find((c: MockEl) => c.classList.has('rp-protocol-editor-floating-actions'))!;
    const buttons = floatingActions.children.filter((c: MockEl) => c.tagName === 'BUTTON');
    const draftBtn = buttons.find((b: MockEl) => b._attrs['aria-label'] === 'Conclusion draft preset')!;
    expect(draftBtn._attrs['aria-label']).toBe('Conclusion draft preset');
  });

  it('conclusion draft modal persists one trimmed item per line and closes on Save', async () => {
    const { view } = createShellView();
    const doc = (view as any).doc as ProtocolDocumentV1;
    const updates: ProtocolDocumentV1[] = [];
    (view as any).documentOwner = {
      capture: () => ({ path: 'test.rp.json', generation: 1 }),
      isCurrent: () => true,
      update: async (_lease: unknown, mutate: (existing: ProtocolDocumentV1) => ProtocolDocumentV1) => {
        const updated = mutate(doc);
        updates.push(updated);
        return updated;
      },
      own: (_lease: unknown, dispose: () => void) => dispose,
    };
    const backdrop = makeEl('div');
    const savedDocument = (globalThis as any).document;
    (globalThis as any).document = { body: { createDiv: () => backdrop }, activeElement: null };
    try {
      (view as any).openConclusionDraftModal();
      const textarea = findAllByTag(backdrop, 'textarea')[0]!;
      expect(textarea).toBeDefined();
      textarea.value = '  Alpha  \n\n Beta ';
      for (const handler of textarea._listeners.get('input') ?? []) handler({});

      const saveBtn = findAllByTag(backdrop, 'button').find((b) => b._text === 'Save')!;
      for (const handler of saveBtn._listeners.get('click') ?? []) handler({});
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(updates).toHaveLength(1);
      expect(updates[0]!.conclusionDraftItems).toEqual(['Alpha', 'Beta']);
      expect((view as any).doc.conclusionDraftItems).toEqual(['Alpha', 'Beta']);
      expect(backdrop.isConnected).toBe(false);
    } finally {
      (globalThis as any).document = savedDocument;
    }
  });

  it('minimap toggle floating button has localized aria-label', () => {
    const { rootEl } = createShellView();
    const workspace = rootEl.children.find((c: MockEl) => c.classList.has('rp-protocol-editor-workspace'))!;
    const floatingActions = workspace.children.find((c: MockEl) => c.classList.has('rp-protocol-editor-floating-actions'))!;
    const buttons = floatingActions.children.filter((c: MockEl) => c.tagName === 'BUTTON');
    const minimapBtn = buttons.find((b: MockEl) => b._attrs['aria-label'] === 'Minimap')!;
    expect(minimapBtn._attrs['aria-label']).toBe('Minimap');
  });

  it('auto-layout floating button opens a Menu with TB/LR items', () => {
    const { view, rootEl } = createShellView();
    const workspace = rootEl.children.find((c: MockEl) => c.classList.has('rp-protocol-editor-workspace'))!;
    const floatingActions = workspace.children.find((c: MockEl) => c.classList.has('rp-protocol-editor-floating-actions'))!;
    const buttons = floatingActions.children.filter((c: MockEl) => c.tagName === 'BUTTON');
    // Exactly one consolidated auto-layout trigger; neither direction is its own button.
    const layoutBtn = buttons.find((b: MockEl) => b._attrs['aria-label'] === 'Auto layout')!;
    expect(layoutBtn._attrs['aria-label']).toBe('Auto layout');
    // Exactly one consolidated auto-layout trigger; neither direction is its own button.
    expect(buttons.filter((b: MockEl) => b._attrs['aria-label'] === 'Auto layout')).toHaveLength(1);
    expect(buttons.filter((b: MockEl) => b._attrs['aria-label'] === 'Vertical layout' || b._attrs['aria-label'] === 'Horizontal layout')).toHaveLength(0);
    // Clicking it opens a Menu positioned at the click event with two items.
    menuCapture.items = [];
    menuCapture.event = null;
    const clickEvent = { preventDefault: () => {}, stopPropagation: () => {} };
    const handlers = layoutBtn._listeners.get('click') ?? [];
    for (const handler of handlers) handler(clickEvent);
    expect(menuCapture.event).toBe(clickEvent);
    expect(menuCapture.items).toHaveLength(2);
    expect(menuCapture.items.map((i) => i.title)).toEqual(['Vertical layout', 'Horizontal layout']);
    // Item callbacks preserve the existing TB/LR mapping into autoLayoutNodes.
    const spy = vi.spyOn(view as any, 'autoLayoutNodes');
    menuCapture.items[0]!.cb();
    menuCapture.items[1]!.cb();
    expect(spy).toHaveBeenNthCalledWith(1, 'TB');
    expect(spy).toHaveBeenNthCalledWith(2, 'LR');
  });

  it('minimap element has no aria-label (no hover-tooltip noise) but keeps role=button', () => {
    const { rootEl } = createShellView();
    const workspace = rootEl.children.find((c: MockEl) => c.classList.has('rp-protocol-editor-workspace'))!;
    const minimap = workspace.children.find((c: MockEl) => c.classList.has('rp-protocol-editor-minimap'))!;
    expect(minimap).toBeDefined();
    expect(minimap!._attrs['aria-label']).toBeUndefined();
    expect(minimap!._attrs['role']).toBe('button');
  });

  it('minimap element has tabindex=0 for keyboard focus', () => {
    const { rootEl } = createShellView();
    const workspace = rootEl.children.find((c: MockEl) => c.classList.has('rp-protocol-editor-workspace'))!;
    const minimap = workspace.children.find((c: MockEl) => c.classList.has('rp-protocol-editor-minimap'))!;
    expect(minimap!._attrs['tabindex']).toBe('0');
  });

  it('Enter key on minimap toggles visibility', () => {
    const { rootEl } = createShellView();
    const workspace = rootEl.children.find((c: MockEl) => c.classList.has('rp-protocol-editor-workspace'))!;
    const minimap = workspace.children.find((c: MockEl) => c.classList.has('rp-protocol-editor-minimap'))!;
    expect(minimap!.classList.has('is-hidden')).toBe(false);
    dispatchKeyDown(minimap!, 'Enter');
    expect(minimap!.classList.has('is-hidden')).toBe(true);
    dispatchKeyDown(minimap!, 'Enter');
    expect(minimap!.classList.has('is-hidden')).toBe(false);
  });

  it('Space key on minimap toggles visibility and prevents default', () => {
    const { rootEl } = createShellView();
    const workspace = rootEl.children.find((c: MockEl) => c.classList.has('rp-protocol-editor-workspace'))!;
    const minimap = workspace.children.find((c: MockEl) => c.classList.has('rp-protocol-editor-minimap'))!;
    let prevented = false;
    const handlers = minimap!._listeners.get('keydown') ?? [];
    for (const handler of handlers) {
      handler({ key: ' ', target: minimap!, preventDefault: () => { prevented = true; }, stopPropagation: () => {} });
    }
    expect(prevented).toBe(true);
    expect(minimap!.classList.has('is-hidden')).toBe(true);
  });

  it('adaptive minimap sets size custom props from the content aspect ratio', () => {
    const { view } = createTestView();
    (view as any).minimapSvgEl = makeEl('svg');
    (view as any).minimapEl = makeEl('div');
    // Wide flat graph (aspect 2:1)
    (view as any).doc = {
      schema: 'radiprotocol.protocol', version: 1, id: 't', title: 'T',
      createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z',
      nodes: [{ id: 'n', kind: null, x: 0, y: 0, width: 1000, height: 400, fields: {} }],
      edges: [],
    } as ProtocolDocumentV1;
    (view as any).renderMinimap();

    const minimap = (view as any).minimapEl as MockEl;
    const w = Number.parseFloat(minimap._cssProps['--rp-minimap-width'] ?? '0');
    const h = Number.parseFloat(minimap._cssProps['--rp-minimap-height'] ?? '0');
    // No measurable viewport in this shell → fallback caps at 640×720;
    // the wide graph hits the width cap.
    expect(w).toBeLessThanOrEqual(640);
    expect(h).toBeLessThanOrEqual(720);
    // Aspect ratio preserved within rounding (content 1160×680 incl. padding).
    const vb = (view as any).minimapSvgEl._attrs['viewBox'].split(' ').map(Number);
    expect(w / h).toBeCloseTo(vb[2] / vb[3], 1);
  });

  it('adaptive minimap caps derive from the editor viewport when measurable', () => {
    const { view } = createTestView();
    (view as any).minimapSvgEl = makeEl('svg');
    (view as any).minimapEl = makeEl('div');
    (view as any).viewportEl = Object.assign(makeEl('div'), { clientWidth: 1000, clientHeight: 800 });
    (view as any).doc = {
      schema: 'radiprotocol.protocol', version: 1, id: 't', title: 'T',
      createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z',
      nodes: [{ id: 'n', kind: null, x: 0, y: 0, width: 1000, height: 400, fields: {} }],
      edges: [],
    } as ProtocolDocumentV1;
    (view as any).renderMinimap();

    const minimap = (view as any).minimapEl as MockEl;
    const w = Number.parseFloat(minimap._cssProps['--rp-minimap-width'] ?? '0');
    // Viewport-derived width cap is 900px — wide graph hits it.
    expect(w).toBeLessThanOrEqual(900);
    expect(w).toBeGreaterThan(340); // larger than the old fixed cap
  });
});

// ── Regression: empty answer text must not fall back to stale node.text ─────

describe('openEditModal — empty multiline field regression (1.22.0 bug)', () => {
  let savedWindow: unknown;
  let savedRAF: unknown;
  let savedDocument: unknown;
  beforeEach(() => {
    savedWindow = (globalThis as any).window;
    savedRAF = (globalThis as any).requestAnimationFrame;
    savedDocument = (globalThis as any).document;
    (globalThis as any).window = globalThis;
    (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => { cb(0); return 0; };
  });
  afterEach(() => {
    (globalThis as any).window = savedWindow;
    (globalThis as any).requestAnimationFrame = savedRAF;
    (globalThis as any).document = savedDocument;
  });

  it('saves empty answerText as empty string, not undefined', async () => {
    // Reproduces the 1.22.0 bug: clearing answerText kept the stale node.text (' ')
    // because multiline inputs used `|| undefined` — empty string was coerced to undefined
    // and then the field was deleted, causing the parser/runner to fall back to node.text.
    const t = (key: string): string => key;

    const savedNodes: ProtocolNodeRecord[] = [];

    const mockStore = {
      async update(_path: string, mutator: (doc: ProtocolDocumentV1 | null) => ProtocolDocumentV1): Promise<ProtocolDocumentV1> {
        const doc: ProtocolDocumentV1 = {
          schema: 'radiprotocol.protocol', version: 1, id: 'test', title: 'T',
          createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z',
          nodes: [{
            id: 'a1', kind: 'answer', x: 0, y: 0, width: 200, height: 80,
            text: ' ',
            fields: { answerText: ' ' },
          }],
          edges: [],
        };
        const result = mutator(doc);
        savedNodes.push(...result.nodes);
        return result;
      },
      async read() { return null; },
    };

    const mockPlugin = { i18n: { t }, settings: {}, protocolDocumentStore: mockStore } as any;
    const leaf = {} as any;
    const view = new ProtocolEditorView(leaf, mockPlugin);

    const surfaceEl = makeEl('div');
    const viewportEl = makeEl('div');
    // openEditModal checks viewportEl.isConnected before restoring focus
    Object.defineProperty(viewportEl, 'isConnected', { value: true, writable: true });

    (view as any).surfaceEl = surfaceEl;
    (view as any).svgEl = makeEl('svg');
    (view as any).viewportEl = viewportEl;
    (view as any).rootEl = makeEl('div');
    (view as any).protocolPath = 'test.rp.json';
    (view as any).zoom = 1;
    (view as any).doc = {
      schema: 'radiprotocol.protocol', version: 1, id: 'test', title: 'T',
      createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z',
      nodes: [{
        id: 'a1', kind: 'answer', x: 0, y: 0, width: 200, height: 80,
        text: ' ',
        fields: { answerText: ' ' },
      }],
      edges: [],
    } as ProtocolDocumentV1;
    (view as any).loadProtocol = vi.fn(async () => {});

    // openEditModal uses document.body.createDiv — point it at surfaceEl
    (globalThis as any).document = {
      body: {
        createDiv: () => surfaceEl,
      },
      activeElement: null,
    };

    (view as any).openEditModal((view as any).doc.nodes[0]);

    const allTextareas = findAllByTag(surfaceEl, 'textarea');
    const answerTextTA = allTextareas.length >= 2 ? allTextareas[1] : allTextareas[allTextareas.length - 1];
    expect(answerTextTA).toBeDefined();
    answerTextTA!.value = '';

    // Click save — find the Save button
    let saveBtn: MockEl | null = null;
    const stack2 = [surfaceEl];
    while (stack2.length > 0) {
      const cur = stack2.pop()!;
      if (cur._text === 'protocolEditor.save') {
        saveBtn = cur;
        break;
      }
      for (const child of cur.children) stack2.push(child);
    }

    // Trigger click handlers
    if (saveBtn) {
      const handlers = saveBtn._listeners.get('click') ?? [];
      for (const h of handlers) await h({});
    }

    // Verify: answerText must be empty string, not undefined
    const savedAnswer = savedNodes.find(n => n.id === 'a1');
    expect(savedAnswer).toBeDefined();
    expect(savedAnswer!.fields['answerText']).toBe('');
  });
});

describe('openEditModal — Answer free-text authoring', () => {
  let savedDocument: unknown;

  beforeEach(() => {
    savedDocument = (globalThis as any).document;
  });

  afterEach(() => {
    (globalThis as any).document = savedDocument;
  });

  interface AnswerModalHarness {
    view: ProtocolEditorView;
    documentBody: MockEl;
    updateSpy: ReturnType<typeof vi.fn>;
    storedDocument(): ProtocolDocumentV1;
  }

  function openAnswerModal(
    initialFields: Record<string, unknown>,
    options: { libraryReadOnly?: boolean } = {},
  ): AnswerModalHarness {
    const documentBody = makeEl('body');
    (globalThis as any).document = { body: documentBody, activeElement: null };

    const fields: Record<string, unknown> = { answerText: 'Answer body' };
    Object.assign(fields, initialFields);
    let stored: ProtocolDocumentV1 = {
      schema: 'radiprotocol.protocol',
      version: 1,
      id: 'answer-authoring',
      title: 'Answer authoring',
      createdAt: '2026-08-20T00:00:00Z',
      updatedAt: '2026-08-20T00:00:00Z',
      nodes: [{
        id: 'answer-1',
        kind: 'answer',
        x: 0,
        y: 0,
        width: 200,
        height: 80,
        text: typeof fields['answerText'] === 'string' ? fields['answerText'] : '',
        fields,
      }],
      edges: [],
    };

    const updateSpy = vi.fn(async (
      _path: string,
      mutator: (document: ProtocolDocumentV1 | null) => ProtocolDocumentV1,
    ): Promise<ProtocolDocumentV1> => {
      stored = mutator(stored);
      return stored;
    });

    const view = new ProtocolEditorView({} as any, {
      i18n: { t },
      settings: {
        protocolFolderPath: 'Protocols',
        snippetFolderPath: '.radiprotocol/snippets',
      },
      protocolDocumentStore: { update: updateSpy },
    } as any);
    const viewportEl = makeEl('div');
    (viewportEl as any).scrollLeft = 15000;
    (viewportEl as any).scrollTop = 12000;
    (view as any).protocolPath = 'Protocols/answer-authoring.rp.json';
    (view as any).doc = stored;
    (view as any).viewportEl = viewportEl;
    (view as any).zoom = 1;
    (view as any).libraryReadOnly = options.libraryReadOnly === true;
    (view as any).restoreEditorFocus = vi.fn();
    (view as any).loadProtocol = vi.fn(async () => {
      (view as any).doc = stored;
    });

    (view as any).openEditModal(stored.nodes[0]);
    return {
      view,
      documentBody,
      updateSpy,
      storedDocument: () => stored,
    };
  }

  function findFreeTextCheckbox(root: MockEl): MockEl {
    const checkbox = findAllByTag(root, 'input').find((input) => {
      if (input._attrs['type'] !== 'checkbox') return false;
      return input.parent?.children.some((child) =>
        child.tagName === 'SPAN'
        && child._text === 'Collect a free-text response') === true;
    });
    expect(checkbox).toBeDefined();
    return checkbox!;
  }

  async function saveAnswerModal(root: MockEl): Promise<void> {
    const saveButton = findAllByTag(root, 'button').find((button) => button._text === 'Save');
    expect(saveButton).toBeDefined();
    const handlers = saveButton!._listeners.get('click') ?? [];
    expect(handlers).toHaveLength(1);
    for (const handler of handlers) await handler({ target: saveButton });
  }

  function deferredDocument() {
    let resolve!: (doc: ProtocolDocumentV1) => void;
    const promise = new Promise<ProtocolDocumentV1>((done) => { resolve = done; });
    return { promise, resolve };
  }

  function enableRealLoads(view: ProtocolEditorView, read: ReturnType<typeof vi.fn>) {
    (view as any).plugin.protocolDocumentStore.read = read;
    (view as any).app = { vault: { getAbstractFileByPath: (path: string) => { const file = new TFile(); file.path = path; return file; } } };
    const renderShell = vi.spyOn(view as any, 'renderShell').mockImplementation(() => {});
    const renderDocument = vi.spyOn(view as any, 'renderDocument').mockImplementation(() => {});
    const load = (path: string) => ProtocolEditorView.prototype.loadProtocol.call(view, path);
    return { load, renderShell, renderDocument };
  }

  it('switching protocols closes the old draft and rejects detached Save callbacks', async () => {
    const h = openAnswerModal({ answerText: 'Old draft' });
    const save = findAllByTag(h.documentBody, 'button').find(button => button._text === 'Save')!;
    const next = { ...h.storedDocument(), id: 'next', title: 'Next document' };
    const loads = enableRealLoads(h.view, vi.fn(async () => next));
    await loads.load('Protocols/next.rp.json');
    expect(findAllByClass(h.documentBody, 'rp-protocol-editor-modal-backdrop')).toHaveLength(0);
    for (const handler of save._listeners.get('click') ?? []) await handler({ target: save });
    expect(h.updateSpy).not.toHaveBeenCalled();
    expect((h.view as any).doc).toBe(next);
  });

  it('latest requested protocol remains visible when earlier loading finishes last', async () => {
    const h = openAnswerModal({});
    const first = deferredDocument();
    const second = deferredDocument();
    const read = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const loads = enableRealLoads(h.view, read);
    const oldLoad = loads.load('Protocols/old.rp.json');
    const newLoad = loads.load('Protocols/new.rp.json');
    const latest = { ...h.storedDocument(), title: 'Latest' };
    second.resolve(latest);
    await newLoad;
    first.resolve(h.storedDocument());
    await oldLoad;
    expect((h.view as any).protocolPath).toBe('Protocols/new.rp.json');
    expect((h.view as any).doc).toBe(latest);
    expect(loads.renderDocument).toHaveBeenCalledTimes(1);
  });

  it('close during loading removes overlays and prevents late rendering', async () => {
    const h = openAnswerModal({});
    const read = deferredDocument();
    const loads = enableRealLoads(h.view, vi.fn(() => read.promise));
    const pending = loads.load('Protocols/next.rp.json');
    await h.view.onClose();
    read.resolve(h.storedDocument());
    await pending;
    expect((h.view as any).doc).toBeNull();
    expect((h.view as any).protocolPath).toBeNull();
    expect(findAllByClass(h.documentBody, 'rp-protocol-editor-modal-backdrop')).toHaveLength(0);
    expect(loads.renderShell).not.toHaveBeenCalled();
    expect(loads.renderDocument).not.toHaveBeenCalled();
  });

  it('switching during a node drag cancels document listeners and cannot save old geometry', async () => {
    const h = openAnswerModal({});
    const savedWindow = (globalThis as any).window;
    const listeners = new Map<string, EventListener>();
    Object.assign((globalThis as any).document, {
      addEventListener: (name: string, handler: EventListener) => listeners.set(name, handler),
      removeEventListener: (name: string, handler: EventListener) => {
        if (listeners.get(name) === handler) listeners.delete(name);
      },
    });
    const cancelFrame = vi.fn();
    (globalThis as any).window = { requestAnimationFrame: () => 1, cancelAnimationFrame: cancelFrame };
    try {
      const nodeEl = makeEl();
      const node = h.storedDocument().nodes[0]!;
      (h.view as any).bindDrag(nodeEl, node);
      for (const handler of nodeEl._listeners.get('mousedown') ?? []) handler({
        button: 0, clientX: 0, clientY: 0, target: nodeEl,
        preventDefault() {}, stopPropagation() {},
      });
      listeners.get('mousemove')!({ clientX: 50, clientY: 40 } as unknown as Event);
      const lateMouseUp = listeners.get('mouseup')!;
      const next = { ...h.storedDocument(), title: 'Next' };
      const loads = enableRealLoads(h.view, vi.fn(async () => next));
      await loads.load('Protocols/next.rp.json');
      expect(listeners.size).toBe(0);
      expect(cancelFrame).toHaveBeenCalledWith(1);
      expect(h.documentBody.classList.has('rp-protocol-editor-drag-active')).toBe(false);
      lateMouseUp({ clientX: 80, clientY: 60 } as unknown as Event);
      expect(h.updateSpy).not.toHaveBeenCalled();
      expect((h.view as any).doc).toBe(next);
    } finally {
      (globalThis as any).window = savedWindow;
    }
  });

  it('late viewport completion cannot alter the newly loaded document', async () => {
    const h = openAnswerModal({});
    const written = deferredDocument();
    h.updateSpy.mockImplementationOnce(async (_path, mutate) => {
      const doc = mutate(h.storedDocument());
      await written.promise;
      return doc;
    });
    const pending = (h.view as any).persistViewportState();
    const next = { ...h.storedDocument(), title: 'Next', viewport: { x: 99, y: 88, zoom: 2 } };
    const loads = enableRealLoads(h.view, vi.fn(async () => next));
    await loads.load('Protocols/next.rp.json');
    written.resolve(h.storedDocument());
    await pending;
    expect((h.view as any).doc).toBe(next);
    expect((h.view as any).doc.viewport).toEqual({ x: 99, y: 88, zoom: 2 });
  });

  const initialStateCases: Array<{
    name: string;
    fields: Record<string, unknown>;
    expectedChecked: boolean;
  }> = [
    { name: 'absent', fields: {}, expectedChecked: false },
    { name: 'malformed', fields: { freeText: 'true' }, expectedChecked: false },
    { name: 'false', fields: { freeText: false }, expectedChecked: false },
    { name: 'true', fields: { freeText: true }, expectedChecked: true },
    { name: 'legacy-only true', fields: { radiprotocol_freeText: true }, expectedChecked: true },
    {
      name: 'canonical false wins over legacy true',
      fields: { freeText: false, radiprotocol_freeText: true },
      expectedChecked: false,
    },
    {
      name: 'malformed canonical suppresses legacy true',
      fields: { freeText: 'true', radiprotocol_freeText: true },
      expectedChecked: false,
    },
  ];

  it.each(initialStateCases)(
    'initializes an Answer checkbox from a strictly true freeText value: $name',
    ({ fields, expectedChecked }) => {
      const harness = openAnswerModal(fields);
      const checkbox = findFreeTextCheckbox(harness.documentBody);

      expect((checkbox as any).checked).toBe(expectedChecked);
      expect(findAllByClass(
        harness.documentBody,
        'rp-protocol-editor-modal-help',
      ).some((element) => element._text
        === 'Use the Answer label or text as the prompt; the radiologist enters multiline report text during the run.')).toBe(true);
    },
  );

  const persistenceCases: Array<{
    initialValue: boolean;
    savedValue: boolean;
  }> = [
    { initialValue: false, savedValue: true },
    { initialValue: true, savedValue: false },
  ];

  it.each(persistenceCases)(
    'persists freeText=$savedValue and restores it when the Answer modal reopens',
    async ({ initialValue, savedValue }) => {
      const harness = openAnswerModal({ freeText: initialValue });
      const checkbox = findFreeTextCheckbox(harness.documentBody);
      (checkbox as any).checked = savedValue;

      await saveAnswerModal(harness.documentBody);

      expect(harness.updateSpy).toHaveBeenCalledTimes(1);
      expect(harness.storedDocument().nodes[0]!.fields['freeText']).toBe(savedValue);

      (harness.view as any).openEditModal(harness.storedDocument().nodes[0]);
      const reopenedCheckbox = findFreeTextCheckbox(harness.documentBody);
      expect((reopenedCheckbox as any).checked).toBe(savedValue);
    },
  );

  it('preserves an empty answerText while persisting explicit freeText state', async () => {
    const harness = openAnswerModal({ answerText: 'Answer body', freeText: false });
    const textareas = findAllByTag(harness.documentBody, 'textarea');
    expect(textareas).toHaveLength(1);
    textareas[0]!.value = '';
    const checkbox = findFreeTextCheckbox(harness.documentBody);
    (checkbox as any).checked = true;

    await saveAnswerModal(harness.documentBody);

    const savedFields = harness.storedDocument().nodes[0]!.fields;
    expect(savedFields['answerText']).toBe('');
    expect(savedFields['freeText']).toBe(true);
  });

  it('keeps the existing library read-only guard authoritative for Answer edits', async () => {
    const harness = openAnswerModal(
      { answerText: 'Original answer', freeText: false },
      { libraryReadOnly: true },
    );
    const checkbox = findFreeTextCheckbox(harness.documentBody);
    (checkbox as any).checked = true;
    findAllByTag(harness.documentBody, 'textarea')[0]!.value = 'Changed answer';

    await saveAnswerModal(harness.documentBody);

    expect(harness.updateSpy).not.toHaveBeenCalled();
    expect(harness.storedDocument().nodes[0]!.fields).toEqual({
      answerText: 'Original answer',
      freeText: false,
    });
  });

  it('hides the answer-text field while freeText is enabled and reveals it when disabled', () => {
    const harness = openAnswerModal({ freeText: true });
    const answerField = findAllByClass(
      harness.documentBody,
      'rp-protocol-editor-modal-field',
    ).find((field) =>
      field.children.some((child) =>
        child.tagName === 'LABEL' && child._text === 'Answer text'),
    );
    expect(answerField).toBeDefined();
    expect(answerField!.classList.has('is-hidden')).toBe(true);

    const checkbox = findFreeTextCheckbox(harness.documentBody);
    (checkbox as any).checked = false;
    for (const handler of checkbox!._listeners.get('change') ?? []) handler({});
    expect(answerField!.classList.has('is-hidden')).toBe(false);

    (checkbox as any).checked = true;
    for (const handler of checkbox!._listeners.get('change') ?? []) handler({});
    expect(answerField!.classList.has('is-hidden')).toBe(true);
  });

  it('keeps the answer-text field visible when freeText is off', () => {
    const harness = openAnswerModal({ freeText: false });
    const answerField = findAllByClass(
      harness.documentBody,
      'rp-protocol-editor-modal-field',
    ).find((field) =>
      field.children.some((child) =>
        child.tagName === 'LABEL' && child._text === 'Answer text'),
    );
    expect(answerField).toBeDefined();
    expect(answerField!.classList.has('is-hidden')).toBe(false);
  });
});

describe('openEditModal — snippet target picker lifecycle', () => {
  let savedDocument: unknown;
  let savedWindow: unknown;
  let savedHTMLElement: unknown;

  beforeEach(() => {
    savedDocument = (globalThis as any).document;
    savedWindow = (globalThis as any).window;
    savedHTMLElement = (globalThis as any).HTMLElement;
    pickerSpies.ctor.mockClear();
    pickerSpies.mount.mockClear();
    pickerSpies.unmount.mockClear();
    pickerSpies.instances.length = 0;
  });

  afterEach(() => {
    (globalThis as any).document = savedDocument;
    (globalThis as any).window = savedWindow;
    (globalThis as any).HTMLElement = savedHTMLElement;
  });

  function clickText(root: MockEl, text: string): MockEl {
    const button = findAllByTag(root, 'button').find(el => el._text === text);
    expect(button).toBeDefined();
    for (const handler of button!._listeners.get('click') ?? []) handler({ target: button });
    return button!;
  }

  async function save(root: MockEl): Promise<void> {
    const saveBtn = findAllByTag(root, 'button').find(el => el._text === 'Save')!;
    for (const handler of saveBtn._listeners.get('click') ?? []) await handler({ target: saveBtn });
  }

  function openSnippetModal(initialFields: Record<string, unknown> = {}) {
    const documentBody = makeEl('body');
    const savedNodes: ProtocolNodeRecord[] = [];
    const node: ProtocolNodeRecord = { id: 's1', kind: 'snippet', x: 0, y: 0, width: 200, height: 80, fields: initialFields };
    const mockStore = {
      async update(_path: string, mutator: (doc: ProtocolDocumentV1) => ProtocolDocumentV1) {
        const doc: ProtocolDocumentV1 = {
          schema: 'radiprotocol.protocol', version: 1, id: 'test', title: 'T',
          createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z',
          nodes: [node], edges: [],
        };
        const result = mutator(doc);
        savedNodes.push(...result.nodes);
        return result;
      },
    };
    const view = new ProtocolEditorView({} as any, {
      i18n: { t },
      settings: { snippetFolderPath: '.radiprotocol/snippets' },
      snippetService: {},
      protocolDocumentStore: mockStore,
    } as any);
    (view as any).protocolPath = 'test.rp.json';
    (view as any).viewportEl = makeEl('div');
    (view as any).loadProtocol = vi.fn(async () => {});
    (globalThis as any).document = { body: documentBody, activeElement: null };
    (globalThis as any).window = {
      setTimeout: (fn: () => void) => { fn(); return 0; },
      requestAnimationFrame: (fn: () => void) => { fn(); return 0; },
    };
    (globalThis as any).HTMLElement = class HTMLElement {};
    (view as any).openEditModal(node);
    return { documentBody, savedNodes };
  }

  it('selecting a folder persists subfolderPath only', async () => {
    const { documentBody, savedNodes } = openSnippetModal();
    clickText(documentBody, 'Browse');
    pickerSpies.instances[0]!.options.onSelect({ kind: 'folder', relativePath: 'abdomen/ct' });
    await save(documentBody);
    const saved = savedNodes[savedNodes.length - 1]!;
    expect(saved.fields.subfolderPath).toBe('abdomen/ct');
    expect(saved.fields.snippetPath).toBeUndefined();
  });

  it('selecting a file persists snippetPath only', async () => {
    const { documentBody, savedNodes } = openSnippetModal({ subfolderPath: 'old' });
    clickText(documentBody, 'Browse');
    pickerSpies.instances[0]!.options.onSelect({ kind: 'file', relativePath: 'abdomen/ct/report.md' });
    await save(documentBody);
    const saved = savedNodes[savedNodes.length - 1]!;
    expect(saved.fields.snippetPath).toBe('abdomen/ct/report.md');
    expect(saved.fields.subfolderPath).toBeUndefined();
  });

  it('cancelling the picker preserves the existing target', async () => {
    const { documentBody, savedNodes } = openSnippetModal({ subfolderPath: 'existing/folder' });
    clickText(documentBody, 'Browse');
    const pickerClose = findAllByClass(documentBody, 'rp-protocol-editor-modal-close').find(el => el.closest('.rp-protocol-editor-snippet-target-picker-shell'))!;
    for (const handler of pickerClose._listeners.get('click') ?? []) handler({ target: pickerClose });
    await save(documentBody);
    const saved = savedNodes[savedNodes.length - 1]!;
    expect(saved.fields.subfolderPath).toBe('existing/folder');
    expect(saved.fields.snippetPath).toBeUndefined();
  });

  it('closing the parent while the picker is open unmounts and removes the picker overlay', () => {
    const { documentBody } = openSnippetModal();
    clickText(documentBody, 'Browse');
    expect(findAllByClass(documentBody, 'rp-protocol-editor-snippet-target-picker-backdrop')).toHaveLength(1);
    const parentCloseBtn = findAllByClass(documentBody, 'rp-protocol-editor-modal-close').find(el => !el.closest('.rp-protocol-editor-snippet-target-picker-shell'))!;
    for (const handler of parentCloseBtn._listeners.get('click') ?? []) handler({ target: parentCloseBtn });
    expect(pickerSpies.unmount).toHaveBeenCalledTimes(1);
    expect(findAllByClass(documentBody, 'rp-protocol-editor-snippet-target-picker-backdrop')).toHaveLength(0);
  });

  it('Escape closes the picker before the parent and restores focus to Browse', () => {
    const { documentBody } = openSnippetModal();
    const browseBtn = clickText(documentBody, 'Browse');
    const pickerBackdrop = findAllByClass(documentBody, 'rp-protocol-editor-snippet-target-picker-backdrop')[0]!;
    dispatchKeyDown(pickerBackdrop, 'Escape');
    expect(pickerSpies.unmount).toHaveBeenCalledTimes(1);
    expect(findAllByClass(documentBody, 'rp-protocol-editor-snippet-target-picker-backdrop')).toHaveLength(0);
    expect(browseBtn.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(findAllByClass(documentBody, 'rp-protocol-editor-modal')).toHaveLength(1);
  });
});

describe('ProtocolEditorView: node-kind creation picker omits text-block (Phase 3)', () => {
  function openPickerDocument(): MockEl {
    const documentBody = makeEl('body');
    (globalThis as any).document = { body: documentBody, activeElement: null };
    return documentBody;
  }

  it('openNodeKindPickerAtWorldPoint offers start/question/answer/snippet and NOT text-block', () => {
    const { view } = createTestView();
    const documentBody = openPickerDocument();
    (view as any).openNodeKindPickerAtWorldPoint(0, 0);
    const kinds = nodeKindsInPicker(documentBody);
    expect(kinds).toEqual(['start', 'question', 'answer', 'snippet']);
    expect(kinds).not.toContain('text-block');
  });

  it('openNodeKindPickerAndConnectAtWorldPoint offers the same set and NOT text-block', () => {
    const { view } = createTestView();
    const documentBody = openPickerDocument();
    (view as any).openNodeKindPickerAndConnectAtWorldPoint('node-1', 0, 0);
    const kinds = nodeKindsInPicker(documentBody);
    expect(kinds).toEqual(['start', 'question', 'answer', 'snippet']);
    expect(kinds).not.toContain('text-block');
  });

  it('both pickers hide Start when the current document already has one', () => {
    const { view } = createTestView();
    (view as any).doc.nodes.unshift({
      id: 'start', kind: 'start', x: 0, y: 0, width: 200, height: 80, fields: {},
    });
    const documentBody = openPickerDocument();

    (view as any).openNodeKindPickerAtWorldPoint(0, 0);
    expect(nodeKindsInPicker(documentBody)).toEqual(['question', 'answer', 'snippet']);

    documentBody.empty();
    (view as any).openNodeKindPickerAndConnectAtWorldPoint('node-1', 0, 0);
    expect(nodeKindsInPicker(documentBody)).toEqual(['question', 'answer', 'snippet']);
  });
});

describe('ProtocolEditorView: loop toggle authoring + badge', () => {
  let savedWindow: unknown;
  let savedRAF: unknown;
  let savedDocument: unknown;
  beforeEach(() => {
    savedWindow = (globalThis as any).window;
    savedRAF = (globalThis as any).requestAnimationFrame;
    savedDocument = (globalThis as any).document;
    (globalThis as any).window = globalThis;
    (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => { cb(0); return 0; };
  });
  afterEach(() => {
    (globalThis as any).window = savedWindow;
    (globalThis as any).requestAnimationFrame = savedRAF;
    (globalThis as any).document = savedDocument;
  });

  function createLoopableView(): { view: ProtocolEditorView; surfaceEl: MockEl; documentBody: MockEl; updateSpy: ReturnType<typeof vi.fn> } {
    const documentBody = makeEl('body');
    (globalThis as any).document = { body: documentBody, activeElement: null };

    const holder: { view: ProtocolEditorView | null } = { view: null };
    const updateSpy = vi.fn(async (_path: string, mutator: (doc: ProtocolDocumentV1) => ProtocolDocumentV1): Promise<ProtocolDocumentV1> => {
      const current = (holder.view as any).doc as ProtocolDocumentV1;
      const updated = mutator(current);
      (holder.view as any).doc = updated;
      return updated;
    });

    const mockPlugin = {
      i18n: { t },
      settings: { snippetFolderPath: '.radiprotocol/snippets' },
      protocolDocumentStore: { update: updateSpy },
    } as any;

    const leaf = {} as any;
    const view = new ProtocolEditorView(leaf, mockPlugin);
    holder.view = view;

    const surfaceEl = makeEl('div');
    const svgEl = makeEl('svg');
    const viewportEl = makeEl('div');
    const rootEl = makeEl('div');
    (view as any).surfaceEl = surfaceEl;
    (view as any).svgEl = svgEl;
    (view as any).viewportEl = viewportEl;
    (view as any).rootEl = rootEl;
    (view as any).protocolPath = 'test.rp.json';
    (view as any).zoom = 1;
    (view as any).loadProtocol = vi.fn(async () => {});

    const doc: ProtocolDocumentV1 = {
      schema: 'radiprotocol.protocol',
      version: 1,
      id: 'test-doc',
      title: 'Test Protocol',
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
      nodes: [
        { id: 'node-q', kind: 'question', x: 100, y: 100, width: 200, height: 80, text: 'Where?', fields: { questionText: 'Where?' } },
      ],
      edges: [],
    };
    (view as any).doc = doc;

    return { view, surfaceEl, documentBody, updateSpy };
  }

  function findLoopCheckbox(root: MockEl): MockEl | undefined {
    const checkboxes = findAllByTag(root, 'input').filter((i) => i._attrs['type'] === 'checkbox');
    return checkboxes.find((c) => {
      const label = c.parent;
      const span = label?.children.find((ch) => ch.tagName === 'SPAN');
      return span?._text === 'Loop';
    });
  }

  function findButtonByText(root: MockEl, text: string): MockEl | undefined {
    return findAllByTag(root, 'button').find((b) => b._text === text);
  }

  it('persisting the loop toggle writes fields.loop === true to the node record', async () => {
    const { view, documentBody, updateSpy } = createLoopableView();
    (view as any).openEditModal((view as any).doc.nodes[0]);

    const loopCheckbox = findLoopCheckbox(documentBody);
    expect(loopCheckbox).toBeDefined();
    expect(loopCheckbox!._attrs['type']).toBe('checkbox');
    // Initial state: loop absent → checkbox unchecked.
    expect((loopCheckbox as any).checked).toBe(false);

    (loopCheckbox as any).checked = true;

    const saveBtn = findButtonByText(documentBody, 'Save');
    expect(saveBtn).toBeDefined();
    const handlers = saveBtn!._listeners.get('click') ?? [];
    expect(handlers.length).toBe(1);
    for (const handler of handlers) await handler({});

    expect(updateSpy).toHaveBeenCalledTimes(1);
    const persisted = (view as any).doc as ProtocolDocumentV1;
    expect(persisted.nodes[0]!.fields['loop']).toBe(true);
    expect(persisted.nodes[0]!.fields['questionText']).toBe('Where?');
  });

  it('leaving the loop toggle unchecked omits fields.loop from the persisted record', async () => {
    const { view, documentBody, updateSpy } = createLoopableView();
    (view as any).openEditModal((view as any).doc.nodes[0]);

    const loopCheckbox = findLoopCheckbox(documentBody);
    expect(loopCheckbox).toBeDefined();
    expect((loopCheckbox as any).checked).toBe(false);
    // Leave unchecked.

    const saveBtn = findButtonByText(documentBody, 'Save');
    const handlers = saveBtn!._listeners.get('click') ?? [];
    for (const handler of handlers) await handler({});

    expect(updateSpy).toHaveBeenCalledTimes(1);
    const persisted = (view as any).doc as ProtocolDocumentV1;
    expect(persisted.nodes[0]!.fields['loop']).toBeUndefined();
  });

  it('renderDocument renders a loop badge with aria-label on a looped question', () => {
    const { view, surfaceEl } = createLoopableView();
    (view as any).doc.nodes[0].fields['loop'] = true;
    (view as any).renderDocument();

    const badges = findAllByClass(surfaceEl, 'rp-protocol-editor-node-loop-badge');
    expect(badges.length).toBe(1);
    expect(badges[0]!._attrs['aria-label']).toBe('Loop question');
  });

  it('renderDocument omits the loop badge on an ordinary question', () => {
    const { view, surfaceEl } = createLoopableView();
    (view as any).renderDocument();

    const badges = findAllByClass(surfaceEl, 'rp-protocol-editor-node-loop-badge');
    expect(badges.length).toBe(0);
  });
});

// ── Loop-exit edge rendering ────────────────────────────────────────────────

describe('ProtocolEditorView: loop-exit edge colorization', () => {
  function createEdgeView(): { view: ProtocolEditorView; svgEl: MockEl; surfaceEl: MockEl } {
    const mockPlugin = {
      i18n: { t },
      settings: { snippetFolderPath: '.radiprotocol/snippets' },
      protocolDocumentStore: {},
    } as any;

    const view = new ProtocolEditorView({} as any, mockPlugin);
    const surfaceEl = makeEl('div');
    const svgEl = makeEl('svg');
    const viewportEl = makeEl('div');
    const rootEl = makeEl('div');
    (view as any).surfaceEl = surfaceEl;
    (view as any).svgEl = svgEl;
    (view as any).viewportEl = viewportEl;
    (view as any).rootEl = rootEl;
    (view as any).protocolPath = 'test.rp.json';
    (view as any).zoom = 1;

    const doc: ProtocolDocumentV1 = {
      schema: 'radiprotocol.protocol',
      version: 1,
      id: 'test-doc',
      title: 'Test Protocol',
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
      nodes: [
        { id: 'node-loop', kind: 'question', x: 100, y: 100, width: 200, height: 80, text: 'Repeat?', fields: { questionText: 'Repeat?', loop: true } },
        { id: 'node-body', kind: 'question', x: 400, y: 100, width: 200, height: 80, text: 'Next finding?', fields: { questionText: 'Next finding?' } },
        { id: 'node-exit', kind: 'text-block', x: 100, y: 300, width: 200, height: 80, text: 'Wrap up', fields: { content: 'Wrap up' } },
      ],
      edges: [
        { id: 'edge-body', fromNodeId: 'node-loop', toNodeId: 'node-body' },
        { id: 'edge-exit', fromNodeId: 'node-loop', toNodeId: 'node-exit', label: 'Done', isLoopExit: true },
      ],
    };
    (view as any).doc = doc;

    return { view, svgEl, surfaceEl };
  }

  // createSvg() in this harness stores `attr.class` verbatim (real SVG elements
  // expose it through classList), so edge classes are asserted via the attribute.
  function edgeGroup(svgEl: MockEl, edgeId: string): MockEl | undefined {
    return svgEl.children.find((child) => child._attrs['data-edge-id'] === edgeId);
  }

  function edgePath(group: MockEl | undefined, kind: 'visible' | 'hitbox'): MockEl | undefined {
    return group?.children.find((child) => {
      if (child.tagName !== 'PATH') return false;
      const cls = child._attrs['class'] ?? '';
      return kind === 'hitbox' ? cls.includes('-hitbox') : !cls.includes('-hitbox');
    });
  }

  it('marks the loop-exit edge with is-loop-exit and leaves the body edge unmarked', () => {
    const { view, svgEl } = createEdgeView();
    (view as any).renderDocument();

    const exitPath = edgePath(edgeGroup(svgEl, 'edge-exit'), 'visible');
    expect(exitPath?._attrs['class']).toBe('rp-protocol-editor-edge');
    expect(exitPath?.classList.has('is-loop-exit')).toBe(true);
    expect(edgePath(edgeGroup(svgEl, 'edge-body'), 'visible')?.classList.has('is-loop-exit')).toBe(false);
  });

  it('keeps the loop-exit hitbox unmarked so only the visible stroke is colorized', () => {
    const { view, svgEl } = createEdgeView();
    (view as any).renderDocument();

    const hitbox = edgePath(edgeGroup(svgEl, 'edge-exit'), 'hitbox');
    expect(hitbox?._attrs['class']).toBe('rp-protocol-editor-edge-hitbox');
    expect(hitbox?.classList.has('is-loop-exit')).toBe(false);
  });

  it('CSS renders loop-exit edges in green (tripwire)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const cssPath = require.resolve('../../styles/protocol-editor.css');
    const css = readFileSync(cssPath, 'utf8');
    const exitRule = css.match(/\.rp-protocol-editor-edge\.is-loop-exit\s*\{[^}]*\}/);
    expect(exitRule?.[0]).toContain('stroke: var(--color-green');
    const minimapRule = css.match(/\.rp-protocol-editor-minimap-edge\.is-loop-exit\s*\{[^}]*\}/);
    expect(minimapRule?.[0]).toContain('stroke: var(--color-green');
  });
});

describe('ProtocolEditorView: node deletion state synchronization', () => {
  it('uses the successful Start deletion result before the asynchronous reload finishes', async () => {
    const savedWindow = (globalThis as any).window;
    const savedHTMLElement = (globalThis as any).HTMLElement;
    const savedDocument = (globalThis as any).document;
    const documentBody = makeEl('body');
    (globalThis as any).document = { body: documentBody, activeElement: null };
    (globalThis as any).window = {
      requestAnimationFrame: (callback: () => void) => { callback(); return 0; },
      setTimeout: (callback: () => void) => { callback(); return 0; },
    };
    (globalThis as any).HTMLElement = class HTMLElement {};
    try {
      const startNode: ProtocolNodeRecord = {
        id: 'start', kind: 'start', x: 0, y: 0, width: 200, height: 80, fields: {},
      };
      let stored: ProtocolDocumentV1 = {
        schema: 'radiprotocol.protocol', version: 1, id: 'delete-start', title: 'Delete Start',
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
        nodes: [startNode], edges: [],
      };
      const update = vi.fn(async (_path: string, mutator: (doc: ProtocolDocumentV1) => ProtocolDocumentV1) => {
        stored = mutator(stored);
        return stored;
      });
      const view = new ProtocolEditorView({} as any, {
        i18n: { t }, settings: { snippetFolderPath: '.radiprotocol/snippets' },
        protocolDocumentStore: { update },
      } as any);
      (view as any).protocolPath = 'delete-start.rp.json';
      (view as any).doc = stored;
      (view as any).viewportEl = makeEl('div');
      (view as any).zoom = 1;
      (view as any).loadProtocol = vi.fn(() => new Promise<void>(() => {}));

      (view as any).openEditModal(startNode);
      const deleteBtn = findAllByTag(documentBody, 'button').find(button => button._text === 'Delete')!;
      for (const handler of deleteBtn._listeners.get('click') ?? []) handler({ target: deleteBtn });
      const confirmBtn = findAllByTag(documentBody, 'button').find(button => button._text === 'Confirm delete')!;
      for (const handler of confirmBtn._listeners.get('click') ?? []) await handler({ target: confirmBtn });

      expect((view as any).doc.nodes).toEqual([]);
      expect((view as any).loadProtocol).toHaveBeenCalledWith('delete-start.rp.json', expect.objectContaining({ path: 'delete-start.rp.json' }));

      (view as any).openNodeKindPickerAtWorldPoint(0, 0);
      expect(nodeKindsInPicker(documentBody)).toEqual(['start', 'question', 'answer', 'snippet']);
      documentBody.empty();
      (view as any).openNodeKindPickerAndConnectAtWorldPoint('start', 0, 0);
      expect(nodeKindsInPicker(documentBody)).toEqual(['start', 'question', 'answer', 'snippet']);
    } finally {
      (globalThis as any).window = savedWindow;
      (globalThis as any).HTMLElement = savedHTMLElement;
      (globalThis as any).document = savedDocument;
    }
  });

  it('does not apply a stale deletion result after another protocol loads', async () => {
    const savedWindow = (globalThis as any).window;
    const savedHTMLElement = (globalThis as any).HTMLElement;
    const savedDocument = (globalThis as any).document;
    const documentBody = makeEl('body');
    (globalThis as any).document = { body: documentBody, activeElement: null };
    (globalThis as any).window = {
      requestAnimationFrame: (callback: () => void) => { callback(); return 0; },
      setTimeout: (callback: () => void) => { callback(); return 0; },
    };
    (globalThis as any).HTMLElement = class HTMLElement {};
    try {
      const startNode: ProtocolNodeRecord = {
        id: 'start', kind: 'start', x: 0, y: 0, width: 200, height: 80, fields: {},
      };
      const deletingDoc: ProtocolDocumentV1 = {
        schema: 'radiprotocol.protocol', version: 1, id: 'deleting', title: 'Deleting',
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
        nodes: [startNode], edges: [],
      };
      const activeDoc: ProtocolDocumentV1 = {
        ...deletingDoc,
        id: 'active',
        title: 'Active',
        nodes: [{
          id: 'active-question', kind: 'question', x: 0, y: 0, width: 200, height: 80,
          fields: { questionText: 'Active' },
        }],
      };
      const holder: { view: ProtocolEditorView | null } = { view: null };
      const update = vi.fn(async (_path: string, mutator: (doc: ProtocolDocumentV1) => ProtocolDocumentV1) => {
        const deleted = mutator(deletingDoc);
        (holder.view as any).protocolPath = 'active.rp.json';
        (holder.view as any).doc = activeDoc;
        (holder.view as any).loadGeneration += 1;
        return deleted;
      });
      const view = new ProtocolEditorView({} as any, {
        i18n: { t }, settings: { snippetFolderPath: '.radiprotocol/snippets' },
        protocolDocumentStore: { update },
      } as any);
      holder.view = view;
      (view as any).protocolPath = 'deleting.rp.json';
      (view as any).doc = deletingDoc;
      (view as any).viewportEl = makeEl('div');
      (view as any).zoom = 1;
      (view as any).loadProtocol = vi.fn(async () => {});

      (view as any).openEditModal(startNode);
      const deleteBtn = findAllByTag(documentBody, 'button').find(button => button._text === 'Delete')!;
      for (const handler of deleteBtn._listeners.get('click') ?? []) handler({ target: deleteBtn });
      const confirmBtn = findAllByTag(documentBody, 'button').find(button => button._text === 'Confirm delete')!;
      for (const handler of confirmBtn._listeners.get('click') ?? []) await handler({ target: confirmBtn });

      expect((view as any).protocolPath).toBe('active.rp.json');
      expect((view as any).doc).toBe(activeDoc);
      expect((view as any).loadProtocol).not.toHaveBeenCalled();
    } finally {
      (globalThis as any).window = savedWindow;
      (globalThis as any).HTMLElement = savedHTMLElement;
      (globalThis as any).document = savedDocument;
    }
  });
});

describe('ProtocolEditorView: ordinary Question edge labels', () => {
  it('preserves a typed Q-to-Q label through save and reopen', async () => {
    const savedDocument = (globalThis as any).document;
    const savedWindow = (globalThis as any).window;
    const savedHTMLElement = (globalThis as any).HTMLElement;
    const documentBody = makeEl('body');
    (globalThis as any).document = { body: documentBody, activeElement: null };
    (globalThis as any).window = {
      requestAnimationFrame: (callback: () => void) => { callback(); return 0; },
    };
    (globalThis as any).HTMLElement = class HTMLElement {};
    try {
      const source: ProtocolNodeRecord = {
        id: 'q-source', kind: 'question', x: 0, y: 0, width: 200, height: 80,
        text: 'Source', fields: { questionText: 'Source' },
      };
      const target: ProtocolNodeRecord = {
        id: 'q-target', kind: 'question', x: 300, y: 0, width: 200, height: 80,
        text: 'Target', fields: { questionText: 'Target' },
      };
      let stored: ProtocolDocumentV1 = {
        schema: 'radiprotocol.protocol', version: 1, id: 'q-label', title: 'Q label',
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
        nodes: [source, target],
        edges: [{ id: 'q-edge', fromNodeId: source.id, toNodeId: target.id }],
      };
      const update = vi.fn(async (_path: string, mutator: (doc: ProtocolDocumentV1) => ProtocolDocumentV1) => {
        stored = mutator(stored);
        return stored;
      });
      const view = new ProtocolEditorView({} as any, {
        i18n: { t }, settings: { snippetFolderPath: '.radiprotocol/snippets' },
        protocolDocumentStore: { update },
      } as any);
      (view as any).protocolPath = 'q-label.rp.json';
      (view as any).doc = stored;
      (view as any).viewportEl = makeEl('div');
      (view as any).zoom = 1;
      (view as any).loadProtocol = vi.fn(async () => { (view as any).doc = stored; });

      (view as any).openEdgeModal(stored.edges[0]);
      const labelInput = findAllByTag(documentBody, 'input').find(input => input._attrs['type'] === 'text')!;
      labelInput.value = '  Follow up  ';
      const saveBtn = findAllByTag(documentBody, 'button').find(button => button._text === 'Save')!;
      for (const handler of saveBtn._listeners.get('click') ?? []) await handler({ target: saveBtn });

      expect(stored.edges[0]?.label).toBe('Follow up');
      expect((view as any).doc.edges[0]?.label).toBe('Follow up');

      (view as any).openEdgeModal((view as any).doc.edges[0]);
      const reopenedInput = findAllByTag(documentBody, 'input').find(input => input._attrs['type'] === 'text')!;
      expect(reopenedInput.value).toBe('Follow up');
    } finally {
      (globalThis as any).document = savedDocument;
      (globalThis as any).window = savedWindow;
      (globalThis as any).HTMLElement = savedHTMLElement;
    }
  });
});

describe('ProtocolEditorView: optionOrder FR-6 append + FR-5 drag-persist', () => {
  let savedWindow: unknown;
  let savedRAF: unknown;
  let savedDocument: unknown;
  beforeEach(() => {
    savedWindow = (globalThis as any).window;
    savedRAF = (globalThis as any).requestAnimationFrame;
    savedDocument = (globalThis as any).document;
    (globalThis as any).window = globalThis;
    (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => { cb(0); return 0; };
  });
  afterEach(() => {
    (globalThis as any).window = savedWindow;
    (globalThis as any).requestAnimationFrame = savedRAF;
    (globalThis as any).document = savedDocument;
  });

  function createOptionOrderView(): { view: ProtocolEditorView; documentBody: MockEl; updateSpy: ReturnType<typeof vi.fn> } {
    const documentBody = makeEl('body');
    (globalThis as any).document = { body: documentBody, activeElement: null };
    const holder: { view: ProtocolEditorView | null } = { view: null };
    const updateSpy = vi.fn(async (_path: string, mutator: (doc: ProtocolDocumentV1) => ProtocolDocumentV1): Promise<ProtocolDocumentV1> => {
      const current = (holder.view as any).doc as ProtocolDocumentV1;
      const updated = mutator(current);
      (holder.view as any).doc = updated;
      return updated;
    });
    const mockPlugin = { i18n: { t }, settings: { snippetFolderPath: '.radiprotocol/snippets' }, protocolDocumentStore: { update: updateSpy } } as any;
    const view = new ProtocolEditorView({} as any, mockPlugin);
    holder.view = view;
    (view as any).surfaceEl = makeEl('div');
    (view as any).svgEl = makeEl('svg');
    (view as any).viewportEl = makeEl('div');
    (view as any).rootEl = makeEl('div');
    (view as any).protocolPath = 'test.rp.json';
    (view as any).zoom = 1;
    (view as any).loadProtocol = vi.fn(async () => {});
    (view as any).restoreEditorFocus = vi.fn();
    const doc: ProtocolDocumentV1 = {
      schema: 'radiprotocol.protocol', version: 1, id: 'test-doc', title: 'Test',
      createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z',
      nodes: [
        { id: 'node-q', kind: 'question', x: 100, y: 100, width: 200, height: 80, text: 'Pick', fields: { questionText: 'Pick', optionOrder: ['e-a'] } },
        { id: 'node-a', kind: 'answer', x: 300, y: 100, width: 200, height: 80, text: 'A', fields: { answerText: 'A' } },
      ],
      edges: [{ id: 'e-a', fromNodeId: 'node-q', toNodeId: 'node-a' }],
    };
    (view as any).doc = doc;
    return { view, documentBody, updateSpy };
  }

  it('FR-6: appendEdgeIdToOptionOrder appends to a question optionOrder; no-op otherwise; immutable', () => {
    const nodes: ProtocolNodeRecord[] = [
      { id: 'q1', kind: 'question', x: 0, y: 0, width: 1, height: 1, fields: { questionText: 'Q', optionOrder: ['e1'] } },
      { id: 'a1', kind: 'answer', x: 0, y: 0, width: 1, height: 1, fields: { answerText: 'A' } },
    ];
    const updated = appendEdgeIdToOptionOrder(nodes, 'q1', 'e2');
    expect(updated[0]!.fields['optionOrder']).toEqual(['e1', 'e2']);
    expect(appendEdgeIdToOptionOrder(nodes, 'a1', 'e2')[0]!.fields['optionOrder']).toEqual(['e1']);
    const noOrder: ProtocolNodeRecord[] = [{ id: 'q2', kind: 'question', x: 0, y: 0, width: 1, height: 1, fields: { questionText: 'Q2' } }];
    expect(appendEdgeIdToOptionOrder(noOrder, 'q2', 'e3')[0]!.fields['optionOrder']).toBeUndefined();
    expect(updated).not.toBe(nodes);
    expect(updated[0]).not.toBe(nodes[0]);
    expect(nodes[0]!.fields['optionOrder']).toEqual(['e1']);
  });

  it('FR-6: addNodeAndConnectAtWorldPoint appends the new edge id to an ordered question', async () => {
    const { view } = createOptionOrderView();
    (view as any).applyCreatedProtocolDocument = vi.fn((updated: ProtocolDocumentV1, id: string) => updated.nodes.find((n) => n.id === id) ?? null);
    (view as any).openEditModal = vi.fn();
    (view as any).addNodeAndConnectAtWorldPoint('node-q', 'answer', 200, 200);
    await new Promise((r) => setTimeout(r, 0));
    const doc = (view as any).doc as ProtocolDocumentV1;
    const newEdge = doc.edges.find((e) => e.fromNodeId === 'node-q' && e.toNodeId !== 'node-a');
    expect(newEdge).toBeDefined();
    expect(doc.nodes.find((n) => n.id === 'node-q')!.fields['optionOrder']).toEqual(['e-a', newEdge!.id]);
  });

  it('FR-6: finishConnectionDrag appends the new edge id to an ordered question', async () => {
    const { view } = createOptionOrderView();
    (view as any).doc.nodes.push({ id: 'node-a2', kind: 'answer', x: 0, y: 0, width: 1, height: 1, fields: { answerText: 'A2' } });
    (view as any).connectionDragState = { fromNodeId: 'node-q', previewPath: makeEl('path') };
    const portEl = makeEl('div');
    portEl.setAttr('data-node-id', 'node-a2');
    (view as any).findInputPortAt = vi.fn(() => portEl);
    (view as any).finishConnectionDrag({ clientX: 0, clientY: 0 } as MouseEvent);
    await new Promise((r) => setTimeout(r, 0));
    const doc = (view as any).doc as ProtocolDocumentV1;
    const newEdge = doc.edges.find((e) => e.fromNodeId === 'node-q' && e.toNodeId === 'node-a2');
    expect(newEdge).toBeDefined();
    expect(doc.nodes.find((n) => n.id === 'node-q')!.fields['optionOrder']).toEqual(['e-a', newEdge!.id]);
  });

  it('FR-5: dragging a chip and saving rewrites optionOrder; reopening shows the same order', async () => {
    const { view, documentBody } = createOptionOrderView();
    (view as any).doc.nodes.push({ id: 'node-a2', kind: 'answer', x: 300, y: 200, width: 200, height: 80, text: 'A2', fields: { answerText: 'A2' } });
    (view as any).doc.edges.push({ id: 'e-b', fromNodeId: 'node-q', toNodeId: 'node-a2' });
    (view as any).doc.nodes.find((n: ProtocolNodeRecord) => n.id === 'node-q').fields['optionOrder'] = ['e-a', 'e-b'];

    (view as any).openEditModal((view as any).doc.nodes.find((n: ProtocolNodeRecord) => n.id === 'node-q'));
    let chips = documentBody.querySelectorAll('.rp-option-order-chip');
    expect(chips.length).toBe(2);
    // DOM order is [e-a (idx 0), e-b (idx 1)]. Drag e-a onto e-b: from=0 → to=1 → [e-b, e-a].
    const dt = { store: {} as Record<string, string>, setData(k: string, v: string) { this.store[k] = v; }, getData(k: string) { return this.store[k] ?? ''; } };
    for (const h of chips[0]!._listeners.get('dragstart') ?? []) h({ dataTransfer: dt, preventDefault() {} });
    for (const h of chips[1]!._listeners.get('drop') ?? []) h({ dataTransfer: dt, preventDefault() {}, relatedTarget: null });

    const saveBtn = findAllByTag(documentBody, 'button').find((b) => b._text === 'Save')!;
    for (const handler of saveBtn._listeners.get('click') ?? []) await handler({});

    const persisted = (view as any).doc as ProtocolDocumentV1;
    expect(persisted.nodes.find((n) => n.id === 'node-q')!.fields['optionOrder']).toEqual(['e-b', 'e-a']);

    // Reopen: chips in DOM order reflect the persisted optionOrder (e-b→A2, e-a→A).
    (view as any).openEditModal((view as any).doc.nodes.find((n: ProtocolNodeRecord) => n.id === 'node-q'));
    chips = documentBody.querySelectorAll('.rp-option-order-chip');
    expect(chips.map((c) => c.querySelector('.rp-option-order-chip-label')?._text)).toEqual(['A2', 'A']);
  });
});

describe('ProtocolEditorView: start-point custom label + free-text answer badge', () => {
  let savedWindow: unknown;
  let savedRAF: unknown;
  let savedDocument: unknown;
  beforeEach(() => {
    savedWindow = (globalThis as any).window;
    savedRAF = (globalThis as any).requestAnimationFrame;
    savedDocument = (globalThis as any).document;
    (globalThis as any).window = globalThis;
    (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => { cb(0); return 0; };
  });
  afterEach(() => {
    (globalThis as any).window = savedWindow;
    (globalThis as any).requestAnimationFrame = savedRAF;
    (globalThis as any).document = savedDocument;
  });

  function createStartPointView(node: ProtocolNodeRecord): {
    view: ProtocolEditorView; documentBody: MockEl; surfaceEl: MockEl; updateSpy: ReturnType<typeof vi.fn>;
  } {
    const documentBody = makeEl('body');
    (globalThis as any).document = { body: documentBody, activeElement: null };

    const holder: { view: ProtocolEditorView | null } = { view: null };
    const updateSpy = vi.fn(async (_path: string, mutator: (doc: ProtocolDocumentV1) => ProtocolDocumentV1): Promise<ProtocolDocumentV1> => {
      const current = (holder.view as any).doc as ProtocolDocumentV1;
      const updated = mutator(current);
      (holder.view as any).doc = updated;
      return updated;
    });

    const mockPlugin = {
      i18n: { t },
      settings: { snippetFolderPath: '.radiprotocol/snippets' },
      protocolDocumentStore: { update: updateSpy },
    } as any;

    const view = new ProtocolEditorView({} as any, mockPlugin);
    holder.view = view;

    const surfaceEl = makeEl('div');
    (view as any).surfaceEl = surfaceEl;
    (view as any).svgEl = makeEl('svg');
    (view as any).viewportEl = makeEl('div');
    (view as any).rootEl = makeEl('div');
    (view as any).protocolPath = 'test.rp.json';
    (view as any).zoom = 1;
    (view as any).loadProtocol = vi.fn(async () => {});

    const doc: ProtocolDocumentV1 = {
      schema: 'radiprotocol.protocol',
      version: 1,
      id: 'test-doc',
      title: 'Test Protocol',
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
      nodes: [node],
      edges: [],
    };
    (view as any).doc = doc;

    return { view, documentBody, surfaceEl, updateSpy };
  }

  function findStartCheckbox(root: MockEl): MockEl | undefined {
    return findAllByTag(root, 'input').filter((i) => i._attrs['type'] === 'checkbox')
      .find((c) => c.parent?.children.some((ch) =>
        ch.tagName === 'SPAN' && ch._text === 'Start point'));
  }

  function findStartLabelInput(root: MockEl): MockEl | undefined {
    return findAllByTag(root, 'input')
      .find((i) => i._attrs['type'] === 'text' && i.parent?.children.some((ch) =>
        ch.tagName === 'LABEL' && ch._text === 'Custom label for the “start from node” picker'));
  }

  function findButtonByText(root: MockEl, text: string): MockEl | undefined {
    return findAllByTag(root, 'button').find((b) => b._text === text);
  }

  it('hides the custom label input while the start checkbox is off and reveals it when checked', () => {
    const { view, documentBody } = createStartPointView({
      id: 'a1', kind: 'answer', x: 0, y: 0, width: 100, height: 50,
      fields: { answerText: 'Body' },
    });
    (view as any).openEditModal((view as any).doc.nodes[0]);

    const startCheckbox = findStartCheckbox(documentBody);
    expect(startCheckbox).toBeDefined();
    const labelInput = findStartLabelInput(documentBody);
    expect(labelInput).toBeDefined();
    expect((startCheckbox as any).checked).toBe(false);
    expect(labelInput!.parent!.classList.has('is-hidden')).toBe(true);

    (startCheckbox as any).checked = true;
    for (const handler of startCheckbox!._listeners.get('change') ?? []) handler({});
    expect(labelInput!.parent!.classList.has('is-hidden')).toBe(false);

    (startCheckbox as any).checked = false;
    for (const handler of startCheckbox!._listeners.get('change') ?? []) handler({});
    expect(labelInput!.parent!.classList.has('is-hidden')).toBe(true);
  });

  it('persists a non-blank custom label only while the start point is enabled', async () => {
    const { view, documentBody, updateSpy } = createStartPointView({
      id: 'q1', kind: 'question', x: 0, y: 0, width: 100, height: 50,
      fields: { questionText: 'Where?' },
    });
    (view as any).openEditModal((view as any).doc.nodes[0]);

    const startCheckbox = findStartCheckbox(documentBody)!;
    (startCheckbox as any).checked = true;
    for (const handler of startCheckbox._listeners.get('change') ?? []) handler({});
    findStartLabelInput(documentBody)!.value = '  My entry  ';

    const saveBtn = findButtonByText(documentBody, 'Save')!;
    for (const handler of saveBtn._listeners.get('click') ?? []) await handler({});

    expect(updateSpy).toHaveBeenCalledTimes(1);
    const persisted = (view as any).doc as ProtocolDocumentV1;
    expect(persisted.nodes[0]!.fields['startPointEnabled']).toBe(true);
    expect(persisted.nodes[0]!.fields['startPointLabel']).toBe('My entry');
  });

  it('drops the custom label when the start checkbox is saved unchecked', async () => {
    const { view, documentBody } = createStartPointView({
      id: 'q1', kind: 'question', x: 0, y: 0, width: 100, height: 50,
      fields: { questionText: 'Where?', startPointEnabled: true, startPointLabel: 'Old entry' },
    });
    (view as any).openEditModal((view as any).doc.nodes[0]);

    const startCheckbox = findStartCheckbox(documentBody)!;
    expect((startCheckbox as any).checked).toBe(true);
    // The stored label is restored into the input.
    expect(findStartLabelInput(documentBody)!.value).toBe('Old entry');

    (startCheckbox as any).checked = false;
    const saveBtn = findButtonByText(documentBody, 'Save')!;
    for (const handler of saveBtn._listeners.get('click') ?? []) await handler({});

    const persisted = (view as any).doc as ProtocolDocumentV1;
    expect(persisted.nodes[0]!.fields['startPointEnabled']).toBeUndefined();
    expect(persisted.nodes[0]!.fields['startPointLabel']).toBeUndefined();
  });

  it('renderDocument renders a free-text badge on an Answer with freeText enabled', () => {
    const { view, surfaceEl } = createStartPointView({
      id: 'a1', kind: 'answer', x: 0, y: 0, width: 100, height: 50,
      fields: { answerText: 'Body', freeText: true },
    });
    (view as any).renderDocument();

    const badges = findAllByClass(surfaceEl, 'rp-protocol-editor-node-free-text-badge');
    expect(badges.length).toBe(1);
    expect(badges[0]!._attrs['aria-label']).toBe('Free-text answer');
  });

  it('renderDocument omits the free-text badge on preset Answers and other kinds', () => {
    const { view, surfaceEl } = createStartPointView({
      id: 'a1', kind: 'answer', x: 0, y: 0, width: 100, height: 50,
      fields: { answerText: 'Body' },
    });
    (view as any).renderDocument();
    expect(findAllByClass(surfaceEl, 'rp-protocol-editor-node-free-text-badge')).toHaveLength(0);

    const second = createStartPointView({
      id: 'q1', kind: 'question', x: 0, y: 0, width: 100, height: 50,
      fields: { questionText: 'Q', freeText: true },
    });
    (second.view as any).renderDocument();
    expect(findAllByClass(second.surfaceEl, 'rp-protocol-editor-node-free-text-badge')).toHaveLength(0);
  });
});
