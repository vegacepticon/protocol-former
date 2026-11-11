import { describe, expect, it } from 'vitest';
import {
  isTextEntryTarget,
  resolveRunnerKey,
  runnerKeyActionId,
  type RunnerKeyContext,
  type RunnerKeyInput,
} from '../../runner/keymap';

const ALL_AVAILABLE: RunnerKeyContext = {
  optionCount: 3,
  canStepBack: true,
  canRedo: true,
  canSkip: true,
  hasFreeTextOption: true,
  hasConclusionDraft: true,
  canInsertConclusion: true,
};

const NOTHING_AVAILABLE: RunnerKeyContext = {
  optionCount: 0,
  canStepBack: false,
  canRedo: false,
  canSkip: false,
  hasFreeTextOption: false,
  hasConclusionDraft: false,
  canInsertConclusion: false,
};

function resolve(input: RunnerKeyInput, context: RunnerKeyContext = ALL_AVAILABLE): string | null {
  const action = resolveRunnerKey(input, context);
  return action === null ? null : runnerKeyActionId(action);
}

describe('runner keymap — numeric selection', () => {
  it.each([1, 2, 3])('selects option %i by main-row digit', (index) => {
    expect(resolve({ code: `Digit${index}`, key: String(index) })).toBe(`choose-option:${index}`);
  });

  it('matches the numpad row', () => {
    expect(resolve({ code: 'Numpad2', key: '2' })).toBe('choose-option:2');
  });

  it('falls back to the key value when code is missing', () => {
    expect(resolve({ key: '3' })).toBe('choose-option:3');
  });

  it('ignores digits beyond the rendered option count', () => {
    expect(resolve({ code: 'Digit4', key: '4' })).toBeNull();
    expect(resolve({ code: 'Digit9', key: '9' })).toBeNull();
  });

  it('ignores zero and multi-character key values', () => {
    expect(resolve({ code: 'Digit0', key: '0' })).toBeNull();
    expect(resolve({ key: '10' })).toBeNull();
  });

  it('never selects numbers with an option count of zero', () => {
    expect(resolve({ code: 'Digit1', key: '1' }, NOTHING_AVAILABLE)).toBeNull();
  });
});

describe('runner keymap — letters and layout independence', () => {
  it.each([
    ['KeyZ', 'back'],
    ['KeyX', 'redo'],
    ['KeyS', 'skip'],
    ['KeyF', 'focus-free-text'],
    ['KeyC', 'focus-conclusion'],
    ['KeyV', 'insert-conclusion'],
    ['KeyH', 'toggle-hints'],
  ])('maps %s to %s', (code, expected) => {
    expect(resolve({ code, key: '?' })).toBe(expected);
  });

  it('matches a Russian-layout Z event by code', () => {
    expect(resolve({ code: 'KeyZ', key: 'я' })).toBe('back');
    expect(resolve({ code: 'KeyX', key: 'ч' })).toBe('redo');
    expect(resolve({ code: 'KeyC', key: 'с' })).toBe('focus-conclusion');
  });

  it('matches an ASCII key when code is absent', () => {
    expect(resolve({ key: 'z' })).toBe('back');
    expect(resolve({ key: 'H' })).toBe('toggle-hints');
  });

  it('allows Shift for letters, because no text field can be focused', () => {
    expect(resolve({ code: 'KeyZ', key: 'Я', shiftKey: true })).toBe('back');
  });

  it.each([
    ['KeyZ', 'back'],
    ['KeyX', 'redo'],
    ['KeyS', 'skip'],
    ['KeyF', 'focus-free-text'],
    ['KeyC', 'focus-conclusion'],
    ['KeyV', 'insert-conclusion'],
  ])('keeps %s inert when its action is unavailable', (code, _label) => {
    expect(resolve({ code, key: '?' }, NOTHING_AVAILABLE)).toBeNull();
  });

  it('always allows the hint toggle', () => {
    expect(resolve({ code: 'KeyH', key: 'h' }, NOTHING_AVAILABLE)).toBe('toggle-hints');
  });
});

describe('runner keymap — modifiers and legacy aliases', () => {
  it.each([
    { ctrlKey: true },
    { altKey: true },
    { metaKey: true },
  ])('keeps Ctrl/Alt/Mod + arrow as back/redo aliases (%o)', (modifier) => {
    expect(resolve({ code: 'ArrowLeft', key: 'ArrowLeft', ...modifier })).toBe('back');
    expect(resolve({ code: 'ArrowRight', key: 'ArrowRight', ...modifier })).toBe('redo');
  });

  it('rejects plain arrows', () => {
    expect(resolve({ code: 'ArrowLeft', key: 'ArrowLeft' })).toBeNull();
    expect(resolve({ code: 'ArrowRight', key: 'ArrowRight' })).toBeNull();
  });

  it('keeps held modifiers from triggering letters and digits', () => {
    expect(resolve({ code: 'KeyZ', key: 'z', ctrlKey: true })).toBeNull();
    expect(resolve({ code: 'KeyV', key: 'v', metaKey: true })).toBeNull();
    expect(resolve({ code: 'Digit1', key: '1', altKey: true })).toBeNull();
    expect(resolve({ code: 'Escape', key: 'Escape', ctrlKey: true })).toBeNull();
  });

  it('honours arrow availability', () => {
    expect(resolve({ code: 'ArrowLeft', key: 'ArrowLeft', ctrlKey: true }, NOTHING_AVAILABLE)).toBeNull();
    expect(resolve({ code: 'ArrowRight', key: 'ArrowRight', altKey: true }, NOTHING_AVAILABLE)).toBeNull();
  });
});

describe('runner keymap — Backspace, Escape, and native keys', () => {
  it('maps Backspace to back when undo is available', () => {
    expect(resolve({ code: 'Backspace', key: 'Backspace' })).toBe('back');
    expect(resolve({ code: 'Backspace', key: 'Backspace' }, NOTHING_AVAILABLE)).toBeNull();
  });

  it('leaves Ctrl+Backspace alone', () => {
    expect(resolve({ code: 'Backspace', key: 'Backspace', ctrlKey: true })).toBeNull();
  });

  it('maps Escape to close', () => {
    expect(resolve({ code: 'Escape', key: 'Escape' }, NOTHING_AVAILABLE)).toBe('close');
  });

  it.each(['Enter', 'Space', 'Tab', 'ArrowUp', 'KeyA', 'F1'])(
    'leaves %s native',
    (code) => {
      expect(resolve({ code, key: code })).toBeNull();
    },
  );
});

describe('runner keymap — composition and text entry', () => {
  it('ignores keys during IME composition', () => {
    expect(resolve({ code: 'KeyZ', key: 'z', isComposing: true })).toBeNull();
    expect(resolve({ code: 'Digit1', key: '1', isComposing: true })).toBeNull();
    expect(resolve({ code: 'KeyZ', key: 'z', keyCode: 229 })).toBeNull();
  });

  it.each(['INPUT', 'TEXTAREA', 'SELECT'])('ignores plain keys from %s', (tagName) => {
    expect(resolve({ code: 'KeyZ', key: 'z', target: { tagName } })).toBeNull();
    expect(resolve({ code: 'Digit1', key: '1', target: { tagName } })).toBeNull();
    expect(resolve({ code: 'Escape', key: 'Escape', target: { tagName } })).toBeNull();
  });

  it('ignores plain keys from contenteditable hosts', () => {
    expect(resolve({
      code: 'KeyZ',
      key: 'z',
      target: { tagName: 'DIV', isContentEditable: true },
    })).toBeNull();
  });

  it('detects text-entry targets by shape only', () => {
    expect(isTextEntryTarget(null)).toBe(false);
    expect(isTextEntryTarget(undefined)).toBe(false);
    expect(isTextEntryTarget({ tagName: 'DIV' })).toBe(false);
    expect(isTextEntryTarget({ tagName: 'input' })).toBe(true);
    expect(isTextEntryTarget({ tagName: 'SPAN', isContentEditable: true })).toBe(true);
  });
});
