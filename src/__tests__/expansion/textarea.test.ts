import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetTextExpansionConfig, setTextExpansionConfig } from '../../expansion/config';
import { attachTextExpansion } from '../../expansion/textarea';
import type { ExpansionRule } from '../../expansion/rules';

const RULES: ExpansionRule[] = [
  { trigger: '-->', replacement: '→' },
  { trigger: ';sig', replacement: 'Roman$nl$Dev$end$' },
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

  /** Simulates a Space press: the delimiter is consumed only when handled. */
  pressSpace(): { prevented: boolean } {
    let prevented = false;
    this.dispatchEvent({
      type: 'keydown',
      key: ' ',
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      isComposing: false,
      preventDefault: () => { prevented = true; },
    } as unknown as { type: string });

    if (!prevented) {
      const start = this.selectionStart ?? 0;
      this.value = this.value.slice(0, start) + ' ' + this.value.slice(start);
      this.selectionStart = start + 1;
      this.selectionEnd = this.selectionStart;
      this.dispatchEvent({ type: 'input', inputType: 'insertText' } as unknown as { type: string });
    }
    return { prevented };
  }
}

function attach(textarea: FakeTextarea): () => void {
  return attachTextExpansion(textarea as unknown as HTMLTextAreaElement);
}

beforeEach(() => {
  resetTextExpansionConfig();
});

afterEach(() => {
  resetTextExpansionConfig();
});

describe('textarea expansion — auto mode', () => {
  beforeEach(() => {
    setTextExpansionConfig({ enabled: true, mode: 'auto', rules: RULES });
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
    setTextExpansionConfig({ enabled: true, mode: 'auto', rules: [{ trigger: 'x', replacement: 'xx' }] });
    const textarea = new FakeTextarea();
    attach(textarea);
    textarea.type('x');
    expect(textarea.value).toBe('xx');
  });

  it('stays inert when the feature is disabled', () => {
    setTextExpansionConfig({ enabled: false, mode: 'auto', rules: RULES });
    const textarea = new FakeTextarea();
    attach(textarea);
    textarea.type('-->');
    expect(textarea.value).toBe('-->');
  });

  it('does nothing on Space in auto mode', () => {
    const textarea = new FakeTextarea();
    attach(textarea);
    textarea.type(';sig2');
    const { prevented } = textarea.pressSpace();
    expect(prevented).toBe(false);
    expect(textarea.value).toBe(';sig2 ');
  });
});

describe('textarea expansion — delimiter mode', () => {
  beforeEach(() => {
    setTextExpansionConfig({ enabled: true, mode: 'delimiter', rules: RULES });
  });

  it('expands a whole word on Space and consumes the delimiter', () => {
    const textarea = new FakeTextarea();
    attach(textarea);
    textarea.type(';sig');
    const { prevented } = textarea.pressSpace();

    expect(prevented).toBe(true);
    expect(textarea.value).toBe('Roman\nDev');
    expect(textarea.selectionStart).toBe(9);
  });

  it('leaves an unknown word and the space untouched', () => {
    const textarea = new FakeTextarea();
    attach(textarea);
    textarea.type('hello');
    const { prevented } = textarea.pressSpace();

    expect(prevented).toBe(false);
    expect(textarea.value).toBe('hello ');
  });

  it('expands after a newline and after other words', () => {
    const textarea = new FakeTextarea();
    attach(textarea);
    textarea.type('first line');
    textarea.type('\n');
    textarea.type(';sig');
    textarea.pressSpace();

    expect(textarea.value).toBe('first line\nRoman\nDev');
  });

  it('stays inert when the feature is disabled', () => {
    setTextExpansionConfig({ enabled: false, mode: 'delimiter', rules: RULES });
    const textarea = new FakeTextarea();
    attach(textarea);
    textarea.type(';sig');
    const { prevented } = textarea.pressSpace();

    expect(prevented).toBe(false);
    expect(textarea.value).toBe(';sig ');
  });
});

describe('textarea expansion — detach', () => {
  it('removes both listeners', () => {
    setTextExpansionConfig({ enabled: true, mode: 'auto', rules: RULES });
    const textarea = new FakeTextarea();
    const detach = attach(textarea);
    detach();

    textarea.type('-->');
    expect(textarea.value).toBe('-->');
  });
});
