import { beforeEach, describe, expect, it } from 'vitest';

import { WorkspaceLeaf } from 'obsidian';
import {
  PluginMenuView,
  PLUGIN_MENU_VIEW_TYPE,
} from '../../views/plugin-menu-view';
import { I18nService } from '../../i18n';
import enLocale from '../../i18n/locales/en.json';
import ruLocale from '../../i18n/locales/ru.json';

const executedCommandIds: string[] = [];

function createView(locale: 'en' | 'ru' = 'en'): PluginMenuView {
  const app = {
    commands: {
      executeCommandById: (commandId: string) => {
        executedCommandIds.push(commandId);
      },
    },
  };
  const leaf = new (WorkspaceLeaf as unknown as new (app: unknown) => WorkspaceLeaf)(app);
  const plugin = { i18n: new I18nService(locale) };
  return new PluginMenuView(leaf, plugin as never);
}

describe('PluginMenuView', () => {
  beforeEach(() => {
    executedCommandIds.length = 0;
  });

  it('exposes a stable view type, display text, and icon', () => {
    const view = createView();
    expect(view.getViewType()).toBe(PLUGIN_MENU_VIEW_TYPE);
    expect(PLUGIN_MENU_VIEW_TYPE).toBe('radiprotocol-plugin-menu');
    expect(view.getDisplayText()).toBe('Protocol Former menu');
    expect(view.getIcon()).toBe('layout-list');
  });

  it('renders one labeled menu item per registered command', async () => {
    const view = createView();
    await view.onOpen();

    // The shared mock supports only simple selectors (.class / tag), so query
    // by class and assert the tag separately.
    const items = Array.from(view.contentEl.querySelectorAll('.rp-plugin-menu-item'));
    expect(items.length).toBe(8);
    expect(items.every((item) => item.tagName === 'BUTTON')).toBe(true);
    const labels = items.map(
      (item) => item.querySelector('.rp-plugin-menu-item-label')?.textContent,
    );
    expect(labels).toContain('Run protocol');
    expect(labels).toContain('Start from specific node');
    expect(labels).toContain('Open protocol editor');
    expect(labels).not.toContain('Open plugin menu');
  });

  it('dispatches the fully-qualified command id when an item is clicked', async () => {
    const view = createView();
    await view.onOpen();

    const items = Array.from(view.contentEl.querySelectorAll('.rp-plugin-menu-item'));
    const runItem = items.find(
      (item) => item.querySelector('.rp-plugin-menu-item-label')?.textContent === 'Run protocol',
    );
    expect(runItem).toBeDefined();
    (runItem as unknown as { click(): void }).click();
    expect(executedCommandIds).toEqual(['radiprotocol:run-protocol-inline']);
  });

  it('renders localized labels in Russian', async () => {
    const view = createView('ru');
    await view.onOpen();

    expect(view.getDisplayText()).toBe('Меню Protocol Former');
    const labels = Array.from(
      view.contentEl.querySelectorAll('.rp-plugin-menu-item-label'),
    ).map((el) => el.textContent);
    expect(labels).toContain('Запустить протокол');
    expect(labels).toContain('Старт с конкретного узла');
  });

  it('clears the content element on close', async () => {
    const view = createView();
    await view.onOpen();
    expect(view.contentEl.querySelectorAll('button').length).toBeGreaterThan(0);
    await view.onClose();
    expect(view.contentEl.querySelectorAll('button').length).toBe(0);
  });

  it('keeps en/ru pluginMenu catalogs in parity', () => {
    const en = enLocale as unknown as Record<string, Record<string, string>>;
    const ru = ruLocale as unknown as Record<string, Record<string, string>>;
    expect(Object.keys(en.pluginMenu ?? {}).sort()).toEqual(Object.keys(ru.pluginMenu ?? {}).sort());
  });
});
