// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A modal `<dialog>` is centred by the platform's own sheet (`margin: auto` on a fixed box). The App kit's author rules
 * win over that sheet whatever their specificity, so any margin they give a dialog moves it: the last-child rule
 * (`body > :last-child { margin-bottom: 0 }`) pinned a dialog an App page appended at the end of its document to the
 * bottom of the screen. No rule of ui.css may set a dialog's margin, wherever in the page it sits.
 */
const css = readFileSync(path.join(__dirname, 'ui.css'), 'utf8');

function marginRulesMatching(element: Element): string[] {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.append(style);
  const hits: string[] = [];
  const visit = (rules: CSSRuleList) => {
    for (const rule of [...rules]) {
      if ('cssRules' in rule && !(rule instanceof CSSStyleRule)) visit((rule as CSSGroupingRule).cssRules);
      if (!(rule instanceof CSSStyleRule)) continue;
      const margins = [...rule.style].some((property) => property === 'margin' || property.startsWith('margin-'));
      if (!margins) continue;
      let matches = false;
      try {
        matches = element.matches(rule.selectorText);
      } catch {
        matches = false;
      }
      if (matches) hits.push(rule.selectorText);
    }
  };
  visit(style.sheet!.cssRules);
  style.remove();
  return hits;
}

describe('the App kit leaves a dialog where the platform puts it', () => {
  it('sets no margin on a dialog at the end of the page, of a section, or anywhere else', () => {
    document.body.innerHTML = '<main><p>Page</p><dialog id="in-main"><p>Sure?</p></dialog></main><section><dialog id="first"></dialog><p>x</p></section><dialog id="last"><form method="dialog"></form></dialog>';
    // The App page's own close button.
    document.querySelector('#last form')!.append(Object.assign(document.createElement('button'), { textContent: 'OK' }));
    for (const id of ['last', 'in-main', 'first']) {
      expect(marginRulesMatching(document.getElementById(id)!), id).toEqual([]);
    }
  });

  it('still takes the last child\'s bottom margin off everything else', () => {
    document.body.innerHTML = '<main><p id="p">a</p></main><p id="tail">b</p>';
    expect(marginRulesMatching(document.getElementById('tail')!).length).toBeGreaterThan(0);
    expect(marginRulesMatching(document.getElementById('p')!).length).toBeGreaterThan(0);
  });
});
