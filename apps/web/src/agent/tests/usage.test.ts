/// <reference types="bun" />
import { expect, test } from 'bun:test';

import { formatCost, formatTokens, formatUsage } from '../usage.ts';

test('formatTokens', () => {
  expect([0, 999, 1000, 1234, 12_345, 123_456, 1_500_000].map(formatTokens)).toEqual([
    '0',
    '999',
    '1k',
    '1.2k',
    '12.3k',
    '123k',
    '1.5M',
  ]);
});

test('formatCost keeps small costs visible', () => {
  expect([0, 0.0091275, 0.00004, 0.42, 3].map(formatCost)).toEqual([
    '$0',
    '$0.0091',
    '$0.000040',
    '$0.42',
    '$3.00',
  ]);
});

test('formatUsage shows cache only when used', () => {
  const base = { input: 1200, output: 340, cacheRead: 0, cacheWrite: 0, costUsd: 0.0091 };
  expect(formatUsage(base)).toBe('1.2k in · 340 out · $0.0091');
  expect(formatUsage({ ...base, cacheRead: 800, cacheWrite: 50 })).toBe(
    '1.2k in · 340 out · 850 cached · $0.0091',
  );
});
