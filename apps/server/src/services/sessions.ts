// Chat threads on disk (SPEC 5.4): <project>/.latex-agent/threads/<id>.jsonl, append-only.
//   { type: "thread", id, title, createdAt }   first line
//   { type: "message", message }               one stored transcript message
//   { type: "usage", usage }                   tokens and cost of the messages before it
//   { type: "title", title }                   the title, set after the first run
//   { type: "compaction", summary, firstKeptIndex }
//                                              older messages summarized (SPEC 8.1): the model
//                                              sees the summary, then messages from firstKeptIndex
//                                              (an index into all messages stored before it)
// Messages are opaque here: the agent layer knows what they are.

import { appendFile, mkdir, readdir, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { ThreadSummary, Usage } from '@phi/shared';

import { withFileLock } from './fs.ts';
import { APP_DATA_DIR, PathError, resolveInProject } from './paths.ts';

export const THREADS_DIR = `${APP_DATA_DIR}/threads`;
const THREAD_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface ThreadHeader {
  type: 'thread';
  id: string;
  title: string;
  createdAt: number;
}

type Line =
  | ThreadHeader
  | { type: 'message'; message: unknown }
  | { type: 'usage'; usage: Usage }
  | { type: 'title'; title: string }
  | { type: 'compaction'; summary: string; firstKeptIndex: number };

/** A compaction, with `at`: how many messages were stored when it happened. */
export interface Compaction {
  summary: string;
  firstKeptIndex: number;
  at: number;
}

export interface StoredThread extends ThreadSummary {
  /** Every stored message, compacted or not, in order. */
  messages: unknown[];
  /** In order; the last one decides what the model sees. */
  compactions: Compaction[];
}

/** A thread file that can't be read (not a corrupted last line, which is skipped). */
export class SessionError extends Error {
  override name = 'SessionError';
}

export const ZERO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    costUsd: a.costUsd + b.costUsd,
  };
}

/** Parses a thread file. A corrupted LAST line (a crash mid-write) is skipped with a warning. */
function parse(id: string, text: string): Omit<StoredThread, 'updatedAt'> {
  const raw = text.split('\n');
  while (raw.length > 0 && raw.at(-1)!.trim() === '') raw.pop();
  const lines: Line[] = [];
  raw.forEach((line, i) => {
    try {
      lines.push(JSON.parse(line) as Line);
    } catch {
      if (i === raw.length - 1) {
        console.warn(`Thread ${id}: skipped a corrupted last line (an interrupted write).`);
        return;
      }
      throw new SessionError(`Thread ${id}: line ${i + 1} is corrupted`);
    }
  });

  const header = lines[0];
  if (header?.type !== 'thread')
    throw new SessionError(`Thread ${id}: the first line is not a thread header`);
  const stored: Omit<StoredThread, 'updatedAt'> = {
    id: header.id,
    title: header.title,
    createdAt: header.createdAt,
    usage: ZERO_USAGE,
    messages: [],
    compactions: [],
  };
  for (const line of lines.slice(1)) {
    if (line.type === 'message') stored.messages.push(line.message);
    else if (line.type === 'usage') stored.usage = addUsage(stored.usage, line.usage);
    else if (line.type === 'title') stored.title = line.title;
    else if (line.type === 'compaction') {
      stored.compactions.push({
        summary: line.summary,
        firstKeptIndex: line.firstKeptIndex,
        at: stored.messages.length,
      });
    }
  }
  return stored;
}

const toJsonl = (lines: Line[]) => lines.map((l) => `${JSON.stringify(l)}\n`).join('');

export type SessionStore = ReturnType<typeof createSessionStore>;

export function createSessionStore(root: string) {
  const pathOf = (id: string) => {
    if (!THREAD_ID.test(id)) throw new PathError(`Invalid thread id: ${id}`);
    return resolveInProject(root, `${THREADS_DIR}/${id}.jsonl`, { allowAppData: true });
  };

  async function load(id: string): Promise<StoredThread | null> {
    const path = pathOf(id);
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    const [text, info] = await Promise.all([file.text(), stat(path)]);
    return { ...parse(id, text), updatedAt: info.mtimeMs };
  }

  return {
    load,

    /** Creates an empty thread; throws if one with this id exists. */
    async create(id: string, createdAt = Date.now()): Promise<ThreadHeader> {
      const path = pathOf(id);
      const header: ThreadHeader = { type: 'thread', id, title: '', createdAt };
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, toJsonl([header]), { flag: 'wx' });
      return header;
    },

    /** Appends messages, then a usage line for them (when given). The thread must exist. */
    async append(id: string, messages: unknown[], usage?: Usage): Promise<void> {
      const lines: Line[] = messages.map((message) => ({ type: 'message', message }));
      if (usage) lines.push({ type: 'usage', usage });
      await appendLines(id, lines);
    },

    /** Records that the messages before `firstKeptIndex` are now represented by `summary`. */
    async appendCompaction(id: string, summary: string, firstKeptIndex: number): Promise<void> {
      await appendLines(id, [{ type: 'compaction', summary, firstKeptIndex }]);
    },

    async setTitle(id: string, title: string): Promise<void> {
      await appendLines(id, [{ type: 'title', title }]);
    },

    /** Every readable thread, most recently updated first; unreadable files are skipped. */
    async list(): Promise<ThreadSummary[]> {
      const dir = resolveInProject(root, THREADS_DIR, { allowAppData: true });
      const names = await readdir(dir).catch(() => [] as string[]);
      const threads: ThreadSummary[] = [];
      for (const name of names) {
        const id = name.replace(/\.jsonl$/, '');
        if (id === name || !THREAD_ID.test(id)) continue;
        try {
          const stored = await load(id);
          if (stored) {
            const { messages: _messages, compactions: _compactions, ...summary } = stored;
            threads.push(summary);
          }
        } catch (err) {
          console.warn(`Skipped thread ${id}: ${err instanceof Error ? err.message : err}`);
        }
      }
      return threads.sort((a, b) => b.updatedAt - a.updatedAt);
    },

    async remove(id: string): Promise<void> {
      await rm(pathOf(id), { force: true });
    },
  };

  async function appendLines(id: string, lines: Line[]): Promise<void> {
    if (lines.length === 0) return;
    const path = pathOf(id);
    await withFileLock(path, async () => {
      const file = Bun.file(path);
      if (!(await file.exists())) throw new SessionError(`Thread ${id} does not exist`);
      // After a crash mid-write the file ends inside a line: drop that fragment first.
      const text = await file.text();
      if (text && !text.endsWith('\n')) {
        const keep = text.slice(0, text.lastIndexOf('\n') + 1);
        console.warn(`Thread ${id}: dropped a corrupted last line (an interrupted write).`);
        await truncate(path, Buffer.byteLength(keep));
      }
      await appendFile(path, toJsonl(lines));
    });
  }
}
