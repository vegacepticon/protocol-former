/**
 * Minimal Obsidian API mock for vitest.
 * Only stubs the classes/functions used by modules under test.
 * Real Obsidian runtime is only available inside the Obsidian desktop app.
 */

/** Child-retaining mock element used by ItemView and settings tests. */
export interface MockElement {
  recordedCssProps: Record<string, string>[];
  tagName: string;
  children: MockElement[];
  parentElement: MockElement | null;
  classList: Set<string>;
  hidden: boolean;
  createEl: (tag: string, opts?: {
    text?: string;
    cls?: string;
    type?: string;
    attr?: Record<string, string>;
  }) => MockElement;
  createDiv: (opts?: {
    text?: string;
    cls?: string;
    attr?: Record<string, string>;
  }) => MockElement;
  empty: () => void;
  remove: () => void;
  contains: (candidate: unknown) => boolean;
  setText: (text: string) => void;
  setCssProps: (props: Record<string, string>) => void;
  type: string;
  min: string;
  placeholder: string;
  value: string;
  rows: number;
  disabled: boolean;
  title: string;
  textContent: string;
  addEventListener: (type: string, cb: (event: any) => void) => void;
  removeEventListener: (type: string, cb: (event: any) => void) => void;
  dispatchEvent: (event: { type: string; [key: string]: unknown }) => boolean;
  setAttribute: (name: string, value: string) => void;
  setAttr: (name: string, value: string | number | boolean) => void;
  getAttribute: (name: string) => string | null;
  addClass: (cls: string) => void;
  removeClass: (cls: string) => void;
  toggleClass: (cls: string, force?: boolean) => void;
  hasClass: (cls: string) => boolean;
  querySelector: (selector: string) => MockElement | null;
  querySelectorAll: (selector: string) => MockElement[];
  click: () => void;
  setCssStyles: (props: Record<string, string>) => void;
  getCssStyles: () => Record<string, string>;
}

function makeMockEl(tag = 'div'): MockElement {
  const classes = new Set<string>();
  const attrs = new Map<string, string>();
  const listeners = new Map<string, Array<(event: any) => void>>();
  const children: MockElement[] = [];

  const matches = (candidate: MockElement, selector: string): boolean => {
    if (selector.startsWith('.')) return candidate.classList.has(selector.slice(1));
    const attrMatch = /^([a-zA-Z]+)\[([^=]+)="([^"]+)"\]$/.exec(selector);
    if (attrMatch !== null) {
      return candidate.tagName === attrMatch[1]!.toUpperCase()
        && candidate.getAttribute(attrMatch[2]!) === attrMatch[3];
    }
    return candidate.tagName === selector.toUpperCase();
  };

  const descendants = (selector: string): MockElement[] => {
    const found: MockElement[] = [];
    const queue = [...children];
    while (queue.length > 0) {
      const candidate = queue.shift()!;
      if (matches(candidate, selector)) found.push(candidate);
      queue.push(...candidate.children);
    }
    return found;
  };

  const el: MockElement = {
    recordedCssProps: [],
    tagName: tag.toUpperCase(),
    children,
    parentElement: null,
    classList: classes,
    hidden: false,
    createEl: (childTag, opts = {}) => {
      const child = makeMockEl(childTag);
      child.parentElement = el;
      if (opts.text !== undefined) child.textContent = opts.text;
      if (opts.cls !== undefined) {
        for (const cls of opts.cls.split(/\s+/).filter(Boolean)) child.addClass(cls);
      }
      if (opts.type !== undefined) {
        child.type = opts.type;
        child.setAttribute('type', opts.type);
      }
      if (opts.attr !== undefined) {
        for (const [name, value] of Object.entries(opts.attr)) {
          child.setAttribute(name, value);
        }
      }
      children.push(child);
      return child;
    },
    createDiv: (opts = {}) => el.createEl('div', opts),
    empty: () => {
      for (const child of children) child.parentElement = null;
      children.length = 0;
    },
    remove: () => {
      const parent = el.parentElement;
      if (parent === null) return;
      const index = parent.children.indexOf(el);
      if (index >= 0) parent.children.splice(index, 1);
      el.parentElement = null;
    },
    contains: (candidate) => {
      if (candidate === el) return true;
      const queue = [...children];
      while (queue.length > 0) {
        const child = queue.shift()!;
        if (child === candidate) return true;
        queue.push(...child.children);
      }
      return false;
    },
    setText: (text) => { el.textContent = text; },
    setCssProps: (props) => { el.recordedCssProps.push({ ...props }); },
    type: '',
    min: '',
    placeholder: '',
    value: '',
    rows: 10,
    disabled: false,
    title: '',
    textContent: '',
    addEventListener: (type, cb) => {
      listeners.set(type, [...(listeners.get(type) ?? []), cb]);
    },
    removeEventListener: (type, cb) => {
      listeners.set(type, (listeners.get(type) ?? []).filter(listener => listener !== cb));
    },
    dispatchEvent: (event) => {
      const dispatched = {
        ...event,
        target: event.target === undefined ? el : event.target,
      };
      for (const listener of listeners.get(event.type) ?? []) listener(dispatched);
      return true;
    },
    setAttribute: (name, value) => {
      attrs.set(name, value);
      if (name === 'type') el.type = value;
    },
    setAttr: (name, value) => { attrs.set(name, String(value)); },
    getAttribute: (name) => attrs.get(name) ?? null,
    addClass: (cls) => { classes.add(cls); },
    removeClass: (cls) => { classes.delete(cls); },
    toggleClass: (cls, force) => {
      if (force === true) classes.add(cls);
      else if (force === false) classes.delete(cls);
      else if (classes.has(cls)) classes.delete(cls);
      else classes.add(cls);
    },
    hasClass: (cls) => classes.has(cls),
    querySelector: (selector) => descendants(selector)[0] ?? null,
    querySelectorAll: (selector) => descendants(selector),
    click: () => { el.dispatchEvent({ type: 'click' }); },
    setCssStyles: (props) => { el.recordedCssProps.push({ ...props }); },
    getCssStyles: () => Object.assign({}, ...el.recordedCssProps),
  };

  return el;
}

interface MockInputEvent {
  type: string;
  bubbles?: boolean;
}

interface MockInputEl {
  type: string;
  min: string;
  value: string;
  rows?: number;
  focused: boolean;
  focus: () => void;
  classList: Set<string>;
  addClass: (cls: string) => void;
  removeClass: (cls: string) => void;
  toggleClass: (cls: string, force?: boolean) => void;
  setAttribute: (name: string, value: string) => void;
  getAttribute: (name: string) => string | null;
  addEventListener: (type: string, cb: (evt: MockInputEvent) => void) => void;
  dispatchEvent: (evt: MockInputEvent) => boolean;
}

const mockTextComponents: MockTextComponent[] = [];
const mockToggleComponents: MockToggle[] = [];
const mockButtonComponents: MockButton[] = [];
const mockExtraButtonComponents: MockExtraButton[] = [];
const mockAbstractInputSuggestInstances: AbstractInputSuggest<unknown>[] = [];

function makeMockInputEl(): MockInputEl {
  const listeners = new Map<string, Array<(evt: MockInputEvent) => void>>();
  const classes = new Set<string>();
  const attrs = new Map<string, string>();
  let focused = false;
  return {
    type: '',
    min: '',
    value: '',
    get focused() { return focused; },
    focus: () => { focused = true; },
    classList: classes,
    addClass: (cls: string) => { classes.add(cls); },
    removeClass: (cls: string) => { classes.delete(cls); },
    toggleClass: (cls: string, force?: boolean) => {
      if (force === true) classes.add(cls);
      else if (force === false) classes.delete(cls);
      else if (classes.has(cls)) classes.delete(cls);
      else classes.add(cls);
    },
    setAttribute: (name: string, value: string) => { attrs.set(name, value); },
    getAttribute: (name: string) => attrs.get(name) ?? null,
    addEventListener: (type: string, cb: (evt: MockInputEvent) => void) => {
      const existing = listeners.get(type) ?? [];
      existing.push(cb);
      listeners.set(type, existing);
    },
    dispatchEvent: (evt: MockInputEvent) => {
      for (const cb of listeners.get(evt.type) ?? []) {
        cb(evt);
      }
      return true;
    },
  };
}

/** Mock TextComponent / TextAreaComponent returned by addText / addTextArea */
function makeMockTextComponent(): MockTextComponent {
  const inputEl = makeMockInputEl();
  const tc: MockTextComponent = {
    inputEl,
    setPlaceholder: (_placeholder: string) => tc,
    setValue: (v: string) => {
      inputEl.value = v;
      return tc;
    },
    onChange: (cb: (v: string) => void) => {
      inputEl.addEventListener('input', () => cb(inputEl.value));
      return tc;
    },
  };
  mockTextComponents.push(tc);
  return tc;
}

interface MockTextComponent {
  inputEl: MockInputEl;
  setPlaceholder: (placeholder: string) => MockTextComponent;
  setValue: (v: string) => MockTextComponent;
  onChange: (cb: (v: string) => void) => MockTextComponent;
}

export function __resetObsidianMocks(): void {
  mockTextComponents.length = 0;
  mockToggleComponents.length = 0;
  mockButtonComponents.length = 0;
  mockExtraButtonComponents.length = 0;
  mockAbstractInputSuggestInstances.length = 0;
}

export function __getMockTextComponents(): MockTextComponent[] {
  return mockTextComponents;
}

export function __getMockToggleComponents(): MockToggle[] {
  return mockToggleComponents;
}

export function __getMockButtonComponents(): MockButton[] {
  return mockButtonComponents;
}

export function __getMockExtraButtonComponents(): MockExtraButton[] {
  return mockExtraButtonComponents;
}

export function __getMockAbstractInputSuggestInstances(): AbstractInputSuggest<unknown>[] {
  return mockAbstractInputSuggestInstances;
}

export class AbstractInputSuggest<T> {
  app: unknown;
  textInputEl: MockInputEl;
  limit = 100;
  selected: T | null = null;
  constructor(app: unknown, textInputEl: MockInputEl) {
    this.app = app;
    this.textInputEl = textInputEl;
    mockAbstractInputSuggestInstances.push(this as AbstractInputSuggest<unknown>);
  }
  setValue(value: string): void {
    this.textInputEl.value = value;
  }
  getValue(): string {
    return this.textInputEl.value;
  }
  protected getSuggestions(_query: string): T[] | Promise<T[]> { return []; }
  selectSuggestion(value: T, _evt: MouseEvent | KeyboardEvent): void {
    this.selected = value;
  }
  onSelect(_callback: (value: T, evt: MouseEvent | KeyboardEvent) => unknown): this { return this; }
}

/** Mock DropdownComponent — must support full addOption chaining (8 options) */
function makeMockDropdown(): MockDropdown {
  const drop: MockDropdown = {
    addOption: (_value: string, _display: string) => drop,
    setValue: (_v: string) => drop,
    onChange: (_cb: (v: string) => void) => drop,
  };
  return drop;
}

interface MockDropdown {
  addOption: (value: string, display: string) => MockDropdown;
  setValue: (v: string) => MockDropdown;
  onChange: (cb: (v: string) => void) => MockDropdown;
}

export interface MockToggle {
  value: boolean;
  setValue: (value: boolean) => MockToggle;
  onChange: (cb: (value: boolean) => void | Promise<void>) => MockToggle;
  trigger: (value: boolean) => Promise<void>;
}

function makeMockToggle(): MockToggle {
  let onChange: ((value: boolean) => void | Promise<void>) | null = null;
  const toggle: MockToggle = {
    value: false,
    setValue: (value) => {
      toggle.value = value;
      return toggle;
    },
    onChange: (cb) => {
      onChange = cb;
      return toggle;
    },
    trigger: async (value) => {
      toggle.value = value;
      await onChange?.(value);
    },
  };
  mockToggleComponents.push(toggle);
  return toggle;
}

/** Mock ButtonComponent — supports setCta and onClick chaining */
function makeMockButton(): MockButton {
  const btn: MockButton = {
    text: '',
    icon: '',
    click: null,
    setButtonText: (text: string) => { btn.text = text; return btn; },
    setIcon: (iconId: string) => { btn.icon = iconId; return btn; },
    setCta: () => btn,
    onClick: (cb: () => void) => { btn.click = cb; return btn; },
  };
  mockButtonComponents.push(btn);
  return btn;
}

export interface MockButton {
  text: string;
  icon: string;
  click: (() => void) | null;
  setButtonText: (text: string) => MockButton;
  setIcon: (iconId: string) => MockButton;
  setCta: () => MockButton;
  onClick: (cb: () => void) => MockButton;
}

function makeMockExtraButton(): MockExtraButton {
  const btn: MockExtraButton = {
    icon: '',
    tooltip: '',
    click: null,
    setIcon: (iconId: string) => { btn.icon = iconId; return btn; },
    setTooltip: (tooltip: string) => { btn.tooltip = tooltip; return btn; },
    onClick: (cb: () => void) => { btn.click = cb; return btn; },
  };
  mockExtraButtonComponents.push(btn);
  return btn;
}

export interface MockExtraButton {
  icon: string;
  tooltip: string;
  click: (() => void) | null;
  setIcon: (iconId: string) => MockExtraButton;
  setTooltip: (tooltip: string) => MockExtraButton;
  onClick: (cb: () => void) => MockExtraButton;
}

interface MockEventRef {
  event: string;
  handler: (...args: any[]) => void;
}

export class ItemView {
  app: any;
  leaf: WorkspaceLeaf;
  containerEl: MockElement;
  contentEl: MockElement;
  private readonly eventRefs: MockEventRef[] = [];

  constructor(leaf: WorkspaceLeaf) {
    this.leaf = leaf;
    this.app = leaf.app;
    this.containerEl = makeMockEl();
    this.contentEl = this.containerEl.createDiv();
  }

  getViewType(): string { return ''; }
  getDisplayText(): string { return ''; }
  getIcon(): string { return ''; }
  getState(): Record<string, unknown> { return {}; }
  setState(_state: unknown, _result: unknown): Promise<void> { return Promise.resolve(); }
  getEphemeralState(): Record<string, unknown> { return this.leaf.getEphemeralState(); }
  setEphemeralState(state: unknown): void { this.leaf.setEphemeralState(state); }
  registerEvent(ref: MockEventRef): MockEventRef {
    this.eventRefs.push(ref);
    return ref;
  }
  registerDomEvent(
    element: MockElement,
    event: string,
    callback: (event: any) => void,
  ): void {
    element.addEventListener(event, callback);
  }
  onOpen(): void | Promise<void> {}
  onClose(): void | Promise<void> {}
}

export class WorkspaceLeaf {
  app: any;
  view: any = {};
  isDeferred = false;
  detached = false;
  detachCalls = 0;
  openedFile: TFile | null = null;
  lastViewState: Record<string, unknown> | null = null;
  lastEState: unknown = null;
  private ephemeralState: Record<string, unknown> = {};
  private closed = false;
  private readonly viewFactory?: (leaf: WorkspaceLeaf, type: string) => any;

  constructor(
    app: any = {},
    viewFactory?: (leaf: WorkspaceLeaf, type: string) => any,
  ) {
    this.app = app;
    this.viewFactory = viewFactory;
  }

  getViewState(): Record<string, unknown> {
    return this.lastViewState ?? { type: 'empty' };
  }

  async setViewState(viewState: Record<string, unknown>, eState?: unknown): Promise<void> {
    this.lastViewState = viewState;
    this.lastEState = eState;
    if (eState !== undefined) this.setEphemeralState(eState);
    const type = typeof viewState.type === 'string' ? viewState.type : '';
    if (this.viewFactory !== undefined) {
      this.view = this.viewFactory(this, type);
      await this.view.onOpen?.();
    }
  }

  async loadIfDeferred(): Promise<void> {
    this.isDeferred = false;
  }

  getEphemeralState(): Record<string, unknown> {
    return this.ephemeralState;
  }

  setEphemeralState(state: unknown): void {
    this.ephemeralState = state !== null && typeof state === 'object'
      ? { ...(state as Record<string, unknown>) }
      : {};
  }

  detach(): void {
    this.detachCalls += 1;
    this.detached = true;
    if (this.closed) return;
    this.closed = true;
    void this.view?.onClose?.();
  }

  async openFile(file: TFile): Promise<void> {
    this.openedFile = file;
    this.view = { file };
  }
}

export class PluginSettingTab {
  app: unknown;
  plugin: unknown;
  containerEl: ReturnType<typeof makeMockEl>;
  constructor(app: unknown, plugin: unknown) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = makeMockEl();
  }
  display(): void {}
  hide(): void {}
}

export class Plugin {
  app: unknown = {};
  manifest: unknown = {};
}

export class App {}

export class MarkdownView {
  file: TFile | null = null;
  editor = {
    replaceSelection: (_value: string): void => {},
    getSelection: (): string => '',
  };
}

export class Menu {
  addItem(callback: (item: {
    setTitle(title: string): any;
    setIcon(icon: string): any;
    onClick(handler: () => void): any;
  }) => void): this {
    const item: any = {
      setTitle: () => item,
      setIcon: () => item,
      onClick: () => item,
    };
    callback(item);
    return this;
  }

  showAtMouseEvent(_event: MouseEvent): void {}
  showAtPosition(_position: { x: number; y: number }): void {}
}

export class Modal {
  app: unknown;
  contentEl: ReturnType<typeof makeMockEl>;
  titleEl: ReturnType<typeof makeMockEl>;
  constructor(app: unknown) {
    this.app = app;
    this.contentEl = makeMockEl();
    this.titleEl = makeMockEl();
  }
  open(): void {}
  close(): void {}
  onOpen(): void {}
  onClose(): void {}
}

export class SuggestModal<T> {
  app: unknown;
  constructor(app: unknown) { this.app = app; }
  getSuggestions(_query: string): T[] { return []; }
  renderSuggestion(_item: T, _el: unknown): void {}
  onChooseSuggestion(_item: T, _evt: unknown): void {}
  setPlaceholder(_placeholder: string): void {}
  open(): void {}
  close(): void {}
}

export class Notice {
  constructor(_message: string, _timeout?: number) {}
}

export class Setting {
  settingEl: MockElement = makeMockEl();
  infoEl: MockElement = makeMockEl();
  nameEl: MockElement = makeMockEl();
  descEl: MockElement = makeMockEl();
  controlEl: MockElement = makeMockEl();
  constructor(containerEl: unknown) {
    // Mirror Obsidian: a Setting appends its own element to the container. This
    // makes containers queryable in tests (e.g. phrase rows during filtering).
    const parent = containerEl as { children?: MockElement[] } | null;
    if (parent !== null && Array.isArray(parent.children)) {
      parent.children.push(this.settingEl);
      this.settingEl.parentElement = parent as MockElement;
    }
  }
  setName(_name: string): this { return this; }
  setDesc(_desc: string): this { return this; }
  setClass(_cls: string): this { return this; }
  setHeading(): this { return this; }
  addText(_cb: (text: MockTextComponent) => void): this {
    _cb(makeMockTextComponent());
    return this;
  }
  addTextArea(_cb: (ta: MockTextComponent) => void): this {
    _cb(makeMockTextComponent());
    return this;
  }
  addDropdown(_cb: (drop: MockDropdown) => void): this {
    _cb(makeMockDropdown());
    return this;
  }
  addSlider(_cb: (slider: unknown) => void): this {
    _cb({ setLimits: () => this, setValue: () => this, onChange: () => this, setDynamicTooltip: () => this });
    return this;
  }
  addToggle(_cb: (toggle: MockToggle) => void): this {
    _cb(makeMockToggle());
    return this;
  }
  addButton(_cb: (btn: MockButton) => void): this {
    _cb(makeMockButton());
    return this;
  }
  addExtraButton(_cb: (btn: MockExtraButton) => void): this {
    _cb(makeMockExtraButton());
    return this;
  }
}

/** TFile mock — instanceof checks use this. Phase 59: added extension + basename for canvas-file filtering. */
export class TFile {
  path: string;
  extension: string;
  basename: string;
  constructor(path = '') {
    this.path = path;
    const parts = path.split('/');
    const leaf = parts[parts.length - 1] ?? '';
    const dot = leaf.lastIndexOf('.');
    this.extension = dot >= 0 ? leaf.slice(dot + 1) : '';
    this.basename = dot >= 0 ? leaf.slice(0, dot) : leaf;
  }
}

/** Mock setIcon — no-op stub matching Obsidian's signature.
 * Real runtime injects an <svg> into the element; tests only verify call wiring. */
export function setIcon(_el: unknown, _iconId: string): void {
  // no-op
}

/** TFolder mock — Phase 59: added for main.ts::resolveProtocolCanvasFiles tests. */
export class TFolder {
  path: string;
  name: string;
  children: Array<TFile | TFolder>;
  constructor(path = '', children: Array<TFile | TFolder> = []) {
    this.path = path;
    this.name = path.split('/').pop() ?? '';
    this.children = children;
  }
}

/** Mock requestUrl — tests inject a vi.fn() via RegistryClient options (D2).
 *  This default stub returns a 503 so a client constructed without the DI
 *  option fails safe (catalog unavailable) rather than crashing. Type-check
 *  resolves `obsidian` to the real obsidian.d.ts; this export is runtime-only. */
export function requestUrl(_request: unknown): Promise<{
  status: number;
  text: string;
  json: unknown;
  arrayBuffer: ArrayBuffer;
  headers: Record<string, string>;
}> {
  return Promise.resolve({ status: 503, text: '', json: {}, arrayBuffer: new ArrayBuffer(0), headers: {} });
}
