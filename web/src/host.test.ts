// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { installHost } from './host';
import { relativeTime } from './format';

it('keeps plugin relativeTime safe to use as an array callback', () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-01-15T14:00:00Z'));
  try {
    installHost();
    const values = ['2026-01-15T13:00:00Z', '2026-01-14T14:00:00Z'];
    expect(values.map(window.ComputeDeck!.format.relativeTime)).toEqual(
      values.map((value) => relativeTime(value)),
    );
  } finally {
    delete window.ComputeDeck;
    vi.restoreAllMocks();
  }
});
