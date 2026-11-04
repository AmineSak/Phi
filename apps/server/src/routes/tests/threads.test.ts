import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import type {
  ThreadHistoryResponse,
  ThreadListResponse,
  ThreadSummary,
  WireEvent,
} from '@phi/shared';

import { createLlm, type Llm } from '../../agent/llm.ts';
import { createThreads } from '../../agent/threads.ts';
import { THREADS_DIR } from '../../services/sessions.ts';
import { agentHandlers } from '../agent.ts';
import { guard } from '../security.ts';
import { tempProject } from './test-project.ts';

let project: ReturnType<typeof tempProject>;
let llm: Llm;
let threads: ReturnType<typeof createThreads>;
let server: ReturnType<typeof Bun.serve>;
let base: string;

function start() {
  llm = createLlm({ LLM_PROVIDER: 'faux' });
  threads = createThreads({ projectRoot: project.root, llm });
  const agent = agentHandlers(threads, llm, project.root);
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const port = server.port ?? 0;
  base = `http://127.0.0.1:${port}/api/threads`;
  server.reload({
    routes: {
      '/api/threads': {
        GET: guard(agent.listThreads, port),
        POST: guard(agent.createThread, port),
      },
      '/api/threads/:id': { DELETE: guard(agent.deleteThread, port) },
      '/api/threads/:id/status': { GET: guard(agent.status, port) },
      '/api/threads/:id/messages': {
        GET: guard(agent.history, port),
        POST: guard(agent.messages, port),
      },
    },
    fetch: () => new Response('Not found', { status: 404 }),
  });
}

/** Restarts the server process on the same project. */
async function restart() {
  await threads.flush();
  await server.stop(true);
  start();
}

beforeEach(() => {
  project = tempProject();
  start();
});

afterEach(async () => {
  await threads.flush().catch(() => {});
  await server.stop(true);
  project.remove();
});

const json = <T>(res: Response) => res.json() as Promise<T>;

async function untilRunEnd(id: string) {
  const thread = await threads.getOrCreateThread(id);
  for (let i = 0; i < 200 && thread.runner.isRunning; i++) await Bun.sleep(10);
  await threads.flush();
}

test('POST creates a thread; GET lists it with title, times and usage', async () => {
  const created = await fetch(base, { method: 'POST' });
  expect(created.status).toBe(201);
  const thread = await json<ThreadSummary>(created);
  expect(thread).toMatchObject({ title: '', usage: { input: 0, costUsd: 0 } });
  expect(existsSync(join(project.root, THREADS_DIR, `${thread.id}.jsonl`))).toBe(true);

  llm.faux?.setResponses([fauxAssistantMessage('Hello!')]);
  await fetch(`${base}/${thread.id}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Say hello' }),
  });
  await untilRunEnd(thread.id);

  const list = await json<ThreadListResponse>(await fetch(base));
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ id: thread.id, title: 'Say hello' });
  expect(list[0]!.usage.output).toBeGreaterThan(0);
  expect(list[0]!.updatedAt).toBeGreaterThanOrEqual(thread.createdAt);
});

test('GET /messages: history after a restart, as wire events; 404 for an unknown thread', async () => {
  llm.faux?.setResponses([fauxAssistantMessage('Hi there.')]);
  await fetch(`${base}/t1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Hello' }),
  });
  await untilRunEnd('t1');
  await restart();

  const res = await fetch(`${base}/t1/messages`);
  expect(res.status).toBe(200);
  const body = await json<ThreadHistoryResponse>(res);
  expect(body.thread).toMatchObject({ id: 't1', title: 'Hello' });
  expect(body.events.map((e) => e.type)).toEqual(['user_message', 'text_delta', 'message_end']);
  expect(body.events[1]).toMatchObject({ delta: 'Hi there.' });

  expect((await fetch(`${base}/nothing-here/messages`)).status).toBe(404);
});

test('DELETE aborts a running run, tells the tabs, and deletes the file', async () => {
  llm.faux?.setResponses([
    (_context, options) =>
      new Promise((resolve) => {
        if (options?.signal?.aborted) return resolve(fauxAssistantMessage('late'));
        options?.signal?.addEventListener('abort', () => resolve(fauxAssistantMessage('late')));
      }),
  ]);
  const { id } = await json<ThreadSummary>(await fetch(base, { method: 'POST' }));
  const thread = await threads.getOrCreateThread(id);
  const events: WireEvent[] = [];
  thread.subscribe(0, (e) => events.push(e));
  await fetch(`${base}/${id}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Write a long chapter' }),
  });
  await Bun.sleep(30);
  expect(thread.runner.isRunning).toBe(true);

  const res = await fetch(`${base}/${id}`, { method: 'DELETE' });
  expect(res.status).toBe(204);
  expect(thread.runner.isRunning).toBe(false);
  expect(events).toContainEqual(expect.objectContaining({ type: 'run_end', reason: 'aborted' }));
  expect(events.at(-1)).toMatchObject({ type: 'thread_updated', threadId: id, deleted: true });
  expect(existsSync(join(project.root, THREADS_DIR, `${id}.jsonl`))).toBe(false);
  expect(await json<ThreadListResponse>(await fetch(base))).toEqual([]);
});

test('GET /status: running with its runId during a run, idle after', async () => {
  llm.faux?.setResponses([
    (_context, options) =>
      new Promise((resolve) => {
        if (options?.signal?.aborted) return resolve(fauxAssistantMessage('late'));
        options?.signal?.addEventListener('abort', () => resolve(fauxAssistantMessage('late')));
      }),
  ]);
  const status = async () =>
    (await (await fetch(`${base}/t1/status`)).json()) as { running: boolean; runId: string | null };
  expect(await status()).toEqual({ running: false, runId: null });

  const res = await fetch(`${base}/t1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Write a long chapter' }),
  });
  const { runId } = (await res.json()) as { runId: string };
  expect(await status()).toEqual({ running: true, runId });

  const thread = await threads.getOrCreateThread('t1');
  thread.runner.abort();
  await thread.runner.whenIdle();
  expect(await status()).toEqual({ running: false, runId: null });
});
