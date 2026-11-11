import { describe, expect, it } from 'vitest';
import {
  matchAuto,
  matchWord,
  maxTriggerLength,
  planAutoExpansion,
  planAutoInsert,
  planWordExpansion,
  wordBeforeCaret,
} from '../../expansion/engine';
import type { ExpansionRule } from '../../expansion/rules';

const RULES: ExpansionRule[] = [
  { trigger: '-->', replacement: '→' },
  { trigger: ';sig', replacement: 'Roman$nl$Dev$end$' },
  { trigger: ';s', replacement: 'short' },
];

describe('expansion engine — auto mode', () => {
  it('matches the longest trigger at the end of the typed text', () => {
    expect(matchAuto('a -->', RULES)?.rule.trigger).toBe('-->');
    expect(matchAuto('x;s', RULES)?.rule.trigger).toBe(';s');
    expect(matchAuto('x;sig', RULES)?.rule.trigger).toBe(';sig');
  });

  it('does not match in the middle of the text', () => {
    expect(matchAuto('--> tail', RULES)).toBeNull();
    expect(matchAuto('', RULES)).toBeNull();
  });

  it('resolves the replacement and caret in the match', () => {
    const match = matchAuto(';sig', RULES);
    expect(match).toMatchObject({ triggerLength: 4, text: 'Roman\nDev', caret: 9 });
  });

  it('plans document coordinates for text that is already typed', () => {
    expect(planAutoExpansion('hello -->', 9, RULES)).toEqual({
      from: 6,
      to: 9,
      insert: '→',
      caret: 7,
    });
  });

  it('plans against the projected text for the CodeMirror input handler', () => {
    // Typing the final `>` at position 8; the doc still holds "hello --".
    expect(planAutoInsert('hello --', 8, '>', RULES)).toEqual({
      from: 6,
      to: 9,
      insert: '→',
      caret: 7,
    });
  });

  it('does not plan when the projected text has no match', () => {
    expect(planAutoInsert('hello', 5, 'x', RULES)).toBeNull();
  });

  it('reports the longest trigger length for bounded read-back', () => {
    expect(maxTriggerLength(RULES)).toBe(4);
    expect(maxTriggerLength([])).toBe(0);
  });
});

describe('expansion engine — delimiter mode', () => {
  it('reads the word before the caret', () => {
    expect(wordBeforeCaret('hello world')).toBe('world');
    expect(wordBeforeCaret('hello ')).toBe('');
    expect(wordBeforeCaret('line1\n;tag')).toBe(';tag');
  });

  it('matches a whole word only', () => {
    expect(matchWord(';sig', RULES)?.rule.trigger).toBe(';sig');
    expect(matchWord('x;sig', RULES)).toBeNull();
    expect(matchWord(';sigx', RULES)).toBeNull();
  });

  it('plans the word replacement without the delimiter', () => {
    // "type ;sig" + Space: the space is consumed, so `to` is the caret.
    expect(planWordExpansion('hello ;sig', 10, RULES)).toEqual({
      from: 6,
      to: 10,
      insert: 'Roman\nDev',
      caret: 15,
    });
  });

  it('plans nothing for an unknown word', () => {
    expect(planWordExpansion('hello', 5, RULES)).toBeNull();
  });
});
