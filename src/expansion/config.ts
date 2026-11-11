// expansion/config.ts
// Process-wide snapshot of the text-expansion settings.
//
// The runner renderers, the snippet fill-in modal, and the conclusion draft are
// constructed in many places and rebuilt on every render; threading a settings
// provider through every host interface would add a parameter to a dozen
// contracts for one optional feature. Instead the plugin pushes a parsed
// snapshot here once settings load or change, and the adapters read it at event
// time. `setTextExpansionConfig` is the only writer.

import type { ExpansionMode } from './engine';
import type { ExpansionRule } from './rules';

interface TextExpansionConfig {
  enabled: boolean;
  mode: ExpansionMode;
  rules: ExpansionRule[];
  /** Whether the CodeMirror extension is active in note editors. */
  inEditor: boolean;
}

const DISABLED: TextExpansionConfig = {
  enabled: false,
  mode: 'auto',
  rules: [],
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
