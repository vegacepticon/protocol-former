// src/__tests__/views/snippet-fill-in-modal.test.ts
// Phase 52 Plan 01 (D-05 / D-06 / D-09 RED) — unified choice rendering contract.
//
// These tests are RED at Plan 01 commit time. Plan 03 narrows `renderField`
// dispatch to two arms (free-text, choice=alwaysMulti) and flips them GREEN.
//
// Infrastructure note:
//   vitest environment is 'node' — no jsdom. The obsidian stub under
//   src/__mocks__/obsidian.ts exposes a `Modal` whose contentEl is a thin
//   MockEl without querySelector/querySelectorAll. This file swaps the stub
//   via a local vi.mock('obsidian', ...) factory that installs a DOM-ish
//   contentEl/titleEl (same pattern used in snippet-editor-modal.test.ts).
// Tests remain RED because production dispatch still renders radios for
// 'choice' (Plan 03 will flip to checkboxes), not because of infra.

import { describe, it, expect, vi } from 'vitest';

// ───── MockEl with querySelector/querySelectorAll + event dispatch ─────
interface MockEl {
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
  _listeners: Map<string, Array<(ev: unknown) => void>>;
  name: string;
  inputMode: string;
  readOnly: boolean;
  scrollHeight: number;
  /** Times `focus()` was called; lets autofocus/roving assertions be observable. */
  focusCount: number;
  dataset: Record<string, string>;
  style: Record<string, string>;
  // accessor-backed: textContent, value, disabled, type, checked, style
  createEl: (
    tag: string,
    opts?: {
      text?: string;
      cls?: string;
      type?: string;
      attr?: Record<string, string | number | boolean>;
    },
  ) => MockEl;
  createDiv: (opts?: { cls?: string; text?: string }) => MockEl;
  createSpan: (opts?: { cls?: string; text?: string }) => MockEl;
  empty: () => void;
  setText: (t: string) => void;
  addClass: (c: string) => void;
  removeClass: (c: string) => void;
  toggleClass: (c: string, on?: boolean) => void;
  hasClass: (c: string) => boolean;
  setAttribute: (k: string, v: string) => void;
  removeAttribute: (k: string) => void;
  getAttribute: (k: string) => string | null;
  setCssProps: (props: Record<string, string>) => void;
  focus: () => void;
  addEventListener: (type: string, handler: (ev: unknown) => void) => void;
  removeEventListener: (type: string, handler: (ev: unknown) => void) => void;
  dispatchEvent: (event: { type: string; target?: MockEl }) => void;
  querySelector: (sel: string) => MockEl | null;
  querySelectorAll: (sel: string) => MockEl[];
}

function makeEl(tag = 'div'): MockEl {
  const listeners = new Map<string, Array<(ev: unknown) => void>>();
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
    scrollHeight: 0,
    focusCount: 0,
    dataset,
    createEl(
      subtag: string,
      opts?: {
        text?: string;
        cls?: string;
        type?: string;
        attr?: Record<string, string | number | boolean>;
      },
    ): MockEl {
      const child = makeEl(subtag);
      child.parent = el as unknown as MockEl;
      if (opts?.text !== undefined) (child as unknown as { _text: string })._text = opts.text;
      if (opts?.cls) child.classList.add(opts.cls);
      if (opts?.type) (child as unknown as { _type: string })._type = opts.type;
      if (opts?.attr) {
        for (const [key, val] of Object.entries(opts.attr)) {
          child.setAttribute(key, String(val));
        }
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
    appendText(text: string): void {
      const node = makeEl('#text');
      node._text = text;
      node.parent = el as unknown as MockEl;
      children.push(node);
    },
    setText(text: string): void {
      (el as unknown as { _text: string })._text = text;
    },
    addClass(cls: string): void { classSet.add(cls); },
    removeClass(cls: string): void { classSet.delete(cls); },
    toggleClass(cls: string, on?: boolean): void {
      const want = on ?? !classSet.has(cls);
      if (want) classSet.add(cls);
      else classSet.delete(cls);
    },
    hasClass(cls: string): boolean { return classSet.has(cls); },
    setAttribute(k: string, v: string): void { attrs[k] = v; },
    removeAttribute(k: string): void { delete attrs[k]; },
    getAttribute(k: string): string | null { return attrs[k] ?? null; },
    setCssProps(props: Record<string, string>): void {
      for (const [key, val] of Object.entries(props)) {
        style[key] = val;
      }
    },
    focus(): void { (el as unknown as { focusCount: number }).focusCount += 1; },
    addEventListener(type: string, handler: (ev: unknown) => void): void {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type)!.push(handler);
    },
    removeEventListener(type: string, handler: (ev: unknown) => void): void {
      const arr = listeners.get(type);
      if (!arr) return;
      const i = arr.indexOf(handler);
      if (i >= 0) arr.splice(i, 1);
    },
    dispatchEvent(event: { type: string; target?: MockEl }): void {
      const arr = listeners.get(event.type);
      if (!arr) return;
      const evt = { ...event, target: event.target ?? (el as unknown as MockEl) };
      for (const h of arr.slice()) h(evt);
    },
    querySelector(sel: string): MockEl | null {
      const all = walk(el as unknown as MockEl, sel);
      return all[0] ?? null;
    },
    querySelectorAll(sel: string): MockEl[] {
      return walk(el as unknown as MockEl, sel);
    },
    style,
  } as unknown as MockEl;

  Object.defineProperty(el, 'textContent', {
    get(): string { return (el as unknown as { _text: string })._text; },
    set(v: string): void { (el as unknown as { _text: string })._text = String(v); },
  });
  Object.defineProperty(el, 'value', {
    get(): string { return (el as unknown as { _value: string })._value; },
    set(v: string): void { (el as unknown as { _value: string })._value = String(v); },
  });
  Object.defineProperty(el, 'disabled', {
    get(): boolean { return (el as unknown as { _disabled: boolean })._disabled; },
    set(v: boolean): void { (el as unknown as { _disabled: boolean })._disabled = Boolean(v); },
  });
  Object.defineProperty(el, 'type', {
    get(): string { return (el as unknown as { _type: string })._type; },
    set(v: string): void { (el as unknown as { _type: string })._type = String(v); },
  });
  Object.defineProperty(el, 'checked', {
    get(): boolean { return (el as unknown as { _checked: boolean })._checked; },
    set(v: boolean): void { (el as unknown as { _checked: boolean })._checked = Boolean(v); },
  });

  return el;
}

/** Simple selector walker — supports 'button[type="button"]', 'button', 'input[type="radio"]', '.class'. */
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
  // class selector
  if (sel.startsWith('.')) {
    const cls = sel.slice(1);
    return (el) => el.classList.has(cls);
  }
  // tag[attr="value"]
  const tagAttrMatch = /^([a-zA-Z]+)\[([a-zA-Z-]+)="([^"]+)"\]$/.exec(sel);
  if (tagAttrMatch) {
    const [, tag, attr, val] = tagAttrMatch;
    return (el) => {
      if (el.tagName !== tag!.toUpperCase()) return false;
      if (attr === 'type') return (el as unknown as { _type: string })._type === val;
      return el.getAttribute(attr!) === val;
    };
  }
  // plain tag
  return (el) => el.tagName === sel.toUpperCase();
}

// ───── Mock obsidian with enhanced Modal ─────
vi.mock('obsidian', () => {
  class Modal {
    app: unknown;
    contentEl: MockEl;
    titleEl: MockEl;
    modalEl: MockEl;
    // Real Obsidian modals own containerEl (holds .modal-bg + .modal-container).
    containerEl: MockEl;
    constructor(app: unknown) {
      this.app = app;
      this.containerEl = makeEl('div');
      this.contentEl = makeEl('div');
      this.titleEl = makeEl('div');
      this.modalEl = makeEl('div');
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
    app: unknown;
    constructor(app: unknown) { this.app = app; }
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
  class TFile { path: string; constructor(p = '') { this.path = p; } }
  return { Modal, Notice, Plugin, ItemView, WorkspaceLeaf, PluginSettingTab, SuggestModal, Setting, TFile };
});

// Import after the mock is installed.
import { SnippetFillInModal } from '../../views/snippet-fill-in-modal';
import type { MdTemplateSnippet } from '../../snippets/snippet-model';

const app = {} as never;

function makeSnippet(
  placeholders: MdTemplateSnippet['placeholders'],
  template = 'R: {{f}}',
): MdTemplateSnippet {
  return {
    kind: 'md-template',
    path: 'Protocols/Snippets/t.md',
    name: 't',
    template,
    placeholders,
    validationError: null,
  };
}

function findConfirmButton(root: MockEl): MockEl {
  const buttons = root.querySelectorAll('button');
  const found = buttons.find(
    (b) => (b as unknown as { _text: string })._text === 'Confirm',
  );
  if (!found) throw new Error('Confirm button missing');
  return found;
}

describe('SnippetFillInModal Phase 52 D-05 — unified choice renders as toggle buttons', () => {
  it('renders toggle buttons (not checkboxes or radios) for choice with options', async () => {
    const snippet = makeSnippet([
      { id: 'f', label: 'F', type: 'choice', options: ['a', 'b', 'c'] },
    ]);
    const modal = new SnippetFillInModal(app, snippet);
    modal.onOpen();
    const root = (modal as unknown as { contentEl: MockEl }).contentEl;
    const checkboxes = root
      .querySelectorAll('input[type="checkbox"]');
    const radios = root
      .querySelectorAll('input[type="radio"]');
    const options = root.querySelectorAll('.rp-snippet-fill-option-row');
    expect(options.length).toBe(3);
    expect(options.every(option => option.tagName === 'BUTTON')).toBe(true);
    expect(options.every(option => (option as unknown as { _type: string })._type === 'button')).toBe(true);
    expect(checkboxes.length).toBe(0);
    expect(radios.length).toBe(0);
    modal.onClose();
  });

  it('resolves with empty string in value map when no option selected + empty custom (D-09)', async () => {
    const snippet = makeSnippet([
      { id: 'f', label: 'F', type: 'choice', options: ['a', 'b'] },
    ]);
    const modal = new SnippetFillInModal(app, snippet);
    modal.onOpen();
    const confirmBtn = findConfirmButton(
      (modal as unknown as { contentEl: MockEl }).contentEl,
    );
    confirmBtn.dispatchEvent({ type: 'click' });
    const result = await modal.result;
    expect(result).toBe('R: ');
    modal.onClose();
  });

  it('inserts a single selected option verbatim', async () => {
    const snippet = makeSnippet([
      { id: 'f', label: 'F', type: 'choice', options: ['alpha', 'beta'] },
    ]);
    const modal = new SnippetFillInModal(app, snippet);
    modal.onOpen();
    const buttons = (modal as unknown as { contentEl: MockEl }).contentEl
      .querySelectorAll('.rp-snippet-fill-option-row');
    buttons[0]!.dispatchEvent({ type: 'click' });
    expect(buttons[0]!.hasClass('is-selected')).toBe(true);
    expect(buttons[0]!.getAttribute('aria-pressed')).toBe('true');
    const confirmBtn = findConfirmButton(
      (modal as unknown as { contentEl: MockEl }).contentEl,
    );
    confirmBtn.dispatchEvent({ type: 'click' });
    const result = await modal.result;
    expect(result).toBe('R: alpha');
    modal.onClose();
  });

  it('joins multiple selected options with default separator ", "', async () => {
    const snippet = makeSnippet([
      { id: 'f', label: 'F', type: 'choice', options: ['a', 'b', 'c'] },
    ]);
    const modal = new SnippetFillInModal(app, snippet);
    modal.onOpen();
    const buttons = (modal as unknown as { contentEl: MockEl }).contentEl
      .querySelectorAll('.rp-snippet-fill-option-row');
    buttons[0]!.dispatchEvent({ type: 'click' });
    buttons[2]!.dispatchEvent({ type: 'click' });
    const confirmBtn = findConfirmButton(
      (modal as unknown as { contentEl: MockEl }).contentEl,
    );
    confirmBtn.dispatchEvent({ type: 'click' });
    const result = await modal.result;
    expect(result).toBe('R: a, c');
    modal.onClose();
  });

  it('joins multiple selected options with override separator " / " (D-02)', async () => {
    const snippet = makeSnippet([
      { id: 'f', label: 'F', type: 'choice', options: ['a', 'b'], separator: ' / ' },
    ]);
    const modal = new SnippetFillInModal(app, snippet);
    modal.onOpen();
    const buttons = (modal as unknown as { contentEl: MockEl }).contentEl
      .querySelectorAll('.rp-snippet-fill-option-row');
    buttons[0]!.dispatchEvent({ type: 'click' });
    buttons[1]!.dispatchEvent({ type: 'click' });
    const confirmBtn = findConfirmButton(
      (modal as unknown as { contentEl: MockEl }).contentEl,
    );
    confirmBtn.dispatchEvent({ type: 'click' });
    const result = await modal.result;
    expect(result).toBe('R: a / b');
    modal.onClose();
  });

  it('preserves array order in joined output (not click order)', async () => {
    const snippet = makeSnippet([
      { id: 'f', label: 'F', type: 'choice', options: ['a', 'b', 'c'] },
    ]);
    const modal = new SnippetFillInModal(app, snippet);
    modal.onOpen();
    const buttons = (modal as unknown as { contentEl: MockEl }).contentEl
      .querySelectorAll('.rp-snippet-fill-option-row');
    // Click order: c, a, b
    buttons[2]!.dispatchEvent({ type: 'click' });
    buttons[0]!.dispatchEvent({ type: 'click' });
    buttons[1]!.dispatchEvent({ type: 'click' });
    const confirmBtn = findConfirmButton(
      (modal as unknown as { contentEl: MockEl }).contentEl,
    );
    confirmBtn.dispatchEvent({ type: 'click' });
    const result = await modal.result;
    expect(result).toBe('R: a, b, c');
    modal.onClose();
  });
});

describe('SnippetFillInModal Phase 52 D-06 — Custom override preserved', () => {
  it('keeps custom text rows collapsed by default behind a compact toggle', () => {
    const snippet = makeSnippet([
      { id: 'f', label: 'F', type: 'choice', options: ['a', 'b'] },
    ]);
    const modal = new SnippetFillInModal(app, snippet);
    modal.onOpen();
    const root = (modal as unknown as { contentEl: MockEl }).contentEl;
    const customRow = root.querySelectorAll('.rp-snippet-modal-custom-row')[0];
    const customToggle = root.querySelectorAll('.rp-snippet-modal-custom-toggle')[0];
    if (!customRow || !customToggle) throw new Error('Custom controls missing');
    // Toggle sits inline right after the option pills; the row opens below the list.
    expect(customToggle.parent!.hasClass('rp-snippet-modal-options')).toBe(true);
    expect(customRow.parent!.tagName).toBe('FIELDSET');
    expect(customRow.getAttribute('hidden')).toBe('true');
    expect(customToggle.getAttribute('aria-expanded')).toBe('false');
    customToggle.dispatchEvent({ type: 'click' });
    expect(customRow.getAttribute('hidden')).toBeNull();
    expect(customToggle.getAttribute('aria-expanded')).toBe('true');
    modal.onClose();
  });

  it('names the Custom field via its visible label, not aria-label (hover-tooltip-free)', () => {
    const snippet = makeSnippet([
      { id: 'f', label: 'F', type: 'choice', options: ['a', 'b'] },
    ]);
    const modal = new SnippetFillInModal(app, snippet);
    modal.onOpen();
    const root = (modal as unknown as { contentEl: MockEl }).contentEl;

    const customInput = walk(root, '.rp-snippet-modal-custom-input')[0];
    if (!customInput) throw new Error('Custom input missing');
    // Obsidian renders any `aria-label` as a hover tooltip over the element —
    // a tooltip over a typing area is exactly the noise this guards against.
    expect(customInput.getAttribute('aria-label')).toBeNull();

    const id = customInput.getAttribute('id');
    expect(id).toBeTruthy();
    const associatedLabel = walk(root, 'label')
      .find((label) => label.getAttribute('for') === id);
    expect(associatedLabel).toBeDefined();
    expect(associatedLabel!._text).toBe('Custom:');
    modal.onClose();
  });

  it('gives every Custom field a distinct label↔field id pair', () => {
    const snippet = makeSnippet([
      { id: 'f', label: 'F', type: 'choice', options: ['a'] },
      { id: 'g', label: 'G', type: 'choice', options: ['b'] },
    ]);
    const modal = new SnippetFillInModal(app, snippet);
    modal.onOpen();
    const root = (modal as unknown as { contentEl: MockEl }).contentEl;

    const ids = walk(root, '.rp-snippet-modal-custom-input')
      .map((input) => input.getAttribute('id'));
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    modal.onClose();
  });

  it('Custom non-empty text overrides options', async () => {
    const snippet = makeSnippet([
      { id: 'f', label: 'F', type: 'choice', options: ['a', 'b'] },
    ]);
    const modal = new SnippetFillInModal(app, snippet);
    modal.onOpen();
    const root = (modal as unknown as { contentEl: MockEl }).contentEl;
    const buttons = root.querySelectorAll('.rp-snippet-fill-option-row');
    buttons[0]!.dispatchEvent({ type: 'click' });
    buttons[1]!.dispatchEvent({ type: 'click' });
    const customInput = root
      .querySelectorAll('.rp-snippet-modal-custom-row')[0]
      ?.querySelectorAll('textarea')[0];
    if (!customInput) throw new Error('Custom input missing');
    (customInput as unknown as { _value: string })._value = 'customX';
    customInput.dispatchEvent({ type: 'input' });
    const confirmBtn = findConfirmButton(root);
    confirmBtn.dispatchEvent({ type: 'click' });
    const result = await modal.result;
    expect(result).toBe('R: customX');
    modal.onClose();
  });

  it('Custom emptied falls back to option values', async () => {
    const snippet = makeSnippet([
      { id: 'f', label: 'F', type: 'choice', options: ['a', 'b'] },
    ]);
    const modal = new SnippetFillInModal(app, snippet);
    modal.onOpen();
    const root = (modal as unknown as { contentEl: MockEl }).contentEl;
    const buttons = root.querySelectorAll('.rp-snippet-fill-option-row');
    buttons[0]!.dispatchEvent({ type: 'click' });
    const customInput = root
      .querySelectorAll('.rp-snippet-modal-custom-row')[0]
      ?.querySelectorAll('textarea')[0];
    if (!customInput) throw new Error('Custom input missing');
    (customInput as unknown as { _value: string })._value = 'override';
    customInput.dispatchEvent({ type: 'input' });
    // Clear Custom
    (customInput as unknown as { _value: string })._value = '';
    customInput.dispatchEvent({ type: 'input' });
    // Re-select the option (Custom listener clears all option selections on non-empty)
    buttons[0]!.dispatchEvent({ type: 'click' });
    const confirmBtn = findConfirmButton(root);
    confirmBtn.dispatchEvent({ type: 'click' });
    const result = await modal.result;
    expect(result).toBe('R: a');
    modal.onClose();
  });
});

describe('SnippetFillInModal Phase 52 — free-text unchanged', () => {
  it('auto-expands the preview textarea as rendered text grows', () => {
    const snippet = makeSnippet(
      [{ id: 'f', label: 'F', type: 'free-text' }],
      'R: {{f}}',
    );
    const modal = new SnippetFillInModal(app, snippet);
    modal.onOpen();
    const root = (modal as unknown as { contentEl: MockEl }).contentEl;
    const preview = root.querySelectorAll('.rp-snippet-preview')[0];
    const textInput = root.querySelectorAll('.rp-snippet-modal-free-text')[0];
    if (!preview || !textInput) throw new Error('Preview or text input missing');
    preview.scrollHeight = 240;
    (textInput as unknown as { _value: string })._value = 'long rendered text';
    textInput.dispatchEvent({ type: 'input' });
    expect(preview.style.height).toBe('240px');
    modal.onClose();
  });

  it('renders an auto-growing textarea for free-text and inserts its value', async () => {
    const snippet = makeSnippet(
      [{ id: 'f', label: 'F', type: 'free-text' }],
      'R: {{f}}',
    );
    const modal = new SnippetFillInModal(app, snippet);
    modal.onOpen();
    const root = (modal as unknown as { contentEl: MockEl }).contentEl;
    const textInput = root.querySelectorAll('.rp-snippet-modal-free-text')[0];
    if (!textInput) throw new Error('Text input missing');
    expect(textInput.tagName).toBe('TEXTAREA');
    expect(textInput.getAttribute('rows')).toBe('1');
    (textInput as unknown as { _value: string })._value = 'hello';
    textInput.dispatchEvent({ type: 'input' });
    const confirmBtn = findConfirmButton(root);
    confirmBtn.dispatchEvent({ type: 'click' });
    const result = await modal.result;
    expect(result).toBe('R: hello');
    modal.onClose();
  });

  it('grows the free-text textarea with its content (runner free-text behavior)', () => {
    const snippet = makeSnippet([{ id: 'f', label: 'F', type: 'free-text' }]);
    const modal = new SnippetFillInModal(app, snippet);
    modal.onOpen();
    const root = (modal as unknown as { contentEl: MockEl }).contentEl;
    const field = root.querySelectorAll('.rp-snippet-modal-free-text')[0];
    if (!field) throw new Error('Free-text field missing');
    field.scrollHeight = 64;
    (field as unknown as { _value: string })._value = 'multi\nline';
    field.dispatchEvent({ type: 'input' });
    expect(field.style.height).toBe('64px');
    modal.onClose();
  });
});

describe('SnippetFillInModal — filled class on text inputs', () => {
  it('adds rp-snippet-field-filled when a free-text input has value', () => {
    const snippet = makeSnippet(
      [{ id: 'f', label: 'F', type: 'free-text' }],
      'R: {{f}}',
    );
    const modal = new SnippetFillInModal(app, snippet);
    modal.onOpen();
    const root = (modal as unknown as { contentEl: MockEl }).contentEl;
    const textInput = root.querySelectorAll('.rp-snippet-modal-free-text')[0];
    if (!textInput) throw new Error('Text input missing');
    expect(textInput.tagName).toBe('TEXTAREA');
    expect(textInput.hasClass('rp-snippet-field-filled')).toBe(false);
    (textInput as unknown as { _value: string })._value = 'hello';
    textInput.dispatchEvent({ type: 'input' });
    expect(textInput.hasClass('rp-snippet-field-filled')).toBe(true);
    // Clear value removes the class
    (textInput as unknown as { _value: string })._value = '';
    textInput.dispatchEvent({ type: 'input' });
    expect(textInput.hasClass('rp-snippet-field-filled')).toBe(false);
    modal.onClose();
  });

  it('adds rp-snippet-field-filled when custom input has value', () => {
    const snippet = makeSnippet([
      { id: 'f', label: 'F', type: 'choice', options: ['a', 'b'] },
    ]);
    const modal = new SnippetFillInModal(app, snippet);
    modal.onOpen();
    const root = (modal as unknown as { contentEl: MockEl }).contentEl;
    const customRow = root.querySelectorAll('.rp-snippet-modal-custom-row')[0];
    if (!customRow) throw new Error('Custom row missing');
    const customInput = customRow.querySelectorAll('textarea')[0];
    if (!customInput) throw new Error('Custom input missing');
    expect(customInput.hasClass('rp-snippet-field-filled')).toBe(false);
    (customInput as unknown as { _value: string })._value = 'custom';
    customInput.dispatchEvent({ type: 'input' });
    expect(customInput.hasClass('rp-snippet-field-filled')).toBe(true);
    // Clear value removes the class
    (customInput as unknown as { _value: string })._value = '';
    customInput.dispatchEvent({ type: 'input' });
    expect(customInput.hasClass('rp-snippet-field-filled')).toBe(false);
    modal.onClose();
  });
});

describe('SnippetFillInModal — toggle button deselect', () => {
  it('clicking a selected button deselects it', async () => {
    const snippet = makeSnippet([
      { id: 'f', label: 'F', type: 'choice', options: ['a', 'b'] },
    ]);
    const modal = new SnippetFillInModal(app, snippet);
    modal.onOpen();
    const root = (modal as unknown as { contentEl: MockEl }).contentEl;
    const buttons = root.querySelectorAll('.rp-snippet-fill-option-row');
    // Select
    buttons[0]!.dispatchEvent({ type: 'click' });
    expect(buttons[0]!.hasClass('is-selected')).toBe(true);
    expect(buttons[0]!.getAttribute('aria-pressed')).toBe('true');
    // Deselect
    buttons[0]!.dispatchEvent({ type: 'click' });
    expect(buttons[0]!.hasClass('is-selected')).toBe(false);
    expect(buttons[0]!.getAttribute('aria-pressed')).toBe('false');
    const confirmBtn = findConfirmButton(root);
    confirmBtn.dispatchEvent({ type: 'click' });
    const result = await modal.result;
    expect(result).toBe('R: ');
    modal.onClose();
  });
});

describe('SnippetFillInModal — wide modal', () => {
  it('adds rp-snippet-fill-modal class to modalEl in onOpen', () => {
    const snippet = makeSnippet([{ id: 'f', label: 'F', type: 'free-text' }]);
    const modal = new SnippetFillInModal(app, snippet);
    modal.onOpen();
    const modalEl = (modal as unknown as { modalEl: MockEl }).modalEl;
    expect(modalEl.hasClass('rp-snippet-fill-modal')).toBe(true);
    modal.onClose();
  });

  it('disables browser spellcheck on free-text and custom textareas', () => {
    const snippet = makeSnippet([
      { id: 'f', label: 'F', type: 'free-text' },
      { id: 'c', label: 'C', type: 'choice', options: ['a', 'b'] },
    ]);
    const modal = new SnippetFillInModal(app, snippet);
    modal.onOpen();
    const root = (modal as unknown as { contentEl: MockEl }).contentEl;
    const textareas = root.querySelectorAll('textarea');
    expect(textareas.length).toBe(2); // free-text + custom override
    for (const textarea of textareas) {
      expect(textarea.getAttribute('spellcheck')).toBe('false');
    }
    modal.onClose();
  });
});

describe('SnippetFillInModal — preview complete highlight', () => {
  it('adds rp-snippet-preview-complete when all free-text placeholders are filled', () => {
    const snippet = makeSnippet(
      [
        { id: 'a', label: 'A', type: 'free-text' },
        { id: 'b', label: 'B', type: 'free-text' },
      ],
      'R: {{a}} / {{b}}',
    );
    const modal = new SnippetFillInModal(app, snippet);
    modal.onOpen();
    const root = (modal as unknown as { contentEl: MockEl }).contentEl;
    const preview = root.querySelectorAll('.rp-snippet-preview')[0];
    if (!preview) throw new Error('Preview missing');
    const textInputs = root.querySelectorAll('.rp-snippet-modal-free-text');
    // Initially not complete
    expect(preview.hasClass('rp-snippet-preview-complete')).toBe(false);
    // Fill first — still incomplete
    (textInputs[0] as unknown as { _value: string })._value = 'hello';
    textInputs[0]!.dispatchEvent({ type: 'input' });
    expect(preview.hasClass('rp-snippet-preview-complete')).toBe(false);
    // Fill second — now complete
    (textInputs[1] as unknown as { _value: string })._value = 'world';
    textInputs[1]!.dispatchEvent({ type: 'input' });
    expect(preview.hasClass('rp-snippet-preview-complete')).toBe(true);
    // Clear one — no longer complete
    (textInputs[0] as unknown as { _value: string })._value = '';
    textInputs[0]!.dispatchEvent({ type: 'input' });
    expect(preview.hasClass('rp-snippet-preview-complete')).toBe(false);
    modal.onClose();
  });

  it('adds rp-snippet-preview-complete when all choice placeholders have selection', () => {
    const snippet = makeSnippet(
      [
        { id: 'x', label: 'X', type: 'choice', options: ['a', 'b'] },
        { id: 'y', label: 'Y', type: 'choice', options: ['c', 'd'] },
      ],
      'R: {{x}} / {{y}}',
    );
    const modal = new SnippetFillInModal(app, snippet);
    modal.onOpen();
    const root = (modal as unknown as { contentEl: MockEl }).contentEl;
    const preview = root.querySelectorAll('.rp-snippet-preview')[0];
    if (!preview) throw new Error('Preview missing');
    // Initially not complete
    expect(preview.hasClass('rp-snippet-preview-complete')).toBe(false);
    // Select first option group — still incomplete
    const allButtons = root.querySelectorAll('.rp-snippet-fill-option-row');
    allButtons[0]!.dispatchEvent({ type: 'click' });
    expect(preview.hasClass('rp-snippet-preview-complete')).toBe(false);
    // Select second option group — now complete
    allButtons[2]!.dispatchEvent({ type: 'click' });
    expect(preview.hasClass('rp-snippet-preview-complete')).toBe(true);
    modal.onClose();
  });
});

describe('SnippetFillInModal — inserted values highlighted in preview', () => {
  /** Collect the preview's child nodes as (text, isValueSpan) pairs. */
  function previewSegments(preview: MockEl): Array<{ text: string; filled: boolean }> {
    return preview.children.map((child) => ({
      text: (child as unknown as { _text: string })._text,
      filled: child.tagName === 'SPAN' && child.hasClass('rp-snippet-preview-value'),
    }));
  }

  function findPreview(root: MockEl): MockEl {
    const preview = root.querySelectorAll('.rp-snippet-preview')[0];
    if (!preview) throw new Error('Preview missing');
    return preview;
  }

  it('renders a div preview (not textarea) so values can carry spans', () => {
    const snippet = makeSnippet([{ id: 'f', label: 'F', type: 'free-text' }]);
    const modal = new SnippetFillInModal(app, snippet);
    modal.onOpen();
    const preview = findPreview((modal as unknown as { contentEl: MockEl }).contentEl);
    expect(preview.tagName).toBe('DIV');
    expect(preview.getAttribute('aria-readonly')).toBe('true');
    modal.onClose();
  });

  it('sets no aria-label on the preview (Obsidian would show it as a hover tooltip)', () => {
    const snippet = makeSnippet([{ id: 'f', label: 'F', type: 'free-text' }]);
    const modal = new SnippetFillInModal(app, snippet);
    modal.onOpen();
    const preview = findPreview((modal as unknown as { contentEl: MockEl }).contentEl);
    expect(preview.getAttribute('aria-label')).toBe(null);
    modal.onClose();
  });

  it('wraps a filled free-text value in rp-snippet-preview-value span', () => {
    const snippet = makeSnippet(
      [{ id: 'f', label: 'F', type: 'free-text' }],
      'R: {{f}} end',
    );
    const modal = new SnippetFillInModal(app, snippet);
    modal.onOpen();
    const root = (modal as unknown as { contentEl: MockEl }).contentEl;
    const preview = findPreview(root);
    // Initially: unfilled {{f}} renders as an empty grey placeholder block
    // (a SPAN without the value class, so previewSegments sees filled: false)
    expect(previewSegments(preview)).toEqual([
      { text: 'R: ', filled: false },
      { text: '', filled: false },
      { text: ' end', filled: false },
    ]);
    const placeholderSpans = preview.querySelectorAll('.rp-snippet-preview-placeholder');
    expect(placeholderSpans.length).toBe(1);
    (root.querySelectorAll('.rp-snippet-modal-free-text')[0] as unknown as { _value: string })._value = 'hello';
    root.querySelectorAll('.rp-snippet-modal-free-text')[0]!.dispatchEvent({ type: 'input' });
    expect(previewSegments(preview)).toEqual([
      { text: 'R: ', filled: false },
      { text: 'hello', filled: true },
      { text: ' end', filled: false },
    ]);
    // Filled value replaced the placeholder block
    expect(preview.querySelectorAll('.rp-snippet-preview-placeholder').length).toBe(0);
    // Clearing the value restores the placeholder block
    (root.querySelectorAll('.rp-snippet-modal-free-text')[0] as unknown as { _value: string })._value = '';
    root.querySelectorAll('.rp-snippet-modal-free-text')[0]!.dispatchEvent({ type: 'input' });
    expect(preview.querySelectorAll('.rp-snippet-preview-placeholder').length).toBe(1);
    // No raw {{id}} token text anywhere in the preview
    const rawText = preview.children
      .filter((c) => c.tagName !== 'SPAN')
      .map((c) => c._text)
      .join('');
    expect(rawText).not.toContain('{{');
    modal.onClose();
  });

  it('renders each unfilled placeholder as a grey block span (no raw token text)', () => {
    const snippet = makeSnippet(
      [
        { id: 'a', label: 'A', type: 'free-text' },
        { id: 'b', label: 'B', type: 'free-text' },
      ],
      'R: {{a}} / {{b}} end',
    );
    const modal = new SnippetFillInModal(app, snippet);
    modal.onOpen();
    const root = (modal as unknown as { contentEl: MockEl }).contentEl;
    const preview = findPreview(root);
    const placeholderSpans = preview.querySelectorAll('.rp-snippet-preview-placeholder');
    expect(placeholderSpans.length).toBe(2);
    for (const span of placeholderSpans) {
      expect(span.tagName).toBe('SPAN');
      expect(span._text).toBe('');
      // No raw token text and no tooltip attributes (hover-noise policy)
      expect(span.getAttribute('title')).toBe(null);
      expect(span.getAttribute('aria-label')).toBe(null);
    }
    const rawText = preview.children
      .filter((c) => c.tagName !== 'SPAN')
      .map((c) => c._text)
      .join('');
    expect(rawText).toBe('R:  /  end');
    modal.onClose();
  });

  it('renders Cyrillic placeholder ids as grey blocks too (matches validator shape)', () => {
    const snippet = makeSnippet(
      [{ id: 'возраст', label: 'Возраст', type: 'free-text' }],
      'Возраст: {{возраст}} лет',
    );
    const modal = new SnippetFillInModal(app, snippet);
    modal.onOpen();
    const root = (modal as unknown as { contentEl: MockEl }).contentEl;
    const preview = findPreview(root);
    const placeholderSpans = preview.querySelectorAll('.rp-snippet-preview-placeholder');
    expect(placeholderSpans.length).toBe(1);
    const rawText = preview.children
      .filter((c) => c.tagName !== 'SPAN')
      .map((c) => c._text)
      .join('');
    expect(rawText).toBe('Возраст:  лет');
    expect(rawText).not.toContain('{{');
    modal.onClose();
  });

  it('CSS styles the placeholder blocks (grey block tripwire)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const cssPath = require.resolve('../../styles/snippet-fill-modal.css');
    const css = readFileSync(cssPath, 'utf8');
    expect(css).toContain('.rp-snippet-preview-placeholder');
  });

  it('wraps choice selections and custom override values in value spans', () => {
    const snippet = makeSnippet(
      [
        { id: 'c', label: 'C', type: 'choice', options: ['a', 'b'] },
        { id: 'd', label: 'D', type: 'choice', options: ['x', 'y'] },
      ],
      'R: {{c}} / {{d}}',
    );
    const modal = new SnippetFillInModal(app, snippet);
    modal.onOpen();
    const root = (modal as unknown as { contentEl: MockEl }).contentEl;
    const preview = findPreview(root);
    const buttons = root.querySelectorAll('.rp-snippet-fill-option-row');
    buttons[0]!.dispatchEvent({ type: 'click' }); // select 'a'
    // Custom override on the SECOND choice (first custom row belongs to C)
    const customRows = root.querySelectorAll('.rp-snippet-modal-custom-row');
    const customInput = customRows[1]!.querySelectorAll('textarea')[0];
    if (!customInput) throw new Error('Custom input missing');
    (customInput as unknown as { _value: string })._value = 'my custom';
    customInput.dispatchEvent({ type: 'input' });
    const segments = previewSegments(preview);
    expect(segments.filter((s) => s.filled).map((s) => s.text)).toEqual(['a', 'my custom']);
    expect(previewSegments(preview).map((s) => s.text).join('')).toBe('R: a / my custom');
    modal.onClose();
  });

  it('keeps multi-line rendered text intact in the preview', () => {
    const snippet = makeSnippet(
      [{ id: 'f', label: 'F', type: 'free-text' }],
      'Line1: {{f}}\nLine2',
    );
    const modal = new SnippetFillInModal(app, snippet);
    modal.onOpen();
    const root = (modal as unknown as { contentEl: MockEl }).contentEl;
    const preview = findPreview(root);
    const textInput = root.querySelectorAll('.rp-snippet-modal-free-text')[0];
    (textInput as unknown as { _value: string })._value = 'v1';
    textInput!.dispatchEvent({ type: 'input' });
    expect(previewSegments(preview).map((s) => s.text).join('')).toBe('Line1: v1\nLine2');
    modal.onClose();
  });

  it('renders unfilled placeholders above a filled one as grey blocks (fill-bottom-first regression)', () => {
    // Filling the LAST placeholder must not corrupt the preview of the
    // UNFILLED placeholders ABOVE it: the old sequential-slice builder put
    // everything left of the filled token into a static prefix, leaking raw
    // {{id}} text into the preview.
    const snippet = makeSnippet(
      [
        { id: 'top', label: 'Top', type: 'free-text' },
        { id: 'mid', label: 'Mid', type: 'free-text' },
        { id: 'bottom', label: 'Bottom', type: 'free-text' },
      ],
      'A: {{top}}\nB: {{mid}}\nC: {{bottom}}',
    );
    const modal = new SnippetFillInModal(app, snippet);
    modal.onOpen();
    const root = (modal as unknown as { contentEl: MockEl }).contentEl;
    const preview = findPreview(root);
    const inputs = root.querySelectorAll('.rp-snippet-modal-free-text');
    // Fill ONLY the bottom (last) field
    (inputs[2] as unknown as { _value: string })._value = 'низ';
    inputs[2]!.dispatchEvent({ type: 'input' });
    expect(previewSegments(preview)).toEqual([
      { text: 'A: ', filled: false },
      { text: '', filled: false }, // grey block for {{top}}
      { text: '\nB: ', filled: false },
      { text: '', filled: false }, // grey block for {{mid}}
      { text: '\nC: ', filled: false },
      { text: 'низ', filled: true },
    ]);
    expect(preview.querySelectorAll('.rp-snippet-preview-placeholder').length).toBe(2);
    // Raw tokens must never leak into static text
    const rawText = preview.children
      .filter((c) => c.tagName !== 'SPAN')
      .map((c) => c._text)
      .join('');
    expect(rawText).not.toContain('{{');
    modal.onClose();
  });

  it('renders choice values when chip order differs from template token order', () => {
    // The template has b BEFORE a, but the chips (placeholders array) list
    // a first. Choice value for 'b' must still appear in the preview — the
    // old sequential-slice builder searched for {{b}} in the leftover string
    // after {{a}} was consumed and silently dropped it.
    const snippet = makeSnippet(
      [
        { id: 'a', label: 'A', type: 'choice', options: ['x', 'y'] },
        { id: 'b', label: 'B', type: 'choice', options: ['p', 'q'] },
      ],
      'B is {{b}}, A is {{a}}',
    );
    const modal = new SnippetFillInModal(app, snippet);
    modal.onOpen();
    const root = (modal as unknown as { contentEl: MockEl }).contentEl;
    const preview = findPreview(root);
    const buttons = root.querySelectorAll('.rp-snippet-fill-option-row');
    // Field A renders first: options x, y → select 'y'
    buttons[1]!.dispatchEvent({ type: 'click' });
    // Field B renders second: options p, q → select 'q'
    buttons[3]!.dispatchEvent({ type: 'click' });
    expect(previewSegments(preview).map((s) => s.text).join('')).toBe('B is q, A is y');
    // Filled values: 'q' (B) then 'y' (A), in template order
    expect(previewSegments(preview).filter((s) => s.filled).map((s) => s.text)).toEqual(['q', 'y']);
    expect(preview.querySelectorAll('.rp-snippet-preview-placeholder').length).toBe(0);
    modal.onClose();
  });

  it('CSS keeps the completed highlight on :hover (hover-parity tripwire)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const cssPath = require.resolve('../../styles/snippet-fill-modal.css');
    const css = readFileSync(cssPath, 'utf8');
    expect(css).toMatch(/\.rp-snippet-preview\.rp-snippet-preview-complete:hover/);
    expect(css).toContain('.rp-snippet-preview-value');
  });

  it('CSS keeps the filled-field highlight on input :hover (hover-parity tripwire)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const cssPath = require.resolve('../../styles/snippet-fill-modal.css');
    const css = readFileSync(cssPath, 'utf8');
    expect(css).toMatch(/\.rp-snippet-modal-free-text\.rp-snippet-field-filled:hover/);
    expect(css).toMatch(/\.rp-snippet-modal-custom-input\.rp-snippet-field-filled:hover/);
  });

  it('CSS suppresses the host textarea hover repaint on both fill-in fields (tripwire)', () => {
    // Obsidian's `textarea:not(:disabled):hover` repaints any textarea using
    // these two variables; pinning them on the fields keeps the resting look
    // on pointer-over (free-text field and the ✎ Custom value field).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const cssPath = require.resolve('../../styles/snippet-fill-modal.css');
    const css = readFileSync(cssPath, 'utf8');
    const pinnedBlock = css.match(
      /\.rp-snippet-modal-free-text,\s*\.rp-snippet-modal-custom-input\s*\{[^}]*--background-modifier-form-field-hover[^}]*\}/,
    );
    expect(pinnedBlock?.[0]).toContain('--background-modifier-form-field-hover: var(--background-primary)');
    expect(pinnedBlock?.[0]).toContain('--background-modifier-border-hover: var(--background-modifier-border)');
  });

  it('dims the workspace backdrop while the modal is open', () => {
    const snippet = makeSnippet(
      [{ id: 'f', label: 'F', type: 'free-text' }],
      'X: {{f}}',
    );
    const modal = new SnippetFillInModal(app, snippet);
    modal.onOpen();
    const containerEl = (modal as unknown as { containerEl: MockEl }).containerEl;
    expect(containerEl.hasClass('rp-snippet-fill-modal-backdrop')).toBe(true);
    modal.onClose();
  });

  it('CSS targets the backdrop cover class (full-cover tripwire)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const cssPath = require.resolve('../../styles/snippet-fill-modal.css');
    const css = readFileSync(cssPath, 'utf8');
    expect(css).toContain('.rp-snippet-fill-modal-backdrop .modal-bg');
  });
});

// =========================================================================
// Shift+Enter confirm hotkey
// =========================================================================

/**
 * Simulate a keydown that BUBBLED from a field up to contentEl.
 * MockEl.dispatchEvent has no bubbling, so dispatch on the root with the
 * target overridden to the originating field (same pattern as
 * snippet-tree-picker.test.ts's triggerBubbledKeydown).
 */
function triggerBubbledKeydown(
  root: MockEl,
  field: MockEl,
  key: string,
  mods: { ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean; shiftKey?: boolean } = {},
): { preventDefault: ReturnType<typeof vi.fn> } {
  const preventDefault = vi.fn();
  root.dispatchEvent({
    type: 'keydown',
    key,
    code: '',
    target: field,
    ctrlKey: !!mods.ctrlKey,
    altKey: !!mods.altKey,
    metaKey: !!mods.metaKey,
    shiftKey: !!mods.shiftKey,
    preventDefault,
  } as unknown as { type: string; target?: MockEl });
  return { preventDefault };
}

function openModalWithFreeText(template = 'R: {{f}}'): {
  modal: SnippetFillInModal;
  root: MockEl;
  field: MockEl;
} {
  const snippet = makeSnippet([{ id: 'f', label: 'F', type: 'free-text' }], template);
  const modal = new SnippetFillInModal(app, snippet);
  modal.onOpen();
  const root = (modal as unknown as { contentEl: MockEl }).contentEl;
  const field = root.querySelectorAll('.rp-snippet-modal-free-text')[0];
  if (!field) throw new Error('Free-text field missing');
  return { modal, root, field };
}

describe('SnippetFillInModal — Shift+Enter confirms', () => {
  it('resolves with the rendered snippet when Shift+Enter bubbles from a free-text field', async () => {
    const { modal, root, field } = openModalWithFreeText();
    (field as unknown as { _value: string })._value = 'text';
    field.dispatchEvent({ type: 'input' });

    const { preventDefault } = triggerBubbledKeydown(root, field, 'Enter', { shiftKey: true });

    // preventDefault keeps the textarea from also inserting a newline
    expect(preventDefault).toHaveBeenCalled();
    expect((modal as unknown as { resolved: boolean }).resolved).toBe(true);
    expect(await modal.result).toBe('R: text');
  });

  it('ignores plain Enter so the field keeps its newline behaviour', async () => {
    const { modal, root, field } = openModalWithFreeText();
    (field as unknown as { _value: string })._value = 'text';
    field.dispatchEvent({ type: 'input' });

    const { preventDefault } = triggerBubbledKeydown(root, field, 'Enter');

    expect(preventDefault).not.toHaveBeenCalled();
    expect((modal as unknown as { resolved: boolean }).resolved).toBe(false);
    // Closing without confirming still resolves null (the modal was not confirmed)
    modal.onClose();
    expect(await modal.result).toBeNull();
  });

  it('ignores Shift with a non-Enter key', async () => {
    const { modal, root, field } = openModalWithFreeText();
    const { preventDefault } = triggerBubbledKeydown(root, field, 'Tab', { shiftKey: true });
    expect(preventDefault).not.toHaveBeenCalled();
    expect((modal as unknown as { resolved: boolean }).resolved).toBe(false);
    modal.onClose();
  });

  it('confirms with unfilled placeholders rendered empty — same as the Confirm button', async () => {
    const { modal, root, field } = openModalWithFreeText();
    triggerBubbledKeydown(root, field, 'Enter', { shiftKey: true });
    expect(await modal.result).toBe('R: ');
  });

  it('confirms from a choice Custom override input', async () => {
    const snippet = makeSnippet(
      [{ id: 'f', label: 'F', type: 'choice', options: ['a', 'b'] }],
      'R: {{f}}',
    );
    const modal = new SnippetFillInModal(app, snippet);
    modal.onOpen();
    const root = (modal as unknown as { contentEl: MockEl }).contentEl;
    const toggle = root.querySelectorAll('.rp-snippet-modal-custom-toggle')[0];
    if (!toggle) throw new Error('Custom toggle missing');
    toggle.dispatchEvent({ type: 'click' });
    const customRow = root.querySelectorAll('.rp-snippet-modal-custom-row')[0];
    if (!customRow) throw new Error('Custom row missing');
    const customInput = customRow.querySelectorAll('textarea')[0];
    if (!customInput) throw new Error('Custom input missing');
    (customInput as unknown as { _value: string })._value = 'custom-val';
    customInput.dispatchEvent({ type: 'input' });

    triggerBubbledKeydown(root, customInput, 'Enter', { shiftKey: true });

    expect(await modal.result).toBe('R: custom-val');
  });

  it('removes the keydown listener on close', async () => {
    const { modal, root } = openModalWithFreeText();
    expect((root._listeners.get('keydown') ?? []).length).toBe(1);
    modal.onClose();
    expect((root._listeners.get('keydown') ?? []).length).toBe(0);
    expect(await modal.result).toBeNull();
  });
});

// =========================================================================
// Ctrl+Space confirm, autofocus, roving tabindex, digit toggles (3.6.19)
// =========================================================================

/** Dispatch a keydown on `host` with `target` overridden (MockEl has no bubbling). */
function dispatchKeydownOn(
  host: MockEl,
  target: MockEl,
  key: string,
  mods: {
    code?: string;
    ctrlKey?: boolean;
    altKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
    isComposing?: boolean;
  } = {},
): { preventDefault: ReturnType<typeof vi.fn> } {
  const preventDefault = vi.fn();
  host.dispatchEvent({
    type: 'keydown',
    key,
    code: mods.code ?? '',
    target,
    ctrlKey: !!mods.ctrlKey,
    altKey: !!mods.altKey,
    metaKey: !!mods.metaKey,
    shiftKey: !!mods.shiftKey,
    isComposing: !!mods.isComposing,
    preventDefault,
  } as unknown as { type: string; target?: MockEl });
  return { preventDefault };
}

function openModalWithChoice(options: string[] = ['A', 'B', 'C']): {
  modal: SnippetFillInModal;
  root: MockEl;
  options: MockEl[];
  toggle: MockEl;
  customInput: MockEl;
} {
  const snippet = makeSnippet(
    [{ id: 'c', label: 'C', type: 'choice', options }],
    'R: {{c}}',
  );
  const modal = new SnippetFillInModal(app, snippet);
  modal.onOpen();
  const root = (modal as unknown as { contentEl: MockEl }).contentEl;
  const buttons = root.querySelectorAll('.rp-snippet-fill-option-row');
  const toggle = root.querySelector('.rp-snippet-modal-custom-toggle');
  const customInput = root.querySelector('.rp-snippet-modal-custom-input');
  if (!toggle || !customInput) throw new Error('choice field incomplete');
  return { modal, root, options: buttons, toggle, customInput };
}

describe('SnippetFillInModal — Ctrl+Space confirms', () => {
  it('confirms from a free-text field and blocks the character', async () => {
    const { modal, root, field } = openModalWithFreeText();
    (field as unknown as { _value: string })._value = 'text';
    field.dispatchEvent({ type: 'input' });

    const { preventDefault } = dispatchKeydownOn(root, field, ' ', {
      code: 'Space',
      ctrlKey: true,
    });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(await modal.result).toBe('R: text');
  });

  it('confirms from a choice group', async () => {
    const { modal, root, options } = openModalWithChoice();
    options[0]!.dispatchEvent({ type: 'click' });

    const { preventDefault } = dispatchKeydownOn(root, options[0]!, ' ', {
      code: 'Space',
      ctrlKey: true,
    });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(await modal.result).toBe('R: A');
  });

  it('confirms from the expanded Custom override', async () => {
    const { modal, root, toggle, customInput } = openModalWithChoice();
    toggle.dispatchEvent({ type: 'click' });
    (customInput as unknown as { _value: string })._value = 'custom value';
    customInput.dispatchEvent({ type: 'input' });

    dispatchKeydownOn(root, customInput, ' ', { code: 'Space', ctrlKey: true });

    expect(await modal.result).toBe('R: custom value');
  });

  it('ignores the chord during IME composition', () => {
    const { modal, root, field } = openModalWithFreeText();
    const { preventDefault } = dispatchKeydownOn(root, field, ' ', {
      code: 'Space',
      ctrlKey: true,
      isComposing: true,
    });

    expect(preventDefault).not.toHaveBeenCalled();
    expect((modal as unknown as { resolved: boolean }).resolved).toBe(false);
  });

  it('does not treat plain Space or Ctrl+Alt+Space as confirm', () => {
    const { modal, root, field } = openModalWithFreeText();

    expect(dispatchKeydownOn(root, field, ' ', { code: 'Space' }).preventDefault)
      .not.toHaveBeenCalled();
    expect(dispatchKeydownOn(root, field, ' ', { code: 'Space', ctrlKey: true, altKey: true }).preventDefault)
      .not.toHaveBeenCalled();
    expect(dispatchKeydownOn(root, field, ' ', { code: 'Space', ctrlKey: true, metaKey: true }).preventDefault)
      .not.toHaveBeenCalled();
    expect((modal as unknown as { resolved: boolean }).resolved).toBe(false);
  });
});

describe('SnippetFillInModal — first field focus on open', () => {
  it('focuses the first free-text field instead of the modal container', () => {
    const { field } = openModalWithFreeText();
    expect(field.focusCount).toBeGreaterThanOrEqual(1);
  });

  it('focuses the first option of a choice field', () => {
    const { options } = openModalWithChoice();
    expect(options[0]!.focusCount).toBeGreaterThanOrEqual(1);
    expect(options[1]!.focusCount).toBe(0);
  });
});

describe('SnippetFillInModal — roving tabindex in a choice group', () => {
  it('keeps one Tab stop per group and moves it with the arrows', () => {
    const { root, options, toggle } = openModalWithChoice();
    const fieldset = root.querySelector('fieldset')!;

    expect(options[0]!.getAttribute('tabindex')).toBe('0');
    expect(options[1]!.getAttribute('tabindex')).toBe('-1');
    expect(options[2]!.getAttribute('tabindex')).toBe('-1');
    expect(toggle.getAttribute('tabindex')).toBe('-1');

    const right = dispatchKeydownOn(fieldset, options[0]!, 'ArrowRight', { code: 'ArrowRight' });
    expect(right.preventDefault).toHaveBeenCalledTimes(1);
    expect(options[1]!.getAttribute('tabindex')).toBe('0');
    expect(options[0]!.getAttribute('tabindex')).toBe('-1');

    // Down behaves like Right; the ✎ toggle sits after the last option.
    dispatchKeydownOn(fieldset, options[2]!, 'ArrowDown', { code: 'ArrowDown' });
    expect(toggle.getAttribute('tabindex')).toBe('0');
    expect(toggle.focusCount).toBeGreaterThanOrEqual(1);

    // Left from the first option wraps backwards onto the toggle.
    dispatchKeydownOn(fieldset, options[0]!, 'ArrowLeft', { code: 'ArrowLeft' });
    expect(toggle.getAttribute('tabindex')).toBe('0');

    // Tab always leaves the group and is never intercepted.
    const tab = dispatchKeydownOn(fieldset, toggle, 'Tab', { code: 'Tab' });
    expect(tab.preventDefault).not.toHaveBeenCalled();
  });
});

describe('SnippetFillInModal — numeric option toggles', () => {
  it('toggles the Nth option from inside the group and keeps ARIA in sync', () => {
    const { root, options } = openModalWithChoice();
    const fieldset = root.querySelector('fieldset')!;

    const { preventDefault } = dispatchKeydownOn(fieldset, options[0]!, '2', { code: 'Digit2' });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(options[1]!.getAttribute('aria-pressed')).toBe('true');
    expect(options[1]!.hasClass('is-selected')).toBe(true);
    expect(options[0]!.getAttribute('aria-pressed')).toBe('false');
    // The roving Tab stop follows the toggled option.
    expect(options[1]!.getAttribute('tabindex')).toBe('0');
  });

  it('toggles the same option back off on a second press', () => {
    const { root, options } = openModalWithChoice();
    const fieldset = root.querySelector('fieldset')!;

    dispatchKeydownOn(fieldset, options[0]!, '2', { code: 'Digit2' });
    dispatchKeydownOn(fieldset, options[0]!, '2', { code: 'Digit2' });

    expect(options[1]!.getAttribute('aria-pressed')).toBe('false');
    expect(options[1]!.hasClass('is-selected')).toBe(false);
  });

  it('ignores digits typed into the Custom override', () => {
    const { root, options, toggle, customInput } = openModalWithChoice();
    toggle.dispatchEvent({ type: 'click' });
    const fieldset = root.querySelector('fieldset')!;

    const { preventDefault } = dispatchKeydownOn(fieldset, customInput, '1', { code: 'Digit1' });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(options[0]!.getAttribute('aria-pressed')).toBe('false');
  });

  it('ignores digits beyond the option count', () => {
    const { root, options } = openModalWithChoice();
    const fieldset = root.querySelector('fieldset')!;

    const { preventDefault } = dispatchKeydownOn(fieldset, options[0]!, '9', { code: 'Digit9' });

    expect(preventDefault).not.toHaveBeenCalled();
  });
});

describe('SnippetFillInModal — visible digit badges on choice options', () => {
  it('numbers the first nine options and stops there', () => {
    const ten = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
    const { options } = openModalWithChoice(ten);

    expect(options).toHaveLength(10);
    expect(options.slice(0, 9).map((btn) => btn.getAttribute('data-rp-key')))
      .toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
    expect(options[0]!.getAttribute('aria-keyshortcuts')).toBe('1');
    // The keymap only accepts 1-9, so later pills stay unnumbered.
    expect(options[9]!.getAttribute('data-rp-key')).toBeNull();
    expect(options[9]!.getAttribute('aria-keyshortcuts')).toBeNull();
  });

  it('keeps the badge in sync with what the digit actually toggles', () => {
    const { root, options } = openModalWithChoice(['A', 'B', 'C']);
    const fieldset = root.querySelector('fieldset')!;

    const shown = options[2]!.getAttribute('data-rp-key');
    expect(shown).toBe('3');
    dispatchKeydownOn(fieldset, options[0]!, shown!, { code: `Digit${shown}` });

    expect(options[2]!.getAttribute('aria-pressed')).toBe('true');
  });
});
