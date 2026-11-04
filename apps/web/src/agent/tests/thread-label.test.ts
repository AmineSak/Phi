import { expect, test } from 'bun:test';

import type { ThreadSummary } from '@phi/shared';

import { relativeTime, threadDetail, threadTitle } from '../thread-label.ts';

const NOW = 1_800_000_000_000;
const thread = (over: Partial<ThreadSummary> = {}): ThreadSummary => ({
  id: 't',
  title: '',
  createdAt: NOW,
  updatedAt: NOW,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
  ...over,
});

test('untitled threads get a placeholder', () => {
  expect(threadTitle(thread())).toBe('New conversation');
  expect(threadTitle(undefined)).toBe('New conversation');
  expect(threadTitle(thread({ title: 'Fix the intro' }))).toBe('Fix the intro');
});

test('relative times', () => {
  expect(relativeTime(NOW - 10_000, NOW)).toBe('just now');
  expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe('5 minutes ago');
  expect(relativeTime(NOW - 26 * 3_600_000, NOW)).toBe('yesterday');
});

test('detail line: when and what it cost', () => {
  expect(
    threadDetail(
      thread({ updatedAt: NOW - 2 * 3_600_000, usage: { ...thread().usage, costUsd: 0.0123 } }),
      NOW,
    ),
  ).toBe('2 hours ago · $0.01');
});
