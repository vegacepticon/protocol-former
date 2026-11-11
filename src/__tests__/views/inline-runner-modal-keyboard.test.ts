import { describe, expect, it, vi } from 'vitest';
import { makeBaseApp, makeBasePlugin } from '../runner/runner-renderer-host-fixtures';

vi.mock('obsidian', async () => {
  const fixtures = await import('../runner/runner-renderer-host-fixtures');
  return fixtures.createObsidianModuleMock();
});

import { TFile } from 'obsidian';
import { InlineRunnerModal } from '../../views/inline-runner-modal';

function event(options: {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  target?: { tagName: string } | null;
}): KeyboardEvent {
  return {
    key: options.key,
    ctrlKey: options.ctrlKey ?? false,
    altKey: options.altKey ?? false,
    target: options.target ?? null,
    preventDefault: vi.fn(),
  } as unknown as KeyboardEvent;
}

function setup() {
  const plugin = makeBasePlugin();
  const app = makeBaseApp(plugin);
  const modal = new InlineRunnerModal(
    app as any,
    plugin as any,
    'Protocols/test.rp.json',
    new (TFile as any)('notes/target.md'),
  );
  const handleKeydown = vi.fn();
  (modal as any).sessionHost = { handleKeydown, dispose: vi.fn(), hasOpenChildModal: () => false };
  const close = vi.spyOn(modal, 'close').mockImplementation(() => {});
  return { modal, handleKeydown, close };
}

describe('InlineRunnerModal keyboard policy', () => {
  it.each([
    { key: 'ArrowLeft', ctrlKey: true },
    { key: 'ArrowLeft', altKey: true },
    { key: 'ArrowRight', ctrlKey: true },
    { key: 'ArrowRight', altKey: true },
  ])('delegates $key with a navigation modifier to the shared host', (keys) => {
    const h = setup();
    const keyboardEvent = event(keys);
    (h.modal as any).handleKeydown(keyboardEvent);
    expect(h.handleKeydown).toHaveBeenCalledWith(keyboardEvent);
    expect(h.close).not.toHaveBeenCalled();
  });

  it('delegates Escape to the shared host first', () => {
    const h = setup();
    const keyboardEvent = event({ key: 'Escape' });
    (h.modal as any).handleKeydown(keyboardEvent);
    expect(h.handleKeydown).toHaveBeenCalledWith(keyboardEvent);
    // The stub host declines (returns undefined), so the shell fallback closes.
    expect(keyboardEvent.preventDefault).toHaveBeenCalled();
    expect(h.close).toHaveBeenCalledTimes(1);
  });

  it('leaves close and preventDefault to the host when it consumes Escape', () => {
    const h = setup();
    h.handleKeydown.mockReturnValue(true);
    const keyboardEvent = event({ key: 'Escape' });
    (h.modal as any).handleKeydown(keyboardEvent);
    expect(h.handleKeydown).toHaveBeenCalledWith(keyboardEvent);
    expect(keyboardEvent.preventDefault).not.toHaveBeenCalled();
    expect(h.close).not.toHaveBeenCalled();
  });

  it.each(['INPUT', 'TEXTAREA'])('ignores every shell shortcut from %s', (tagName) => {
    const h = setup();
    (h.modal as any).handleKeydown(event({
      key: 'Escape',
      target: { tagName },
    }));
    expect(h.close).not.toHaveBeenCalled();
    expect(h.handleKeydown).not.toHaveBeenCalled();
  });

  it.each(['INPUT', 'TEXTAREA'])('lets Ctrl+Space reach the shared host from %s', (tagName) => {
    const h = setup();
    // Regression for 3.6.19: the shell used to drop every key from a field, so
    // the submit chord never reached the host's keymap.
    const keyboardEvent = event({ key: ' ', ctrlKey: true, target: { tagName } });
    (h.modal as any).handleKeydown(keyboardEvent);
    expect(h.handleKeydown).toHaveBeenCalledWith(keyboardEvent);
    expect(h.close).not.toHaveBeenCalled();
  });
});
