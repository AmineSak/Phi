import type { ThreadSummary } from '@phi/shared';

import { formatCost } from './usage.ts';

/** The thread's title, or a placeholder until its first run names it. */
export const threadTitle = (thread?: ThreadSummary) => thread?.title || 'New conversation';

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86_400_000],
  ['month', 30 * 86_400_000],
  ['week', 7 * 86_400_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

/** "just now", "5 minutes ago", "yesterday". */
export function relativeTime(ms: number, now = Date.now()): string {
  const elapsed = now - ms;
  const format = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [unit, size] of UNITS) {
    if (elapsed >= size) return format.format(-Math.floor(elapsed / size), unit);
  }
  return 'just now';
}

/** "5 minutes ago · $0.012" for the thread list. */
export const threadDetail = (thread: ThreadSummary, now = Date.now()) =>
  `${relativeTime(thread.updatedAt, now)} · ${formatCost(thread.usage.costUsd)}`;
