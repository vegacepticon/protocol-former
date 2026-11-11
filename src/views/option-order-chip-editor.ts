// views/option-order-chip-editor.ts
// Focused reorderable chip list for a Question node's outgoing connections.
// Caller owns the `draft` (an ordered array of {id, label} items); this helper
// mutates it in place on DnD reorder and calls `onChange()` after every
// user-visible mutation. Mirrors the tracked-listener + destroy() + splice-DnD
// structure of snippet-chip-editor.ts (Phase 33 MODAL-06), reduced to the
// simple reorder-only case (no add/remove/expand — chips are 1:1 with current
// outgoing edges). Zero plugin/view state; pure DOM + draft mutation.

import { defaultT, type Translator } from '../i18n';

export interface OptionOrderChipItem {
  /** Edge id (stable selection identity). */
  id: string;
  /** Display label for the chip (edge caption / target label). User-authored content — never wrapped in t(). */
  label: string;
}

interface OptionOrderChipEditorHandle {
  /** Detach event listeners and clear the container. Called on modal close. */
  destroy(): void;
}

interface MountOptionOrderChipsOptions {
  /** Translator for the section heading, help text, and drag aria label. */
  t?: Translator;
}

type ListenerTuple = {
  el: EventTarget;
  type: string;
  handler: EventListenerOrEventListenerObject;
};

export function mountOptionOrderChips(
  container: HTMLElement,
  draft: OptionOrderChipItem[],
  onChange: () => void,
  options: MountOptionOrderChipsOptions = {},
): OptionOrderChipEditorHandle {
  container.empty();
  const listeners: ListenerTuple[] = [];
  const t: Translator = options.t ?? defaultT;

  const onRaw = (el: EventTarget, type: string, handler: EventListener): void => {
    el.addEventListener(type, handler);
    listeners.push({ el, type, handler });
  };

  const field = container.createDiv({ cls: 'rp-protocol-editor-modal-field rp-option-order-field' });
  field.createEl('label', { text: t('protocolEditor.optionOrderLabel') });
  field.createDiv({ cls: 'rp-option-order-help', text: t('protocolEditor.optionOrderHelp') });
  const list = field.createDiv({ cls: 'rp-option-order-chip-list' });

  function renderList(): void {
    list.empty();
    for (let i = 0; i < draft.length; i++) {
      const item = draft[i];
      if (item === undefined) continue;
      renderChip(item, i);
    }
  }

  function renderChip(item: OptionOrderChipItem, index: number): void {
    const chip = list.createDiv({ cls: 'rp-option-order-chip' });
    chip.setAttribute('draggable', 'true');
    chip.dataset['dragIndex'] = String(index);

    const handle = chip.createSpan({ cls: 'rp-option-order-chip-handle' });
    handle.textContent = '⠿'; // non-translatable drag-handle glyph
    handle.setAttribute('aria-label', t('protocolEditor.optionOrderDragAria', { label: item.label }));

    const labelSpan = chip.createSpan({ cls: 'rp-option-order-chip-label' });
    labelSpan.textContent = item.label; // user-authored content, not a UI string

    onRaw(chip, 'dragstart', ((e: DragEvent) => {
      e.dataTransfer?.setData('text/plain', chip.dataset['dragIndex'] ?? String(index));
    }) as EventListener);
    onRaw(chip, 'dragover', ((e: DragEvent) => {
      e.preventDefault();
      chip.addClass('drag-over');
    }) as EventListener);
    onRaw(chip, 'dragenter', ((e: DragEvent) => {
      e.preventDefault();
      chip.addClass('drag-over');
    }) as EventListener);
    onRaw(chip, 'dragleave', ((e: DragEvent) => {
      if (chip.contains(e.relatedTarget as Node | null)) return;
      chip.removeClass('drag-over');
    }) as EventListener);
    onRaw(chip, 'drop', ((e: DragEvent) => {
      e.preventDefault();
      chip.removeClass('drag-over');
      const fromStr = e.dataTransfer?.getData('text/plain');
      const from = fromStr !== undefined ? parseInt(fromStr, 10) : -1;
      const to = parseInt(chip.dataset['dragIndex'] ?? '-1', 10);
      if (isNaN(from) || isNaN(to) || from === to || from < 0 || to < 0) return;
      if (from >= draft.length || to >= draft.length) return;
      const [moved] = draft.splice(from, 1);
      if (moved !== undefined) draft.splice(to, 0, moved);
      renderList();
      onChange();
    }) as EventListener);
    onRaw(chip, 'dragend', (() => {
      list.querySelectorAll('.drag-over').forEach((el) => (el as HTMLElement).removeClass('drag-over'));
    }) as EventListener);
  }

  renderList();

  return {
    destroy(): void {
      for (const { el, type, handler } of listeners) {
        el.removeEventListener(type, handler);
      }
      listeners.length = 0;
      container.empty();
    },
  };
}
