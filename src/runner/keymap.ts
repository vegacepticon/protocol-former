// runner/keymap.ts
// Pure, DOM-free resolver for the runner's left-hand keyboard model.
//
// The shells, the host, and the renderers used to own separate listeners
// (shell Esc, host Ctrl/Alt+arrows, renderer Shift+Enter), so the key contract
// could not be read in one place. This module is the single source of truth: it
// maps a keyboard event plus an availability snapshot to at most one action and
// knows nothing about rendering, focus, or the Obsidian API.
//
// Matching rules:
//   * Letters and digits match on `code` (layout independent: the Russian layout
//     reports `key: "я"` for the physical Z key).
//   * Every mapped key bails out while an IME composition is active.
//   * Plain keys never fire from a text-entry target; fields keep native meaning.
//   * Only the legacy arrow aliases accept Ctrl/Meta/Alt; a held modifier makes
//     every other mapped key inert instead of ambiguous. Shift stays allowed for
//     letters and digits because no text field can be focused when they resolve.
//   * Unavailable actions resolve to `null`, so callers neither act nor call
//     preventDefault().

/** What the runner can do for the currently rendered state. */
export interface RunnerKeyContext {
  /** Number of keyboard-selectable options (answers, branches, loop edges). */
  optionCount: number;
  canStepBack: boolean;
  canRedo: boolean;
  canSkip: boolean;
  /** At least one free-text answer is currently projected. */
  hasFreeTextOption: boolean;
  /** The conclusion draft exists for this session. */
  hasConclusionDraft: boolean;
  /** The draft has uninserted text and no write is in flight. */
  canInsertConclusion: boolean;
}

/** Subset of KeyboardEvent the resolver needs (kept DOM-free for tests). */
export interface RunnerKeyInput {
  code?: string;
  key?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  /** Event target, when it is a DOM element; only shape is inspected. */
  target?: { tagName?: string; isContentEditable?: boolean } | null;
}

export type RunnerKeyAction =
  | { kind: 'choose-option'; index: number }
  | { kind: 'back' }
  | { kind: 'redo' }
  | { kind: 'skip' }
  | { kind: 'focus-free-text' }
  | { kind: 'focus-conclusion' }
  | { kind: 'insert-conclusion' }
  | { kind: 'toggle-hints' }
  | { kind: 'close' };

const DIGIT_CODE_RE = /^(?:Digit|Numpad)([1-9])$/;
const ASCII_LETTER_RE = /^[a-zA-Z]$/;
const ASCII_DIGIT_RE = /^[1-9]$/;

/** Text-entry targets keep every plain key for themselves. */
export function isTextEntryTarget(target: RunnerKeyInput['target']): boolean {
  if (target === null || target === undefined) return false;
  const tag = target.tagName?.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable === true;
}

/** Falls back to `key` when a synthetic event supplies no `code`. */
function resolveCode(input: RunnerKeyInput): string {
  if (input.code !== undefined && input.code !== '') return input.code;
  const key = input.key ?? '';
  if (ASCII_LETTER_RE.test(key)) return `Key${key.toUpperCase()}`;
  if (ASCII_DIGIT_RE.test(key)) return `Digit${key}`;
  return key;
}

function hasNavigationModifier(input: RunnerKeyInput): boolean {
  return input.ctrlKey === true || input.metaKey === true || input.altKey === true;
}

function resolveArrow(code: string, context: RunnerKeyContext): RunnerKeyAction | null {
  if (code === 'ArrowLeft') {
    return context.canStepBack ? { kind: 'back' } : null;
  }
  if (code === 'ArrowRight') {
    return context.canRedo ? { kind: 'redo' } : null;
  }
  return null;
}

function resolveLetter(code: string, context: RunnerKeyContext): RunnerKeyAction | null {
  switch (code) {
    case 'KeyZ':
      return context.canStepBack ? { kind: 'back' } : null;
    case 'KeyX':
      return context.canRedo ? { kind: 'redo' } : null;
    case 'KeyS':
      return context.canSkip ? { kind: 'skip' } : null;
    case 'KeyF':
      return context.hasFreeTextOption ? { kind: 'focus-free-text' } : null;
    case 'KeyC':
      return context.hasConclusionDraft ? { kind: 'focus-conclusion' } : null;
    case 'KeyV':
      return context.canInsertConclusion ? { kind: 'insert-conclusion' } : null;
    case 'KeyH':
      return { kind: 'toggle-hints' };
    default:
      return null;
  }
}

/**
 * Resolves one keyboard event to one runner action.
 * Returns `null` when the key is unrelated, unavailable, or must stay native.
 */
export function resolveRunnerKey(
  input: RunnerKeyInput,
  context: RunnerKeyContext,
): RunnerKeyAction | null {
  if (input.isComposing === true || input.keyCode === 229) return null;
  if (isTextEntryTarget(input.target)) return null;

  const code = resolveCode(input);

  if (hasNavigationModifier(input)) {
    // Legacy aliases only: Ctrl/Alt/Mod + arrows. No modifier-plus-letter chords.
    return resolveArrow(code, context);
  }

  if (code === 'Escape') return { kind: 'close' };

  const digit = DIGIT_CODE_RE.exec(code);
  if (digit !== null) {
    const index = Number(digit[1]);
    return index <= context.optionCount ? { kind: 'choose-option', index } : null;
  }

  if (code === 'Backspace') {
    return context.canStepBack ? { kind: 'back' } : null;
  }

  return resolveLetter(code, context);
}

/** Stable identifier for tests and debug tooling. */
export function runnerKeyActionId(action: RunnerKeyAction): string {
  return action.kind === 'choose-option'
    ? `${action.kind}:${action.index}`
    : action.kind;
}
