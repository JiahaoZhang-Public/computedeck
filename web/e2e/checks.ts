import { expect, type Page } from '@playwright/test';

import type { DomFinding } from './dom-findings';

export async function checkLayout(page: Page): Promise<DomFinding[]> {
  return page.evaluate(() => {
    const issues: DomFinding[] = [];
    const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
    const identity = (node: Element) => {
      const labelledBy = node
        .getAttribute('aria-labelledby')
        ?.split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ');
      const labels =
        node instanceof HTMLInputElement ||
        node instanceof HTMLSelectElement ||
        node instanceof HTMLTextAreaElement
          ? [...(node.labels ?? [])].map((label) => label.textContent ?? '').join(' ')
          : '';
      const name = normalize(
        labelledBy || node.getAttribute('aria-label') || labels || node.textContent || '',
      );
      if (name) return `${node.getAttribute('role') || node.localName}: ${name}`;
      // Unnamed controls/slots still need distinct, stable identities.
      const parts: string[] = [];
      for (let element: Element | null = node; element; element = element.parentElement) {
        if (element.id) {
          parts.unshift(`#${CSS.escape(element.id)}`);
          break;
        }
        if (!element.parentElement) {
          parts.unshift(element.localName);
          break;
        }
        const siblings = [...element.parentElement.children].filter(
          (sibling) => sibling.localName === element.localName,
        );
        parts.unshift(`${element.localName}:nth-of-type(${siblings.indexOf(element) + 1})`);
      }
      return parts.join(' > ');
    };
    if (document.documentElement.scrollWidth > innerWidth)
      issues.push({
        kind: 'horizontal-overflow',
        identity: 'html',
        width: document.documentElement.scrollWidth,
        viewportWidth: innerWidth,
      });
    const visible = (node: Element) => {
      const box = node.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && getComputedStyle(node).visibility !== 'hidden';
    };
    const textNodes = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const checked = new Set<Element>();
    while (textNodes.nextNode()) {
      const text = textNodes.currentNode;
      const parent = text.parentElement;
      if (!parent || checked.has(parent) || !normalize(text.textContent ?? '')) continue;
      if (parent.closest('script,style') || !visible(parent)) continue;
      const range = document.createRange();
      range.selectNodeContents(text);
      if (![...range.getClientRects()].some((box) => box.width > 0 && box.height > 0)) continue;
      checked.add(parent);
      const style = getComputedStyle(parent);
      const fontSize = parseFloat(style.fontSize);
      const fontWeight = style.fontWeight;
      if (fontSize < 12) issues.push({ kind: 'small-text', identity: identity(parent), fontSize });
      if (!['400', '600'].includes(fontWeight))
        issues.push({ kind: 'unsupported-font-weight', identity: identity(parent), fontWeight });
    }
    for (const cell of document.querySelectorAll('td,th')) {
      if (
        visible(cell) &&
        getComputedStyle(cell).display !== 'table-cell' &&
        cell.scrollHeight > cell.clientHeight + 1
      ) {
        issues.push({
          kind: 'cell-overflow',
          identity: identity(cell),
          height: cell.clientHeight,
          scrollHeight: cell.scrollHeight,
        });
      }
    }
    for (const slot of document.querySelectorAll('.plugin-slot')) {
      if (
        visible(slot) &&
        !slot.textContent?.trim() &&
        !slot.querySelector('img,svg,input,button')
      ) {
        const { width, height } = slot.getBoundingClientRect();
        issues.push({ kind: 'empty-plugin-slot', identity: identity(slot), width, height });
      }
    }
    const headings = new Set<string>();
    for (const heading of document.querySelectorAll('main h1,main h2,main h3')) {
      if (!visible(heading)) continue;
      const text = `${heading.tagName}: ${heading.textContent?.trim()}`;
      if (headings.has(text)) issues.push({ kind: 'duplicate-heading', identity: text });
      headings.add(text);
    }
    if (matchMedia('(pointer: coarse)').matches) {
      for (const control of document.querySelectorAll(
        'button,a[href],input,select,textarea,summary,[role="tab"]',
      )) {
        if (!visible(control)) continue;
        // A switch's transparent input uses its visible label as the hit area.
        const target = control.matches('input[type="checkbox"]')
          ? (control.closest('label') ?? control)
          : control;
        const { width, height } = target.getBoundingClientRect();
        if (width < 44 || height < 44)
          issues.push({ kind: 'small-touch-target', identity: identity(control), width, height });
      }
    }
    return issues;
  });
}

export async function focusObstructions(page: Page) {
  return page.evaluate(async () => {
    const hidden: string[] = [];
    const controls = document.querySelectorAll<HTMLElement>(
      'a[href],button,input,select,textarea,summary,[tabindex]',
    );
    for (const node of controls) {
      if (node.tabIndex < 0 || node.matches(':disabled') || !node.getClientRects().length) continue;
      node.focus();
      if (document.activeElement !== node) continue;
      const target = node.matches('input[type="checkbox"]')
        ? (node.closest('label') ?? node)
        : node;
      const exposed = () => {
        const box = target.getBoundingClientRect();
        const left = Math.max(0, box.left),
          right = Math.min(innerWidth, box.right);
        const top = Math.max(0, box.top),
          bottom = Math.min(innerHeight, box.bottom);
        return (
          right > left &&
          bottom > top &&
          [0.1, 0.5, 0.9].some((x) =>
            [0.1, 0.5, 0.9].some((y) => {
              const hit = document.elementFromPoint(
                left + (right - left) * x,
                top + (bottom - top) * y,
              );
              return !!hit && (target.contains(hit) || hit.contains(target));
            }),
          )
        );
      };
      let visible = exposed();
      // WebKit may reveal focused controls two frames after focus(). Let the
      // browser finish its own reveal; never scroll on its behalf.
      for (let frame = 0; !visible && frame < 3; frame++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        visible = exposed();
      }
      if (!visible)
        hidden.push(node.getAttribute('aria-label') || node.textContent?.trim() || node.tagName);
    }
    return hidden;
  });
}

export async function checkFocus(page: Page) {
  const covered = await focusObstructions(page);
  expect.soft(covered, 'Focused targets entirely covered or outside the viewport').toEqual([]);
}
