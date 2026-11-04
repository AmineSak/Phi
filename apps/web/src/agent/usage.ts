import type { Usage } from '@phi/shared';

/** 1234 → "1.2k", 999 → "999", 1_500_000 → "1.5M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${trim(n / 1000)}k`;
  return `${trim(n / 1_000_000)}M`;
}

const trim = (n: number) => (n >= 100 ? String(Math.round(n)) : n.toFixed(1).replace(/\.0$/, ''));

/** Dollars, with enough digits that small per-message costs don't round to $0.00. */
export function formatCost(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toPrecision(2)}`;
  return `$${usd.toFixed(2)}`;
}

/** "1.2k in · 340 out · 800 cached · $0.0091" (cache only when used). */
export function formatUsage(usage: Usage): string {
  const parts = [`${formatTokens(usage.input)} in`, `${formatTokens(usage.output)} out`];
  const cached = usage.cacheRead + usage.cacheWrite;
  if (cached > 0) parts.push(`${formatTokens(cached)} cached`);
  parts.push(formatCost(usage.costUsd));
  return parts.join(' · ');
}
