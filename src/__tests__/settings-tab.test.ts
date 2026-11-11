import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, RadiProtocolSettingsTab, type RadiProtocolSettings } from '../settings';
import { parseRuleLines } from '../expansion/rules';
import {
  __getMockAbstractInputSuggestInstances,
  __getMockTextComponents,
  __getMockToggleComponents,
  __resetObsidianMocks,
} from '../__mocks__/obsidian';

describe('Settings defaults (RUN-07)', () => {
  it('RUN-07: no legacy loop-iteration-cap field on DEFAULT_SETTINGS', () => {
    expect('maxLoopIterations' in DEFAULT_SETTINGS).toBe(false);
  });

  it('DEFAULT_SETTINGS: snippetFolderPath defaults to Snippets', () => {
    expect(DEFAULT_SETTINGS.snippetFolderPath).toBe('Snippets');
  });

  it('DEFAULT_SETTINGS: protocolFolderPath defaults to Protocols', () => {
    expect(DEFAULT_SETTINGS.protocolFolderPath).toBe('Protocols');
  });

  it('defaults sidebar presentation to disabled for new and migrated installs', () => {
    expect(DEFAULT_SETTINGS.useSidebarRunner).toBe(false);
  });

  it('defaults the runner conclusion draft to enabled', () => {
    expect(DEFAULT_SETTINGS.enableRunnerDraft).toBe(true);
  });

  it('defaults text expansion to disabled, auto mode, editor enabled, with valid starter rules', () => {
    expect(DEFAULT_SETTINGS.textExpansionEnabled).toBe(false);
    expect(DEFAULT_SETTINGS.textExpansionMode).toBe('auto');
    expect(DEFAULT_SETTINGS.textExpansionInEditor).toBe(true);
    const { rules, invalid } = parseRuleLines(DEFAULT_SETTINGS.textExpansionRules ?? '');
    expect(invalid).toEqual([]);
    expect(rules.length).toBeGreaterThan(0);
  });

  it('SettingsTab has display method (stub check)', async () => {
    // Full settings tab test requires Obsidian environment — manual only.
    // This stub verifies the class is importable and has the display method.
    const { RadiProtocolSettingsTab } = await import('../settings');
    expect(typeof RadiProtocolSettingsTab.prototype.display).toBe('function');
  });
});

function makePlugin(settings: Partial<RadiProtocolSettings> = {}) {
  return {
    settings: { ...DEFAULT_SETTINGS, ...settings },
    saveSettingsCalls: 0,
    rebuildLibraryServicesCalls: 0,
    lifecycle: [] as string[],
    async saveSettings() {
      this.saveSettingsCalls += 1;
      this.lifecycle.push('save:start');
      await Promise.resolve();
      this.lifecycle.push('save:end');
    },
    async rebuildLibraryServices() {
      this.rebuildLibraryServicesCalls += 1;
      this.lifecycle.push('rebuild');
    },
    // Text expansion settings push a parsed snapshot; nothing to assert here.
    applyTextExpansionSettings() {},
    i18n: {
      t: (key: string, _params?: Record<string, string>, fallback?: string) => fallback ?? key,
      setLocale: () => {},
      getLocale: () => 'en' as const,
    },
  };
}

async function flushAsyncChanges(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function makeApp() {
  return {
    vault: {
      getAllFolders: () => [
        { path: '' },
        { path: 'Protocols' },
        { path: 'Protocols/CT' },
        { path: 'RadiProtocol Output' },
        { path: '.radiprotocol/snippets' },
      ],
    },
  };
}

function renderSettings(settings: Partial<RadiProtocolSettings> = {}) {
  __resetObsidianMocks();
  const app = makeApp();
  const plugin = makePlugin(settings);
  const tab = new RadiProtocolSettingsTab(app as never, plugin as never);

  tab.display();

  return {
    app,
    plugin,
    textComponents: __getMockTextComponents(),
    suggesters: __getMockAbstractInputSuggestInstances(),
    toggleComponents: __getMockToggleComponents(),
  };
}

describe('Settings sidebar runner toggle', () => {
  it.each([false, true])(
    'renders the persisted initial value %s',
    (useSidebarRunner) => {
      const { toggleComponents } = renderSettings({ useSidebarRunner });

      // sidebar, conclusion draft, text expansion, expansion-in-editor
      expect(toggleComponents).toHaveLength(4);
      expect(toggleComponents[0]!.value).toBe(useSidebarRunner);
    },
  );

  it('persists toggle changes through saveSettings', async () => {
    const { plugin, toggleComponents } = renderSettings({ useSidebarRunner: false });

    await toggleComponents[0]!.trigger(true);
    expect(plugin.settings.useSidebarRunner).toBe(true);
    expect(plugin.saveSettingsCalls).toBe(1);

    await toggleComponents[0]!.trigger(false);
    expect(plugin.settings.useSidebarRunner).toBe(false);
    expect(plugin.saveSettingsCalls).toBe(2);
  });
});

describe('Settings runner conclusion draft toggle', () => {
  it.each([undefined, true, false])(
    'renders the persisted value %s (absent means enabled)',
    (enableRunnerDraft) => {
      const { toggleComponents } = renderSettings({ enableRunnerDraft });

      expect(toggleComponents).toHaveLength(4);
      expect(toggleComponents[1]!.value).toBe(enableRunnerDraft !== false);
    },
  );

  it('persists disabling and enabling without changing sidebar presentation', async () => {
    const { plugin, toggleComponents } = renderSettings({ useSidebarRunner: true });

    await toggleComponents[1]!.trigger(false);
    expect(plugin.settings.enableRunnerDraft).toBe(false);
    expect(plugin.saveSettingsCalls).toBe(1);

    await toggleComponents[1]!.trigger(true);
    expect(plugin.settings.enableRunnerDraft).toBe(true);
    expect(plugin.saveSettingsCalls).toBe(2);
    expect(plugin.settings.useSidebarRunner).toBe(true);
    expect(plugin.rebuildLibraryServicesCalls).toBe(0);
  });
});

describe('Settings folder autocomplete (SETTINGS-01)', () => {
  beforeEach(() => {
    __resetObsidianMocks();
  });

  it('attaches folder suggesters to Protocol and Snippet fields only', () => {
    const { textComponents, suggesters } = renderSettings();

    // protocol folder, snippet folder, library URL, and the expansion rules textarea
    expect(textComponents).toHaveLength(4);
    expect(suggesters).toHaveLength(2);
    // [0] is the expansion rules textarea; folder fields follow it.
    expect(suggesters.map((suggester: { textInputEl: unknown }) => suggester.textInputEl)).toEqual([
      textComponents[1]!.inputEl,
      textComponents[2]!.inputEl,
    ]);
  });

  it('typing wired fields still persists through field-specific save handlers', async () => {
    const { plugin, textComponents } = renderSettings({
      protocolFolderPath: 'Old Protocols',
      snippetFolderPath: 'Old Snippets',
    });
    const [, protocolText, snippetText] = textComponents;

    protocolText!.inputEl.value = ' /Protocols\\CT/ ';
    protocolText!.inputEl.dispatchEvent({ type: 'input', bubbles: true });
    await flushAsyncChanges();
    snippetText!.inputEl.value = '';
    snippetText!.inputEl.dispatchEvent({ type: 'input', bubbles: true });
    await flushAsyncChanges();

    expect(plugin.settings.protocolFolderPath).toBe('Protocols/CT');
    expect(plugin.settings.snippetFolderPath).toBe('Snippets');
    expect(plugin.saveSettingsCalls).toBe(2);
    expect(plugin.rebuildLibraryServicesCalls).toBe(2);
    expect(plugin.lifecycle).toEqual([
      'save:start', 'save:end', 'rebuild',
      'save:start', 'save:end', 'rebuild',
    ]);
  });

  it('selecting suggestions reaches the same save-on-change pathway as typing', async () => {
    const { plugin, suggesters } = renderSettings();

    suggesters[0]!.selectSuggestion('/Protocols\\MR/', {} as KeyboardEvent);
    await flushAsyncChanges();
    suggesters[1]!.selectSuggestion('.radiprotocol\\snippets\\CT/', {} as KeyboardEvent);
    await flushAsyncChanges();

    expect(plugin.settings.protocolFolderPath).toBe('Protocols/MR');
    expect(plugin.settings.snippetFolderPath).toBe('.radiprotocol/snippets/CT');
    expect(plugin.saveSettingsCalls).toBe(2);
    expect(plugin.rebuildLibraryServicesCalls).toBe(2);
    expect(plugin.lifecycle).toEqual([
      'save:start', 'save:end', 'rebuild',
      'save:start', 'save:end', 'rebuild',
    ]);
  });
});
