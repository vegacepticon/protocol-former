import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetTextExpansionConfig, setTextExpansionConfig } from '../../expansion/config';
import {
  attachTextExpansion,
  expandHotkeyPhrase,
  isTextExpansionTextarea,
} from '../../expansion/textarea';
import type { ExpansionRule } from '../../expansion/rules';

const AUTO_RULES: ExpansionRule[] = [
  { trigger: '-->', replacement: '→', mode: 'auto' },
  { trigger: ';sig', replacement: 'Roman$nl$Dev$end$', mode: 'auto' },
];

const HOTKEY_RULES: ExpansionRule[] = [
  { trigger: ';plan', replacement: 'Plan$nl$findings', mode: 'hotkey' },
  { trigger: '-->', replacement: '→', mode: 'hotkey' },
];

/**
 * Minimal textarea stand-in: value + selection + listeners + the same
 * post-input state a browser produces. Node has no DOM, and the adapter only
 * needs this surface.
 */
class FakeTextarea {
  value = '';
  selectionStart: number | null = 0;
  selectionEnd: number | null = 0;
  private readonly listeners = new Map<string, Set<(event: { type: string }) => void>>();

  addEventListener(type: string, handler: (event: { type: string }) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(handler);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, handler: (event: { type: string }) => void): void {
    this.listeners.get(type)?.delete(handler);
  }

  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
  }

  dispatchEvent(event: { type: string }): boolean {
    for (const handler of [...(this.listeners.get(event.type) ?? [])]) handler(event);
    return true;
  }

  focus(): void {}

  /** Simulates typing `text` at the caret plus the browser's `input` event. */
  type(text: string, options: { inputType?: string; isComposing?: boolean } = {}): void {
    const start = this.selectionStart ?? 0;
    this.value = this.value.slice(0, start) + text + this.value.slice(start);
    const caret = start + text.length;
    this.selectionStart = caret;
    this.selectionEnd = caret;
    this.dispatchEvent({
      type: 'input',
      inputType: options.inputType ?? 'insertText',
      isComposing: options.isComposing ?? false,
    } as unknown as { type: string });
  }
}

function attach(textarea: FakeTextarea): () => void {
  return attachTextExpansion(textarea as unknown as HTMLTextAreaElement);
}

function expand(textarea: FakeTextarea, rules: ExpansionRule[] = HOTKEY_RULES): boolean {
  return expandHotkeyPhrase(textarea as unknown as HTMLTextAreaElement, rules);
}

beforeEach(() => {
  resetTextExpansionConfig();
});

afterEach(() => {
  resetTextExpansionConfig();
});

describe('textarea expansion — auto mode', () => {
  beforeEach(() => {
    setTextExpansionConfig({ enabled: true, autoRules: AUTO_RULES });
  });

  it('replaces as soon as the trigger is typed and keeps the value in place', () => {
    const textarea = new FakeTextarea();
    attach(textarea);
    textarea.type('h');
    textarea.type('i');
    textarea.type(' ');
    textarea.type('-');
    textarea.type('-');
    textarea.type('>');

    expect(textarea.value).toBe('hi →');
    expect(textarea.selectionStart).toBe(4);
  });

  it('resolves $nl$ and $end$ hints', () => {
    const textarea = new FakeTextarea();
    attach(textarea);
    textarea.type(';sig');

    expect(textarea.value).toBe('Roman\nDev');
    expect(textarea.selectionStart).toBe(9);
  });

  it('does not rewrite pasted text', () => {
    const textarea = new FakeTextarea();
    attach(textarea);
    textarea.type('-->', { inputType: 'insertFromPaste' });
    expect(textarea.value).toBe('-->');
  });

  it('ignores IME composition input', () => {
    const textarea = new FakeTextarea();
    attach(textarea);
    textarea.type('-->', { isComposing: true });
    expect(textarea.value).toBe('-->');
  });

  it('notifies the owning component through a single input event', () => {
    const textarea = new FakeTextarea();
    const seen: string[] = [];
    textarea.addEventListener('input', () => seen.push(textarea.value));
    attach(textarea);
    textarea.type('-->');

    expect(seen[0]).toBe('-->');
    expect(seen[seen.length - 1]).toBe('→');
  });

  it('never re-expands its own replacement (no feedback loop)', () => {
    setTextExpansionConfig({ enabled: true, autoRules: [{ trigger: 'x', replacement: 'xx', mode: 'auto' }] });
    const textarea = new FakeTextarea();
    attach(textarea);
    textarea.type('x');
    expect(textarea.value).toBe('xx');
  });

  it('stays inert when the feature is disabled', () => {
    setTextExpansionConfig({ enabled: false, autoRules: AUTO_RULES });
    const textarea = new FakeTextarea();
    attach(textarea);
    textarea.type('-->');
    expect(textarea.value).toBe('-->');
  });

  it('does not expand hotkey phrases while typing', () => {
    setTextExpansionConfig({ enabled: true, autoRules: [], hotkeyRules: HOTKEY_RULES });
    const textarea = new FakeTextarea();
    attach(textarea);
    textarea.type('-->');
    expect(textarea.value).toBe('-->');
  });
});

describe('textarea expansion — hotkey insertion', () => {
  beforeEach(() => {
    setTextExpansionConfig({ enabled: true, autoRules: AUTO_RULES });
  });

  it('replaces the word before the caret and resolves markers', () => {
    const textarea = new FakeTextarea();
    attach(textarea);
    textarea.type(';plan');

    expect(expand(textarea)).toBe(true);
    expect(textarea.value).toBe('Plan\nfindings');
    expect(textarea.selectionStart).toBe(13);
  });

  it('replaces only the word at the caret', () => {
    const textarea = new FakeTextarea();
    attach(textarea);
    textarea.type('first ;plan');

    expect(expand(textarea)).toBe(true);
    expect(textarea.value).toBe('first Plan\nfindings');
  });

  it('leaves an unknown word untouched', () => {
    const textarea = new FakeTextarea();
    attach(textarea);
    textarea.type('unknown');

    expect(expand(textarea)).toBe(false);
    expect(textarea.value).toBe('unknown');
  });

  it('does nothing when the caret is inside a selection', () => {
    const textarea = new FakeTextarea();
    attach(textarea);
    textarea.type(';plan');
    textarea.setSelectionRange(1, 4);

    expect(expand(textarea)).toBe(false);
    expect(textarea.value).toBe(';plan');
  });

  it('does not re-run auto expansion on its own synthetic input', () => {
    // The hotkey replacement ends with a trigger that auto mode would match.
    setTextExpansionConfig({ enabled: true, autoRules: AUTO_RULES });
    const textarea = new FakeTextarea();
    attach(textarea);
    textarea.type(';arrow');

    expect(expand(textarea, [{ trigger: ';arrow', replacement: '-->', mode: 'hotkey' }])).toBe(true);
    expect(textarea.value).toBe('-->');
  });

  it('does not fire with an empty rule list', () => {
    const textarea = new FakeTextarea();
    attach(textarea);
    textarea.type(';plan');
    expect(expand(textarea, [])).toBe(false);
    expect(textarea.value).toBe(';plan');
  });
});

describe('textarea expansion — attach ownership', () => {
  it('marks an attached field and forgets it on detach', () => {
    const textarea = new FakeTextarea();
    const el = textarea as unknown as HTMLTextAreaElement;
    expect(isTextExpansionTextarea(el)).toBe(false);

    const detach = attach(textarea);
    expect(isTextExpansionTextarea(el)).toBe(true);

    detach();
    expect(isTextExpansionTextarea(el)).toBe(false);
  });

  it('removes the input listener on detach', () => {
    setTextExpansionConfig({ enabled: true, autoRules: AUTO_RULES });
    const textarea = new FakeTextarea();
    const detach = attach(textarea);
    detach();

    textarea.type('-->');
    expect(textarea.value).toBe('-->');
  });
});
