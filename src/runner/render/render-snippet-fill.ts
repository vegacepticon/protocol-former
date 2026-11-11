// runner/render/render-snippet-fill.ts
// Phase 75 Plan 05 (DEDUP-01) — shared awaiting-snippet-fill renderer helpers.
import { CSS_CLASS } from '../../constants/css-classes';
import type { Translator } from '../../i18n';
//
// Owns:
//   - "Loading snippet..." placeholder paragraph rendered while host loads the
//     snippet asynchronously.
//   - "Snippet '{id}' not found" copy emitted when resolution returns `missing`.
//   - Phase 2 (JSON-removal): "unsupported legacy JSON format" copy emitted
//     when `SnippetService.resolveSnippet` returns `legacy-json`.
//
// Hosts retain:
//   - SnippetService.resolveSnippet orchestration (InlineRunnerModal handleSnippetFill).
//   - SnippetFillInModal lifecycle (`fillModal`/`isFillModalOpen` gate is host-owned).
//   - completeSnippet dispatch + autosave / accumulator-delta append + re-render.
//
// Phase 2 (JSON-removal): path-shape detection (`isFullSnippetPath`) and all
// root-checked snippet-ID resolution moved into `SnippetService.resolveSnippet`.
// This module is now presentation-only.

/** Render the "Loading snippet..." placeholder. Host calls this synchronously
 *  before kicking off the async snippet load. */
export function renderSnippetFillLoading(zone: HTMLElement): void {
  zone.createEl('p', {
    text: 'Loading snippet...',
    cls: CSS_CLASS.EMPTY_STATE_BODY,
  });
}

interface SnippetFillNotFoundOptions {
  /** Optional trailing copy appended to the base "Snippet '{id}' not found." line.
   *  Legacy hosts may pass the " The snippet may have been deleted. Use
   *  step-back to continue." trailer; inline modal omits it. */
  trailer?: string;
}

/** Replace the zone with a localised not-found message. */
export function renderSnippetFillNotFound(
  zone: HTMLElement,
  snippetId: string,
  options: SnippetFillNotFoundOptions = {},
): void {
  zone.empty();
  const trailer = options.trailer ?? '';
  zone.createEl('p', {
    text: `Snippet '${snippetId}' not found.${trailer}`,
    cls: CSS_CLASS.EMPTY_STATE_BODY,
  });
}

/** Phase 2 (JSON-removal): Replace the zone with the localised unsupported-
 *  legacy-JSON-format message. Consumed by InlineRunnerModal when
 *  `SnippetService.resolveSnippet` returns `{ status: 'legacy-json', path }`. */
export function renderSnippetFillUnsupportedFormat(
  zone: HTMLElement,
  path: string,
  t: Translator,
): void {
  zone.empty();
  zone.createEl('p', {
    text: t('inlineRunner.snippetLegacyJson', { path }),
    cls: CSS_CLASS.EMPTY_STATE_BODY,
  });
}

