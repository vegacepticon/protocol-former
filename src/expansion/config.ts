// expansion/config.ts
// Process-wide snapshot of the text-expansion settings.
//
// The runner renderers, the snippet fill-in modal, the conclusion draft, and
// the hotkey command are constructed in many places and rebuilt on every
// render; threading a settings provider through every host interface would add
// a parameter to a dozen contracts for one optional feature. Instead the plugin
// pushes a parsed snapshot here once settings load or change, and the adapters
// read it at event time. `setTextExpansionConfig` is the only writer.
//
// Rules are pre-split by mode so an adapter never has to reinterpret the list:
// automatic typing reads `autoRules`, the command reads `hotkeyRules`.

import type { ExpansionRule } from './rules';

interface TextExpansionConfig {
  enabled: boolean;
  autoRules: ExpansionRule[];
  hotkeyRules: ExpansionRule[];
  /** Whether the CodeMirror extension is active in note editors. */
  inEditor: boolean;
}

const DISABLED: TextExpansionConfig = {
  enabled: false,
  autoRules: [],
  hotkeyRules: [],
  inEditor: true,
};

let current: TextExpansionConfig = DISABLED;

export function setTextExpansionConfig(config: Partial<TextExpansionConfig>): void {
  current = { ...DISABLED, ...config };
}

export function getTextExpansionConfig(): TextExpansionConfig {
  return current;
}

/** Test seam: drops back to the disabled snapshot. */
export function resetTextExpansionConfig(): void {
  current = DISABLED;
}
