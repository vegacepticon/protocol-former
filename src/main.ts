// main.ts
import { Plugin, Notice, TFile, SuggestModal, MarkdownView, WorkspaceLeaf } from 'obsidian';
import { RadiProtocolSettings, DEFAULT_SETTINGS, RadiProtocolSettingsTab, type InlineRunnerLayout } from './settings';
import { ProtocolDocumentParser } from './protocol/protocol-document-parser';
import { ProtocolDocumentStore } from './protocol/protocol-document-store';
import { SnippetManagerView, SNIPPET_MANAGER_VIEW_TYPE } from './views/snippet-manager-view';
import { SnippetService } from './snippets/snippet-service';
// Phase 6 (library): forward-declared type so LibraryView type-checks standalone;
// the field is initialized in Phase 9.
import { LibraryView, LIBRARY_VIEW_TYPE } from './views/library-view';
import { LibraryExportModal } from './views/library-export-modal';
import { RegistryClient } from './library/registry-client';
import { LibraryService } from './library/library-service';
import { LibrarySubmissionService } from './library/submission-service';
import { requestUrlSubmitTransport } from './library/submission-client';
import type { InstalledRecord } from './library/library-model';
import { WriteMutex } from './utils/write-mutex';
import { I18nService } from './i18n';
import { normalizeProtocolFolderPath, resolveProtocolDocumentFiles } from './protocol/protocol-file-resolver';
import { getTextExpansionConfig, setTextExpansionConfig } from './expansion/config';
import { expandHotkeyPhraseInEditor, textExpansionExtension } from './expansion/editor';
import { isAutoRule, isHotkeyRule, normalizePhrases, phrasesFromLegacyRules, DEFAULT_TEXT_EXPANSION_PHRASES } from './expansion/rules';
import { expandHotkeyPhrase, isTextExpansionTextarea } from './expansion/textarea';
import { isTextEntryTarget } from './runner/keymap';
// Phase 45 (LOOP-06): start-from-node command dependencies
import { NodePickerModal, buildStartableProtocolNodeOptions } from './views/node-picker-modal';
// Phase 54: inline protocol display mode
import {
  InlineRunnerModal,
  inlineRunnerRegistryKey,
} from './views/inline-runner-modal';
import {
  SidebarRunnerView,
  SIDEBAR_RUNNER_VIEW_TYPE,
  createSidebarRunnerEphemeralState,
} from './views/sidebar-runner-view';
import { PluginMenuView, PLUGIN_MENU_VIEW_TYPE } from './views/plugin-menu-view';
import { InsertSnippetModal } from './views/insert-snippet-modal';
import { SnippetEditorModal } from './views/snippet-editor-modal';
import { ProtocolEditorView, PROTOCOL_EDITOR_VIEW_TYPE } from './views/protocol-editor-view';
import {
  ProtocolEditorPickerModal,
  ProtocolPickerSuggestModal,
  protocolDisplayName,
  protocolDocumentId,
  type ProtocolEditorPickerSuggestion,
  type ProtocolPickerSuggestion,
  type LibraryPickerContext,
} from './views/protocol-picker-modal';

export interface OpenRunnerSessionOptions {
  protocolPath: string;
  targetNote: TFile;
  startNodeId?: string;
}

// Rebrand note: the visible name is Protocol Former, but manifest.id, the
// install folder, view/command ids, and the .rp.json schema intentionally keep
// the `radiprotocol` identifier for backward compatibility. Renaming the id is
// a separate, explicitly migrated change.
export default class RadiProtocolPlugin extends Plugin {
  settings!: RadiProtocolSettings;
  i18n!: I18nService;
  protocolDocumentParser!: ProtocolDocumentParser;
  protocolDocumentStore!: ProtocolDocumentStore;
  snippetService!: SnippetService;
  registryClient!: RegistryClient;
  // Forward-declared in Phase 6 so LibraryView type-checks; initialized in Phase 9.
  libraryService!: LibraryService;
  /** Stage D — submission orchestration (persist-before-POST, frozen retry). */
  librarySubmissionService!: LibrarySubmissionService;
  private readonly insertMutex = new WriteMutex();
  private pickerModal: SuggestModal<ProtocolPickerSuggestion | ProtocolEditorPickerSuggestion> | null = null;
  // Phase 85 INLINE-MULTI-01: registry of open inline runners keyed by `${protocolPath}#${notePath}`.
  private inlineRunners = new Map<string, InlineRunnerModal>();

  /**
   * Sidebar runners keyed by bound note path. Parallel runners each live in
   * their own right-sidebar leaf (Obsidian's getRightLeaf creates a new leaf
   * per call), so a launch never destroys another runner — it only steals
   * sidebar visibility. This registry maps each bound note to its runner leaf
   * so switching notes can surface the matching runner, and a repeated launch
   * for the same note dedupes instead of stacking a look-alike tab.
   */
  private sidebarRunnersByNote = new Map<string, WorkspaceLeaf>();

  async onload(): Promise<void> {
    // Load settings with defaults guard (NFR-08)
    const storedSettings = (await this.loadData()) ?? {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, storedSettings);
    const migratedExpansion = this.migrateTextExpansionPhrases(storedSettings);

    // Phase 84 (I18N-01): init i18n. Backward-compat: existing installs without locale key default to 'ru'.
    const loadedLocale = (this.settings as unknown as Record<string, unknown>).locale;
    if (loadedLocale === undefined || loadedLocale === null) {
      this.settings.locale = 'ru';
      await this.saveSettings();
    }
    this.i18n = new I18nService(this.settings.locale);

    // Typed text expansion: push the parsed snapshot once, then keep it in sync
    // from saveSettings(). The editor extension reads it at event time.
    this.applyTextExpansionSettings();
    this.registerEditorExtension(textExpansionExtension());
    if (migratedExpansion) await this.saveSettings();

    // Instantiate pure modules (no Obsidian dependency)
    // Phase 84 (I18N-02): inject the i18n translator so parse-time error messages follow the active locale.
    this.protocolDocumentParser = new ProtocolDocumentParser(this.i18n.t.bind(this.i18n));
    this.protocolDocumentStore = new ProtocolDocumentStore(this.app);

    // Instantiate services
    // Phase 84 (I18N-01): SnippetService takes the plugin's i18n translator so
    // its error messages and validatePlaceholders output follow the active locale.
    this.snippetService = new SnippetService(this.app, this.settings, this.i18n.t.bind(this.i18n), (result) => {
      if (result.skipped.length > 0) {
        new Notice(this.i18n.t('snippetManager.referenceSyncWarning', {
          error: result.skipped.map(({ path, reason }) => `${path}: ${reason}`).join('; '),
        }));
      }
    });

    // Slice 9 — community library services (wired here; consumed by Slices 6-8 views).
    // libraryRegistryUrl is the advanced override. Empty/undefined → the
    // RegistryClient falls back to the bundled mirror list (REGISTRY_URLS).
    const registryOverride = this.settings.libraryRegistryUrl?.trim() || undefined;
    this.registryClient = new RegistryClient({ baseUrl: registryOverride });
    // Step 5 C11: normalize both roots so installer paths match resolver-enumerated
    // paths (trailing slashes/backslashes would otherwise mismatch). There is no
    // snippet-specific normalizer — the shared normalizeProtocolFolderPath is used
    // for both roots.
    const librarySettings = {
      protocolFolderPath: normalizeProtocolFolderPath(this.settings.protocolFolderPath),
      snippetFolderPath: normalizeProtocolFolderPath(this.settings.snippetFolderPath),
    };
    this.libraryService = new LibraryService(this.app, librarySettings, this.registryClient, { t: this.i18n.t.bind(this.i18n) });
    // Stage D — submission orchestration: persist-before-POST receipt store +
    // typed submit client. View-agnostic (outlives the submit modal).
    this.librarySubmissionService = new LibrarySubmissionService(this.app, requestUrlSubmitTransport);
    // Recovery on load: finalize any in-flight installs (never throws — rolls back
    // journals without a commit marker, commits valid ones). Runs before views are
    // registered so no user action can race a recovering install.
    await this.libraryService.recoverInterruptedInstalls();

    // Commands — IDs intentionally omit plugin name prefix (NFR-06)

    // Register ProtocolEditorView ItemView (.rp.json visual editor)
    this.registerView(PROTOCOL_EDITOR_VIEW_TYPE, (leaf) => new ProtocolEditorView(leaf, this));

    // Register SnippetManagerView ItemView (SNIP-01)
    this.registerView(SNIPPET_MANAGER_VIEW_TYPE, (leaf) => new SnippetManagerView(leaf, this));

    // Command: open-snippet-manager (SNIP-01)
    this.addCommand({
      id: 'open-snippet-manager',
      name: 'Open snippet manager',
      callback: () => { void this.activateSnippetManagerView(); },
    });

    // Slice 9 — Register LibraryView ItemView (community library, D4 first-class view)
    this.registerView(LIBRARY_VIEW_TYPE, (leaf) => new LibraryView(leaf, this));

    this.registerView(
      SIDEBAR_RUNNER_VIEW_TYPE,
      (leaf) => new SidebarRunnerView(leaf, this),
    );

    // Persistent right-sidebar plugin menu (durable workspace state — restored
    // by Obsidian across restarts once the leaf has been created).
    this.registerView(PLUGIN_MENU_VIEW_TYPE, (leaf) => new PluginMenuView(leaf, this));

    // Surface the sidebar runner bound to a note when that note becomes
    // active. With several parallel runners each living in its own sidebar
    // leaf, the newest launch otherwise keeps hiding older runner tabs even
    // while their notes are being edited. registerEvent cleans this up on
    // unload automatically.
    this.registerEvent(this.app.workspace.on('file-open', (file) => {
      if (file === null) return;
      void this.revealSidebarRunnerForNote(file);
    }));

    // Registry keys are note paths; TFile.path mutates on rename, so re-key
    // alongside it or the binding silently points at the old path.
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if (!(file instanceof TFile)) return;
      this.rekeySidebarRunnerForRename(file, oldPath);
    }));

    // Command: open-community-library (NFR-06: no plugin name prefix)
    this.addCommand({
      id: 'open-community-library',
      name: 'Open community library',
      callback: () => { void this.activateLibraryView(); },
    });

    // Slice 6 — Export a local protocol as a library package (FR-6/D9).
    this.addCommand({
      id: 'export-protocol-as-library-package',
      name: 'Export protocol as library package',
      callback: () => { void this.handleExportProtocolPackage(); },
    });

    // Command: open-protocol-editor — prompts for a .rp.json target, then opens the independent visual editor.
    this.addCommand({
      id: 'open-protocol-editor',
      name: 'Open protocol editor',
      callback: () => { void this.handleOpenProtocolEditor(); },
    });

    // Phase 45 (LOOP-06): start-from-node command (NFR-06: no plugin name prefix)
    this.addCommand({
      id: 'start-from-node',
      name: 'Start from specific node',
      callback: () => { void this.handleStartFromNode(); },
    });

    // Phase 54: inline protocol display mode — command palette only (D3, D9)
    this.addCommand({
      id: 'run-protocol-inline',
      name: 'Run protocol',
      callback: () => { void this.handleRunProtocolInline(); },
    });

    this.addCommand({
      id: 'insert-snippet',
      name: 'Insert snippet',
      callback: () => { void this.handleInsertSnippet(); },
    });

    // Hotkey-mode phrases: type the trigger, run this command with a user-assigned chord.
    this.addCommand({
      id: 'insert-phrase',
      name: 'Insert phrase from trigger',
      callback: () => { this.insertPhraseFromTrigger(); },
    });

    this.addCommand({
      id: 'create-snippet',
      name: 'Create snippet from selection',
      callback: () => { void this.handleCreateSnippet(); },
    });

    // Command: open-plugin-menu — reveals (or creates) the persistent right-sidebar menu.
    this.addCommand({
      id: 'open-plugin-menu',
      name: 'Open plugin menu',
      callback: () => { void this.activatePluginMenuView(); },
    });

    // Settings tab
    this.addSettingTab(new RadiProtocolSettingsTab(this.app, this));

    // Create the persistent plugin-menu leaf once the workspace layout is
    // ready. If the leaf already exists in the saved workspace (normal case on
    // restart), nothing happens and Obsidian restores it as durable state.
    this.app.workspace.onLayoutReady(() => {
      void this.activatePluginMenuView();
    });

    console.debug('[Protocol Former] Plugin loaded');
  }

  // eslint-disable-next-line obsidianmd/detach-leaves -- runner leaves are intentionally transient and must not survive plugin unload
  async onunload(): Promise<void> {
    if (this.pickerModal !== null) {
      this.pickerModal.close();
      this.pickerModal = null;
    }
    for (const modal of this.inlineRunners.values()) {
      modal.close(true);
    }
    this.inlineRunners.clear();
    this.sidebarRunnersByNote.clear();
    this.app.workspace.detachLeavesOfType(SIDEBAR_RUNNER_VIEW_TYPE);
    console.debug('[Protocol Former] Plugin unloaded');
  }

  // Phase 85 INLINE-MULTI-01: registry API for inline runner instances. Key is
  // `${protocolPath}#${notePath}`. Each instance unregisters itself on close().
  registerInlineRunner(key: string, modal: InlineRunnerModal): void {
    this.inlineRunners.set(key, modal);
  }

  unregisterInlineRunner(key: string): void {
    this.inlineRunners.delete(key);
  }

  getInlineRunner(key: string): InlineRunnerModal | null {
    return this.inlineRunners.get(key) ?? null;
  }

  // Phase 85 INLINE-MULTI-02: returns currently-open inline runners in registry order
  // so the cascade-position logic can offset the new instance from the last one opened.
  getOpenInlineRunners(): InlineRunnerModal[] {
    return Array.from(this.inlineRunners.values());
  }

  /** Sidebar runners keyed by bound note path (see sidebarRunnersByNote). */
  getSidebarRunnerNotePaths(): string[] {
    return Array.from(this.sidebarRunnersByNote.keys());
  }

  /** Registry maintenance called by a sidebar runner when its leaf closes. */
  unregisterSidebarRunnerLeaf(notePath: string, leaf: WorkspaceLeaf): void {
    if (this.sidebarRunnersByNote.get(notePath) === leaf) {
      this.sidebarRunnersByNote.delete(notePath);
    }
  }

  /**
   * Surface the sidebar runner bound to the given note (its leaf), so
   * switching notes brings up the matching runner instead of leaving the
   * newest launch's tab stacked on top. Also repairs stale entries whose
   * leaf has been repurposed for another view.
   */
  private async revealSidebarRunnerForNote(file: TFile): Promise<void> {
    const runnerLeaf = this.sidebarRunnersByNote.get(file.path);
    if (runnerLeaf === undefined) return;
    const view = runnerLeaf.view;
    if (!(view instanceof SidebarRunnerView)) {
      this.sidebarRunnersByNote.delete(file.path);
      return;
    }
    await this.app.workspace.revealLeaf(runnerLeaf);
  }

  /** Registry keys are note paths; re-key when the bound note is renamed. */
  private rekeySidebarRunnerForRename(file: TFile, oldPath: string): void {
    const runnerLeaf = this.sidebarRunnersByNote.get(oldPath);
    if (runnerLeaf === undefined) return;
    this.sidebarRunnersByNote.delete(oldPath);
    this.sidebarRunnersByNote.set(file.path, runnerLeaf);
  }

  async saveSettings(): Promise<void> {
    this.applyTextExpansionSettings();
    await this.saveData(this.settings);
  }

  /**
   * Rebuilds the parsed text-expansion snapshot the adapters read.
   * Called on load and from saveSettings(), so every settings change is live
   * without restarting Obsidian or reconfiguring the editor extension.
   */
  applyTextExpansionSettings(): void {
    const phrases = normalizePhrases(this.settings.textExpansionPhrases ?? []);
    setTextExpansionConfig({
      enabled: this.settings.textExpansionEnabled === true,
      inEditor: this.settings.textExpansionInEditor !== false,
      autoRules: phrases.filter(isAutoRule),
      hotkeyRules: phrases.filter(isHotkeyRule),
      allRules: phrases,
    });
  }

  /**
   * One-way upgrade from the 3.6.21 text format (`trigger => replacement`) to
   * the structured phrase list. Returns true when the old keys were consumed.
   * Invalid legacy lines are dropped; rows the user adds later are preserved
   * verbatim so the settings page can flag them instead of deleting them.
   */
  private migrateTextExpansionPhrases(stored: Record<string, unknown>): boolean {
    if (Array.isArray(stored['textExpansionPhrases'])) {
      this.settings.textExpansionPhrases = (stored['textExpansionPhrases'] as Array<Record<string, unknown>>)
        .map((phrase) => ({
          trigger: typeof phrase['trigger'] === 'string' ? phrase['trigger'] : '',
          replacement: typeof phrase['replacement'] === 'string' ? phrase['replacement'] : '',
          mode: phrase['mode'] === 'hotkey' ? 'hotkey' : 'auto',
        }));
      return false;
    }

    const legacyRules = typeof stored['textExpansionRules'] === 'string'
      ? stored['textExpansionRules']
      : undefined;
    const legacyMode = stored['textExpansionMode'] === 'delimiter'
      ? 'delimiter'
      : stored['textExpansionMode'] === 'auto'
        ? 'auto'
        : undefined;
    this.settings.textExpansionPhrases = legacyRules === undefined
      ? DEFAULT_TEXT_EXPANSION_PHRASES.map((phrase) => ({ ...phrase }))
      : phrasesFromLegacyRules(legacyRules, legacyMode);
    delete this.settings.textExpansionRules;
    delete this.settings.textExpansionMode;
    return legacyRules !== undefined || stored['textExpansionMode'] !== undefined;
  }

  /**
   * `Insert phrase from trigger`: replaces the word before the caret with the
   * phrase whose trigger matches it. Any phrase qualifies — a hotkey-mode
   * phrase simply waits for this command instead of firing while typing — and
   * the command only touches fields Protocol Former wired for expansion plus the
   * note editor, so it cannot rewrite a search box or another plugin's input.
   */
  private insertPhraseFromTrigger(): void {
    const config = getTextExpansionConfig();
    if (!config.enabled) {
      new Notice(this.i18n.t('expansion.disabled'));
      return;
    }

    // The note editor's content element is contenteditable, so it also looks
    // like a generic text-entry target. Resolve the editor first; otherwise
    // every editor chord falls into the foreign-text-field branch below and
    // reports a no-match without ever trying the editor path.
    const editor = this.app.workspace.activeEditor?.editor
      ?? this.getActiveMarkdownView()?.editor
      ?? null;
    if (editor !== null && editor.hasFocus()) {
      if (!config.inEditor) {
        new Notice(this.i18n.t('expansion.editorDisabled'));
        return;
      }
      if (expandHotkeyPhraseInEditor(editor, config.allRules)) return;
      new Notice(this.i18n.t('expansion.hotkeyNoMatch'));
      return;
    }

    const active = typeof document === 'undefined' ? null : document.activeElement;
    if (isTextEntryTarget(active as HTMLElement | null)) {
      if (active !== null && active !== undefined && isTextExpansionTextarea(active)) {
        if (expandHotkeyPhrase(active, config.allRules)) return;
      }
      new Notice(this.i18n.t('expansion.hotkeyNoMatch'));
      return;
    }

    // Focus on a runner control (root, button, draft chrome) must not insert
    // into the note behind the panel; only the editor or expando fields qualify.
    const activeEl = active as HTMLElement | null;
    if (activeEl !== null && typeof activeEl.closest === 'function'
      && activeEl.closest('.rp-runner-session-root, .rp-snippet-fill-modal') !== null) {
      new Notice(this.i18n.t('expansion.hotkeyNoMatch'));
      return;
    }

    new Notice(this.i18n.t('expansion.hotkeyNoMatch'));
  }

  private getActiveMarkdownView(): MarkdownView | null {
    return this.app.workspace.getActiveViewOfType(MarkdownView);
  }

  getInlineRunnerPosition(): InlineRunnerLayout | null {
    return this.settings.inlineRunnerPosition ?? null;
  }

  async saveInlineRunnerPosition(layout: InlineRunnerLayout | null): Promise<void> {
    this.settings.inlineRunnerPosition = layout;
    await this.saveSettings();
  }

  async activateProtocolEditorView(protocolPath?: string): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(PROTOCOL_EDITOR_VIEW_TYPE)[0];
    const leaf = existing ?? workspace.getLeaf(false);
    if (leaf === null) return;

    if (existing === undefined) {
      await leaf.setViewState({ type: PROTOCOL_EDITOR_VIEW_TYPE, active: true });
    }
    void workspace.revealLeaf(leaf);

    if (protocolPath !== undefined) {
      const view = leaf.view;
      if (view instanceof ProtocolEditorView) {
        await view.loadProtocol(protocolPath);
      }
    }
  }

  private async handleOpenProtocolEditor(): Promise<void> {
    const folderPath = normalizeProtocolFolderPath(this.settings.protocolFolderPath);
    if (folderPath === '') {
      new Notice(this.i18n.t('protocolEditor.setProtocolFolderFirst'));
      await this.activateProtocolEditorView();
      return;
    }

    const protocolFiles = resolveProtocolDocumentFiles(this.app.vault, folderPath);
    const libraryContext = await this.buildLibraryPickerContext(folderPath);
    const modal = new ProtocolEditorPickerModal(
      this.app,
      protocolFiles,
      this.i18n.t.bind(this.i18n),
      (file) => {
        this.pickerModal = null;
        void this.activateProtocolEditorView(file.path);
      },
      (title) => {
        this.pickerModal = null;
        void this.createAndOpenProtocol(folderPath, title);
      },
      libraryContext,
    );
    this.pickerModal = modal;
    modal.open();
  }

  private async createAndOpenProtocol(folderPath: string, title: string): Promise<void> {
    try {
      const { file } = await this.protocolDocumentStore.create(folderPath, title, protocolDocumentId());
      new Notice(this.i18n.t('protocolEditor.protocolCreated', { title: protocolDisplayName(file) }));
      await this.activateProtocolEditorView(file.path);
    } catch (err) {
      new Notice(this.i18n.t('protocolEditor.createProtocolFailed', { error: String(err) }));
    }
  }

  async activateSnippetManagerView(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(SNIPPET_MANAGER_VIEW_TYPE)[0];
    const leaf = existing ?? workspace.getLeaf(false);
    if (leaf === null) return;

    if (existing === undefined) {
      await leaf.setViewState({ type: SNIPPET_MANAGER_VIEW_TYPE, active: true });
    }
    void workspace.revealLeaf(leaf);
  }

  /** Get-or-create the persistent right-sidebar plugin menu leaf. Unlike the
   *  transient sidebar runner, this leaf is durable workspace state: it is
   *  never detached on unload, so Obsidian restores it across restarts. */
  async activatePluginMenuView(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(PLUGIN_MENU_VIEW_TYPE)[0];
    const leaf = existing ?? workspace.getRightLeaf(false);
    if (leaf === null) return;

    if (existing === undefined) {
      await leaf.setViewState({ type: PLUGIN_MENU_VIEW_TYPE, active: false });
    }
    void workspace.revealLeaf(leaf);
  }

  /** Slice 9 — activate the community library view (get-or-create leaf, modeled
   *  after activateSnippetManagerView). */
  async activateLibraryView(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(LIBRARY_VIEW_TYPE)[0];
    const leaf = existing ?? workspace.getLeaf(false);
    if (leaf === null) return;
    if (existing === undefined) {
      await leaf.setViewState({ type: LIBRARY_VIEW_TYPE, active: true });
    }
    void workspace.revealLeaf(leaf);
  }

  /** Step 5 C12 — recreate the registry client + library service after the
   *  advanced libraryRegistryUrl setting changes, so the override takes effect
   *  without a plugin reload. libraryService.installer/recordStore/cacheStore are
   *  preserved (they own no URL-dependent state); only the URL-bound client is
   *  replaced. The LibraryView picks up the new service on its next refresh. */
  async rebuildLibraryServices(): Promise<void> {
    const registryOverride = this.settings.libraryRegistryUrl?.trim() || undefined;
    this.registryClient = new RegistryClient({ baseUrl: registryOverride });
    this.libraryService = new LibraryService(this.app, {
      protocolFolderPath: normalizeProtocolFolderPath(this.settings.protocolFolderPath),
      snippetFolderPath: normalizeProtocolFolderPath(this.settings.snippetFolderPath),
    }, this.registryClient, { t: this.i18n.t.bind(this.i18n) });
  }

  /** Slice 9 — build the library-managed indicator context for protocol pickers.
   *  Best-effort: a listInstalled() failure yields an empty record list (no badge),
   *  never a throw. protocolRoot is the vault-relative protocol folder the picker
   *  is enumerating. */
  private async buildLibraryPickerContext(protocolRoot: string): Promise<LibraryPickerContext> {
    let installedRecords: InstalledRecord[] = [];
    try { installedRecords = await this.libraryService.listInstalled(); }
    catch { installedRecords = []; }
    return { protocolRoot, installedRecords };
  }

  /**
   * Start the inline runner from a selected start-enabled node in a .rp.json protocol.
   *
   * The command intentionally ignores any open Obsidian Canvas leaves: Protocol Former's
   * active authoring/runtime path is .rp.json, so the node list must come only from
   * the configured protocol picker folder.
   */
  private async handleStartFromNode(): Promise<void> {
    await this.handleStartFromProtocolNode();
  }

  private async handleStartFromProtocolNode(): Promise<void> {
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile === null || activeFile.extension !== 'md') {
      new Notice(this.i18n.t('insertSnippet.openMarkdownFirst'));
      return;
    }

    const folderPath = normalizeProtocolFolderPath(this.settings.protocolFolderPath);
    if (folderPath === '') {
      new Notice(this.i18n.t('protocolEditor.setProtocolFolderFirst'));
      return;
    }

    const protocolFiles = resolveProtocolDocumentFiles(this.app.vault, folderPath);
    if (protocolFiles.length === 0) {
      new Notice(this.i18n.t('command.noProtocolFiles', { folderPath }));
      return;
    }

    const libraryContext = await this.buildLibraryPickerContext(folderPath);
    this.pickerModal = new ProtocolPickerSuggestModal(
      this.app,
      protocolFiles,
      (item) => {
        this.pickerModal = null;
        void this.openProtocolStartNodePicker(item.file, activeFile);
      },
      libraryContext,
      this.i18n.t.bind(this.i18n),
    );
    this.pickerModal.open();
  }

  private async openProtocolStartNodePicker(protocolFile: TFile, activeFile: TFile): Promise<void> {
    let doc;
    try {
      doc = await this.protocolDocumentStore.read(protocolFile.path);
    } catch {
      new Notice(this.i18n.t('protocolEditor.loadFailed'));
      return;
    }

    if (doc === null) {
      new Notice(this.i18n.t('protocolEditor.loadFailed'));
      return;
    }

    const options = buildStartableProtocolNodeOptions(doc.nodes, this.i18n.t.bind(this.i18n), doc.edges);
    if (options.length === 0) {
      new Notice(this.i18n.t('startFromNode.noStartPoints'));
      return;
    }

    new NodePickerModal(this.app, options, (opt) => {
      void this.openRunnerSession({
        protocolPath: protocolFile.path,
        targetNote: activeFile,
        startNodeId: opt.id,
      });
    }, this).open();
  }

  private async handleInsertSnippet(): Promise<void> {
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile === null || activeFile.extension !== 'md') {
      new Notice(this.i18n.t('insertSnippet.openMarkdownFirst'));
      return;
    }

    const modal = new InsertSnippetModal(this.app, this);
    modal.open();
    const rendered = await modal.result;
    if (rendered === null) return;

    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const editor = activeView?.editor;
    if (editor !== undefined) {
      editor.replaceSelection(rendered);
      // No "inserted" Notice: the inserted text is visible in the editor itself.
      return;
    }

    await this.insertMutex.runExclusive(activeFile.path, async () => {
      const current = await this.app.vault.read(activeFile);
      const separator = current.endsWith('\n') || current.length === 0 ? '' : '\n';
      await this.app.vault.modify(activeFile, `${current}${separator}${rendered}`);
    });
  }

  /**
   * "Create snippet from selection" command. Opens SnippetEditorModal in create
   * mode with the active Markdown editor's selection pre-filled as the template.
   *
   * No md-guard bail: when there is no active MarkdownView or no selection, the
   * modal still opens with an empty template so the command remains useful for
   * authoring a snippet from scratch.
   */
  private async handleCreateSnippet(): Promise<void> {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const initialTemplate = activeView?.editor?.getSelection() ?? '';

    const modal = new SnippetEditorModal(this.app, this, {
      mode: 'create',
      initialFolder: this.settings.snippetFolderPath,
      initialTemplate,
    });
    modal.open();
    const result = await modal.result;
    if (result.saved) {
      new Notice(this.i18n.t('snippetEditor.createdNotice'));
    }
  }

  /** Slice 6 — pick a source protocol, then open the export modal. */
  private async handleExportProtocolPackage(): Promise<void> {
    const folderPath = normalizeProtocolFolderPath(this.settings.protocolFolderPath);
    if (folderPath === '') {
      new Notice(this.i18n.t('protocolEditor.setProtocolFolderFirst'));
      return;
    }
    const protocolFiles = resolveProtocolDocumentFiles(this.app.vault, folderPath);
    if (protocolFiles.length === 0) {
      new Notice(this.i18n.t('command.noProtocolFiles', { folderPath }));
      return;
    }
    const libraryContext = await this.buildLibraryPickerContext(folderPath);
    this.pickerModal = new ProtocolPickerSuggestModal(
      this.app,
      protocolFiles,
      (item) => {
        this.pickerModal = null;
        new LibraryExportModal(this.app, this, item.file.path).open();
      },
      libraryContext,
      this.i18n.t.bind(this.i18n),
    );
    this.pickerModal.open();
  }

  /**
   * Phase 54: "Run protocol" command callback.
   *
   * Flow:
   *   1. D9 guard — check active file is a markdown note.
   *   2. Protocol folder enumeration — D8 guard.
   *   3. .rp.json protocol picker via SuggestModal.
   *   4. Instantiate InlineRunnerModal + open().
   */
  private async handleRunProtocolInline(): Promise<void> {
    // D9 guard: active file must be a markdown note
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile === null || activeFile.extension !== 'md') {
      new Notice(this.i18n.t('command.openMarkdownFirst'));
      return;
    }

    // Protocol folder enumeration
    const folderPath = normalizeProtocolFolderPath(this.settings.protocolFolderPath);
    if (folderPath === '') {
      new Notice(this.i18n.t('command.setProtocolFolder'));
      return;
    }

    // Protocol document enumeration. Handles trailing/leading slashes, Windows
    // backslash, and vault-index null fallback.
    const protocolFiles = resolveProtocolDocumentFiles(this.app.vault, folderPath);

    // D8 guard: empty list
    if (protocolFiles.length === 0) {
      new Notice(this.i18n.t('command.noProtocolFiles', { folderPath }));
      return;
    }

    const libraryContext = await this.buildLibraryPickerContext(folderPath);

    // Protocol picker via SuggestModal
    this.pickerModal = new ProtocolPickerSuggestModal(
      this.app,
      protocolFiles,
      (item) => {
        this.pickerModal = null;
        void this.openRunnerSession({
          protocolPath: item.file.path,
          targetNote: activeFile,
        });
      },
      libraryContext,
      this.i18n.t.bind(this.i18n),
    );

    this.pickerModal.open();
  }

  /** Open one transient runner session using the configured presentation. */
  async openRunnerSession(options: OpenRunnerSessionOptions): Promise<void> {
    if (this.settings.useSidebarRunner === true) {
      // Dedup: a note owns at most one sidebar runner. Relaunching for the
      // same note surfaces the existing runner instead of stacking a second
      // look-alike tab over it (mirrors the inline-mode registry semantics).
      // Protocol restart = close the runner, launch again.
      const existingLeaf = this.sidebarRunnersByNote.get(options.targetNote.path);
      if (existingLeaf !== undefined) {
        const view = existingLeaf.view;
        if (view instanceof SidebarRunnerView) {
          await this.revealSidebarRunnerForNote(options.targetNote);
          return;
        }
        // Stale entry (leaf reused for a non-runner view): repair and fall
        // through to a fresh launch. Leaf identity is re-verified after every
        // await below so async interleaving can never bind the wrong view.
        this.sidebarRunnersByNote.delete(options.targetNote.path);
      }

      const leaf = this.app.workspace.getRightLeaf(false);
      if (leaf === null) return;

      const ephemeralState = createSidebarRunnerEphemeralState();
      leaf.setEphemeralState(ephemeralState);
      try {
        await leaf.setViewState({
          type: SIDEBAR_RUNNER_VIEW_TYPE,
          active: true,
          state: {},
        }, ephemeralState);
        if (leaf.isDeferred) await leaf.loadIfDeferred();

        const view = leaf.view;
        if (!(view instanceof SidebarRunnerView)) {
          leaf.detach();
          return;
        }
        // Registry set is check-then-set with no await in between: if a
        // concurrent launch for the same note registered while we awaited
        // setViewState, that newer launch wins and ours detaches instead of
        // stacking over it.
        if (this.sidebarRunnersByNote.has(options.targetNote.path)) {
          leaf.detach();
          return;
        }
        this.sidebarRunnersByNote.set(options.targetNote.path, leaf);
        await this.app.workspace.revealLeaf(leaf);

        // If the runner closed while reveal's layout work was awaited, the
        // registry slot is already freed — do not initialize into a dead leaf.
        if (this.sidebarRunnersByNote.get(options.targetNote.path) !== leaf) {
          leaf.detach();
          return;
        }
        await view.initialize(options);
        // Boot failures (missing protocol, mount rejection) already detached
        // the leaf inside the view; drop the registry entry or a dead leaf
        // would own the note's slot.
        if (!view.isClosed) {
          return;
        }
        this.sidebarRunnersByNote.delete(options.targetNote.path);
      } catch (error) {
        if (this.sidebarRunnersByNote.get(options.targetNote.path) === leaf) {
          this.sidebarRunnersByNote.delete(options.targetNote.path);
        }
        leaf.detach();
        console.error('[Protocol Former] Failed to open sidebar runner', error);
      }
      return;
    }

    const key = inlineRunnerRegistryKey(
      options.protocolPath,
      options.targetNote.path,
      options.startNodeId,
    );
    const existing = this.getInlineRunner(key);
    if (existing !== null) {
      existing.focus();
      return;
    }

    const modal = new InlineRunnerModal(
      this.app,
      this,
      options.protocolPath,
      options.targetNote,
      options.startNodeId,
    );
    await modal.open();
    if (modal.isOpen()) this.registerInlineRunner(key, modal);
  }
}
