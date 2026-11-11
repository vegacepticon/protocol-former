// runner/render/render-snippet-picker.ts
// Phase 75 Plan 04 (DEDUP-01) — shared awaiting-snippet-pick renderer.
//
// Owns:
//   - host-class wrapper div + SnippetTreePicker construction (file-only mode)
//   - stale-result guard (state status + nodeId)
//   - optional DOM-attached guard (inline modal)
//   - localised not-found / validation-error dispatch via host copy
//   - shared Back footer
//
// Hosts retain:
//   - SnippetTreePicker instance lifetime (returned from this function so the
//     host can call unmount() on state-change / step-back)
//   - autosave / accumulator-delta side effects
//   - snippet placeholder modal flow (handleSnippetPickerSelection)
//   - re-render entry point
//
// Historical Phase 75 shared picker extraction plan.
import type { App } from 'obsidian';
import type { Snippet } from '../../snippets/snippet-model';
import type { SnippetService } from '../../snippets/snippet-service';
import type { RunnerState } from '../runner-state';
import type { Translator } from '../../i18n';
import { CSS_CLASS } from '../../constants/css-classes';
import { SnippetTreePicker } from '../../views/snippet-tree-picker';
import { renderRunnerFooter, type RunnerFooterHost } from './render-footer';

type AwaitingSnippetPickState = Extract<RunnerState, { status: 'awaiting-snippet-pick' }>;

type SnippetPickerHostClass =
  | typeof CSS_CLASS.STP_RUNNER_SESSION_HOST
  | typeof CSS_CLASS.STP_INLINE_HOST;

/** Host-supplied copy for async errors surfaced by the picker. */
interface SnippetPickerCopy {
  /** Snippet at the picked path could not be loaded. */
  notFound(relativePath: string): string;
}

interface SnippetPickerRenderOptions extends RunnerFooterHost {
  app: App;
  snippetService: SnippetService;
  /** Optional translator for footer aria-labels. */
  t?: Translator;
  /** Vault-relative root path (plugin.settings.snippetFolderPath). */
  rootPath: string;
  /** Host wrapper CSS hook for either the extracted session host or legacy inline host. */
  hostClass: SnippetPickerHostClass;
  /** Copy locale (EN divergence preserved unless explicitly merged). */
  copy: SnippetPickerCopy;
  /** Returns the runner's current awaiting-snippet-pick nodeId, or null if the
   *  state has changed (advanced/stepped-back/error/etc). T-30-04 stale-result guard. */
  getCurrentNodeId(): string | null;
  /** Optional host-ownership guard. The session host supplies its render-operation check. */
  isStillMounted?(): boolean;
  /** Host-controlled async error presentation. Default: empty `questionZone`
   *  and append a `.rp-empty-state-body` paragraph in place. Inline modal
   *  overrides to call its own `render()` first and write to the fresh zone. */
  presentAsyncError?(message: string): void;
  /** Called when a usable snippet is loaded. Host advances runner / autosaves /
   *  appends accumulator delta / re-renders. */
  onSnippetReady(snippet: Snippet): void | Promise<void>;
  /** Footer back-button handler. Host owns picker.unmount + runner.stepBack +
   *  any host-specific autosave + re-render. */
  onBack(): void;
  /** Footer redo-button handler. Host calls runner.redo + re-render. */
  onRedo?(): void;
}

export function renderSnippetPicker(
  questionZone: HTMLElement,
  state: AwaitingSnippetPickState,
  options: SnippetPickerRenderOptions,
): SnippetTreePicker {
  const { app, snippetService, rootPath, hostClass, copy } = options;
  const nodeRootRel = state.subfolderPath ?? '';
  const nodeRootAbs = nodeRootRel === '' ? rootPath : `${rootPath}/${nodeRootRel}`;

  questionZone.empty();
  const pickerHost = questionZone.createDiv({ cls: hostClass });

  const capturedNodeId = state.nodeId;

  const presentAsyncError = options.presentAsyncError ?? ((message: string) => {
    questionZone.empty();
    questionZone.createEl('p', { cls: CSS_CLASS.EMPTY_STATE_BODY, text: message });
  });

  const picker = new SnippetTreePicker({
    app,
    snippetService,
    container: pickerHost as unknown as HTMLElement,
    mode: 'file-only',
    rootPath: nodeRootAbs,
    // Keyboard-first runner picker: the caret starts in the search field so the
    // radiologist can type to filter / arrow through snippets right away.
    autoFocusSearch: true,
    onSelect: (result) => {
      void (async () => {
        const absPath = result.relativePath === ''
          ? nodeRootAbs
          : `${nodeRootAbs}/${result.relativePath}`;
        const snippet = await snippetService.load(absPath);

        // T-30-04 stale-result guard: bail if runner advanced / stepped-back
        // during the await.
        if (options.getCurrentNodeId() !== capturedNodeId) return;
        // CR-01 (inline-only): bail if the host DOM was detached.
        if (options.isStillMounted !== undefined && !options.isStillMounted()) return;

        if (snippet === null) {
          presentAsyncError(copy.notFound(result.relativePath));
          return;
        }
        await options.onSnippetReady(snippet);
      })();
    },
  });
  void picker.mount();

  renderRunnerFooter(questionZone, options, {
    showBack: state.canStepBack,
    onBack: options.onBack,
    showRedo: state.canRedo,
    onRedo: options.onRedo,
    t: options.t,
  });

  return picker;
}
