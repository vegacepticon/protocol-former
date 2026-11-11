// runner/render/render-footer.ts
// Phase 87 — shared runner Back/Skip footer icon buttons.
import { setIcon } from 'obsidian';
import { createButton } from '../../utils/dom-helpers';
import type { Translator } from '../../i18n';

interface RunnerFooterOptions {
  showBack: boolean;
  onBack: () => void;
  showSkip?: boolean;
  onSkip?: () => void;
  showRedo?: boolean;
  onRedo?: () => void;
  /** Translation function for aria-labels. Defaults to English. */
  t?: Translator;
}

export interface RunnerFooterHost {
  bindClick(el: HTMLElement, handler: (ev: MouseEvent) => void): void;
}

const fallbackT: Translator = (key) => key;

export function renderRunnerFooter(
  zone: HTMLElement,
  host: RunnerFooterHost,
  options: RunnerFooterOptions,
): void {
  if (!options.showBack && options.showSkip !== true && options.showRedo !== true) return;

  const t = options.t ?? fallbackT;
  const footerRow = zone.createDiv({ cls: 'rp-runner-footer-row' });
  if (options.showBack) {
    const backBtn = createButton(footerRow, {
      cls: 'rp-step-back-btn rp-runner-icon-btn',
      attr: { 'aria-label': t('protocolRunner.stepBack') },
    });
    setIcon(backBtn, 'arrow-left');
    // Phase 66 D-01 + D-02 + D-03: visual half of the double-click guard.
    // Disable Back synchronously on first click; runner-side guards handle any races.
    host.bindClick(backBtn, () => {
      backBtn.disabled = true;
      options.onBack();
    });
  }
  if (options.showRedo === true && options.onRedo !== undefined) {
    const redoBtn = createButton(footerRow, {
      cls: 'rp-step-redo-btn rp-runner-icon-btn',
      attr: { 'aria-label': t('protocolRunner.stepRedo') },
    });
    setIcon(redoBtn, 'redo');
    host.bindClick(redoBtn, () => {
      redoBtn.disabled = true;
      options.onRedo!();
    });
  }
  if (options.showSkip === true && options.onSkip !== undefined) {
    const skipBtn = createButton(footerRow, {
      cls: 'rp-skip-btn rp-runner-icon-btn',
      attr: { 'aria-label': t('protocolRunner.stepSkip') },
    });
    setIcon(skipBtn, 'skip-forward');
    host.bindClick(skipBtn, options.onSkip);
  }
}
