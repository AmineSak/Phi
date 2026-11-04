import type { UnsequencedWireEvent, Usage, WireEvent } from '@phi/shared';

export interface UserMessage {
  role: 'user';
  id: string;
  text: string;
  /** Sent while a run was active; waiting for the agent's next turn to pick it up. */
  queued: boolean;
}

export interface AssistantMessage {
  role: 'assistant';
  id: string;
  text: string;
  thinking: string;
  streaming: boolean;
  /** Set at message_end. A step that only called tools has usage but no text. */
  usage?: Usage;
}

/** Marks where a tool call sits in the conversation; its data lives in `tools`. */
export interface ToolMessage {
  role: 'tool';
  id: string;
}

/** Where older messages were summarized to fit the model's context (SPEC 8.1). */
export interface CompactionMarker {
  role: 'compaction';
  id: string;
  summary: string;
}

export type ChatMessage = UserMessage | AssistantMessage | ToolMessage | CompactionMarker;

export interface ToolCall {
  id: string;
  name: string;
  label: string;
  args: unknown;
  status: 'running' | 'done' | 'error';
  /** Latest progress text while running. */
  progress?: string;
  summary?: string;
  details?: unknown;
}

export type RunStatus = 'idle' | 'running' | 'done' | 'aborted' | 'error';

export interface ChatState {
  messages: ChatMessage[];
  tools: Record<string, ToolCall>;
  runStatus: RunStatus;
  runError?: string;
  /** What the server is doing right now ("Retrying (2/3)…"), until something streams. */
  status?: string;
  /** Sum of every assistant message's usage in the thread. */
  totals: Usage;
  /** Highest wire seq applied; replayed events at or below it are ignored. */
  lastSeq: number;
}

export const ZERO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };

export const initialChatState: ChatState = {
  messages: [],
  tools: {},
  runStatus: 'idle',
  totals: ZERO_USAGE,
  lastSeq: 0,
};

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    costUsd: a.costUsd + b.costUsd,
  };
}

/** Adds or updates a user message by id (the sender's optimistic copy and the server's event merge). */
export function upsertUserMessage(
  state: ChatState,
  id: string,
  text: string,
  queued: boolean,
): ChatState {
  const exists = state.messages.some((m) => m.role === 'user' && m.id === id);
  const message: UserMessage = { role: 'user', id, text, queued };
  return {
    ...state,
    messages: exists
      ? state.messages.map((m) => (m.role === 'user' && m.id === id ? message : m))
      : [...state.messages, message],
  };
}

/** Removes a message the server refused (e.g. no API key). */
export function removeMessage(state: ChatState, id: string): ChatState {
  return { ...state, messages: state.messages.filter((m) => m.id !== id) };
}

function updateAssistant(
  state: ChatState,
  id: string,
  update: (m: AssistantMessage) => AssistantMessage,
): ChatMessage[] {
  const index = state.messages.findIndex((m) => m.role === 'assistant' && m.id === id);
  if (index === -1) {
    const created: AssistantMessage = {
      role: 'assistant',
      id,
      text: '',
      thinking: '',
      streaming: true,
    };
    return [...state.messages, update(created)];
  }
  return state.messages.map((m, i) => (i === index ? update(m as AssistantMessage) : m));
}

function updateTool(state: ChatState, id: string, update: (t: ToolCall) => ToolCall): ChatState {
  const tool = state.tools[id];
  return tool ? { ...state, tools: { ...state.tools, [id]: update(tool) } } : state;
}

function apply(state: ChatState, event: WireEvent): ChatState {
  switch (event.type) {
    case 'user_message':
      return upsertUserMessage(state, event.messageId, event.text, event.queued);

    case 'run_start':
      return { ...state, runStatus: 'running', runError: undefined };

    case 'turn_start':
      // The agent picks up queued messages at the start of a turn.
      return state.messages.some((m) => m.role === 'user' && m.queued)
        ? {
            ...state,
            messages: state.messages.map((m) =>
              m.role === 'user' && m.queued ? { ...m, queued: false } : m,
            ),
          }
        : state;

    case 'text_delta':
      return {
        ...state,
        messages: updateAssistant(state, event.messageId, (m) => ({
          ...m,
          text: m.text + event.delta,
        })),
      };

    case 'thinking_delta':
      return {
        ...state,
        messages: updateAssistant(state, event.messageId, (m) => ({
          ...m,
          thinking: m.thinking + event.delta,
        })),
      };

    case 'message_end':
      return {
        ...state,
        totals: addUsage(state.totals, event.usage),
        messages: updateAssistant(state, event.messageId, (m) => ({
          ...m,
          streaming: false,
          usage: event.usage,
        })),
      };

    case 'tool_start':
      return {
        ...state,
        messages: [...state.messages, { role: 'tool', id: event.toolCallId }],
        tools: {
          ...state.tools,
          [event.toolCallId]: {
            id: event.toolCallId,
            name: event.name,
            label: event.label,
            args: event.args,
            status: 'running',
          },
        },
      };

    case 'tool_update':
      return updateTool(state, event.toolCallId, (t) => ({ ...t, progress: event.text }));

    case 'tool_end':
      return updateTool(state, event.toolCallId, (t) => ({
        ...t,
        status: event.isError ? 'error' : 'done',
        summary: event.summary,
        progress: undefined,
        ...(event.details === undefined ? {} : { details: event.details }),
      }));

    case 'run_end': {
      // Nothing streams or runs after run_end, even if its own end events were lost (SPEC 8.3).
      const tools = Object.fromEntries(
        Object.entries(state.tools).map(([id, t]) =>
          t.status === 'running'
            ? [id, { ...t, status: 'error' as const, summary: 'Stopped' }]
            : [id, t],
        ),
      );
      return {
        ...state,
        runStatus: event.reason,
        runError: event.error,
        tools,
        messages: state.messages.map((m) =>
          m.role === 'assistant' && m.streaming ? { ...m, streaming: false } : m,
        ),
      };
    }

    case 'status':
      return { ...state, status: event.message };

    case 'compacted':
      return {
        ...state,
        messages: [
          ...state.messages,
          { role: 'compaction', id: `compaction-${state.messages.length}`, summary: event.summary },
        ],
      };

    // Reviews live in the review store.
    case 'turn_end':
    case 'awaiting_user':
    case 'review_resolved':
    case 'thread_updated':
      return state;
  }
}

/** Events that mean the agent moved on, so a status note ("Retrying…") is stale. */
const CLEARS_STATUS = new Set<WireEvent['type']>([
  'run_start',
  'text_delta',
  'thinking_delta',
  'message_end',
  'tool_start',
  'compacted',
  'run_end',
]);

function applyWithStatus(state: ChatState, event: WireEvent): ChatState {
  const next = apply(state, event);
  return CLEARS_STATUS.has(event.type) && next.status !== undefined
    ? { ...next, status: undefined }
    : next;
}

/** Applies one wire event. Events with seq ≤ lastSeq are ignored, so replays are idempotent. */
export function reduce(state: ChatState, event: WireEvent): ChatState {
  if (event.seq <= state.lastSeq) return state;
  return { ...applyWithStatus(state, event), lastSeq: event.seq };
}

/**
 * Ends a run the client gave up waiting for: the server says nothing runs, but no run_end
 * arrived (SPEC 8.3). The same as a run_end with an error, without a seq.
 */
export function endRunLocally(state: ChatState, error: string): ChatState {
  if (state.runStatus !== 'running') return state;
  return applyWithStatus(state, { type: 'run_end', reason: 'error', error, seq: state.lastSeq });
}

/**
 * The state of a thread's stored history (SPEC 5.4): the same events a live run produces,
 * without seq. lastSeq stays 0, so the live stream that follows applies from its start.
 */
export function fromHistory(events: UnsequencedWireEvent[]): ChatState {
  return events.reduce<ChatState>(
    (state, event) => applyWithStatus(state, { ...event, seq: 0 } as WireEvent),
    initialChatState,
  );
}
