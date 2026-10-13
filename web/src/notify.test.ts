import { describe, expect, it } from 'vitest';
import { channelSummary, listOf, smtpPortFor } from './notify';

describe('notification helpers', () => {
  it('splits user lists on commas, semicolons and spaces', () => {
    expect(listOf(' alice, bob;carol  dave ')).toEqual(['alice', 'bob', 'carol', 'dave']);
    expect(listOf('')).toEqual([]);
  });
  it('summarises a channel by where it sends', () => {
    const channel = (kind: string, config: Record<string, string>) => ({
      id: 'c',
      name: 'C',
      kind,
      config,
    });
    expect(channelSummary(channel('email', { recipients: 'a@example.com' }))).toBe('a@example.com');
    expect(channelSummary(channel('webhook', { url: 'env:HOOK', format: 'feishu' }))).toBe(
      'feishu · env:HOOK',
    );
    expect(channelSummary(channel('pager', {}))).toBe('');
  });
  it('moves an untouched SMTP port with the encryption', () => {
    // The form pre-fills the declared default 587; SSL on 587 fails to connect.
    expect(smtpPortFor('ssl', '587', false)).toBe('465');
    expect(smtpPortFor('starttls', '465', false)).toBe('587');
    expect(smtpPortFor('none', '465', false)).toBe('587');
    expect(smtpPortFor('ssl', '', false)).toBe('465');
    expect(smtpPortFor('ssl', '465', false)).toBeNull();
    // A port the user typed, or a non-standard one, is theirs.
    expect(smtpPortFor('ssl', '587', true)).toBeNull();
    expect(smtpPortFor('ssl', '2525', false)).toBeNull();
  });
});
