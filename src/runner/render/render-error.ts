// runner/render/render-error.ts
// Phase 75 Plan 05 (DEDUP-01) — shared error-list body.
//
// Owns:
//   - "Protocol error" title paragraph (cls optional — preserves divergence
//     between the default no-class title and inline modal's `rp-error-title`).
//   - `<ul class="rp-error-list">` of `<li>` messages.
//
// Hosts retain:
//   - Outer chrome divergence: hosts decide whether to render whole-view or
//     zone-local error panels. InlineRunnerModal renders inside `.rp-error-panel`.

interface ErrorListOptions {
  /** Optional class for the "Protocol error" title paragraph. When omitted,
   *  the title uses the default no-class shape; inline modal passes 'rp-error-title'. */
  titleClass?: string;
}

export function renderErrorList(
  parent: HTMLElement,
  messages: string[],
  options: ErrorListOptions = {},
): void {
  const titleOpts: { text: string; cls?: string } = { text: 'Protocol error' };
  if (options.titleClass !== undefined) titleOpts.cls = options.titleClass;
  parent.createEl('p', titleOpts);

  const ul = parent.createEl('ul', { cls: 'rp-error-list' });
  for (const message of messages) {
    ul.createEl('li', { text: message });
  }
}
