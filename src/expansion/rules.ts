// expansion/rules.ts
// Author-facing text-expansion rules, stored as one rule per line in settings.
//
// Line grammar — everything after the first separator is the replacement:
//   trigger => replacement
//   trigger → replacement
//
// Blank lines and lines starting with `#` are ignored (comments). A trigger
// must be a single word: the delimiter mode matches whole words, and keeping
// one rule set for both modes would otherwise behave differently per mode.
//
// Replacement markers (the union of what the two replaced plugins offered):
//   \n, \t, \b, \\   escaped characters
//   $nl$              line break
//   $end$             caret position after expansion (default: end of text)
//
// This module is pure: no DOM, no Obsidian, no settings access.

/** One parsed rule. `replacement` is the raw author text, markers included. */
export interface ExpansionRule {
  trigger: string;
  replacement: string;
}

interface ParsedRules {
  rules: ExpansionRule[];
  /** Non-comment lines that could not be parsed; kept for the settings notice. */
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

export function parseRuleLines(source: string): ParsedRules {
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
    if (trigger === '' || /\s/u.test(trigger)) {
      invalid.push(rawLine);
      continue;
    }

    rules.push({ trigger, replacement });
  }

  return { rules, invalid };
}

/** Round-trips parsed rules back to the editable settings text. */
export function serializeRuleLines(rules: ExpansionRule[]): string {
  return rules.map((rule) => `${rule.trigger} => ${rule.replacement}`).join('\n');
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

/** Defaults shown on a fresh install once text expansion is enabled. */
export const DEFAULT_TEXT_EXPANSION_RULES = serializeRuleLines([
  { trigger: '-->', replacement: '→' },
  { trigger: '<--', replacement: '←' },
  { trigger: '!=', replacement: '≠' },
  { trigger: '1/2', replacement: '½' },
]);
