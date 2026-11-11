import { describe, expect, it, vi } from 'vitest';
import type { Editor } from 'obsidian';
import { expandHotkeyPhraseInEditor } from '../../expansion/editor';
import type { ExpansionRule } from '../../expansion/rules';

const RULES: ExpansionRule[] = [
  { trigger: ';plan', replacement: 'Plan$nl$findings', mode: 'hotkey' },
  { trigger: ';short', replacement: 'Short', mode: 'hotkey' },
];

/** Single-line Editor stand-in for the hotkey command's editor path. */
function makeEditor(text: string): {
  editor: Editor;
  text: () => string;
  cursorOffset: () => number;
} {
  let value = text;
  let cursor = text.length;

  const editor = {
    getCursor: () => ({ line: 0, ch: cursor }),
    getLine: () => value,
    getSelection: () => '',
    posToOffset: (pos: { line: number; ch: number }) => pos.ch,
    offsetToPos: (offset: number) => ({ line: 0, ch: offset }),
    replaceRange: (replacement: string, from: { ch: number }, to: { ch: number }) => {
      value = value.slice(0, from.ch) + replacement + value.slice(to.ch);
    },
    setCursor: vi.fn((pos: { ch: number }) => { cursor = pos.ch; }),
  } as unknown as Editor;

  return {
    editor,
    text: () => value,
    cursorOffset: () => cursor,
  };
}

describe('editor hotkey phrase insertion', () => {
  it('replaces the word before the editor caret and places the caret by offset', () => {
    const h = makeEditor('findings ;plan');
    expect(expandHotkeyPhraseInEditor(h.editor, RULES)).toBe(true);
    expect(h.text()).toBe('findings Plan\nfindings');
    expect(h.cursorOffset()).toBe('findings Plan\nfindings'.length);
  });

  it('leaves text alone when no hotkey trigger matches', () => {
    const h = makeEditor('findings');
    expect(expandHotkeyPhraseInEditor(h.editor, RULES)).toBe(false);
    expect(h.text()).toBe('findings');
  });

  it('does nothing with an empty rule list', () => {
    const h = makeEditor(';plan');
    expect(expandHotkeyPhraseInEditor(h.editor, [])).toBe(false);
    expect(h.text()).toBe(';plan');
  });
});
