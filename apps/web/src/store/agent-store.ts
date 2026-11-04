import type { ThreadSummary, WireEvent } from '@phi/shared';
import { create } from 'zustand';

import {
  initialChatState,
  reduce,
  removeMessage,
  upsertUserMessage,
  type ChatState,
} from '../agent/reducer.ts';

export type Connection = 'connecting' | 'open' | 'reconnecting';

interface AgentStore {
  threadId: string | null;
  /** Saved threads, most recent first (SPEC 5.4). */
  threads: ThreadSummary[];
  chat: ChatState;
  connection: Connection;
  /** A request failed (network, 4xx/5xx), separate from a run that ended in error. */
  error: string | null;
  /** Set when the server has no API key: the chat shows a setup card (SPEC 7.2). */
  /** The active provider has no key: its name and the variable that would hold one. */
  missingKey: { envVar: string; provider: string } | null;
  /** The composer's text, kept here so shortcuts can prefill it. */
  draft: string;
  /** Bumped to move focus to the composer (after a prefill). */
  draftFocus: number;
}

export const useAgentStore = create<AgentStore>(() => ({
  threadId: null,
  threads: [],
  chat: initialChatState,
  connection: 'connecting',
  error: null,
  missingKey: null,
  draft: '',
  draftFocus: 0,
}));

export function setDraft(draft: string, { focus = false } = {}): void {
  useAgentStore.setState((s) => ({ draft, draftFocus: focus ? s.draftFocus + 1 : s.draftFocus }));
}

/** Starts a fresh view of `threadId`: its saved history (if any), then the live stream. */
export function resetThread(threadId: string, chat: ChatState = initialChatState): void {
  useAgentStore.setState({
    threadId,
    chat,
    connection: 'connecting',
    error: null,
  });
}

export function dispatchWire(event: WireEvent): void {
  useAgentStore.setState((s) => ({ chat: reduce(s.chat, event) }));
}

export function upsertLocalMessage(id: string, text: string, queued: boolean): void {
  useAgentStore.setState((s) => ({ chat: upsertUserMessage(s.chat, id, text, queued) }));
}

export function dropLocalMessage(id: string): void {
  useAgentStore.setState((s) => ({ chat: removeMessage(s.chat, id) }));
}
