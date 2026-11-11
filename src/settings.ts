// settings.ts
import type { App } from 'obsidian';
import { PluginSettingTab, Setting, Notice } from 'obsidian';
import type RadiProtocolPlugin from './main';
import { FolderSuggest } from './views/folder-suggest';
import { DONATE_WALLETS } from './donate/wallets';
import { normalizeProtocolFolderPath } from './protocol/protocol-file-resolver';

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
}

export const DEFAULT_SETTINGS: RadiProtocolSettings = {
  snippetFolderPath: 'Snippets',
  snippetTreeExpandedPaths: [],
  protocolFolderPath: 'Protocols',
  textSeparator: 'newline',
  useSidebarRunner: false,
  enableRunnerDraft: true,
  inlineRunnerPosition: null,
  locale: 'en',
  libraryRegistryUrl: '',
  libraryLastSubmittedVersions: {},
  librarySubmissionBindings: {},
  libraryLastExportFolder: '',
};

export class RadiProtocolSettingsTab extends PluginSettingTab {
  private plugin: RadiProtocolPlugin;

  constructor(app: App, plugin: RadiProtocolPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // Group 0 — Language (Phase 84 I18N-01)
    new Setting(containerEl).setName(this.plugin.i18n.t('settings.language', undefined, 'Language')).setHeading();

    new Setting(containerEl)
      .setName(this.plugin.i18n.t('settings.languageLabel'))
      .setDesc(this.plugin.i18n.t('settings.languageDesc'))
      .addDropdown(drop => drop
        .addOption('en', this.plugin.i18n.t('settings.english'))
        .addOption('ru', this.plugin.i18n.t('settings.russian'))
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
      .setName(this.plugin.i18n.t('settings.textSeparator'))
      .setDesc(this.plugin.i18n.t('settings.textSeparatorDesc'))
      .addDropdown(drop => {
        drop
          .addOption('newline', this.plugin.i18n.t('settings.newline'))
          .addOption('space', this.plugin.i18n.t('settings.space'))
          .setValue(this.plugin.settings.textSeparator)
          .onChange(value => {
            this.plugin.settings.textSeparator = value as 'newline' | 'space';
            void this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(this.plugin.i18n.t('settings.useSidebarRunner'))
      .setDesc(this.plugin.i18n.t('settings.useSidebarRunnerDesc'))
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.useSidebarRunner === true)
        .onChange(async (value) => {
          this.plugin.settings.useSidebarRunner = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName(this.plugin.i18n.t('settings.enableRunnerDraft'))
      .setDesc(this.plugin.i18n.t('settings.enableRunnerDraftDesc'))
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableRunnerDraft !== false)
        .onChange(async (value) => {
          this.plugin.settings.enableRunnerDraft = value;
          await this.plugin.saveSettings();
        }));

    // Group 2 — Storage
    new Setting(containerEl).setName(this.plugin.i18n.t('settings.storageHeading')).setHeading();

    new Setting(containerEl)
      .setName(this.plugin.i18n.t('settings.protocolFolder'))
      .setDesc(this.plugin.i18n.t('settings.protocolFolderDesc'))
      .addText(text => {
        new FolderSuggest(this.app, text.inputEl);
        text
          .setPlaceholder(this.plugin.i18n.t('settings.protocolFolderPlaceholder'))
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
      .setName(this.plugin.i18n.t('settings.snippetFolder'))
      .setDesc(this.plugin.i18n.t('settings.snippetFolderDesc'))
      .addText(text => {
        new FolderSuggest(this.app, text.inputEl);
        text
          .setPlaceholder(this.plugin.i18n.t('settings.snippetFolderPathPlaceholder'))
          .setValue(this.plugin.settings.snippetFolderPath)
          .onChange(async (value) => {
            this.plugin.settings.snippetFolderPath = normalizeProtocolFolderPath(value) || 'Snippets';
            await this.plugin.saveSettings();
            await this.plugin.rebuildLibraryServices();
          });
      });

    // Group — Advanced (Slice 9 — community library)
    new Setting(containerEl).setName(this.plugin.i18n.t('settings.advancedHeading')).setHeading();

    new Setting(containerEl)
      .setName(this.plugin.i18n.t('settings.libraryRegistryUrl'))
      .setDesc(this.plugin.i18n.t('settings.libraryRegistryUrlDesc'))
      .addText(text => {
        text
          .setPlaceholder(this.plugin.i18n.t('settings.libraryRegistryUrlPlaceholder'))
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
    new Setting(containerEl).setName(this.plugin.i18n.t('settings.donateHeading')).setHeading();

    containerEl.createEl('p', {
      text: this.plugin.i18n.t('donate.invitation'),
      cls: 'rp-donate-intro',
    });

    // Quick 260430-s48: addresses collapsed by default to reduce settings-tab clutter.
    const detailsEl = containerEl.createEl('details', { cls: 'rp-donate-details' });
    detailsEl.createEl('summary', {
      text: this.plugin.i18n.t('settings.showWalletAddresses'),
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
        .setTooltip(this.plugin.i18n.t('donate.copyAddress'))
        .onClick(() => {
          void navigator.clipboard.writeText(address).then(() => {
            new Notice(this.plugin.i18n.t('donate.addressCopied'));
          });
        })
      );
    }
  }
}
