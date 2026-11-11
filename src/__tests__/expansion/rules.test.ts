import { describe, expect, it } from 'vitest';
import {
  countInvalidPhrases,
  DEFAULT_TEXT_EXPANSION_PHRASES,
  isValidTrigger,
  normalizePhrases,
  parseRuleLines,
  phraseMatchesQuery,
  phrasesFromLegacyRules,
  resolveExpansion,
} from '../../expansion/rules';

describe('expansion rules — legacy line parsing (3.6.21 migration)', () => {
  it('parses one rule per line with => and → separators', () => {
    const { rules, invalid } = parseRuleLines([
      '--> => →',
      '<-- → ←',
      ';sig => Best regards',
    ].join('\n'));

    expect(invalid).toEqual([]);
    expect(rules).toEqual([
      { trigger: '-->', replacement: '→', mode: 'auto' },
      { trigger: '<--', replacement: '←', mode: 'auto' },
      { trigger: ';sig', replacement: 'Best regards', mode: 'auto' },
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
    expect(rules).toEqual([{ trigger: ';arrow', replacement: 'a => b', mode: 'auto' }]);
  });

  it('reports lines without a separator, with an empty trigger, or with spaces in the trigger', () => {
    const { rules, invalid } = parseRuleLines([
      'no separator here',
      '=> orphan',
      'two words => nope',
      'ok => yes',
    ].join('\n'));

    expect(rules).toEqual([{ trigger: 'ok', replacement: 'yes', mode: 'auto' }]);
    expect(invalid).toEqual(['no separator here', '=> orphan', 'two words => nope']);
  });

  it('trims the line and the trigger, and drops separator padding', () => {
    const { rules } = parseRuleLines('   ;x   =>  value  ');
    expect(rules).toEqual([{ trigger: ';x', replacement: 'value', mode: 'auto' }]);
  });

  it('maps the legacy global delimiter mode to hotkey phrases', () => {
    const rules = phrasesFromLegacyRules(';sig => Best\n--> => →', 'delimiter');
    expect(rules.map((rule) => rule.mode)).toEqual(['hotkey', 'hotkey']);
  });

  it('leaves absent legacy text alone', () => {
    expect(phrasesFromLegacyRules(undefined, 'auto')).toEqual([]);
  });
});

describe('expansion phrases — structured validation', () => {
  it('accepts one-word triggers and rejects blank or multi-word ones', () => {
    expect(isValidTrigger('-->')).toBe(true);
    expect(isValidTrigger('  ;sig  ')).toBe(true);
    expect(isValidTrigger('')).toBe(false);
    expect(isValidTrigger('   ')).toBe(false);
    expect(isValidTrigger('two words')).toBe(false);
  });

  it('normalizes modes and trims surrounding trigger whitespace', () => {
    expect(normalizePhrases([
      { trigger: '  ;sig  ', replacement: 'Best', mode: 'hotkey' },
      { trigger: '-->', replacement: '→' },
    ])).toEqual([
      { trigger: ';sig', replacement: 'Best', mode: 'hotkey' },
      { trigger: '-->', replacement: '→', mode: 'auto' },
    ]);
  });

  it('drops invalid rows from the runtime snapshot but keeps their count for the page', () => {
    const phrases = [
      { trigger: '', replacement: 'x' },
      { trigger: 'two words', replacement: 'y' },
      { trigger: 'ok', replacement: 'z' },
    ];
    expect(normalizePhrases(phrases)).toHaveLength(1);
    expect(countInvalidPhrases(phrases)).toBe(2);
  });

  it('ships defaults that are valid', () => {
    expect(DEFAULT_TEXT_EXPANSION_PHRASES.length).toBeGreaterThan(0);
    expect(countInvalidPhrases(DEFAULT_TEXT_EXPANSION_PHRASES)).toBe(0);
  });

  it('searches phrases by trigger or insertion, case-insensitively', () => {
    const phrase = { trigger: ';MRI', replacement: 'Магнитно-резонансная томография' };

    expect(phraseMatchesQuery(phrase, '')).toBe(true);
    expect(phraseMatchesQuery(phrase, '   ')).toBe(true);
    expect(phraseMatchesQuery(phrase, 'mri')).toBe(true);
    expect(phraseMatchesQuery(phrase, 'резонанс')).toBe(true);
    expect(phraseMatchesQuery(phrase, 'томограф')).toBe(true);
    expect(phraseMatchesQuery(phrase, 'mrt')).toBe(false);
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
