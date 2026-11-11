import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, RadiProtocolSettingsTab, type RadiProtocolSettings } from '../settings';
import { countInvalidPhrases, type ExpansionRule } from '../expansion/rules';
import {
  __getMockAbstractInputSuggestInstances,
  __getMockButtonComponents,
  __getMockExtraButtonComponents,
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

  it('defaults the runner conclusion draft and hint row to enabled', () => {
    expect(DEFAULT_SETTINGS.enableRunnerDraft).toBe(true);
    expect(DEFAULT_SETTINGS.showRunnerKeyHints).toBe(true);
  });

  it('defaults text expansion to disabled, editor enabled, with a valid structured phrase list', () => {
    expect(DEFAULT_SETTINGS.textExpansionEnabled).toBe(false);
    expect(DEFAULT_SETTINGS.textExpansionInEditor).toBe(true);
    expect('textExpansionMode' in DEFAULT_SETTINGS).toBe(false);
    expect('textExpansionRules' in DEFAULT_SETTINGS).toBe(false);
    const phrases = DEFAULT_SETTINGS.textExpansionPhrases ?? [];
    expect(phrases.length).toBeGreaterThan(0);
    expect(countInvalidPhrases(phrases)).toBe(0);
  });

  it('SettingsTab has display method (stub check)', async () => {
    // Full settings tab test requires Obsidian environment — manual only.
    // This stub verifies the class is importable and has the display method.
    const { RadiProtocolSettingsTab } = await import('../settings');
    expect(typeof RadiProtocolSettingsTab.prototype.display).toBe('function');
  });
});

function makePlugin(settings: Partial<RadiProtocolSettings> = {}) {
  const phrases = (settings.textExpansionPhrases ?? DEFAULT_SETTINGS.textExpansionPhrases ?? [])
    .map((phrase) => ({ ...phrase }));
  return {
    settings: { ...DEFAULT_SETTINGS, ...settings, textExpansionPhrases: phrases },
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
    tab,
    containerEl: tab.containerEl,
    textComponents: __getMockTextComponents(),
    suggesters: __getMockAbstractInputSuggestInstances(),
    toggleComponents: __getMockToggleComponents(),
    buttonComponents: __getMockButtonComponents(),
    extraButtonComponents: __getMockExtraButtonComponents(),
  };
}

function openPhrasesPage(settings: Partial<RadiProtocolSettings> = {}) {
  const rendered = renderSettings(settings);
  const manage = rendered.buttonComponents.find(
    (button) => button.text === 'settings.textExpansionManagePhrases',
  );
  expect(manage).toBeDefined();
  manage!.click!();
  // Drop the main-page controls so the returned component lists describe the
  // nested page only; the page itself is kept by `tab.page`.
  __resetObsidianMocks();
  rendered.tab.display();
  return rendered;
}

describe('Settings sidebar runner toggle', () => {
  it.each([false, true])(
    'renders the persisted initial value %s',
    (useSidebarRunner) => {
      const { toggleComponents } = renderSettings({ useSidebarRunner });

      // sidebar, conclusion draft, hint row, expansion enabled, expansion-in-editor
      expect(toggleComponents).toHaveLength(5);
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

      expect(toggleComponents).toHaveLength(5);
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

describe('Settings runner hint row', () => {
  it.each([undefined, true, false])(
    'renders the persisted value %s (absent means enabled)',
    (showRunnerKeyHints) => {
      const { toggleComponents } = renderSettings({ showRunnerKeyHints });
      expect(toggleComponents[2]!.value).toBe(showRunnerKeyHints !== false);
    },
  );

  it('persists the visibility choice', async () => {
    const { plugin, toggleComponents } = renderSettings({ showRunnerKeyHints: true });

    await toggleComponents[2]!.trigger(false);
    expect(plugin.settings.showRunnerKeyHints).toBe(false);
    expect(plugin.saveSettingsCalls).toBe(1);
  });

  it('opens a shortcut reference table in the same section', () => {
    const { containerEl } = renderSettings();
    const table = containerEl.querySelector('.rp-runner-keys-table');
    expect(table).not.toBeNull();
    const rows = table!.querySelectorAll('tr');
    expect(rows).toHaveLength(17);
    expect(rows[0]!.querySelector('kbd')!.textContent).toBe('1–9');
  });
});

describe('Settings text expansion', () => {
  it.each([undefined, true, false])(
    'renders the persisted enabled value %s (absent means off)',
    (textExpansionEnabled) => {
      const { toggleComponents } = renderSettings({ textExpansionEnabled });
      expect(toggleComponents[3]!.value).toBe(textExpansionEnabled === true);
    },
  );

  it.each([undefined, true, false])(
    'renders the persisted editor value %s (absent means enabled)',
    (textExpansionInEditor) => {
      const { toggleComponents } = renderSettings({ textExpansionInEditor });
      expect(toggleComponents[4]!.value).toBe(textExpansionInEditor !== false);
      expect(toggleComponents).toHaveLength(5);
    },
  );

  it('persists enabling expansion and the editor scope', async () => {
    const { plugin, toggleComponents } = renderSettings();

    await toggleComponents[3]!.trigger(true);
    await toggleComponents[4]!.trigger(false);

    expect(plugin.settings.textExpansionEnabled).toBe(true);
    expect(plugin.settings.textExpansionInEditor).toBe(false);
    expect(plugin.saveSettingsCalls).toBe(2);
  });
});

describe('Settings phrase page', () => {
  it('opens the nested page with a search field and one trigger/insertion pair per phrase', () => {
    const { textComponents } = openPhrasesPage();
    const phrases = DEFAULT_SETTINGS.textExpansionPhrases ?? [];

    expect(textComponents).toHaveLength(phrases.length * 2 + 1);
    expect(textComponents[0]!.inputEl.classList.has('rp-phrase-search')).toBe(true);
    expect(textComponents[1]!.inputEl.value).toBe(phrases[0]!.trigger);
    expect(textComponents[2]!.inputEl.value).toBe(phrases[0]!.replacement);
  });

  it('returns to the main page with the back button', () => {
    const rendered = openPhrasesPage();
    const back = rendered.buttonComponents.find((button) => button.text === 'settings.back');

    expect(back).toBeDefined();
    __resetObsidianMocks();
    back!.click!();

    expect(__getMockTextComponents()).toHaveLength(3);
    expect(__getMockToggleComponents()).toHaveLength(5);
  });

  it('edits a trigger in place and saves after the debounce', async () => {
    vi.useFakeTimers();
    try {
      const { plugin, textComponents } = openPhrasesPage();
      const trigger = textComponents[1]!.inputEl as unknown as {
        value: string;
        dispatchEvent: (event: { type: string }) => boolean;
      };

      trigger.value = ';new';
      trigger.dispatchEvent({ type: 'input' });
      expect(plugin.settings.textExpansionPhrases![0]!.trigger).toBe(';new');

      await vi.advanceTimersByTimeAsync(400);
      expect(plugin.saveSettingsCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('switches a phrase between auto and hotkey with the icon button', () => {
    const { plugin, extraButtonComponents } = openPhrasesPage();

    // The first row's buttons are [mode, delete].
    expect(extraButtonComponents[0]!.icon).toBe('zap');
    extraButtonComponents[0]!.click!();

    expect(plugin.settings.textExpansionPhrases![0]!.mode).toBe('hotkey');
    expect(plugin.saveSettingsCalls).toBe(1);
    // The button updates in place: the list does not re-render, so scroll stays put.
    expect(extraButtonComponents[0]!.icon).toBe('keyboard');
    expect(extraButtonComponents[0]!.tooltip).toBe('settings.textExpansionPhraseModeToAuto');
  });

  it('adds a phrase at the top, clears the filter, and focuses its trigger field', () => {
    const rendered = openPhrasesPage();
    const initial = rendered.plugin.settings.textExpansionPhrases!.length;
    const search = rendered.textComponents[0]!.inputEl as unknown as {
      value: string;
      dispatchEvent: (event: { type: string }) => boolean;
    };

    search.value = 'no such phrase';
    search.dispatchEvent({ type: 'input' });

    const add = rendered.buttonComponents.find(
      (button) => button.text === 'settings.textExpansionAddPhrase',
    );
    expect(add).toBeDefined();
    add!.click!();

    expect(rendered.plugin.settings.textExpansionPhrases).toHaveLength(initial + 1);
    expect(rendered.plugin.settings.textExpansionPhrases![0]).toEqual({
      trigger: '',
      replacement: '',
      mode: 'auto',
    });
    expect(rendered.plugin.saveSettingsCalls).toBe(1);

    // The re-render appends a fresh search field (index 0) and the new blank row.
    const renderedPage = rendered.textComponents.slice(-((initial + 1) * 2 + 1));
    expect(renderedPage[0]!.inputEl.value).toBe('');
    expect(renderedPage[1]!.inputEl.value).toBe('');
    expect(renderedPage[1]!.inputEl.focused).toBe(true);

    // Newest page: first row's delete button.
    const newestButtons = __getMockExtraButtonComponents().slice(-((initial + 1) * 2));
    const deletes = newestButtons.filter((button) => button.icon === 'trash');
    deletes[0]!.click!();
    expect(rendered.plugin.settings.textExpansionPhrases).toHaveLength(initial);
  });

  it('filters rows by trigger or insertion and reports no matches', () => {
    const phrases: ExpansionRule[] = [
      { trigger: ';a', replacement: 'Alpha', mode: 'auto' },
      { trigger: ';b', replacement: 'Beta', mode: 'auto' },
      { trigger: ';c', replacement: 'Gamma', mode: 'auto' },
    ];
    const { containerEl, textComponents } = openPhrasesPage({ textExpansionPhrases: phrases });
    const search = textComponents[0]!.inputEl as unknown as {
      value: string;
      dispatchEvent: (event: { type: string }) => boolean;
    };
    const rows = Array.from(containerEl.querySelectorAll('.rp-phrase-row'));
    const noMatches = containerEl.querySelector('.rp-phrase-no-matches');
    const hiddenRows = (): boolean[] => rows.map(
      (row) => (row.classList as unknown as Set<string>).has('is-hidden'),
    );
    const noMatchesHidden = (): boolean => (
      noMatches!.classList as unknown as Set<string>
    ).has('is-hidden');
    expect(rows).toHaveLength(3);
    expect(noMatches).not.toBeNull();

    search.value = 'BETA';
    search.dispatchEvent({ type: 'input' });
    expect(hiddenRows()).toEqual([true, false, true]);
    expect(noMatchesHidden()).toBe(true);

    search.value = ';c';
    search.dispatchEvent({ type: 'input' });
    expect(hiddenRows()).toEqual([true, true, false]);

    search.value = 'missing';
    search.dispatchEvent({ type: 'input' });
    expect(hiddenRows()).toEqual([true, true, true]);
    expect(noMatchesHidden()).toBe(false);

    search.value = '';
    search.dispatchEvent({ type: 'input' });
    expect(hiddenRows()).toEqual([false, false, false]);
    expect(noMatchesHidden()).toBe(true);
  });

  it('keeps the search and add controls above the phrase list', () => {
    const { containerEl } = openPhrasesPage();
    const toolbar = containerEl.querySelector('.rp-phrase-toolbar');
    const list = containerEl.querySelector('.rp-phrase-list');
    const children = Array.from(containerEl.children);

    expect(toolbar).not.toBeNull();
    expect(list).not.toBeNull();
    expect(children.indexOf(toolbar!)).toBeLessThan(children.indexOf(list!));
  });

  it('shows already stored custom phrases in the same order', () => {
    const phrases: ExpansionRule[] = [
      { trigger: ';a', replacement: 'First', mode: 'hotkey' },
      { trigger: ';b', replacement: 'Second', mode: 'auto' },
    ];
    const { textComponents, extraButtonComponents } = openPhrasesPage({ textExpansionPhrases: phrases });

    expect(textComponents.slice(1).map((component) => component.inputEl.value)).toEqual([
      ';a', 'First', ';b', 'Second',
    ]);
    expect(extraButtonComponents[0]!.icon).toBe('keyboard');
    expect(extraButtonComponents[2]!.icon).toBe('zap');
  });
});

describe('Settings folder autocomplete (SETTINGS-01)', () => {
  beforeEach(() => {
    __resetObsidianMocks();
  });

  it('attaches folder suggesters to Protocol and Snippet fields only', () => {
    const { textComponents, suggesters } = renderSettings();

    // protocol folder, snippet folder, library URL
    expect(textComponents).toHaveLength(3);
    expect(suggesters).toHaveLength(2);
    expect(suggesters.map((suggester: { textInputEl: unknown }) => suggester.textInputEl)).toEqual([
      textComponents[0]!.inputEl,
      textComponents[1]!.inputEl,
    ]);
  });

  it('typing wired fields still persists through field-specific save handlers', async () => {
    const { plugin, textComponents } = renderSettings({
      protocolFolderPath: 'Old Protocols',
      snippetFolderPath: 'Old Snippets',
    });
    const [protocolText, snippetText] = textComponents;

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
