// expansion/engine.ts
// Pure matching logic for text expansion.
//
// Two firing paths share this core:
//   * auto   — replace as soon as the typed text ends with a trigger
//              (Substitutions behaviour: `-->` becomes `→` immediately).
//   * hotkey — replace the whole word before the caret when the user runs the
//              `Insert phrase from trigger` command (Text Snippets shortcut
//              behaviour with one user-assigned chord).
//
// Everything here takes plain strings and returns a coordinate-free plan, so
// the textarea adapter, the CodeMirror extension, and the hotkey command share
// one implementation and the behaviour is testable without a DOM.

import { resolveExpansion, type ExpansionRule } from './rules';

interface ExpansionMatch {
  rule: ExpansionRule;
  /** Length of the trigger that must be replaced before the caret. */
  triggerLength: number;
  /** Text to insert (markers already resolved). */
  text: string;
  /** Caret offset from the start of `text`. */
  caret: number;
}

/** Replacement plan in document coordinates. */
export interface ExpansionChange {
  from: number;
  to: number;
  insert: string;
  /** Absolute caret position after the change. */
  caret: number;
}

function toMatch(rule: ExpansionRule): ExpansionMatch {
  const resolved = resolveExpansion(rule.replacement);
  return {
    rule,
    triggerLength: rule.trigger.length,
    text: resolved.text,
    caret: resolved.caret,
  };
}

/**
 * Auto mode: the longest trigger that is a suffix of `before`.
 *
 * There is deliberately no word-boundary check: Substitutions behaves the same
 * way, and a boundary rule would silently skip symbol triggers such as `-->`.
 */
export function matchAuto(before: string, rules: ExpansionRule[]): ExpansionMatch | null {
  let best: ExpansionRule | null = null;
  for (const rule of rules) {
    if (!before.endsWith(rule.trigger)) continue;
    if (best === null || rule.trigger.length > best.trigger.length) best = rule;
  }
  return best === null ? null : toMatch(best);
}

/** Longest trigger length — bounds how much text the adapters must read back. */
export function maxTriggerLength(rules: ExpansionRule[]): number {
  return rules.reduce((longest, rule) => Math.max(longest, rule.trigger.length), 0);
}

/** Hotkey mode: the word before the caret must equal a trigger exactly. */
export function matchWord(word: string, rules: ExpansionRule[]): ExpansionMatch | null {
  const rule = rules.find((candidate) => candidate.trigger === word);
  return rule === undefined ? null : toMatch(rule);
}

/** Word immediately before the caret; stops at whitespace. */
export function wordBeforeCaret(before: string): string {
  const match = /(\S+)$/u.exec(before);
  return match === null ? '' : match[1]!;
}

/**
 * Auto-mode plan for text that is already in the document (textarea adapter).
 * `caret` must be the caret position inside `before`.
 */
export function planAutoExpansion(
  before: string,
  caret: number,
  rules: ExpansionRule[],
): ExpansionChange | null {
  const match = matchAuto(before, rules);
  if (match === null) return null;
  const from = caret - match.triggerLength;
  return { from, to: caret, insert: match.text, caret: from + match.caret };
}

/**
 * Auto-mode plan for text the user is about to insert (CodeMirror input
 * handler). `before` excludes the typed text; `insert` is what is about to be
 * inserted at `from`. The resulting change always spans up to `from + insert`.
 */
export function planAutoInsert(
  before: string,
  from: number,
  insert: string,
  rules: ExpansionRule[],
): ExpansionChange | null {
  const projected = before + insert;
  const match = matchAuto(projected, rules);
  if (match === null) return null;
  const start = from + insert.length - match.triggerLength;
  return { from: start, to: from + insert.length, insert: match.text, caret: start + match.caret };
}

/** Hotkey-mode plan: the word before `caret` is replaced. */
export function planWordExpansion(
  before: string,
  caret: number,
  rules: ExpansionRule[],
): ExpansionChange | null {
  const word = wordBeforeCaret(before);
  if (word === '') return null;
  const match = matchWord(word, rules);
  if (match === null) return null;
  const from = caret - word.length;
  return { from, to: caret, insert: match.text, caret: from + match.caret };
}
