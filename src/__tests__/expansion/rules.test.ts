import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TEXT_EXPANSION_RULES,
  parseRuleLines,
  resolveExpansion,
  serializeRuleLines,
} from '../../expansion/rules';

describe('expansion rules — parsing', () => {
  it('parses one rule per line with => and → separators', () => {
    const { rules, invalid } = parseRuleLines([
      '--> => →',
      '<-- → ←',
      ';sig => Best regards',
    ].join('\n'));

    expect(invalid).toEqual([]);
    expect(rules).toEqual([
      { trigger: '-->', replacement: '→' },
      { trigger: '<--', replacement: '←' },
      { trigger: ';sig', replacement: 'Best regards' },
    ]);
  });

  it('skips blank lines and # comments', () => {
    const { rules, invalid } = parseRuleLines([
      '# symbols',
      '',
      '  ',
      '--> => →',
    ].join('\n'));

    expect(invalid).toEqual([]);
    expect(rules).toHaveLength(1);
  });

  it('keeps a separator that appears inside the replacement', () => {
    const { rules } = parseRuleLines(';arrow => a => b');
    expect(rules).toEqual([{ trigger: ';arrow', replacement: 'a => b' }]);
  });

  it('reports lines without a separator, with an empty trigger, or with spaces in the trigger', () => {
    const { rules, invalid } = parseRuleLines([
      'no separator here',
      '=> orphan',
      'two words => nope',
      'ok => yes',
    ].join('\n'));

    expect(rules).toEqual([{ trigger: 'ok', replacement: 'yes' }]);
    expect(invalid).toEqual(['no separator here', '=> orphan', 'two words => nope']);
  });

  it('trims the line and the trigger, and drops separator padding', () => {
    const { rules } = parseRuleLines('   ;x   =>  value  ');
    expect(rules).toEqual([{ trigger: ';x', replacement: 'value' }]);
  });

  it('serializes back to an editable list with one rule per line', () => {
    const rules = [
      { trigger: '-->', replacement: '→' },
      { trigger: ';sig', replacement: 'Best' },
    ];
    expect(serializeRuleLines(rules)).toBe('--> => →\n;sig => Best');
  });

  it('ships defaults that parse cleanly', () => {
    const { rules, invalid } = parseRuleLines(DEFAULT_TEXT_EXPANSION_RULES);
    expect(invalid).toEqual([]);
    expect(rules.length).toBeGreaterThan(0);
  });
});

describe('expansion rules — replacement resolution', () => {
  it('resolves escapes', () => {
    expect(resolveExpansion('a\\nb\\tc\\\\d')).toEqual({ text: 'a\nb\tc\\d', caret: 7 });
  });

  it('keeps an unknown escape as written', () => {
    expect(resolveExpansion('50\\%')).toEqual({ text: '50\\%', caret: 4 });
  });

  it('resolves $nl$ into a line break', () => {
    expect(resolveExpansion('a$nl$b')).toEqual({ text: 'a\nb', caret: 3 });
  });

  it('places the caret at the first $end$ marker', () => {
    expect(resolveExpansion('a$end$b')).toEqual({ text: 'ab', caret: 1 });
    expect(resolveExpansion('$end$a$end$b')).toEqual({ text: 'ab', caret: 0 });
  });

  it('places the caret at the end when there is no marker', () => {
    expect(resolveExpansion('plain')).toEqual({ text: 'plain', caret: 5 });
  });

  it('supports empty replacements (trigger deletion)', () => {
    expect(resolveExpansion('')).toEqual({ text: '', caret: 0 });
  });
});
