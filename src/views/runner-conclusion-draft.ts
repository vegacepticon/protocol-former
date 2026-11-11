import type { Translator } from '../i18n';
import { createButton, createTextarea, growAutoTextarea } from '../utils/dom-helpers';

interface DraftLine { text: string }
const DRAG_TYPE = 'application/x-radiprotocol-conclusion-line';
let nextDraftId = 0;

function growDraftTextarea(textarea: HTMLTextAreaElement): void {
  growAutoTextarea(textarea);
  // scrollHeight excludes borders, while these fields use border-box sizing.
  const borders = textarea.offsetHeight - textarea.clientHeight;
  textarea.setCssProps({ height: `${textarea.scrollHeight + borders}px` });
}

const GROW_DELAY_MS = 0;

/** Session-local editor. Successful writes acknowledge a snapshot, never clear the draft. */
export class RunnerConclusionDraft {
  private readonly root: HTMLElement;
  private readonly list: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  private readonly insert: HTMLButtonElement;
  private readonly dragId = String(++nextDraftId);
  private nextLabelId = 0;
  private lines: DraftLine[] = [];
  private dragged: DraftLine | null = null;
  private insertedText = '';
  private busy = false;
  private destroyed = false;
  private growScheduled = false;
  private growTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private resizeObserver: ResizeObserver | null = null;

  constructor(
    container: HTMLElement,
    private readonly t: Translator,
    onInsert: () => void,
    private readonly onChange: () => void = () => {},
  ) {
    this.root = container.createDiv({ cls: 'rp-runner-draft' });
    // Never let native textarea drops import foreign/plain text. Only our row
    // handler may mutate order, after validating this component's drag token.
    this.root.addEventListener('drop', event => { event.preventDefault(); });

    this.list = this.root.createDiv({ cls: 'rp-runner-draft-list' });
    this.input = createTextarea(this.root, {
      cls: 'rp-runner-draft-input', placeholder: t('runnerDraft.inputPlaceholder'),
      attr: { rows: '1' },
    });
    this.labelControl(this.root, this.input, 'runnerDraft.inputLabel');
    this.input.addEventListener('input', () => {
      growDraftTextarea(this.input);
      this.changed();
    });
    this.input.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
      event.preventDefault();
      if (this.destroyed) return;
      const added = this.input.value.split(/\r?\n/).filter(text => text.trim());
      if (!added.length) return;
      this.lines.push(...added.map(text => ({ text })));
      this.input.value = '';
      growDraftTextarea(this.input);
      this.renderLines();
      this.changed();
    });
    this.insert = createButton(this.root, { cls: 'rp-runner-draft-insert', text: t('runnerDraft.insert'), attr: { type: 'button' } });
    this.insert.addEventListener('click', () => {
      if (!this.destroyed && !this.busy && this.getText().trim()) onInsert();
    });
    growDraftTextarea(this.input);
    this.refresh();
    this.scheduleGrow();
    if (typeof ResizeObserver !== 'undefined') {
      let previousWidth = -1;
      this.resizeObserver = new ResizeObserver(entries => {
        const width = entries[0]?.contentRect.width;
        if (this.destroyed || width === undefined || width === previousWidth) return;
        previousWidth = width;
        this.growFields();
      });
      this.resizeObserver.observe(this.root);
    }
  }

  getText(): string {
    return [...this.lines.map(line => line.text), this.input.value]
      .filter(text => text.trim()).join('\n');
  }

  /** Public focus target for the runner keymap (C). */
  focusInput(): void {
    if (this.destroyed) return;
    this.input.focus();
  }

  hasUninsertedText(): boolean {
    const text = this.getText();
    return Boolean(text.trim()) && text !== this.insertedText;
  }

  markInserted(text: string): void {
    this.insertedText = text;
    this.changed();
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    this.refresh();
  }

  destroy(): void {
    this.destroyed = true;
    this.dragged = null;
    this.clearGrowTimer();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.root.remove();
  }

  private refresh(): void {
    this.insert.disabled = this.destroyed || this.busy || !this.getText().trim();
  }

  private changed(): void {
    if (this.destroyed) return;
    this.refresh();
    this.scheduleGrow();
    this.onChange();
  }

  /**
   * Re-measure every field on the next task, after the DOM rebuilt and the
   * scroll container's gutter settled.
   *
   * A measurement taken inside the rebuild loop is unreliable: the editor is
   * laid out before its delete button exists (so it measures ~one control
   * wider), and the container's scrollbar appears only once all rows are in
   * place. Either way wrapped text re-flows into more lines than the recorded
   * height shows, which clipped long lines until an unrelated width change
   * re-measured them. The same deferred pattern guards the host's answer
   * textareas.
   */
  private scheduleGrow(): void {
    if (this.destroyed || this.growScheduled) return;
    this.growScheduled = true;
    this.growTimer = globalThis.setTimeout(() => {
      this.growScheduled = false;
      this.growTimer = null;
      if (this.destroyed) return;
      this.growFields();
    }, GROW_DELAY_MS);
  }

  private growFields(): void {
    growDraftTextarea(this.input);
    this.list.querySelectorAll<HTMLTextAreaElement>('textarea').forEach(editor => growDraftTextarea(editor));
  }

  private clearGrowTimer(): void {
    if (this.growTimer === null) return;
    globalThis.clearTimeout(this.growTimer);
    this.growTimer = null;
    this.growScheduled = false;
  }

  private move(line: DraftLine, target: number): void {
    const from = this.lines.indexOf(line);
    if (from < 0 || target < 0 || target >= this.lines.length || from === target) return;
    this.lines.splice(from, 1);
    this.lines.splice(target, 0, line);
    this.renderLines();
    this.changed();
  }

  private labelControl(parent: HTMLElement, control: HTMLElement, key: string): void {
    const id = `rp-runner-draft-${this.dragId}-label-${++this.nextLabelId}`;
    parent.createEl('span', { cls: 'rp-sr-only', text: this.t(key), attr: { id } });
    // Obsidian turns aria-label into a tooltip; labelledby keeps the accessible
    // name without introducing hover noise on fields or icon-only controls.
    control.setAttribute('aria-labelledby', id);
  }

  private renderLines(): void {
    this.list.empty();
    this.lines.forEach(line => {
      const row = this.list.createDiv({ cls: 'rp-runner-draft-row' });
      const handle = createButton(row, { cls: 'rp-runner-draft-drag', text: '⠿', attr: { type: 'button', draggable: 'true' } });
      this.labelControl(row, handle, 'runnerDraft.dragLine');
      handle.addEventListener('dragstart', event => {
        if (!event.dataTransfer || this.destroyed) return;
        this.dragged = line;
        event.dataTransfer.setData(DRAG_TYPE, this.dragId);
        event.dataTransfer.effectAllowed = 'move';
      });
      handle.addEventListener('dragend', () => { this.dragged = null; });
      row.addEventListener('dragover', event => {
        if (this.dragged && event.dataTransfer?.types.includes(DRAG_TYPE)) event.preventDefault();
      });
      row.addEventListener('drop', event => {
        if (!this.dragged || event.dataTransfer?.getData(DRAG_TYPE) !== this.dragId) return;
        event.preventDefault();
        const dragged = this.dragged;
        this.dragged = null;
        this.move(dragged, this.lines.indexOf(line));
      });
      const editor = createTextarea(row, { cls: 'rp-runner-draft-line', attr: { rows: '1' } });
      this.labelControl(row, editor, 'runnerDraft.editLine');
      editor.value = line.text;
      editor.addEventListener('input', () => {
        line.text = editor.value;
        growDraftTextarea(editor);
        this.changed();
      });
      const remove = createButton(row, { cls: 'rp-runner-draft-delete', text: '×', attr: { type: 'button' } });
      this.labelControl(row, remove, 'runnerDraft.deleteLine');
      remove.addEventListener('click', () => {
        this.lines = this.lines.filter(candidate => candidate !== line);
        this.renderLines();
        this.input.focus();
        this.changed();
      });
      // Measure only once the row is complete: the editor's grid column is
      // `minmax(0, 1fr)`, so without the trailing delete button it reads one
      // control wider and stores a height that clips the wrapped last line.
      growDraftTextarea(editor);
    });
  }
}
