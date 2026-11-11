import { afterEach, describe, expect, it } from 'vitest';
import {
  getTextExpansionConfig,
  resetTextExpansionConfig,
  setTextExpansionConfig,
} from '../../expansion/config';
import type { ExpansionRule } from '../../expansion/rules';

const AUTO: ExpansionRule = { trigger: 'a', replacement: 'A', mode: 'auto' };
const HOTKEY: ExpansionRule = { trigger: 'h', replacement: 'H', mode: 'hotkey' };

afterEach(() => {
  resetTextExpansionConfig();
});

describe('text expansion config snapshot', () => {
  it('derives the command rule list from the mode lists when it is omitted', () => {
    setTextExpansionConfig({ enabled: true, autoRules: [AUTO], hotkeyRules: [HOTKEY] });
    expect(getTextExpansionConfig().allRules).toEqual([HOTKEY, AUTO]);
  });

  it('keeps the explicit list order so the first duplicate trigger wins', () => {
    setTextExpansionConfig({
      enabled: true,
      autoRules: [AUTO],
      hotkeyRules: [HOTKEY],
      allRules: [AUTO, HOTKEY],
    });
    expect(getTextExpansionConfig().allRules).toEqual([AUTO, HOTKEY]);
  });

  it('drops back to the disabled snapshot', () => {
    setTextExpansionConfig({ enabled: true, autoRules: [AUTO], hotkeyRules: [HOTKEY] });
    resetTextExpansionConfig();
    const config = getTextExpansionConfig();
    expect(config).toMatchObject({
      enabled: false,
      autoRules: [],
      hotkeyRules: [],
      allRules: [],
      inEditor: true,
    });
  });
});
