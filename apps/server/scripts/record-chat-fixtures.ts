// Records real thread streams from the agent routes (faux model) as JSONL fixtures for the web
// reducer tests. Run: bun apps/server/scripts/record-chat-fixtures.ts
// Each line is one WireEvent as received on GET /stream, or a {"client": …} line marking what
// the tab did (a POST, a reload), so tests can replay the tab's local actions in order.

import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type FauxResponseStep,
} from '@earendil-works/pi-ai/providers/faux';
import { LIST_FILES, READ_FILE } from '@phi/shared';

import { createLlm } from '../src/agent/llm.ts';
import { createThreads } from '../src/agent/threads.ts';
import { agentHandlers } from '../src/routes/agent.ts';
import { guard } from '../src/routes/security.ts';
import { SAMPLE_MAIN } from '../src/routes/tests/test-project.ts';

const OUT = join(import.meta.dir, '../../web/src/agent/tests/__fixtures__');

type Line = Record<string, unknown>;

/** Reads a stream's events into `lines` until `stop` says so (the stream itself never ends). */
async function read(res: Response, lines: Line[], stop: (e: Line) => boolean): Promise<void> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = /^data: (.*)$/m.exec(frame)?.[1];
      if (!data) continue;
      const event = JSON.parse(data) as Line;
      lines.push(event);
      if (stop(event)) {
        await reader.cancel();
        return;
      }
    }
  }
}

interface Ctx {
  script: (...steps: FauxResponseStep[]) => void;
  /** Logs the tab's POST as a client line, then sends it. */
  send: (lines: Line[], text: string, messageId: string) => Promise<Response>;
  abort: () => Promise<Response>;
  stream: (headers?: Record<string, string>) => Promise<Response>;
}

async function scenario(name: string, run: (ctx: Ctx) => Promise<Line[]>) {
  const root = mkdtempSync(join(tmpdir(), 'fixture-project-'));
  cpSync(SAMPLE_MAIN, join(root, 'main.tex'));
  const llm = createLlm({ LLM_PROVIDER: 'faux' });
  const agent = agentHandlers(createThreads({ projectRoot: root, llm }), llm, root);
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    fetch: () => new Response(),
  });
  const port = server.port ?? 0;
  server.reload({
    routes: {
      '/api/threads/:id/messages': { POST: guard(agent.messages, port) },
      '/api/threads/:id/abort': { POST: guard(agent.abort, port) },
      '/api/threads/:id/stream': { GET: guard(agent.stream, port) },
    },
    fetch: () => new Response('Not found', { status: 404 }),
  });
  const base = `http://127.0.0.1:${port}/api/threads/t`;
  try {
    const lines = await run({
      script: (...steps) => llm.faux?.setResponses(steps),
      send: async (lines, text, messageId) => {
        lines.push({ client: 'send', text, messageId });
        const res = await fetch(`${base}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, messageId }),
        });
        lines.push({ client: 'response', messageId, status: res.status, body: await res.json() });
        return res;
      },
      abort: () => fetch(`${base}/abort`, { method: 'POST' }),
      stream: (headers = {}) => fetch(`${base}/stream`, { headers }),
    });
    await Bun.write(
      join(OUT, `${name}.jsonl`),
      lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    );
    console.log(`${name}: ${lines.length} lines`);
  } finally {
    await server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}

function gate() {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => (release = resolve));
  return { release, opened };
}

const isRunEnd = (e: Line) => e.type === 'run_end';

// Thinking, a tool call, then a markdown answer with a code block.
await scenario('tool-run', async ({ script, send, stream }) => {
  script(
    fauxAssistantMessage([
      fauxThinking('I should look at the project files first.'),
      fauxText('Let me check the project.'),
      fauxToolCall(LIST_FILES, {}),
    ]),
    fauxAssistantMessage(
      'The project has one file, `main.tex`. A minimal document:\n\n```latex\n\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n```',
    ),
  );
  const lines: Line[] = [];
  const reading = read(await stream(), lines, isRunEnd);
  await send(lines, 'What is in this project?', 'u1');
  await reading;
  return lines;
});

// A tool that throws: the run continues and the model explains.
await scenario('tool-error', async ({ script, send, stream }) => {
  script(
    fauxAssistantMessage(fauxToolCall(READ_FILE, { path: 'chapters/missing.tex' })),
    fauxAssistantMessage('That file does not exist.'),
  );
  const lines: Line[] = [];
  const reading = read(await stream(), lines, isRunEnd);
  await send(lines, 'Read chapters/missing.tex', 'u1');
  await reading;
  return lines;
});

// Stop after a finished tool, while the next model call is waiting.
await scenario('aborted', async ({ script, send, abort, stream }) => {
  script(
    fauxAssistantMessage([fauxText('Listing files first.'), fauxToolCall(LIST_FILES, {})]),
    (_context, options) =>
      new Promise((resolve) =>
        options?.signal?.addEventListener('abort', () => resolve(fauxAssistantMessage('late'))),
      ),
  );
  const lines: Line[] = [];
  let turns = 0;
  const reading = read(await stream(), lines, (e) => {
    if (e.type === 'turn_start' && ++turns === 2) {
      lines.push({ client: 'abort' });
      void abort();
    }
    return isRunEnd(e);
  });
  await send(lines, 'Rewrite the whole document', 'u1');
  await reading;
  return lines;
});

// A second message sent mid-run is queued and answered in the same run.
await scenario('steered', async ({ script, send, stream }) => {
  const hold = gate();
  script(async () => {
    await hold.opened;
    return fauxAssistantMessage('Here is the introduction fix.');
  }, fauxAssistantMessage('And the bibliography looks fine.'));
  const lines: Line[] = [];
  let steered = false;
  const reading = read(await stream(), lines, (e) => {
    if (e.type === 'turn_start' && !steered) {
      steered = true;
      void send(lines, 'Also check the bibliography.', 'u2').then(() => hold.release());
    }
    return isRunEnd(e);
  });
  await send(lines, 'Fix the intro.', 'u1');
  await reading;
  return lines;
});

// The model call fails.
await scenario('model-error', async ({ script, send, stream }) => {
  script(
    fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'Rate limited by provider' }),
  );
  const lines: Line[] = [];
  const reading = read(await stream(), lines, isRunEnd);
  await send(lines, 'Hello', 'u1');
  await reading;
  return lines;
});

// Reload mid-run: the tab drops after turn_start and reconnects with Last-Event-ID.
await scenario('reconnect', async ({ script, send, stream }) => {
  const hold = gate();
  script(async () => {
    await hold.opened;
    return fauxAssistantMessage('Still here after the reload.');
  });
  const lines: Line[] = [];
  const first = read(await stream(), lines, (e) => e.type === 'turn_start');
  await send(lines, 'Long task', 'u1');
  await first;
  const lastSeq = Number(lines.findLast((l) => typeof l.seq === 'number')?.seq);
  lines.push({ client: 'reload', lastEventId: lastSeq });
  const resumed = await stream({ 'Last-Event-ID': String(lastSeq) });
  hold.release();
  await read(resumed, lines, isRunEnd);
  return lines;
});
