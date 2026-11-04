import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSessionStore, SessionError, THREADS_DIR, ZERO_USAGE } from '../sessions.ts';

let root: string;
let store: ReturnType<typeof createSessionStore>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sessions-test-'));
  store = createSessionStore(root);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const file = (id: string) => join(root, THREADS_DIR, `${id}.jsonl`);
const usage = (input: number, costUsd: number) => ({ ...ZERO_USAGE, input, output: 1, costUsd });
const user = (text: string) => ({ role: 'user', content: text, timestamp: 1 });

test('a new thread is one header line; load returns it with no messages', async () => {
  await store.create('t1', 1000);
  expect(readFileSync(file('t1'), 'utf8')).toBe(
    '{"type":"thread","id":"t1","title":"","createdAt":1000}\n',
  );
  expect(await store.load('t1')).toMatchObject({
    id: 't1',
    title: '',
    createdAt: 1000,
    messages: [],
    usage: ZERO_USAGE,
  });
  expect(await store.load('missing')).toBeNull();
  await expect(store.create('t1')).rejects.toThrow();
});

test('messages, usage and title lines append; load sums usage and keeps message order', async () => {
  await store.create('t1');
  await store.append('t1', [user('one'), { role: 'assistant', content: [] }], usage(10, 0.5));
  await store.setTitle('t1', 'Fix the intro');
  await store.append('t1', [user('two')], usage(5, 0.25));
  const lines = readFileSync(file('t1'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  expect(lines.map((l) => l.type)).toEqual([
    'thread',
    'message',
    'message',
    'usage',
    'title',
    'message',
    'usage',
  ]);

  const loaded = await store.load('t1');
  expect(loaded?.messages).toEqual([user('one'), { role: 'assistant', content: [] }, user('two')]);
  expect(loaded?.usage).toEqual({ ...ZERO_USAGE, input: 15, output: 2, costUsd: 0.75 });
  expect(loaded?.title).toBe('Fix the intro');
});

test('appending needs an existing thread', async () => {
  await expect(store.append('nope', [user('x')])).rejects.toThrow(SessionError);
});

test('a corrupted last line (crash mid-write) is skipped with a warning; later appends still work', async () => {
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  await store.create('t1');
  await store.append('t1', [user('kept')]);
  appendFileSync(file('t1'), '{"type":"message","message":{"role":"us'); // no newline: cut off
  expect((await store.load('t1'))?.messages).toEqual([user('kept')]);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipped a corrupted last line'));

  // The next append starts on a new line, so only the broken fragment is lost.
  await store.append('t1', [user('after')]);
  expect((await store.load('t1'))?.messages).toEqual([user('kept'), user('after')]);
  warn.mockRestore();
});

test('a corrupted line in the middle is an error, not silently dropped', async () => {
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  await store.create('t1');
  appendFileSync(file('t1'), 'garbage\n');
  await store.append('t1', [user('x')]);
  await expect(store.load('t1')).rejects.toThrow('line 2 is corrupted');
  // The list skips the unreadable thread instead of failing.
  expect(await store.list()).toEqual([]);
  warn.mockRestore();
});

test('list: summaries without messages, most recently updated first; remove deletes the file', async () => {
  await store.create('old', 1);
  await store.create('new', 2);
  await store.append('old', [user('x')], usage(3, 0.1));
  utimesSync(file('old'), new Date(1000), new Date(1000));
  const list = await store.list();
  expect(list.map((t) => t.id)).toEqual(['new', 'old']);
  expect(list[1]).toEqual({
    id: 'old',
    title: '',
    createdAt: 1,
    updatedAt: 1000,
    usage: { ...ZERO_USAGE, input: 3, output: 1, costUsd: 0.1 },
  });

  await store.remove('old');
  expect(existsSync(file('old'))).toBe(false);
  expect((await store.list()).map((t) => t.id)).toEqual(['new']);
  await store.remove('old'); // removing twice is fine
});

test('thread ids are checked: no paths', async () => {
  await expect(store.create('../escape')).rejects.toThrow('Invalid thread id');
  await expect(store.load('a/b')).rejects.toThrow('Invalid thread id');
});

test('compaction lines: recorded with where they happened; messages are all kept', async () => {
  await store.create('t1');
  await store.append('t1', [user('a'), user('b'), user('c')]);
  await store.appendCompaction('t1', 'Summary of a and b.', 2);
  await store.append('t1', [user('d')]);
  const loaded = await store.load('t1');
  expect(loaded?.messages).toEqual([user('a'), user('b'), user('c'), user('d')]);
  expect(loaded?.compactions).toEqual([
    { summary: 'Summary of a and b.', firstKeptIndex: 2, at: 3 },
  ]);
});
