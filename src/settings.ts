// settings.ts
import type { App } from 'obsidian';
import { PluginSettingTab, Setting, Notice } from 'obsidian';
import type RadiProtocolPlugin from './main';
import { FolderSuggest } from './views/folder-suggest';
import { DONATE_WALLETS } from './donate/wallets';
import { normalizeProtocolFolderPath } from './protocol/protocol-file-resolver';
import {
  countInvalidPhrases,
  DEFAULT_TEXT_EXPANSION_PHRASES,
  isValidTrigger,
  phraseMatchesQuery,
  type ExpansionRule,
} from './expansion/rules';

/** Phase 67 (D-05): renamed from InlineRunnerPosition; width/height optional for back-compat (D-06).
 *  Existing on-disk records have only {left, top}; missing width/height fall back to
 *  INLINE_RUNNER_DEFAULT_WIDTH (360) / INLINE_RUNNER_DEFAULT_HEIGHT (240) in the modal layer.
 *  Settings field name `inlineRunnerPosition` is intentionally NOT renamed — preserves
 *  on-disk back-compat per Standing Pitfall #11. */
export interface InlineRunnerLayout {
  left: number;
  top: number;
  width?: number;
  height?: number;
}

export interface RadiProtocolSettings {
  /** Vault-relative path for snippet JSON files (D-15, SNIP-08). Default: .radiprotocol/snippets */
  snippetFolderPath: string;
  /** Phase 33 (D-17): Tree-view expanded-folder paths, persisted across sessions. */
  snippetTreeExpandedPaths: string[];
  /** Vault-relative folder scanned for .rp.json protocol files. Default: '' (empty). */
  protocolFolderPath: string;
  /** Separator inserted before each new text chunk in the runner (D-08, SEP-01). Default: 'newline'. */
  textSeparator: 'newline' | 'space';
  /** Present runner sessions in independent transient right-sidebar leaves. Absent = false for compatibility. */
  useSidebarRunner?: boolean;
  /** Show the session-only conclusion scratchpad in the runner. Absent = enabled. */
  enableRunnerDraft?: boolean;
  /** Start each runner session with the keyboard hint row visible. Absent = enabled. */
  showRunnerKeyHints?: boolean;
  /** Phase 60 (D-01): Last dragged inline runner position; Phase 67 (D-05/D-06) extended with optional width/height. */
  inlineRunnerPosition?: InlineRunnerLayout | null;
  /** Phase 84 (I18N-01): UI language. Default 'en' for new installs; existing installs without this key default to 'ru' for backward compat. */
  locale: 'en' | 'ru';
  /** Slice 9 — community library registry endpoint override (advanced).
   *  Empty/undefined → bundled REGISTRY_URLS list.
   *  Non-https/invalid URLs are normalized to '' by the registry client,
   *  which makes the catalog unavailable. */
  libraryRegistryUrl?: string;
  /** Library submission bookkeeping: last submitted release version per packageId,
   *  so the export modal can auto-suggest the next version (+0.0.1). Legacy
   *  advisory field (Stage D): kept for backward compat, superseded by
   *  librarySubmissionBindings as the identity/version source of truth. */
  libraryLastSubmittedVersions?: Record<string, string>;
  /** Stage D — persistent submission identity: binding key
   *  `<registryKey>|<protocolDoc.id>` → { packageId, lastAcceptedVersion? }.
   *  Path is a hint, NOT identity: renaming a protocol file must not create a
   *  new package, and a title change must not re-derive the packageId. Written
   *  only after a confirmed API result (cancel/error never bumps the version). */
  librarySubmissionBindings?: Record<string, { packageId: string; lastAcceptedVersion?: string }>;
  /** Last vault folder used for a local package export (empty = never exported). */
  libraryLastExportFolder?: string;
  /** Typed text expansion (the Substitutions / Text Snippets replacement). Absent = off. */
  textExpansionEnabled?: boolean;
  /** Structured phrase list edited on its own settings page. */
  textExpansionPhrases?: ExpansionRule[];
  /** Also expand inside the note editor. Absent = true. */
  textExpansionInEditor?: boolean;
  /** @deprecated 3.6.21 text format; read once by main.ts and replaced by textExpansionPhrases. */
  textExpansionRules?: string;
  /** @deprecated 3.6.21 global mode; read once by main.ts and replaced by per-phrase modes. */
  textExpansionMode?: 'auto' | 'delimiter';
}

export const DEFAULT_SETTINGS: RadiProtocolSettings = {
  snippetFolderPath: 'Snippets',
  snippetTreeExpandedPaths: [],
  protocolFolderPath: 'Protocols',
  textSeparator: 'newline',
  useSidebarRunner: false,
  enableRunnerDraft: true,
  showRunnerKeyHints: true,
  inlineRunnerPosition: null,
  locale: 'en',
  libraryRegistryUrl: '',
  libraryLastSubmittedVersions: {},
  librarySubmissionBindings: {},
  libraryLastExportFolder: '',
  textExpansionEnabled: false,
  textExpansionPhrases: DEFAULT_TEXT_EXPANSION_PHRASES.map((phrase) => ({ ...phrase })),
  textExpansionInEditor: true,
};

type SettingsPage = 'main' | 'phrases';

interface PhraseRowEntry {
  phrase: ExpansionRule;
  rowEl: HTMLElement;
  triggerInputEl: HTMLInputElement;
}

export class RadiProtocolSettingsTab extends PluginSettingTab {
  private readonly plugin: RadiProtocolPlugin;
  private page: SettingsPage = 'main';
  private expansionSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private phrasesStatusEl: HTMLElement | null = null;
  /** Search text; deleting a row re-renders and keeps it, adding a row clears it. */
  private phraseSearchQuery = '';
  private phraseRows: PhraseRowEntry[] = [];
  private phraseNoMatchesEl: HTMLElement | null = null;

  constructor(app: App, plugin: RadiProtocolPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    this.phrasesStatusEl = null;
    this.phraseNoMatchesEl = null;
    this.phraseRows = [];

    if (this.page === 'phrases') {
      this.displayPhrasesPage();
      return;
    }
    this.displayMainPage();
  }

  /** Reopening the tab starts on the main page, not on a nested list. */
  hide(): void {
    this.page = 'main';
    this.phraseSearchQuery = '';
    super.hide();
  }

  private displayMainPage(): void {
    const { containerEl } = this;
    const t = (key: string, params?: Record<string, string>) => this.plugin.i18n.t(key, params);

    // Group 0 — Language (Phase 84 I18N-01)
    new Setting(containerEl)
      .setName(this.plugin.i18n.t('settings.language', undefined, 'Language'))
      .setHeading();

    new Setting(containerEl)
      .setName(t('settings.languageLabel'))
      .setDesc(t('settings.languageDesc'))
      .addDropdown(drop => drop
        .addOption('en', t('settings.english'))
        .addOption('ru', t('settings.russian'))
        .setValue(this.plugin.settings.locale)
        .onChange(async (value) => {
          this.plugin.settings.locale = value as 'en' | 'ru';
          this.plugin.i18n.setLocale(this.plugin.settings.locale);
          await this.plugin.saveSettings();
          // Refresh the settings tab so all headings re-render in the new language.
          this.display();
        })
      );

    new Setting(containerEl)
      .setName(t('settings.textSeparator'))
      .setDesc(t('settings.textSeparatorDesc'))
      .addDropdown(drop => {
        drop
          .addOption('newline', t('settings.newline'))
          .addOption('space', t('settings.space'))
          .setValue(this.plugin.settings.textSeparator)
          .onChange(value => {
            this.plugin.settings.textSeparator = value as 'newline' | 'space';
            void this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(t('settings.useSidebarRunner'))
      .setDesc(t('settings.useSidebarRunnerDesc'))
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.useSidebarRunner === true)
        .onChange(async (value) => {
          this.plugin.settings.useSidebarRunner = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName(t('settings.enableRunnerDraft'))
      .setDesc(t('settings.enableRunnerDraftDesc'))
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableRunnerDraft !== false)
        .onChange(async (value) => {
          this.plugin.settings.enableRunnerDraft = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName(t('settings.runnerKeyHints'))
      .setDesc(t('settings.runnerKeyHintsDesc'))
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.showRunnerKeyHints !== false)
        .onChange(async (value) => {
          this.plugin.settings.showRunnerKeyHints = value;
          await this.plugin.saveSettings();
        }));

    this.renderRunnerKeyReference(containerEl);

    // Group 1.5 — Typed text expansion (the Substitutions / Text Snippets replacement)
    new Setting(containerEl).setName(t('settings.expansionHeading')).setHeading();

    new Setting(containerEl)
      .setName(t('settings.textExpansionEnabled'))
      .setDesc(t('settings.textExpansionEnabledDesc'))
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.textExpansionEnabled === true)
        .onChange(async (value) => {
          this.plugin.settings.textExpansionEnabled = value;
          this.plugin.applyTextExpansionSettings();
          await this.plugin.saveSettings();
        }));

    const phrases = this.getPhrases();
    new Setting(containerEl)
      .setName(t('settings.textExpansionPhrases'))
      .setDesc(t('settings.textExpansionPhrasesDesc', { count: String(phrases.length) }))
      .addButton(button => button
        .setButtonText(t('settings.textExpansionManagePhrases'))
        .setIcon('list')
        .onClick(() => {
          this.page = 'phrases';
          this.display();
        }));

    new Setting(containerEl)
      .setName(t('settings.textExpansionInEditor'))
      .setDesc(t('settings.textExpansionInEditorDesc'))
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.textExpansionInEditor !== false)
        .onChange(async (value) => {
          this.plugin.settings.textExpansionInEditor = value;
          this.plugin.applyTextExpansionSettings();
          await this.plugin.saveSettings();
        }));

    // Group 2 — Storage
    new Setting(containerEl).setName(t('settings.storageHeading')).setHeading();

    new Setting(containerEl)
      .setName(t('settings.protocolFolder'))
      .setDesc(t('settings.protocolFolderDesc'))
      .addText(text => {
        new FolderSuggest(this.app, text.inputEl);
        text
          .setPlaceholder(t('settings.protocolFolderPlaceholder'))
          .setValue(this.plugin.settings.protocolFolderPath)
          .onChange(async (value) => {
            this.plugin.settings.protocolFolderPath = normalizeProtocolFolderPath(value);
            await this.plugin.saveSettings();
            // LibraryService and LibraryInstaller capture managed roots at
            // construction, so rebuild only after the new value is persisted.
            await this.plugin.rebuildLibraryServices();
          });
      });

    new Setting(containerEl)
      .setName(t('settings.snippetFolder'))
      .setDesc(t('settings.snippetFolderDesc'))
      .addText(text => {
        new FolderSuggest(this.app, text.inputEl);
        text
          .setPlaceholder(t('settings.snippetFolderPathPlaceholder'))
          .setValue(this.plugin.settings.snippetFolderPath)
          .onChange(async (value) => {
            this.plugin.settings.snippetFolderPath = normalizeProtocolFolderPath(value) || 'Snippets';
            await this.plugin.saveSettings();
            await this.plugin.rebuildLibraryServices();
          });
      });

    // Group — Advanced (Slice 9 — community library)
    new Setting(containerEl).setName(t('settings.advancedHeading')).setHeading();

    new Setting(containerEl)
      .setName(t('settings.libraryRegistryUrl'))
      .setDesc(t('settings.libraryRegistryUrlDesc'))
      .addText(text => {
        text
          .setPlaceholder(t('settings.libraryRegistryUrlPlaceholder'))
          .setValue(this.plugin.settings.libraryRegistryUrl ?? '')
          .onChange(async (value) => {
            this.plugin.settings.libraryRegistryUrl = value.trim();
            await this.plugin.saveSettings();
            // Step 5 C12: recreate the registry client + library service so the
            // override takes effect immediately (baseUrl is captured at construction).
            await this.plugin.rebuildLibraryServices();
          });
      });

    // Quick 260430-s48: relocated to bottom; addresses collapsed behind <details>.
    // Stateless: addresses are hard-coded constants in ./donate/wallets, no settings persistence.
    new Setting(containerEl).setName(t('settings.donateHeading')).setHeading();

    containerEl.createEl('p', {
      text: this.plugin.i18n.t('donate.invitation'),
      cls: 'rp-donate-intro',
    });

    // Quick 260430-s48: addresses collapsed by default to reduce settings-tab clutter.
    const detailsEl = containerEl.createEl('details', { cls: 'rp-donate-details' });
    detailsEl.createEl('summary', {
      text: t('settings.showWalletAddresses'),
      cls: 'rp-donate-summary',
    });

    for (const wallet of DONATE_WALLETS) {
      const desc = wallet.networks ? wallet.networks.join(' · ') : '';
      const { address } = wallet;
      const setting = new Setting(detailsEl)
        .setName(wallet.name)
        .setDesc(desc);
      setting.descEl.createEl('code', {
        text: address,
        cls: 'rp-donate-address',
      });
      setting.addExtraButton(btn => btn
        .setIcon('copy')
        .setTooltip(t('donate.copyAddress'))
        .onClick(() => {
          void navigator.clipboard.writeText(address).then(() => {
            new Notice(t('donate.addressCopied'));
          });
        })
      );
    }
  }

  /** The phrase list is a nested page of the same settings tab. */
  private displayPhrasesPage(): void {
    const { containerEl } = this;
    const t = (key: string, params?: Record<string, string>) => this.plugin.i18n.t(key, params);

    const backRow = new Setting(containerEl);
    backRow.settingEl.addClass('rp-settings-back-row');
    backRow.addButton(button => button
      .setButtonText(t('settings.back'))
      .setIcon('arrow-left')
      .onClick(() => {
        this.page = 'main';
        this.phraseSearchQuery = '';
        this.display();
      }));

    new Setting(containerEl)
      .setName(t('settings.textExpansionPhrasesPageTitle'))
      .setHeading();

    containerEl.createEl('p', {
      text: t('settings.textExpansionPhrasesPageDesc'),
      cls: 'rp-phrase-hint',
    });

    if (this.plugin.settings.textExpansionEnabled !== true) {
      containerEl.createEl('p', {
        text: t('settings.textExpansionPhrasesDisabled'),
        cls: 'rp-phrase-hint rp-phrase-disabled-hint',
      });
    }

    const statusEl = containerEl.createEl('p', { cls: 'rp-phrase-status is-hidden' });
    this.phrasesStatusEl = statusEl;

    this.renderPhrasesToolbar(containerEl);

    const listEl = containerEl.createDiv({ cls: 'rp-phrase-list' });
    const phrases = this.getPhrases();
    if (phrases.length === 0) {
      listEl.createEl('p', {
        text: t('settings.textExpansionPhrasesEmpty'),
        cls: 'rp-phrase-empty',
      });
    }
    phrases.forEach((phrase, index) => {
      this.phraseRows.push(this.renderPhraseRow(listEl, phrase, index));
    });
    this.phraseNoMatchesEl = listEl.createEl('p', {
      cls: 'rp-phrase-no-matches is-hidden',
    });
    this.applyPhraseFilter();
    this.updatePhrasesStatus(statusEl, phrases);

    containerEl.createEl('p', {
      text: t('settings.textExpansionHotkeyHint'),
      cls: 'rp-phrase-hint',
    });
  }

  /** Search and add live above the list so a long phrase list needs no scrolling. */
  private renderPhrasesToolbar(containerEl: HTMLElement): void {
    const t = (key: string, params?: Record<string, string>) => this.plugin.i18n.t(key, params);
    const toolbar = new Setting(containerEl);
    toolbar.settingEl.addClass('rp-phrase-toolbar');

    toolbar.addText(text => {
      text.inputEl.type = 'search';
      text.inputEl.addClass('rp-phrase-search');
      text.inputEl.setAttribute('aria-label', t('settings.textExpansionPhraseSearch'));
      text
        .setPlaceholder(t('settings.textExpansionPhraseSearchPlaceholder'))
        .setValue(this.phraseSearchQuery)
        .onChange((value) => {
          this.phraseSearchQuery = value;
          this.applyPhraseFilter();
        });
    });

    toolbar.addButton(button => button
      .setCta()
      .setButtonText(t('settings.textExpansionAddPhrase'))
      .onClick(() => this.addPhrase()));
  }

  /** Adds a blank row at the top, where the search/add toolbar is, and focuses it. */
  private addPhrase(): void {
    this.getPhrases().unshift({ trigger: '', replacement: '', mode: 'auto' });
    this.phraseSearchQuery = '';
    this.persistPhrases();
    this.display();
    this.phraseRows[0]?.triggerInputEl.focus();
  }

  /** Toggles row visibility in place, so typing in the search field keeps focus. */
  private applyPhraseFilter(): void {
    let visible = 0;
    for (const row of this.phraseRows) {
      const matches = phraseMatchesQuery(row.phrase, this.phraseSearchQuery);
      row.rowEl.toggleClass('is-hidden', !matches);
      if (matches) visible += 1;
    }

    const noMatchesEl = this.phraseNoMatchesEl;
    if (noMatchesEl === null) return;
    const show = this.phraseSearchQuery.trim() !== ''
      && this.phraseRows.length > 0
      && visible === 0;
    noMatchesEl.toggleClass('is-hidden', !show);
    noMatchesEl.setText(show
      ? this.plugin.i18n.t('settings.textExpansionPhrasesNoMatches', {
        query: this.phraseSearchQuery.trim(),
      })
      : '');
  }

  private renderPhraseRow(
    parent: HTMLElement,
    phrase: ExpansionRule,
    index: number,
  ): PhraseRowEntry {
    const t = (key: string, params?: Record<string, string>) => this.plugin.i18n.t(key, params);
    const setting = new Setting(parent);
    setting.settingEl.addClass('rp-phrase-row');
    let triggerInputEl: HTMLInputElement | null = null;

    setting.addText(text => {
      triggerInputEl = text.inputEl;
      text.inputEl.addClass('rp-phrase-trigger');
      text.inputEl.setAttribute('aria-label', t('settings.textExpansionPhraseTrigger'));
      text.inputEl.setAttribute('data-rp-phrase-index', String(index));
      const markValidity = (value: string): void => {
        const valid = isValidTrigger(value);
        text.inputEl.toggleClass('rp-phrase-trigger-invalid', !valid);
        text.inputEl.setAttribute('aria-invalid', String(!valid));
      };
      markValidity(phrase.trigger);
      text
        .setPlaceholder(t('settings.textExpansionPhraseTriggerPlaceholder'))
        .setValue(phrase.trigger)
        .onChange((value) => {
          phrase.trigger = value;
          markValidity(value);
          this.onPhrasesEdited();
        });
    });

    setting.addText(text => {
      text.inputEl.addClass('rp-phrase-replacement');
      text.inputEl.setAttribute('aria-label', t('settings.textExpansionPhraseReplacement'));
      text.inputEl.setAttribute('data-rp-phrase-index', String(index));
      text
        .setPlaceholder(t('settings.textExpansionPhraseReplacementPlaceholder'))
        .setValue(phrase.replacement)
        .onChange((value) => {
          phrase.replacement = value;
          this.onPhrasesEdited();
        });
    });

    const isHotkey = phrase.mode === 'hotkey';
    setting.addExtraButton(button => button
      .setIcon(isHotkey ? 'keyboard' : 'zap')
      .setTooltip(isHotkey
        ? t('settings.textExpansionPhraseModeToAuto')
        : t('settings.textExpansionPhraseModeToHotkey'))
      .onClick(() => {
        const toHotkey = phrase.mode !== 'hotkey';
        phrase.mode = toHotkey ? 'hotkey' : 'auto';
        // Update in place so a long list keeps its scroll position.
        button
          .setIcon(toHotkey ? 'keyboard' : 'zap')
          .setTooltip(toHotkey
            ? t('settings.textExpansionPhraseModeToAuto')
            : t('settings.textExpansionPhraseModeToHotkey'));
        this.persistPhrases();
      }));

    setting.addExtraButton(button => button
      .setIcon('trash')
      .setTooltip(t('settings.textExpansionPhraseDelete'))
      .onClick(() => {
        const phrases = this.getPhrases();
        const at = phrases.indexOf(phrase);
        if (at >= 0) phrases.splice(at, 1);
        this.persistPhrases();
        // Keep the current filter: deleting a match should not reset the search.
        this.display();
      }));

    return {
      phrase,
      rowEl: setting.settingEl,
      triggerInputEl: triggerInputEl!,
    };
  }

  /** Show how many rows are invalid; silently ignoring a typo looks like a broken trigger. */
  private updatePhrasesStatus(el: HTMLElement | null, phrases: ExpansionRule[]): void {
    if (el === null) return;
    const invalid = countInvalidPhrases(phrases);
    el.toggleClass('is-hidden', invalid === 0);
    el.setText(invalid === 0
      ? ''
      : this.plugin.i18n.t('settings.textExpansionPhrasesInvalid', { count: String(invalid) }));
  }

  private onPhrasesEdited(): void {
    this.plugin.applyTextExpansionSettings();
    this.updatePhrasesStatus(this.phrasesStatusEl, this.getPhrases());
    this.scheduleExpansionSave();
  }

  private persistPhrases(): void {
    this.plugin.applyTextExpansionSettings();
    void this.plugin.saveSettings();
  }

  /** The phrase inputs change per keystroke; persist them on a short delay. */
  private scheduleExpansionSave(): void {
    if (this.expansionSaveTimer !== null) clearTimeout(this.expansionSaveTimer);
    this.expansionSaveTimer = setTimeout(() => {
      this.expansionSaveTimer = null;
      void this.plugin.saveSettings();
    }, 400);
  }

  private getPhrases(): ExpansionRule[] {
    if (!Array.isArray(this.plugin.settings.textExpansionPhrases)) {
      this.plugin.settings.textExpansionPhrases = DEFAULT_TEXT_EXPANSION_PHRASES.map(
        (phrase) => ({ ...phrase }),
      );
    }
    return this.plugin.settings.textExpansionPhrases;
  }

  /** Inline cheat sheet opened from the same place as the visibility toggle. */
  private renderRunnerKeyReference(containerEl: HTMLElement): void {
    const t = (key: string) => this.plugin.i18n.t(key);
    const details = containerEl.createEl('details', { cls: 'rp-runner-keys-reference' });
    details.createEl('summary', {
      text: t('settings.runnerKeysReference'),
      cls: 'rp-runner-keys-summary',
    });

    const table = details.createEl('table', { cls: 'rp-runner-keys-table' });
    const body = table.createEl('tbody');
    const rows: Array<[string, string]> = [
      ['1–9', t('protocolRunner.hintChoose')],
      ['Z / Backspace', t('protocolRunner.hintBack')],
      ['X', t('protocolRunner.hintRedo')],
      ['Ctrl+← / Alt+←', t('settings.runnerKeyLegacyBack')],
      ['Ctrl+→ / Alt+→', t('settings.runnerKeyLegacyRedo')],
      ['S', t('protocolRunner.hintSkip')],
      ['F', t('protocolRunner.hintFreeText')],
      ['C', t('protocolRunner.hintConclusion')],
      ['V', t('protocolRunner.hintInsert')],
      ['Ctrl+Space', t('settings.runnerKeyConfirm')],
      ['Shift+Enter', t('settings.runnerKeyOldConfirm')],
      ['Enter', t('settings.runnerKeyDraftEnter')],
      ['Shift+Enter', t('settings.runnerKeyDraftNewline')],
      ['Tab / Shift+Tab', t('settings.runnerKeyTab')],
      ['j / k / Tab / Shift+Tab', t('settings.runnerKeyPicker')],
      ['H', t('protocolRunner.hintHints')],
      ['Esc', t('protocolRunner.hintClose')],
    ];

    for (const [keys, action] of rows) {
      const row = body.createEl('tr');
      const keyCell = row.createEl('td', { cls: 'rp-runner-keys-key' });
      keyCell.createEl('kbd', { text: keys });
      row.createEl('td', { text: action, cls: 'rp-runner-keys-action' });
    }
  }
}
