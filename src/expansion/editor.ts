// expansion/editor.ts
// CodeMirror 6 extension that runs text expansion inside Obsidian's note editor.
//
// `Plugin.registerEditorExtension` is a public API and the editor is CM6, so
// this needs no internals: one input handler covers auto mode and one keymap
// binding covers the Space delimiter. The extension reads the current settings
// snapshot at event time, so toggling the feature needs no reconfiguration.

import { Prec, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { getTextExpansionConfig } from './config';
import {
  maxTriggerLength,
  planAutoInsert,
  planWordExpansion,
  type ExpansionChange,
} from './engine';
import type { ExpansionRule } from './rules';

function activeMode(): 'auto' | 'delimiter' | null {
  const config = getTextExpansionConfig();
  if (!config.enabled || !config.inEditor || config.rules.length === 0) return null;
  return config.mode;
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

export function textExpansionExtension(): Extension {
  return [
    EditorView.inputHandler.of((view, from, to, text) => {
      if (activeMode() !== 'auto') return false;
      if (view.composing) return false;
      // Only direct insertion at a collapsed cursor; pastes and programmatic
      // edits keep their text (Substitutions has the same restriction).
      if (from !== to || text.length === 0) return false;

      const config = getTextExpansionConfig();
      const change = planAutoInsert(
        textBefore(view, from, config.rules),
        from,
        text,
        config.rules,
      );
      if (change === null) return false;
      dispatchChange(view, change);
      return true;
    }),

    Prec.high(keymap.of([{
      key: 'Space',
      run: (view) => {
        if (activeMode() !== 'delimiter') return false;
        if (view.composing) return false;
        const selection = view.state.selection.main;
        if (!selection.empty) return false;

        const config = getTextExpansionConfig();
        // Word mode needs the whole word, not just the longest trigger; it runs
        // once per Space press, so reading back to the line start is cheap.
        const line = view.state.doc.lineAt(selection.head);
        const change = planWordExpansion(
          line.text.slice(0, selection.head - line.from),
          selection.head,
          config.rules,
        );
        if (change === null) return false;
        dispatchChange(view, change);
        return true;
      },
    }])),
  ];
}
