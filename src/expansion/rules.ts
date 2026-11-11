// expansion/rules.ts
// Phrase model for typed text expansion.
//
// A phrase has a single-word trigger, a replacement, and an insertion mode:
//   * auto   — replace as soon as the trigger has been typed (the
//              Substitutions behaviour: `-->` becomes `→` immediately).
//   * hotkey — leave the typed word alone until the user runs the
//              `Insert phrase from trigger` command (the Text Snippets
//              shortcut behaviour, but with one user-assigned chord).
//
// Phrases live in settings as a structured list (`textExpansionPhrases`) and
// are edited row by row. `parseRuleLines()` remains as the one-way migration
// reader for the 3.6.21 `trigger => replacement` text format; the new UI never
// writes that format again.
//
// Replacement markers (the union of what the two replaced plugins offered):
//   \n, \t, \b, \\   escaped characters
//   $nl$              line break
//   $end$             caret position after expansion (default: end of text)
//
// This module is pure: no DOM, no Obsidian, no settings access.

export type ExpansionMode = 'auto' | 'hotkey';

/** One phrase. `replacement` is the raw author text, markers included. */
export interface ExpansionRule {
  trigger: string;
  replacement: string;
  /** Absent is treated as `auto` so hand-written and legacy data stays valid. */
  mode?: ExpansionMode;
}

interface ParsedRules {
  rules: ExpansionRule[];
  /** Non-comment lines that could not be parsed; kept for the migration check. */
  invalid: string[];
}

interface ResolvedExpansion {
  text: string;
  /** Caret offset from the start of `text`. */
  caret: number;
}

/** First separator wins, so a replacement may itself contain `=>` or `→`. */
const SEPARATOR_RE = /\s*(?:=>|→)\s*/;

const ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  b: '\b',
  '\\': '\\',
};

/** A trigger must be one word: both modes match it as a single token. */
export function isValidTrigger(trigger: string): boolean {
  const trimmed = trigger.trim();
  return trimmed !== '' && !/\s/u.test(trimmed);
}

export function isHotkeyRule(rule: ExpansionRule): boolean {
  return rule.mode === 'hotkey';
}

export function isAutoRule(rule: ExpansionRule): boolean {
  return rule.mode !== 'hotkey';
}

/**
 * Drops invalid rows and copies the rest, so the adapters never receive a
 * blank or multi-word trigger. Surrounding whitespace is trimmed; a trigger
 * with internal whitespace is invalid.
 */
export function normalizePhrases(phrases: ExpansionRule[]): ExpansionRule[] {
  const normalized: ExpansionRule[] = [];
  for (const phrase of phrases) {
    const trigger = phrase.trigger.trim();
    if (trigger === '' || /\s/u.test(trigger)) continue;
    normalized.push({
      trigger,
      replacement: phrase.replacement,
      mode: isHotkeyRule(phrase) ? 'hotkey' : 'auto',
    });
  }
  return normalized;
}

/** Number of rows the new settings page marks as invalid. */
export function countInvalidPhrases(phrases: ExpansionRule[]): number {
  return phrases.filter((phrase) => !isValidTrigger(phrase.trigger)).length;
}

/**
 * Settings-page search: a case-insensitive substring of the trigger or the
 * replacement. A blank query matches every row.
 */
export function phraseMatchesQuery(phrase: ExpansionRule, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return phrase.trigger.toLowerCase().includes(needle)
    || phrase.replacement.toLowerCase().includes(needle);
}

/**
 * One-way reader for the old `trigger => replacement` settings text.
 * The legacy global `delimiter` mode mapped to Space; its closest equivalent
 * in the new model is a phrase that waits for an explicit hotkey.
 */
export function parseRuleLines(
  source: string,
  mode: ExpansionMode = 'auto',
): ParsedRules {
  const rules: ExpansionRule[] = [];
  const invalid: string[] = [];

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const separator = SEPARATOR_RE.exec(line);
    if (separator === null) {
      invalid.push(rawLine);
      continue;
    }

    const trigger = line.slice(0, separator.index).trim();
    const replacement = line.slice(separator.index + separator[0].length);
    if (!isValidTrigger(trigger)) {
      invalid.push(rawLine);
      continue;
    }

    rules.push({ trigger, replacement, mode });
  }

  return { rules, invalid };
}

/**
 * Turns a raw replacement into the text to insert plus the caret offset.
 *
 * Markers are scanned left to right in one pass, so `\\` produces a literal
 * backslash and does not start an escape, and the first `$end$` wins.
 */
export function resolveExpansion(raw: string): ResolvedExpansion {
  let text = '';
  let caret: number | null = null;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!;

    if (char === '\\' && index + 1 < raw.length) {
      const escaped = ESCAPES[raw[index + 1]!];
      if (escaped !== undefined) {
        text += escaped;
        index += 1;
        continue;
      }
      text += char;
      continue;
    }

    if (char === '$') {
      if (raw.startsWith('$end$', index)) {
        if (caret === null) caret = text.length;
        index += 4;
        continue;
      }
      if (raw.startsWith('$nl$', index)) {
        text += '\n';
        index += 3;
        continue;
      }
    }

    text += char;
  }

  return { text, caret: caret ?? text.length };
}

/** Defaults shown on a fresh install. */
export const DEFAULT_TEXT_EXPANSION_PHRASES: ExpansionRule[] = [
  { trigger: '-->', replacement: '→', mode: 'auto' },
  { trigger: '<--', replacement: '←', mode: 'auto' },
  { trigger: '!=', replacement: '≠', mode: 'auto' },
  { trigger: '1/2', replacement: '½', mode: 'auto' },
];

/** Legacy settings reader used by `main.ts` when upgrading from 3.6.21. */
export function phrasesFromLegacyRules(
  source: string | undefined,
  legacyMode: 'auto' | 'delimiter' | undefined,
): ExpansionRule[] {
  if (source === undefined) return [];
  return parseRuleLines(source, legacyMode === 'delimiter' ? 'hotkey' : 'auto').rules;
}
