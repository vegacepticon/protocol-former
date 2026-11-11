// expansion/textarea.ts
// Text-expansion adapter for plain <textarea> fields.
//
// The runner's free-text answers, loop targets, the conclusion draft, and the
// snippet fill-in fields are textareas, so none of the community phrase plugins
// can reach them. This adapter needs no editor instance: it reads the value and
// the selection, applies a pure plan from `engine.ts`, and re-dispatches a
// synthetic `input` event so the surrounding component (draft state, live
// preview) updates exactly as if the user had typed the replacement.
//
// Two entry points:
//   * `attachTextExpansion()` reacts to direct typing (auto phrases);
//   * `expandHotkeyPhrase()` is called by the `Insert phrase from trigger`
//     command for a field this adapter owns.
//
// Known trade-off: assigning `value` bypasses the browser's native undo stack,
// so one Ctrl+Z does not restore the pre-expansion text in these fields. The
// notes editor is unaffected because it goes through CodeMirror transactions.

import { getTextExpansionConfig } from './config';
import {
  maxTriggerLength,
  planAutoExpansion,
  planWordExpansion,
  type ExpansionChange,
} from './engine';
import type { ExpansionRule } from './rules';

const INSERT_TEXT = 'insertText';

/** Fields this adapter owns; the command refuses to touch anything else. */
const attachedTextareas = new WeakSet<HTMLTextAreaElement>();
/** Guards the synthetic `input` event from being treated as a fresh keystroke. */
const applyingTextareas = new WeakSet<HTMLTextAreaElement>();

function caretOf(textarea: HTMLTextAreaElement): number | null {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  // `null`/undefined: no selection API (or the field is not focused yet).
  if (start === null || start === undefined || start !== end) return null;
  return start;
}

function applyChange(textarea: HTMLTextAreaElement, change: ExpansionChange): void {
  applyingTextareas.add(textarea);
  try {
    const value = textarea.value;
    textarea.value = value.slice(0, change.from) + change.insert + value.slice(change.to);
    if (typeof textarea.setSelectionRange === 'function') {
      textarea.setSelectionRange(change.caret, change.caret);
    }
    // Let the component that owns this field observe the new value through its
    // normal `input` handler instead of duplicating its state update here.
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  } finally {
    applyingTextareas.delete(textarea);
  }
}

/** True for fields that `attachTextExpansion()` wired. */
export function isTextExpansionTextarea(
  element: Element | null | undefined,
): element is HTMLTextAreaElement {
  return element !== null
    && element !== undefined
    && attachedTextareas.has(element as HTMLTextAreaElement);
}

/**
 * Replaces the word before the caret with a hotkey-mode phrase.
 * Returns true when a replacement was applied. The command owns the
 * "nothing matched" feedback.
 */
export function expandHotkeyPhrase(
  textarea: HTMLTextAreaElement,
  rules: ExpansionRule[],
): boolean {
  if (rules.length === 0) return false;
  const caret = caretOf(textarea);
  if (caret === null) return false;

  const change = planWordExpansion(textarea.value.slice(0, caret), caret, rules);
  if (change === null) return false;
  applyChange(textarea, change);
  return true;
}

/**
 * Wires expansion into one textarea. Returns a detach function; elements that
 * are recreated per render may simply be garbage-collected with their
 * listeners.
 */
export function attachTextExpansion(textarea: HTMLTextAreaElement): () => void {
  const onInput = (event: Event): void => {
    if (applyingTextareas.has(textarea)) return;
    const config = getTextExpansionConfig();
    if (!config.enabled || config.autoRules.length === 0) return;

    const inputEvent = event as InputEvent;
    if (inputEvent.isComposing === true) return;
    // Direct typing only: pastes and drops must not be rewritten.
    if (inputEvent.inputType !== undefined
      && inputEvent.inputType !== ''
      && inputEvent.inputType !== INSERT_TEXT) return;

    const caret = caretOf(textarea);
    if (caret === null) return;

    // Only the last `longest` characters can match, so long answers are not
    // copied on every keystroke.
    const longest = maxTriggerLength(config.autoRules);
    const before = textarea.value.slice(Math.max(0, caret - longest), caret);
    const change = planAutoExpansion(before, caret, config.autoRules);
    if (change === null) return;

    applyChange(textarea, change);
  };

  attachedTextareas.add(textarea);
  textarea.addEventListener('input', onInput);

  return () => {
    attachedTextareas.delete(textarea);
    textarea.removeEventListener('input', onInput);
  };
}
