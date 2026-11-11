// expansion/editor.ts
// CodeMirror 6 extension that runs automatic text expansion inside Obsidian's
// note editor.
//
// `Plugin.registerEditorExtension` is a public API and the editor is CM6, so
// this needs no internals: one input handler covers the auto phrases. Hotkey
// phrases are inserted by the plugin command through `expandHotkeyPhraseInEditor`
// below, because the command is user-invoked rather than a keystroke the editor
// should capture. Both paths read the current settings snapshot at event time,
// so toggling the feature needs no reconfiguration.

import type { Editor } from 'obsidian';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { getTextExpansionConfig } from './config';
import {
  maxTriggerLength,
  planAutoInsert,
  planWordExpansion,
  type ExpansionChange,
} from './engine';
import type { ExpansionRule } from './rules';

function autoRulesOrNull(): ExpansionRule[] | null {
  const config = getTextExpansionConfig();
  if (!config.enabled || !config.inEditor || config.autoRules.length === 0) return null;
  return config.autoRules;
}

function dispatchChange(view: EditorView, change: ExpansionChange): void {
  view.dispatch({
    changes: { from: change.from, to: change.to, insert: change.insert },
    selection: { anchor: change.caret },
    userEvent: 'input.type',
  });
}

/** Text before `from`, limited to what the longest trigger could match. */
function textBefore(view: EditorView, from: number, rules: ExpansionRule[]): string {
  const longest = maxTriggerLength(rules);
  return view.state.sliceDoc(Math.max(0, from - longest), from);
}

/**
 * Replaces the word before the editor caret with a hotkey-mode phrase.
 * Returns true when a replacement was applied.
 */
export function expandHotkeyPhraseInEditor(
  editor: Editor,
  rules: ExpansionRule[],
): boolean {
  if (rules.length === 0) return false;
  if (editor.getSelection() !== '') return false;
  const cursor = editor.getCursor();
  const line = editor.getLine(cursor.line);
  if (cursor.ch > line.length) return false;

  const change = planWordExpansion(line.slice(0, cursor.ch), cursor.ch, rules);
  if (change === null) return false;

  const from = { line: cursor.line, ch: change.from };
  const to = { line: cursor.line, ch: change.to };
  const fromOffset = editor.posToOffset(from);
  editor.replaceRange(change.insert, from, to);
  // `change.caret` is line-relative and may point past the first line when the
  // insertion contains breaks, so convert only the offset inside the insertion.
  editor.setCursor(editor.offsetToPos(fromOffset + (change.caret - change.from)));
  return true;
}

export function textExpansionExtension(): Extension {
  return [
    EditorView.inputHandler.of((view, from, to, text) => {
      const rules = autoRulesOrNull();
      if (rules === null) return false;
      // `compositionStarted`, not `composing`: it is also true on the first
      // composition event, and the input handler must never rewrite a preedit.
      if (view.compositionStarted) return false;
      // Only direct insertion at a single collapsed cursor; pastes,
      // programmatic edits, and multi-cursor input keep their text.
      if (from !== to || text.length === 0) return false;
      if (view.state.selection.ranges.length > 1) return false;

      const change = planAutoInsert(
        textBefore(view, from, rules),
        from,
        text,
        rules,
      );
      if (change === null) return false;
      dispatchChange(view, change);
      return true;
    }),
  ];
}
