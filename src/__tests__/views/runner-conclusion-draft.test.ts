import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { makeEl, type MockEl, type MockEvent } from '../runner/runner-renderer-host-fixtures';
import { defaultT } from '../../i18n';
import { RunnerConclusionDraft } from '../../views/runner-conclusion-draft';

function setup() {
  const container = makeEl();
  const onInsert = vi.fn();
  const onChange = vi.fn();
  const draft = new RunnerConclusionDraft(container as unknown as HTMLElement, defaultT, onInsert, onChange);
  const find = (cls: string) => container.querySelector(`.rp-runner-draft-${cls}`)!;
  const rows = () => container.querySelectorAll('.rp-runner-draft-row');
  const type = (text: string, element = find('input')) => {
    element.value = text;
    element.dispatchEvent({ type: 'input' });
  };
  const commit = (text: string) => {
    type(text);
    find('input').dispatchEvent({ type: 'keydown', key: 'Enter', preventDefault: vi.fn() });
  };
  return { container, draft, onInsert, onChange, find, rows, type, commit };
}

function dragEvent(element: MockEl, type: string, dataTransfer: ReturnType<typeof transfer>) {
  const preventDefault = vi.fn();
  element.dispatchEvent({ type, dataTransfer, preventDefault } as MockEvent);
  return preventDefault;
}

function transfer() {
  const values = new Map<string, string>();
  return {
    effectAllowed: '',
    get types() { return [...values.keys()]; },
    setData: (type: string, value: string) => { values.set(type, value); },
    getData: (type: string) => values.get(type) ?? '',
  };
}

describe('RunnerConclusionDraft', () => {
  it('uses one theme-based control height and centers the insert button', () => {
    const css = readFileSync(new URL('../../styles/runner-session.css', import.meta.url), 'utf8');
    expect(css).toMatch(/--rp-runner-draft-control-height:\s*var\(--input-height,\s*30px\)/);
    expect(css).toMatch(/\.rp-runner-draft-line\s*\{[^}]*min-height:\s*var\(--rp-runner-draft-control-height\)/);
    expect(css).toMatch(/\.rp-runner-draft-delete\s*\{[^}]*height:\s*var\(--rp-runner-draft-control-height\)/);
    expect(css).toMatch(/\.rp-runner-draft-insert\s*\{\s*align-self:\s*center/);
    expect(css).not.toMatch(/\.rp-runner-draft-(?:up|down|help|controls)\b/);
  });

  it('reserves the draft scrollbar gutter so measured width equals rendered width', () => {
    const css = readFileSync(new URL('../../styles/runner-session.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.rp-runner-draft-container\s*\{[^}]*scrollbar-gutter:\s*stable/);
  });

  it('measures a line only once its row is complete', () => {
    const s = setup();
    const list = s.container.querySelector('.rp-runner-draft-list')!;
    const reads: boolean[] = [];
    const createDiv = list.createDiv.bind(list);
    list.createDiv = (opts) => {
      const row = createDiv(opts);
      const createEl = row.createEl.bind(row);
      row.createEl = (tag, elOpts) => {
        const el = createEl(tag, elOpts);
        if (tag === 'textarea') {
          // A row measured before its delete button exists resolves the editor's
          // `minmax(0, 1fr)` column one control wider and clips wrapped lines.
          Object.defineProperty(el, 'scrollHeight', {
            get: () => {
              reads.push(row.children.some(child => child.hasClass('rp-runner-draft-delete')));
              return 24;
            },
          });
        }
        return el;
      };
      return row;
    };
    s.commit('One\nTwo');
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every(Boolean)).toBe(true);
  });

  it('re-measures every field once the rebuild settles, once per task', () => {
    vi.useFakeTimers();
    try {
      const s = setup();
      s.commit('Wrapped one\nWrapped two');
      const lines = s.container.querySelectorAll('.rp-runner-draft-line');
      const fields = [s.find('input'), ...lines];
      s.type(' pending', s.find('input'));
      // Two rebuild/measure triggers, one pending pass.
      expect(vi.getTimerCount()).toBe(1);
      for (const field of fields) {
        // Heights as recorded mid-rebuild: too short for the settled width.
        field.setCssProps({ height: '30px' });
        field.scrollHeight = 96;
        field.offsetHeight = 92;
        field.clientHeight = 90;
      }
      expect(fields.map(field => field.style.height)).toEqual(['30px', '30px', '30px']);
      vi.advanceTimersByTime(0);
      expect(fields.map(field => field.style.height)).toEqual(['98px', '98px', '98px']);
      expect(vi.getTimerCount()).toBe(0);
      s.draft.destroy();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('accounts for borders and remeasures on width changes, disconnecting on destroy', () => {
    let resize!: (entries: Array<{ contentRect: { width: number } }>) => void;
    const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: typeof resize) { resize = callback; }
      observe(): void {}
      disconnect = disconnect;
    });
    try {
      const s = setup();
      s.commit('Wrapped line');
      const line = s.find('line');
      line.scrollHeight = 90;
      line.clientHeight = 88;
      line.offsetHeight = 90;
      resize([{ contentRect: { width: 240 } }]);
      expect(line.style.height).toBe('92px');
      line.scrollHeight = 120;
      resize([{ contentRect: { width: 160 } }]);
      expect(line.style.height).toBe('122px');
      s.draft.destroy();
      expect(disconnect).toHaveBeenCalledOnce();
    } finally { vi.unstubAllGlobals(); }
  });

  it('starts clean and blank; whitespace does not produce entries or enable insertion', () => {
    const s = setup();
    expect(s.draft.getText()).toBe('');
    expect(s.draft.hasUninsertedText()).toBe(false);
    expect(s.find('insert').disabled).toBe(true);
    s.commit(' \n\t ');
    expect(s.rows()).toHaveLength(0);
    expect(s.draft.getText()).toBe('');
    expect(s.draft.hasUninsertedText()).toBe(false);
    s.find('insert').dispatchEvent({ type: 'click' });
    expect(s.onInsert).not.toHaveBeenCalled();
  });

  it('seeds protocol preset lines as a baseline without clobbering typed text', () => {
    const s = setup();
    s.draft.setPresetLines(['  First  ', '', 'Second']);
    expect(s.rows()).toHaveLength(2);
    expect(s.container.querySelectorAll('.rp-runner-draft-line').map((line) => line.value)).toEqual(['First', 'Second']);
    expect(s.draft.getText()).toBe('First\nSecond');
    expect(s.draft.hasUninsertedText()).toBe(false);
    expect(s.find('insert').disabled).toBe(false);

    // A later preset application must not overwrite the seeded draft.
    s.draft.setPresetLines(['Replacement']);
    expect(s.draft.getText()).toBe('First\nSecond');

    // Editing after seeding is user work again.
    s.type('Changed', s.find('line'));
    expect(s.draft.hasUninsertedText()).toBe(true);

    const typed = setup();
    typed.type('Typed before load');
    typed.draft.setPresetLines(['Preset']);
    expect(typed.rows()).toHaveLength(0);
    expect(typed.draft.getText()).toBe('Typed before load');
  });

  it('ignores an empty preset', () => {
    const s = setup();
    s.draft.setPresetLines([]);
    s.draft.setPresetLines([' ', '\t']);
    expect(s.rows()).toHaveLength(0);
    expect(s.draft.getText()).toBe('');
    expect(s.draft.hasUninsertedText()).toBe(false);
  });

  it('commits each nonblank pasted line on plain Enter, retaining useful whitespace', () => {
    const s = setup();
    s.commit('  First  \r\n\nSecond\n \t\nThird');
    expect(s.rows()).toHaveLength(3);
    expect(s.find('input').value).toBe('');
    expect(s.draft.getText()).toBe('  First  \nSecond\nThird');
    s.type(' pending\ntext ');
    expect(s.draft.getText()).toBe('  First  \nSecond\nThird\n pending\ntext ');
    expect(s.draft.hasUninsertedText()).toBe(true);
    expect(s.onChange).toHaveBeenCalled();
    s.find('insert').dispatchEvent({ type: 'click' });
    expect(s.onInsert).toHaveBeenCalledOnce();
  });

  it('leaves Shift+Enter, modifiers and IME composition to the textarea', () => {
    const s = setup();
    s.type('First');
    for (const extra of [{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }]) {
      const preventDefault = vi.fn();
      s.find('input').dispatchEvent({ type: 'keydown', key: 'Enter', preventDefault, ...extra });
      expect(preventDefault).not.toHaveBeenCalled();
    }
    expect(s.rows()).toHaveLength(0);
    expect(s.draft.getText()).toBe('First');
  });

  it('edits, auto-grows and deletes individual rows without losing other content', () => {
    const s = setup();
    s.commit('First\nSecond');
    const line = s.find('line');
    line.scrollHeight = 96;
    s.type('  Revised\nwrapped  ', line);
    expect(line.style.height).toBe('96px');
    expect(s.draft.getText()).toBe('  Revised\nwrapped  \nSecond');
    s.find('delete').dispatchEvent({ type: 'click' });
    expect(s.draft.getText()).toBe('Second');
    expect(s.rows()).toHaveLength(1);
    s.type('   ', s.find('line'));
    expect(s.draft.getText()).toBe('');
    expect(s.find('insert').disabled).toBe(true);
  });

  it('acknowledges successful snapshots, including writes completed after newer edits', () => {
    const s = setup();
    s.commit('First');
    s.draft.markInserted('First');
    expect(s.draft.getText()).toBe('First');
    expect(s.draft.hasUninsertedText()).toBe(false);
    s.type('Revised', s.find('line'));
    expect(s.draft.hasUninsertedText()).toBe(true);
    s.draft.markInserted('First');
    expect(s.draft.hasUninsertedText()).toBe(true);
    s.type('First', s.find('line'));
    expect(s.draft.hasUninsertedText()).toBe(false);
    s.type('pending');
    s.draft.markInserted('First\npending');
    expect(s.draft.hasUninsertedText()).toBe(false);
    s.find('input').dispatchEvent({ type: 'keydown', key: 'Enter', preventDefault: vi.fn() });
    expect(s.draft.hasUninsertedText()).toBe(false);
  });

  it('blocks insertion while busy but preserves concurrent editing and snapshot dirtiness', () => {
    const s = setup();
    s.type('Before');
    s.draft.setBusy(true);
    expect(s.find('insert').disabled).toBe(true);
    s.find('insert').dispatchEvent({ type: 'click' });
    expect(s.onInsert).not.toHaveBeenCalled();
    s.type('After');
    s.draft.markInserted('Before');
    s.draft.setBusy(false);
    expect(s.find('insert').disabled).toBe(false);
    expect(s.draft.getText()).toBe('After');
    expect(s.draft.hasUninsertedText()).toBe(true);
  });

  it('keeps the draft minimal and labels controls without Obsidian hover tooltips', () => {
    const s = setup();
    s.commit('One\nTwo\nThree');
    expect(s.container.querySelector('h3')).toBeNull();
    for (const removed of ['help', 'up', 'down']) expect(s.find(removed)).toBeNull();
    for (const control of [s.find('input'), ...s.container.querySelectorAll('.rp-runner-draft-line'),
      ...s.container.querySelectorAll('.rp-runner-draft-drag'), ...s.container.querySelectorAll('.rp-runner-draft-delete')]) {
      expect(control.getAttribute('aria-label')).toBeNull();
      expect(control.getAttribute('title')).toBeNull();
      const labelId = control.getAttribute('aria-labelledby');
      expect(labelId).toBeTruthy();
      const label = s.container.querySelectorAll('span').find(el => el.getAttribute('id') === labelId);
      expect(label?.hasClass('rp-sr-only')).toBe(true);
      expect(label?.textContent).toBeTruthy();
    }
  });

  it('reorders by handle drag only within the owning component', () => {
    const a = setup();
    const b = setup();
    a.commit('One\nTwo');
    a.draft.markInserted(a.draft.getText());
    b.commit('Foreign\nOther');
    const data = transfer();
    dragEvent(a.find('drag'), 'dragstart', data);
    expect(data.effectAllowed).toBe('move');
    expect(dragEvent(a.rows()[1]!, 'dragover', data)).toHaveBeenCalled();
    expect(dragEvent(b.rows()[1]!, 'drop', data)).not.toHaveBeenCalled();
    expect(b.draft.getText()).toBe('Foreign\nOther');
    dragEvent(a.rows()[1]!, 'drop', data);
    expect(a.draft.getText()).toBe('Two\nOne');
    expect(a.draft.hasUninsertedText()).toBe(true);
    const back = transfer();
    dragEvent(a.find('drag'), 'dragstart', back);
    dragEvent(a.rows()[1]!, 'drop', back);
    expect(a.draft.getText()).toBe('One\nTwo');
    expect(a.draft.hasUninsertedText()).toBe(false);
    const again = transfer();
    dragEvent(a.find('drag'), 'dragstart', again);
    dragEvent(a.rows()[1]!, 'drop', again);
    const plain = transfer();
    plain.setData('text/plain', 'Injected');
    // MockEl does not bubble events: exercise the root guard explicitly too.
    expect(dragEvent(a.container.querySelector('.rp-runner-draft')!, 'drop', plain)).toHaveBeenCalled();
    expect(dragEvent(a.rows()[0]!, 'drop', plain)).not.toHaveBeenCalled();
    expect(a.draft.getText()).toBe('Two\nOne');
    // Even an active local drag must not accept another component's payload.
    dragEvent(a.find('drag'), 'dragstart', transfer());
    const foreign = transfer();
    dragEvent(b.find('drag'), 'dragstart', foreign);
    expect(dragEvent(a.rows()[1]!, 'drop', foreign)).not.toHaveBeenCalled();
    expect(a.draft.getText()).toBe('Two\nOne');
    dragEvent(a.find('drag'), 'dragend', foreign);
    expect(dragEvent(a.rows()[1]!, 'drop', data)).not.toHaveBeenCalled();
  });

  it('removes only its own DOM on destroy and suppresses insertion and notifications', () => {
    const s = setup();
    const sibling = s.container.createDiv({ text: 'Host content' });
    const insert = s.find('insert');
    s.type('Retained');
    s.onChange.mockClear();
    s.draft.destroy();
    s.draft.destroy();
    expect(s.container.children).toEqual([sibling]);
    insert.dispatchEvent({ type: 'click' });
    s.draft.markInserted('Retained');
    expect(s.onInsert).not.toHaveBeenCalled();
    expect(s.onChange).not.toHaveBeenCalled();
  });
});
