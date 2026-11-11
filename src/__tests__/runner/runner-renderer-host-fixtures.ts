// Shared host fixtures for inline runner modal tests.
import { vi } from 'vitest';
import { I18nService } from '../../i18n';

export interface MockEvent {
  type: string;
  target?: MockEl | null;
  key?: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  preventDefault?: () => void;
}

export interface MockEl {
  tagName: string;
  children: MockEl[];
  parent: MockEl | null;
  _text: string;
  classList: Set<string>;
  _attrs: Record<string, string>;
  _style: Record<string, string>;
  _value: string;
  _disabled: boolean;
  _type: string;
  _checked: boolean;
  _listeners: Map<string, Array<(ev: MockEvent) => void>>;
  textContent: string;
  value: string;
  disabled: boolean;
  type: string;
  checked: boolean;
  style: Record<string, string>;
  name: string;
  inputMode: string;
  readOnly: boolean;
  dataset: Record<string, string>;
  scrollHeight: number;
  offsetHeight: number;
  clientHeight: number;
  focusCount: number;
  createEl: (tag: string, opts?: { text?: string; cls?: string; type?: string; attr?: Record<string, string> }) => MockEl;
  createDiv: (opts?: { cls?: string; text?: string; attr?: Record<string, string> }) => MockEl;
  createSpan: (opts?: { cls?: string; text?: string }) => MockEl;
  empty: () => void;
  setText: (t: string) => void;
  addClass: (c: string) => void;
  removeClass: (c: string) => void;
  toggleClass: (c: string, on?: boolean) => void;
  hasClass: (c: string) => boolean;
  setAttribute: (k: string, v: string) => void;
  getAttribute: (k: string) => string | null;
  removeAttribute: (k: string) => void;
  contains: (candidate: unknown) => boolean;
  focus: () => void;
  remove: () => void;
  addEventListener: (type: string, handler: (ev: MockEvent) => void) => void;
  removeEventListener: (type: string, handler: (ev: MockEvent) => void) => void;
  dispatchEvent: (event: MockEvent) => void;
  querySelector: (sel: string) => MockEl | null;
  querySelectorAll: (sel: string) => MockEl[];
  prepend: (el: MockEl) => void;
  setCssProps: (props: Record<string, string>) => void;
}

export function makeEl(tag = 'div'): MockEl {
  const listeners = new Map<string, Array<(ev: MockEvent) => void>>();
  const children: MockEl[] = [];
  const attrs: Record<string, string> = {};
  const style: Record<string, string> = {};
  const classSet = new Set<string>();
  const dataset: Record<string, string> = {};

  const el = {
    tagName: tag.toUpperCase(),
    children,
    parent: null as MockEl | null,
    _text: '',
    classList: classSet,
    _attrs: attrs,
    _style: style,
    _value: '',
    _disabled: false,
    _type: '',
    _checked: false,
    _listeners: listeners,
    name: '',
    inputMode: '',
    readOnly: false,
    dataset,
    scrollHeight: 24,
    offsetHeight: 24,
    clientHeight: 24,
    focusCount: 0,
    createEl(subtag: string, opts?: { text?: string; cls?: string; type?: string; attr?: Record<string, string> }): MockEl {
      const child = makeEl(subtag);
      child.parent = el as unknown as MockEl;
      if (opts?.text !== undefined) child._text = opts.text;
      if (opts?.cls) {
        for (const cls of opts.cls.split(/\s+/).filter(Boolean)) child.classList.add(cls);
      }
      if (opts?.type) child._type = opts.type;
      if (opts?.attr) {
        for (const [key, value] of Object.entries(opts.attr)) {
          child.setAttribute(key, value);
        }
      }
      children.push(child);
      return child;
    },
    createDiv(opts?: { cls?: string; text?: string; attr?: Record<string, string> }): MockEl {
      return (this as unknown as MockEl).createEl('div', opts);
    },
    createSpan(opts?: { cls?: string; text?: string }): MockEl {
      return (this as unknown as MockEl).createEl('span', opts);
    },
    empty(): void {
      for (const child of children) child.parent = null;
      children.length = 0;
    },
    setText(text: string): void { (el as unknown as MockEl)._text = text; },
    addClass(cls: string): void { classSet.add(cls); },
    removeClass(cls: string): void { classSet.delete(cls); },
    toggleClass(cls: string, on?: boolean): void {
      if (on ?? !classSet.has(cls)) classSet.add(cls); else classSet.delete(cls);
    },
    hasClass(cls: string): boolean { return classSet.has(cls); },
    setAttribute(key: string, value: string): void {
      attrs[key] = value;
      if (key === 'type') (el as unknown as MockEl)._type = value;
    },
    getAttribute(key: string): string | null { return attrs[key] ?? null; },
    removeAttribute(key: string): void { delete attrs[key]; },
    contains(candidate: unknown): boolean {
      if (candidate === el) return true;
      const stack = [...children];
      while (stack.length > 0) {
        const current = stack.shift()!;
        if (current === candidate) return true;
        stack.push(...current.children);
      }
      return false;
    },
    focus(): void { (el as unknown as MockEl).focusCount += 1; },
    remove(): void {
      const parent = (el as unknown as MockEl).parent;
      if (parent === null) return;
      const index = parent.children.indexOf(el as unknown as MockEl);
      if (index >= 0) parent.children.splice(index, 1);
      (el as unknown as MockEl).parent = null;
    },
    addEventListener(type: string, handler: (ev: MockEvent) => void): void {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type)!.push(handler);
    },
    removeEventListener(type: string, handler: (ev: MockEvent) => void): void {
      const registered = listeners.get(type);
      if (registered === undefined) return;
      const index = registered.indexOf(handler);
      if (index >= 0) registered.splice(index, 1);
    },
    dispatchEvent(event: MockEvent): void {
      const registered = listeners.get(event.type);
      if (registered === undefined) return;
      const dispatched = {
        ...event,
        target: event.target ?? (el as unknown as MockEl),
      };
      for (const handler of registered.slice()) handler(dispatched);
    },
    querySelector(selector: string): MockEl | null {
      return walk(el as unknown as MockEl, selector)[0] ?? null;
    },
    querySelectorAll(selector: string): MockEl[] {
      return walk(el as unknown as MockEl, selector);
    },
    prepend(child: MockEl): void {
      children.unshift(child);
      child.parent = el as unknown as MockEl;
    },
    setCssProps(props: Record<string, string>): void {
      for (const [key, value] of Object.entries(props)) style[key] = value;
    },
    style,
  } as unknown as MockEl;

  Object.defineProperty(el, 'textContent', {
    get(): string { return (el as unknown as MockEl)._text; },
    set(value: string): void { (el as unknown as MockEl)._text = String(value); },
  });
  Object.defineProperty(el, 'value', {
    get(): string { return (el as unknown as MockEl)._value; },
    set(value: string): void { (el as unknown as MockEl)._value = String(value); },
  });
  Object.defineProperty(el, 'disabled', {
    get(): boolean { return (el as unknown as MockEl)._disabled; },
    set(value: boolean): void { (el as unknown as MockEl)._disabled = Boolean(value); },
  });
  Object.defineProperty(el, 'type', {
    get(): string { return (el as unknown as MockEl)._type; },
    set(value: string): void { (el as unknown as MockEl)._type = String(value); },
  });
  Object.defineProperty(el, 'checked', {
    get(): boolean { return (el as unknown as MockEl)._checked; },
    set(value: boolean): void { (el as unknown as MockEl)._checked = Boolean(value); },
  });

  return el;
}

function walk(root: MockEl, sel: string): MockEl[] {
  const out: MockEl[] = [];
  const match = buildMatcher(sel);
  const stack: MockEl[] = [...root.children];
  while (stack.length > 0) {
    const cur = stack.shift()!;
    if (match(cur)) out.push(cur);
    for (const c of cur.children) stack.push(c);
  }
  return out;
}

function buildMatcher(sel: string): (el: MockEl) => boolean {
  if (sel.startsWith('.')) {
    const cls = sel.slice(1);
    return (el) => el.classList.has(cls);
  }
  const tagAttrMatch = /^([a-zA-Z]+)\[([a-zA-Z-]+)="([^"]+)"\]$/.exec(sel);
  if (tagAttrMatch) {
    const [, tag, attr, val] = tagAttrMatch;
    return (el) => {
      if (el.tagName !== tag!.toUpperCase()) return false;
      if (attr === 'type') return (el as unknown as { _type: string })._type === val;
      return el.getAttribute(attr!) === val;
    };
  }
  return (el) => el.tagName === sel.toUpperCase();
}

export function findByClass(root: MockEl, cls: string): MockEl[] {
  return walk(root, '.' + cls);
}

export function createObsidianModuleMock(): Record<string, unknown> {
  class Modal {
    app: unknown;
    contentEl: MockEl;
    titleEl: MockEl;
    modalEl: { style: Record<string, string> };
    constructor(app: unknown) {
      this.app = app;
      this.contentEl = makeEl('div');
      this.titleEl = makeEl('div');
      this.modalEl = { style: {} };
    }
    open(): void { this.onOpen(); }
    close(): void { this.onClose(); }
    onOpen(): void {}
    onClose(): void {}
  }
  class Notice { constructor(_m: string) {} }
  class Plugin {}
  class ItemView {}
  class WorkspaceLeaf {}
  class PluginSettingTab {}
  class SuggestModal<T> {
    constructor(public app: unknown) {}
    getSuggestions(_q: string): T[] { return []; }
    renderSuggestion(): void {}
    onChooseSuggestion(): void {}
    setPlaceholder(): void {}
    open(): void {}
    close(): void {}
  }
  class Setting {
    constructor(_e: unknown) {}
    setName(): this { return this; }
    setDesc(): this { return this; }
    setHeading(): this { return this; }
    addText(): this { return this; }
    addTextArea(): this { return this; }
    addDropdown(): this { return this; }
    addSlider(): this { return this; }
    addButton(): this { return this; }
  }
  class TFile {
    path: string;
    extension: string;
    basename: string;
    constructor(p = '') {
      this.path = p;
      const parts = p.split('/');
      const leaf = parts[parts.length - 1] ?? '';
      const dot = leaf.lastIndexOf('.');
      this.extension = dot >= 0 ? leaf.slice(dot + 1) : '';
      this.basename = dot >= 0 ? leaf.slice(0, dot) : leaf;
    }
  }
  class TFolder {
    path: string;
    name: string;
    children: Array<TFile | TFolder>;
    constructor(p = '', children: Array<TFile | TFolder> = []) {
      this.path = p;
      this.name = p.split('/').pop() ?? '';
      this.children = children;
    }
  }
  class AbstractInputSuggest<T> {
    app: unknown;
    inputEl: unknown;
    constructor(app: unknown, inputEl: unknown) { this.app = app; this.inputEl = inputEl; }
    setValue(_v: T): void {}
    open(): void {}
    close(): void {}
  }
  return { Modal, Notice, Plugin, ItemView, WorkspaceLeaf, PluginSettingTab, SuggestModal, Setting, TFile, TFolder, AbstractInputSuggest, setIcon: mockSetIcon };
}

function mockSetIcon(_el: unknown, _iconId: string): void {}

interface FillModalInstance {
  snippet: unknown;
  result: Promise<string | null>;
  __resolve(value: string | null): void;
  open(): void;
  close(): void;
  opened: boolean;
  closed: boolean;
}

const fillModalInstances: FillModalInstance[] = [];

export function getFillModalInstances(): FillModalInstance[] {
  return fillModalInstances;
}

export function resetFillModalInstances(): void {
  fillModalInstances.length = 0;
}

export function createSnippetFillInModalMock(): Record<string, unknown> {
  class SnippetFillInModal {
    readonly result: Promise<string | null>;
    readonly snippet: unknown;
    opened = false;
    closed = false;
    private settled = false;
    private resolveFn!: (value: string | null) => void;

    constructor(_app: unknown, snippet: unknown) {
      this.snippet = snippet;
      this.result = new Promise<string | null>((resolve) => { this.resolveFn = resolve; });
      fillModalInstances.push(this as unknown as FillModalInstance);
    }

    private settle(value: string | null): void {
      if (this.settled) return;
      this.settled = true;
      this.resolveFn(value);
    }

    __resolve(value: string | null): void { this.settle(value); }
    open(): void { this.opened = true; }
    close(): void {
      if (this.closed) return;
      this.closed = true;
      this.settle(null);
    }
  }
  return { SnippetFillInModal, __fillModalInstances: fillModalInstances };
}

interface PickerMockInstance {
  options: Record<string, unknown>;
  mounted: boolean;
  unmounted: boolean;
}

const pickerMockInstances: PickerMockInstance[] = [];

export function getPickerMockInstances(): PickerMockInstance[] {
  return pickerMockInstances;
}

export function resetPickerMockInstances(): void {
  pickerMockInstances.length = 0;
}

export function createSnippetTreePickerMock(
  mountSpy: (instance: PickerMockInstance) => void | Promise<void> = () => {},
): Record<string, unknown> {
  class SnippetTreePicker {
    private readonly instance: PickerMockInstance;
    constructor(options: Record<string, unknown>) {
      this.instance = { options, mounted: false, unmounted: false };
      pickerMockInstances.push(this.instance);
    }
    async mount(): Promise<void> {
      this.instance.mounted = true;
      await mountSpy(this.instance);
    }
    unmount(): void { this.instance.unmounted = true; }
  }
  return { SnippetTreePicker };
}

export function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

type FileLike = { path: string };
type LeafLike = unknown;
type VaultHandler = (file: FileLike) => void;
type WorkspaceHandler = (leaf: LeafLike | null) => void;
type EventRefLike<T> = { event: string; handler: T };

export function makeBasePlugin(
  opts: { textSeparator?: 'newline' | 'space'; snippetFolderPath?: string } = {},
) {
  const inlineRunners = new Map<string, unknown>();
  return {
    settings: {
      textSeparator: opts.textSeparator ?? 'newline',
      snippetFolderPath: opts.snippetFolderPath ?? 'Snippets',
      protocolFolderPath: 'Protocols',
      locale: 'ru',
      enableRunnerDraft: false,
    },
    snippetService: {
      load: vi.fn<(absolutePath: string) => Promise<unknown | null>>(async () => null),
      resolveSnippet: vi.fn<(id: string) => Promise<unknown>>(async () => ({ status: 'missing' })),
    },
    protocolDocumentStore: {
      read: vi.fn<(path: string) => Promise<unknown | null>>(async () => ({
        schema: 'radiprotocol.protocol', version: 1,
      })),
    },
    protocolDocumentParser: {
      parse: vi.fn<(content: string, path: string) => unknown>(),
    },
    insertMutex: {
      runExclusive: vi.fn<(
        path: string,
        operation: () => Promise<void>,
      ) => Promise<void>>(async (_path, operation) => operation()),
    },
    canvasLiveEditor: { getCanvasJSON: () => null },
    _vaultModifyCalls: [] as Array<[string, string]>,
    i18n: new I18nService('ru'),
    inlineRunners,
    registerInlineRunner: vi.fn<(key: string, modal: unknown) => void>((key, modal) => {
      inlineRunners.set(key, modal);
    }),
    unregisterInlineRunner: vi.fn<(key: string) => void>((key) => {
      inlineRunners.delete(key);
    }),
    getInlineRunner: vi.fn<(key: string) => unknown>((key) => inlineRunners.get(key) ?? null),
    getOpenInlineRunners: vi.fn<() => unknown[]>(() => Array.from(inlineRunners.values())),
    getInlineRunnerPosition: vi.fn<() => null>(() => null),
    saveInlineRunnerPosition: vi.fn<(layout: unknown) => Promise<void>>(async () => {}),
  };
}

export function makeBaseApp(
  plugin: ReturnType<typeof makeBasePlugin>,
  opts: { vaultContent?: string } = {},
) {
  const vaultContent = opts.vaultContent ?? '';
  const modifyCalls: Array<[string, string]> = [];
  const vaultHandlers = new Map<string, VaultHandler[]>();
  const workspaceHandlers = new Map<string, WorkspaceHandler[]>();

  const app = {
    vault: {
      getAbstractFileByPath: vi.fn<(path: string) => FileLike | null>((path) =>
        path === 'Snippets/report.md' ? { path } : null),
      read: vi.fn<(file: FileLike) => Promise<string>>(async () => vaultContent),
      modify: vi.fn<(file: FileLike, content: string) => Promise<void>>(async (file, content) => {
        modifyCalls.push([file.path, content]);
        plugin._vaultModifyCalls.push([file.path, content]);
      }),
      getFiles: vi.fn<() => FileLike[]>(() => []),
      on: vi.fn<(event: string, handler: VaultHandler) => EventRefLike<VaultHandler>>(
        (event, handler) => {
          vaultHandlers.set(event, [...(vaultHandlers.get(event) ?? []), handler]);
          return { event, handler };
        },
      ),
      offref: vi.fn<(ref: EventRefLike<VaultHandler>) => void>((ref) => {
        vaultHandlers.set(
          ref.event,
          (vaultHandlers.get(ref.event) ?? []).filter((handler) => handler !== ref.handler),
        );
      }),
    },
    workspace: {
      on: vi.fn<(
        event: string,
        handler: WorkspaceHandler,
      ) => EventRefLike<WorkspaceHandler>>((event, handler) => {
        workspaceHandlers.set(event, [...(workspaceHandlers.get(event) ?? []), handler]);
        return { event, handler };
      }),
      offref: vi.fn<(ref: EventRefLike<WorkspaceHandler>) => void>((ref) => {
        workspaceHandlers.set(
          ref.event,
          (workspaceHandlers.get(ref.event) ?? []).filter((handler) => handler !== ref.handler),
        );
      }),
      getActiveFile: vi.fn<() => FileLike | null>(() => null),
      iterateAllLeaves: vi.fn<(callback: (leaf: LeafLike) => void) => void>(() => {}),
    },
    _modifyCalls: modifyCalls,
    _emitVault(event: string, file: FileLike): void {
      for (const handler of vaultHandlers.get(event) ?? []) handler(file);
    },
    _emitWorkspace(event: string, leaf: LeafLike | null = null): void {
      for (const handler of workspaceHandlers.get(event) ?? []) handler(leaf);
    },
    _vaultHandlerCount(event: string): number {
      return vaultHandlers.get(event)?.length ?? 0;
    },
    _workspaceHandlerCount(event: string): number {
      return workspaceHandlers.get(event)?.length ?? 0;
    },
  };
  return app;
}
