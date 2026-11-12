// views/snippet-fill-in-modal.ts
// Runtime fill-in modal for dynamic snippets (SNIP-04, SNIP-05, SNIP-09, D-10 through D-13)
import { Modal, App } from 'obsidian';
import type { MdTemplateSnippet, SnippetPlaceholder } from '../snippets/snippet-model';
import { renderMdTemplateSnippet } from '../snippets/snippet-model';
import type { Translator } from '../i18n';
import { defaultT } from '../i18n';
import { createTextarea, growAutoTextarea } from '../utils/dom-helpers';
import { isConfirmChord } from '../runner/keymap';
import { attachTextExpansion } from '../expansion/textarea';

// Phase 2 (JSON-removal): the fill-in modal accepts Markdown template snippets
// only and renders exclusively via renderMdTemplateSnippet.

/**
 * True when `target` is `root` or a descendant of it. Uses the DOM `parent*`
 * chain (and the test double's `parent`) instead of `Node.contains` so the
 * modal stays testable in the Node/vitest environment.
 */
function isInside(root: HTMLElement, target: EventTarget | null): boolean {
  let node: unknown = target;
  while (node) {
    if (node === root) return true;
    const parented = node as {
      parentElement?: unknown;
      parentNode?: unknown;
      parent?: unknown;
    };
    node = parented.parentElement ?? parented.parentNode ?? parented.parent ?? null;
  }
  return false;
}

/**
 * SnippetFillInModal — presented by a runner host when the runner reaches a text-block
 * node with a snippetId attached.
 *
 * Usage:
 *   const modal = new SnippetFillInModal(this.app, snippet);
 *   modal.open();
 *   const rendered = await modal.result;  // string | null
 *
 * Returns:
 *   - string  — fully-rendered snippet text (Confirm path)
 *   - null    — user cancelled or pressed Escape (runner skips snippet, D-11)
 *
 * The modal has zero knowledge of the runner — it receives a Markdown template
 * snippet and resolves its promise. The caller decides what to do with the result.
 */
export class SnippetFillInModal extends Modal {
  private readonly snippet: MdTemplateSnippet;
  private resolve!: (value: string | null) => void;
  /** Double-resolve guard (T-5-11, RESEARCH.md Pitfall 3) */
  private resolved = false;
  /** Awaitable promise resolved on Confirm or null on Cancel/Escape */
  readonly result: Promise<string | null>;

  /** Map of placeholder id → current string value used for live preview */
  private readonly values: Record<string, string> = {};

  /** Live preview container reference for updatePreview() calls */
  private previewEl: HTMLDivElement | null = null;
  private readonly t: Translator;
  /** Monotonic seed for label↔field id pairs (accessible naming without
   *  `aria-label`, which Obsidian turns into a hover tooltip). */
  private fieldIdSeed = 0;
  /** First interactive field in render order; focused when the modal opens. */
  private firstFieldEl: HTMLElement | null = null;
  /**
   * Focus stops in render order — one per placeholder ("question"). Tab and
   * Shift+Tab move between whole questions instead of individual option pills,
   * so a multi-option choice never costs an extra Tab press.
   */
  private readonly questionStops: Array<{ root: HTMLElement; focus: () => void }> = [];
  /** Cancel button; Tab from the last question hands focus over to it. */
  private cancelBtnEl: HTMLButtonElement | null = null;
  /** Host-provided modal close button; Shift+Tab from the first question uses it. */
  private modalCloseEl: HTMLElement | null = null;

  /**
   * Bubble-phase keydown listener on `contentEl` — Ctrl+Space confirms
   * (Shift+Enter stays a legacy alias) and Tab/Shift+Tab move between
   * questions.
   *
   * A contentEl-level listener is used instead of `Modal.scope` key bindings
   * because the event has to be seen while focus sits inside a placeholder
   * textarea (and scope bindings are bypassed for plain-key/typing contexts).
   * It also covers the collapsed Custom override input and the action row.
   * Plain Enter keeps its native meaning inside a field (newline), and
   * Shift+Enter keeps confirming for users who learned it before 3.6.19.
   * The chord itself is shared with the runner's free-text submit.
   */
  private readonly onContentKeydown = (event: KeyboardEvent): void => {
    if (event.isComposing) return;
    if (event.key === 'Tab') {
      // Modified Tab chords belong to Obsidian / the OS.
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      this.handleQuestionTab(event);
      return;
    }
    const shiftEnter = event.key === 'Enter' && event.shiftKey;
    if (!shiftEnter && !isConfirmChord(event)) return;
    event.preventDefault();
    this.confirm();
  };

  /**
   * Tab / Shift+Tab move between placeholders as whole questions. Native
   * sequential focus would still stop on the focused option pill (or on the
   * question's inner fieldset), which made the user press Tab twice after
   * selecting an option in the middle. At the edges focus leaves the question
   * list for the surrounding modal controls.
   */
  private handleQuestionTab(event: KeyboardEvent): void {
    const index = this.questionStops.findIndex((stop) => isInside(stop.root, event.target));
    if (index === -1) return;

    const target = event.shiftKey
      ? (index > 0 ? this.questionStops[index - 1] : this.modalCloseEl)
      : (index < this.questionStops.length - 1 ? this.questionStops[index + 1] : this.cancelBtnEl);
    // Let the browser handle the boundary if the host control is unavailable.
    if (!target) return;
    event.preventDefault();
    target.focus();
  }

  constructor(app: App, snippet: MdTemplateSnippet, t?: Translator) {
    super(app);
    this.snippet = snippet;
    this.t = t ?? defaultT;
    this.result = new Promise<string | null>(res => {
      this.resolve = res;
    });
  }

  onOpen(): void {
    this.titleEl.setText(this.snippet.name);
    this.contentEl.addClass('rp-snippet-modal');

    // D-07: wide Obsidian modal (same pattern as snippet-editor-modal)
    const modalEl = (this as unknown as {
      modalEl?: {
        addClass?: (cls: string) => void;
        querySelector?: (selector: string) => Element | null;
      };
    }).modalEl;
    if (typeof modalEl?.addClass === 'function') {
      modalEl.addClass('rp-snippet-fill-modal');
    }
    this.modalCloseEl = (modalEl?.querySelector?.('.modal-close-button') as HTMLElement | null) ?? null;

    // Darken the entire workspace behind the modal (.modal-bg lives inside
    // containerEl) so attention stays on placeholder filling. containerEl is
    // torn down with the modal — no explicit cleanup needed.
    const containerEl = this.containerEl as HTMLElement | undefined;
    if (containerEl && typeof containerEl.addClass === 'function') {
      containerEl.addClass('rp-snippet-fill-modal-backdrop');
    }

    // Initialize values map with empty strings for every placeholder
    for (const p of this.snippet.placeholders) {
      this.values[p.id] = '';
    }

    this.firstFieldEl = null;
    this.questionStops.length = 0;
    this.cancelBtnEl = null;

    // Render one field per placeholder in array order (D-12: tab order = array order)
    for (const placeholder of this.snippet.placeholders) {
      this.renderField(placeholder);
    }

    // Live preview section (D-13)
    this.renderPreview();

    // Button row — [Confirm] is last tab stop (D-12)
    this.renderButtonRow();

    // Start in the first placeholder instead of the modal container: the
    // preview is a non-interactive div, so without this the first key a user
    // presses is always a Tab.
    this.focusFirstField();

    // Ctrl+Space → Confirm (bubbled keydown from any field in the modal)
    this.contentEl.addEventListener('keydown', this.onContentKeydown);
  }

  onClose(): void {
    this.contentEl.removeEventListener('keydown', this.onContentKeydown);
    // Escape key or external close — resolve with null if not already resolved (T-5-11)
    this.safeResolve(null);
    this.contentEl.empty();
  }

  /**
   * Resolve the result promise at most once (T-5-11).
   * Guards against null overwriting a prior Confirm resolution.
   */
  private safeResolve(value: string | null): void {
    if (!this.resolved) {
      this.resolved = true;
      this.resolve(value);
    }
  }

  /**
   * Focus the first placeholder field on open.
   *
   * Obsidian re-focuses the modal container once `onOpen` returns, so the
   * synchronous call is re-asserted on the next tick (skipped if the modal was
   * already confirmed or dismissed in the meantime).
   */
  private focusFirstField(): void {
    const first = this.firstFieldEl;
    if (first === null) return;
    first.focus();
    globalThis.setTimeout(() => {
      if (this.resolved) return;
      this.firstFieldEl?.focus();
    }, 0);
  }

  /** Render the appropriate input field for a single placeholder. */
  private renderField(placeholder: SnippetPlaceholder): void {
    const fieldDiv = this.contentEl.createDiv({ cls: 'rp-snippet-modal-field rp-stack' });
    let focus: (() => void) | null = null;
    if (placeholder.type === 'free-text') {
      focus = this.renderFreeTextField(fieldDiv, placeholder);
    } else if (placeholder.type === 'choice') {
      focus = this.renderChoiceField(fieldDiv, placeholder);
    }
    // Phase 52: unknown types render nothing. Plan 04 guards upstream via validationError.
    if (focus !== null) {
      this.questionStops.push({ root: fieldDiv, focus });
    }
  }

  /**
   * free-text: visible label + auto-growing textarea. Same compact-start /
   * grow-with-content behavior as the runner's free-text Answer fields
   * (rows=1, CSS min-height, JS grow via scrollHeight).
   */
  private renderFreeTextField(
    container: HTMLElement,
    placeholder: SnippetPlaceholder,
  ): () => void {
    const label = container.createEl('label', { cls: 'rp-snippet-modal-label' });
    label.textContent = placeholder.label; // User-authored content, not a UI string

    const textarea = createTextarea(label, {
      cls: 'rp-snippet-modal-free-text',
      // Start at a single compact line; growInput expands it as content grows.
      attr: { rows: 1 },
    });
    if (this.firstFieldEl === null) this.firstFieldEl = textarea;
    attachTextExpansion(textarea);

    textarea.addEventListener('input', () => {
      this.values[placeholder.id] = textarea.value;
      textarea.toggleClass('rp-snippet-field-filled', textarea.value.length > 0);
      this.growInput(textarea);
      this.updatePreview();
    });

    return () => textarea.focus();
  }

  /** Expand a single-line input textarea to fit its content (runner free-text pattern). */
  private growInput(textarea: HTMLTextAreaElement): void {
    growAutoTextarea(textarea);
  }

  /**
   * Phase 52 D-05: unified choice field — multi-select option buttons.
   * Includes a "Custom:" free-text override at the bottom (SNIP-09, D-06/D-09).
   * Selecting an option clears custom input; typing in custom clears all selected options.
   * 0 selected + empty Custom → empty string (D-09).
   */
  private renderChoiceField(
    container: HTMLElement,
    placeholder: SnippetPlaceholder,
  ): () => void {
    // The fieldset is the question's single Tab stop. Option pills and the ✎
    // toggle stay at tabindex="-1": arrows reach them, Tab moves to the next
    // question instead of stopping inside this one.
    const fieldset = container.createEl('fieldset', { attr: { tabindex: '0' } });
    const legend = fieldset.createEl('legend', { cls: 'rp-snippet-modal-label' });
    legend.textContent = placeholder.label; // User-authored content, not a UI string

    const optionsDiv = fieldset.createDiv({ cls: 'rp-snippet-modal-options' });
    const options = placeholder.options ?? [];

    const optionButtons: HTMLButtonElement[] = [];
    let customInput: HTMLTextAreaElement | null = null;

    /** Recompute the current value from custom input or toggle-button state. */
    const recomputeValue = (): void => {
      if (customInput && customInput.value.trim() !== '') {
        // Custom value takes precedence over option selection (D-06)
        this.values[placeholder.id] = customInput.value.trim();
      } else {
        const selected = optionButtons
          .filter(btn => btn.hasClass('is-selected'))
          .map(btn => btn.value);
        const sep = placeholder.separator ?? ', ';
        this.values[placeholder.id] = selected.join(sep);
      }
      this.updatePreview();
    };

    /** Flip one option pill and keep the value/preview/ARIA in sync. */
    const toggleOption = (btn: HTMLButtonElement): void => {
      // Clear custom input when an option button is toggled (D-06)
      if (customInput) {
        customInput.value = '';
        customInput.removeClass('rp-snippet-field-filled');
      }

      const selected = !btn.hasClass('is-selected');
      btn.toggleClass('is-selected', selected);
      btn.setAttribute('aria-pressed', selected ? 'true' : 'false');
      recomputeValue();
    };

    // Render one toggle pill button per predefined option
    for (const opt of options) {
      const btn = optionsDiv.createEl('button', {
        cls: 'rp-snippet-fill-option-row',
        type: 'button',
      });
      btn.textContent = opt; // User-authored content, not a UI string
      btn.name = `rp-${placeholder.id}`;
      btn.value = opt;
      btn.setAttribute('aria-pressed', 'false');
      btn.setAttribute('tabindex', '-1');

      // The digit that toggles this option while the group has focus. Only the
      // first nine are numbered because that is all the keymap accepts; the
      // badge keeps the affordance visible instead of hidden in the docs.
      if (optionButtons.length < 9) {
        const digit = String(optionButtons.length + 1);
        btn.setAttribute('data-rp-key', digit);
        btn.setAttribute('aria-keyshortcuts', digit);
      }

      optionButtons.push(btn);

      btn.addEventListener('click', () => {
        toggleOption(btn);
      });
    }

    // Custom: free-text override (SNIP-09, D-06/D-09), collapsed by default to reduce visual noise.
    // The toggle sits inline right after the predefined option pills; the
    // input row expands below the option list when opened.
    const customToggle = optionsDiv.createEl('button', {
      cls: 'rp-snippet-modal-custom-toggle',
      type: 'button',
    });
    customToggle.textContent = '✎'; // Non-translatable edit-toggle symbol
    customToggle.setAttribute('aria-label', this.t('snippetPreview.showCustomAria', { label: placeholder.label }));
    customToggle.setAttribute('aria-expanded', 'false');
    customToggle.setAttribute('tabindex', '-1');

    const customRow = fieldset.createDiv({ cls: 'rp-snippet-modal-custom-row' });
    customRow.setAttribute('hidden', 'true');
    // Name the field through the visible label (`for` ↔ `id`) instead of an
    // `aria-label`: Obsidian renders every `aria-label` as a hover tooltip over
    // the element (hover-noise policy, see 3.5.8), and a tooltip over a typing
    // area is pure noise. The fieldset legend already carries the placeholder
    // context for assistive tech.
    const customInputId = `rp-snippet-custom-input-${++this.fieldIdSeed}`;
    customRow.createEl('label', {
      text: this.t('snippetFillIn.customLabel'),
      attr: { for: customInputId },
    });

    customInput = createTextarea(customRow, {
      cls: 'rp-snippet-modal-custom-input',
      // Same compact auto-growing behavior as free-text placeholder fields.
      attr: { rows: 1, id: customInputId },
    });
    attachTextExpansion(customInput);

    const setCustomOpen = (open: boolean): void => {
      customToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) {
        customRow.removeAttribute('hidden');
        customRow.addClass('is-open');
        customInput?.focus();
      } else {
        customRow.setAttribute('hidden', 'true');
        customRow.removeClass('is-open');
      }
    };

    customToggle.addEventListener('click', () => {
      setCustomOpen(customToggle.getAttribute('aria-expanded') !== 'true');
    });

    customInput.addEventListener('input', () => {
      customInput.toggleClass('rp-snippet-field-filled', customInput.value.length > 0);
      if (customInput.value.trim() !== '') {
        // Deselect all option buttons when custom is typed (D-06)
        for (const btn of optionButtons) {
          btn.removeClass('is-selected');
          btn.setAttribute('aria-pressed', 'false');
        }
      }
      this.growInput(customInput);
      recomputeValue();
    });

    // Arrow keys walk the option pills and the ✎ toggle. They are not Tab
    // stops: the fieldset itself is the stop, and Tab/Shift+Tab are handled at
    // the modal level so they always move the whole question.
    const groupMembers: HTMLElement[] = [...optionButtons, customToggle];
    const focusMember = (index: number): void => {
      const count = groupMembers.length;
      if (count === 0) return;
      groupMembers[((index % count) + count) % count]?.focus();
    };
    if (this.firstFieldEl === null) this.firstFieldEl = fieldset;

    fieldset.addEventListener('keydown', (event) => {
      // The Custom textarea keeps every key for typing (digits, arrows, Space).
      if (event.target === customInput) return;
      const fromGroup = event.target === fieldset;
      const memberIndex = groupMembers.indexOf(event.target as HTMLElement);
      if (memberIndex === -1 && !fromGroup) return;

      const code = event.code || event.key;
      const delta = code === 'ArrowRight' || code === 'ArrowDown'
        ? 1
        : code === 'ArrowLeft' || code === 'ArrowUp'
          ? -1
          : 0;
      if (delta !== 0) {
        event.preventDefault();
        if (fromGroup) {
          // Enter the list at its first option or at the ✎ toggle.
          focusMember(delta > 0 ? 0 : groupMembers.length - 1);
        } else {
          focusMember(memberIndex + delta);
        }
        return;
      }

      // 1–9 toggles the Nth option while the question or one of its members
      // has focus. Focus deliberately stays where it is: the next Tab must go
      // to the next question, not to the option that was just toggled.
      const digit = /^(?:Digit|Numpad)([1-9])$/.exec(code)
        ?? /^([1-9])$/.exec(event.key ?? '');
      const index = digit === null ? 0 : Number(digit[1]);
      if (index === 0) return;
      const btn = optionButtons[index - 1];
      if (btn === undefined) return;
      event.preventDefault();
      toggleOption(btn);
    });

    return () => fieldset.focus();
  }

  /** Render the live preview section below all placeholder fields (D-13). */
  private renderPreview(): void {
    const previewSection = this.contentEl.createDiv();

    const previewLabel = previewSection.createEl('p', { cls: 'rp-snippet-preview-label' });
    previewLabel.textContent = this.t('snippetFillIn.preview');

    // A div (not a textarea) so inserted placeholder values can be highlighted
    // with spans; static text is preserved verbatim via text nodes.
    this.previewEl = previewSection.createDiv({ cls: 'rp-snippet-preview' });
    this.previewEl.setAttribute('role', 'textbox');
    this.previewEl.setAttribute('aria-readonly', 'true');
    // No aria-label here: Obsidian renders it as a hover tooltip over the
    // preview, and the visible "Preview" heading above already names this
    // region (hover-noise policy, see 3.5.8).
    // Show the raw template initially (unfilled tokens visible per UI-SPEC empty state)
    this.renderPreviewContent();
    this.resizePreview();
  }

  /** Rebuild the preview content: static text nodes + highlighted value spans. */
  private renderPreviewContent(): void {
    if (!this.previewEl) return;
    this.previewEl.empty();
    for (const segment of this.buildPreviewSegments()) {
      if (segment.kind === 'value') {
        const span = this.previewEl.createSpan({ cls: 'rp-snippet-preview-value' });
        span.textContent = segment.text;
      } else if (segment.kind === 'placeholder') {
        // Unfilled placeholders render as an empty grey block instead of the
        // raw {{id}} token. No title/aria-label: hover-noise policy (3.5.8).
        this.previewEl.createSpan({ cls: 'rp-snippet-preview-placeholder' });
      } else {
        this.previewEl.appendText(segment.text);
      }
    }
  }

  /**
   * Split the template into segments: static text, filled placeholder values,
   * and unfilled placeholder tokens. Unfilled placeholders become discrete
   * `placeholder` segments so the preview can render them as grey blocks
   * instead of raw `{{id}}` tokens (UI-SPEC empty state).
   */
  private buildPreviewSegments(): Array<
    { kind: 'static'; text: string }
    | { kind: 'value'; text: string }
    | { kind: 'placeholder'; id: string }
  > {
    const segments: Array<
      { kind: 'static'; text: string }
      | { kind: 'value'; text: string }
      | { kind: 'placeholder'; id: string }
    > = [];
    // Single left-to-right scan of the template. Placeholder fill order and
    // the chip order (placeholders array) are irrelevant to the preview —
    // each token is resolved independently from the values map. The earlier
    // sequential-slice approach broke when the chip order differed from the
    // template token order: filling a later placeholder swallowed the
    // unfilled tokens before it into a static prefix (raw {{id}} instead of
    // grey blocks), and choice values whose token sat "behind" the slice
    // point never appeared in the preview at all.
    const tokenRe = /\{\{\s*([^{}\s]+)\s*\}\}/g;
    let cursor = 0;
    for (let match = tokenRe.exec(this.snippet.template); match !== null; match = tokenRe.exec(this.snippet.template)) {
      if (match.index > cursor) {
        segments.push({ kind: 'static', text: this.snippet.template.slice(cursor, match.index) });
      }
      const id = match[1]!;
      const raw = this.values[id] ?? '';
      if (raw.length > 0) {
        segments.push({ kind: 'value', text: raw });
      } else {
        segments.push({ kind: 'placeholder', id });
      }
      cursor = match.index + match[0].length;
    }
    if (cursor < this.snippet.template.length) {
      segments.push({ kind: 'static', text: this.snippet.template.slice(cursor) });
    }
    return segments;
  }

  /** Keep preview compact for short text and readable for long rendered snippets. */
  private resizePreview(): void {
    if (!this.previewEl) return;
    const scrollHeight = this.previewEl.scrollHeight;
    this.previewEl.style.height = `${Math.max(160, scrollHeight)}px`;
  }

  /** True when every placeholder has a selected/typed value. */
  private areAllPlaceholdersFilled(): boolean {
    return this.snippet.placeholders.length > 0
      && this.snippet.placeholders.every((placeholder) => (this.values[placeholder.id] ?? '').length > 0);
  }

  /** Update the live preview with current field values. */
  private updatePreview(): void {
    if (this.previewEl) {
      this.renderPreviewContent();
      this.previewEl.toggleClass(
        'rp-snippet-preview-complete',
        this.areAllPlaceholdersFilled(),
      );
      this.resizePreview();
    }
  }

  private renderCurrentSnippet(): string {
    return renderMdTemplateSnippet(this.snippet, this.values);
  }

  /**
   * Resolve with the fully-rendered snippet and close the modal.
   * Shared by the Confirm button and the Shift+Enter hotkey — both paths stay
   * identical, including the "unfilled placeholders render empty" behaviour.
   */
  private confirm(): void {
    const rendered = this.renderCurrentSnippet();
    this.safeResolve(rendered);
    this.close();
  }

  /** Render the Cancel / Confirm button row. Confirm is the last tab stop (D-12). */
  private renderButtonRow(): void {
    const row = this.contentEl.createDiv({ cls: 'rp-snippet-modal-btn-row' });

    const cancelBtn = row.createEl('button');
    cancelBtn.textContent = this.t('snippetEditor.cancel');
    this.cancelBtnEl = cancelBtn;
    cancelBtn.addEventListener('click', () => {
      this.safeResolve(null);
      this.close();
    });

    const confirmBtn = row.createEl('button', { cls: 'mod-cta' });
    confirmBtn.textContent = this.t('snippetFillIn.confirm');
    confirmBtn.addEventListener('click', () => {
      this.confirm();
    });
  }
}
