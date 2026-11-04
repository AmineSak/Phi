// Saving a thread's transcript as it grows (SPEC 5.4). Only non-system messages are stored:
// the system prompt and tool declarations are rebuilt from code when the thread loads.

import type { Agent, AgentMessage } from '@earendil-works/pi-agent-core';
import type { ThreadSummary, Usage } from '@phi/shared';

import {
  addUsage,
  ZERO_USAGE,
  type SessionStore,
  type StoredThread,
} from '../services/sessions.ts';
import { usageOf } from './wire.ts';

const TITLE_CHARS = 60;

/** The transcript as stored: everything but system messages. */
export const storedMessages = (messages: AgentMessage[]) =>
  messages.filter((m) => m.role !== 'system');

function usageOfMessages(messages: AgentMessage[]): Usage | undefined {
  const assistants = messages.filter((m) => m.role === 'assistant');
  if (assistants.length === 0) return undefined;
  return assistants.reduce((sum, m) => addUsage(sum, usageOf(m)), ZERO_USAGE);
}

/** The thread title: the first 60 characters of its first user message. */
export function titleFrom(messages: AgentMessage[]): string {
  const first = messages.find((m) => m.role === 'user');
  if (!first || first.role !== 'user') return '';
  const text =
    typeof first.content === 'string'
      ? first.content
      : first.content.map((c) => (c.type === 'text' ? c.text : '')).join(' ');
  return text.replace(/\s+/g, ' ').trim().slice(0, TITLE_CHARS);
}

export type ThreadRecord = ReturnType<typeof persistThread>;

/**
 * Keeps thread `id` on disk in step with `agent`. `stored` is what was on disk when the thread
 * loaded (null for a thread not saved yet). `persisted` counts the messages of the agent's
 * transcript already on disk; `rawCount` counts the message lines in the file. They differ
 * once a compaction put a summary in front of the transcript.
 */
export function persistThread(
  id: string,
  agent: Agent,
  sessions: SessionStore,
  stored: StoredThread | null,
  { persisted, rawCount }: { persisted: number; rawCount: number },
) {
  let onDisk = stored !== null;
  let closed = false;
  let title = stored?.title ?? '';
  let usage = stored?.usage ?? ZERO_USAGE;
  let updatedAt = stored?.updatedAt ?? Date.now();
  const createdAt = stored?.createdAt ?? Date.now();
  // Writes run one after another, in order.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (write: () => Promise<void>) => {
    queue = queue.then(write).catch((err: unknown) => {
      console.error(`Could not save thread ${id}:`, err);
    });
    return queue;
  };

  return {
    /** Appends the messages not stored yet, and their usage. */
    save(): Promise<void> {
      return enqueue(async () => {
        if (closed) return;
        const messages = storedMessages(agent.state.messages);
        const fresh = messages.slice(persisted);
        if (fresh.length === 0) return;
        if (!onDisk) {
          await sessions.create(id, createdAt);
          onDisk = true;
        }
        const freshUsage = usageOfMessages(fresh);
        await sessions.append(id, fresh, freshUsage);
        persisted = messages.length;
        rawCount += fresh.length;
        if (freshUsage) usage = addUsage(usage, freshUsage);
        updatedAt = Date.now();
      });
    },

    /**
     * Records a compaction (SPEC 8.1): the agent's transcript is now [summary, ...the last
     * `kept` stored messages]. Call after save(), once the agent's messages are replaced.
     */
    compacted(summary: string, kept: number): Promise<void> {
      // Taken now: messages added after this call are not on disk yet.
      const length = storedMessages(agent.state.messages).length;
      return enqueue(async () => {
        if (closed || !onDisk) return;
        await sessions.appendCompaction(id, summary, rawCount - kept);
        persisted = length;
      });
    },

    /** Sets the title from the first user message if it has none yet; true when it did. */
    async nameIfUntitled(): Promise<boolean> {
      if (title || closed) return false;
      const next = titleFrom(agent.state.messages);
      if (!next) return false;
      title = next;
      await enqueue(async () => {
        if (!closed && onDisk) await sessions.setTitle(id, next);
      });
      return true;
    },

    /** Saves the thread file now (an empty, new thread). */
    async create(): Promise<void> {
      await enqueue(async () => {
        if (onDisk) return;
        await sessions.create(id, createdAt);
        onDisk = true;
      });
    },

    /** Stops saving and waits for writes in progress (before the file is deleted). */
    async close(): Promise<void> {
      closed = true;
      await queue;
    },

    get title() {
      return title;
    },

    summary(): ThreadSummary {
      return { id, title, createdAt, updatedAt, usage };
    },
  };
}
