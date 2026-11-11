// One keyboard-selectable option as rendered for the current runner state.
// Renderers create the DOM and register the option; the host owns the numbered
// dispatch, the badges, and the availability snapshot handed to the keymap.

export interface RunnerOptionTarget {
  /** Element that carries the numeric badge (`data-rp-key`). */
  element: HTMLElement;
  /**
   * Runs the option's action for its numeric key. A free-text option focuses its
   * field instead of submitting, matching the "press the number, then type" flow.
   */
  activate(): void;
  /** Interactive element that receives `aria-keyshortcuts`; defaults to `element`. */
  keyboardElement?: HTMLElement;
}
