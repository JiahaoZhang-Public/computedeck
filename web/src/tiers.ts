import type { MessageKey } from './i18n';

/** How marketplace tiers are named and coloured. The tier comes from where a catalog was added. */
export const TIER_LABELS: Record<string, MessageKey> = {
  official: 'market.tier.official',
  internal: 'market.tier.internal',
  community: 'market.tier.community',
  local: 'market.tier.local',
};
export const TIER_TONES: Record<string, string> = {
  official: 'green',
  internal: 'accent',
  community: 'amber',
  local: 'gray',
};
