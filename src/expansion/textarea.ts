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

const INSERT_TEXT = 'insertText';

function caretOf(textarea: HTMLTextAreaElement): number | null {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  // `null`/undefined: no selection API (or the field is not focused yet).
  if (start === null || start === undefined || start !== end) return null;
  return start;
}

function applyChange(textarea: HTMLTextAreaElement, change: ExpansionChange): void {
  const value = textarea.value;
  textarea.value = value.slice(0, change.from) + change.insert + value.slice(change.to);
  if (typeof textarea.setSelectionRange === 'function') {
    textarea.setSelectionRange(change.caret, change.caret);
  }
  // Let the component that owns this field observe the new value through its
  // normal `input` handler instead of duplicating its state update here.
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Wires expansion into one textarea. Returns a detach function; elements that
 * are recreated per render may simply be garbage-collected with their
 * listeners.
 */
export function attachTextExpansion(textarea: HTMLTextAreaElement): () => void {
  // Guards the synthetic `input` event dispatched by applyChange from being
  // treated as a fresh keystroke (which would expand again).
  let applying = false;

  const onInput = (event: Event): void => {
    if (applying) return;
    const config = getTextExpansionConfig();
    if (!config.enabled || config.mode !== 'auto' || config.rules.length === 0) return;

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
    const longest = maxTriggerLength(config.rules);
    const before = textarea.value.slice(Math.max(0, caret - longest), caret);
    const change = planAutoExpansion(before, caret, config.rules);
    if (change === null) return;

    applying = true;
    try {
      applyChange(textarea, change);
    } finally {
      applying = false;
    }
  };

  const onKeydown = (event: KeyboardEvent): void => {
    const config = getTextExpansionConfig();
    if (!config.enabled || config.mode !== 'delimiter' || config.rules.length === 0) return;
    if (event.key !== ' ' || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.isComposing === true) return;

    const caret = caretOf(textarea);
    if (caret === null) return;

    const change = planWordExpansion(textarea.value.slice(0, caret), caret, config.rules);
    if (change === null) return;

    // The delimiter is consumed: the expansion replaces the trigger and the
    // space is not inserted, matching Text Snippets.
    event.preventDefault();
    applying = true;
    try {
      applyChange(textarea, change);
    } finally {
      applying = false;
    }
  };

  textarea.addEventListener('input', onInput);
  textarea.addEventListener('keydown', onKeydown);

  return () => {
    textarea.removeEventListener('input', onInput);
    textarea.removeEventListener('keydown', onKeydown);
  };
}
