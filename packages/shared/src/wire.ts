// SSE protocol from server to browser: one long-lived stream per chat thread
// (GET /api/threads/:id/stream), shared by every open tab. Pi events are translated in
// exactly one place, apps/server/src/agent/wire.ts; run_start, run_end and user_message
// come from the server's own run code.

import type { Hunk } from './edit-match.ts';

/** An edit the agent proposes to one file (SPEC 3.1), shown to the user for review. */
export interface EditProposal {
  /** The tool call id: decisions and reverts refer to it. */
  id: string;
  type: 'edit';
  path: string;
  /** One line, shown to the user. */
  rationale: string;
  /** Located in baseText, sorted by position. */
  hunks: Hunk[];
  /** Unified diff of all hunks, for display. */
  diff: string;
  /** The file's text the hunks were matched against (the editor's buffer if it was unsaved). */
  baseText: string;
}

/** A file created, renamed or deleted by the agent; applied by the server on accept. */
export interface FileOpProposal {
  id: string;
  type: 'file_op';
  op: 'create' | 'rename' | 'delete';
  path: string;
  /** Rename target. */
  newPath?: string;
  /** Content of a created file. */
  content?: string;
  rationale: string;
}

export type Proposal = EditProposal | FileOpProposal;

/**
 * How a review ended: decided by the user, cancelled after 10 minutes without a decision
 * (SPEC 3.8), or aborted with the run.
 */
export type ReviewOutcome = 'accepted' | 'rejected' | 'stale' | 'cancelled' | 'aborted';

interface WireEventBase {
  /** Increases by one per event within a thread; lets the client detect gaps and dedupe on reconnect. */
  seq: number;
}

/**
 * Emitted when the server accepts a message, before run_start for a new run, or alone
 * when it is queued for a running agent (steering). Every tab sees what was sent.
 */
export interface UserMessageEvent extends WireEventBase {
  type: 'user_message';
  /** The id the sending tab chose, so it can match its optimistic copy. */
  messageId: string;
  text: string;
  /** Sent during a run; picked up at the next turn_start. */
  queued: boolean;
}

/** Emitted once when the agent starts processing a user message. */
export interface RunStartEvent extends WireEventBase {
  type: 'run_start';
  runId: string;
}

/** Emitted at the start of each LLM call within a run; a run has one turn per tool round trip. */
export interface TurnStartEvent extends WireEventBase {
  type: 'turn_start';
}

/** Emitted for each chunk of visible assistant text as it streams. */
export interface TextDeltaEvent extends WireEventBase {
  type: 'text_delta';
  /** Server-assigned; pi messages carry no id. Stable for the whole assistant message. */
  messageId: string;
  delta: string;
}

/** Emitted for each chunk of model reasoning as it streams, when the model exposes it. */
export interface ThinkingDeltaEvent extends WireEventBase {
  type: 'thinking_delta';
  messageId: string;
  delta: string;
}

/** Token counts and cost of one model response (from pi's AssistantMessage usage). */
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
}

/**
 * Emitted when an assistant message has finished streaming, including messages that only
 * called tools (those had no text deltas, but still have usage).
 */
export interface MessageEndEvent extends WireEventBase {
  type: 'message_end';
  messageId: string;
  role: 'assistant';
  usage: Usage;
}

/** Emitted when a tool call begins executing (pi `tool_execution_start`). */
export interface ToolStartEvent extends WireEventBase {
  type: 'tool_start';
  toolCallId: string;
  /** One of the ToolName constants, but the model can call a tool that doesn't exist. */
  name: string;
  /** Human-readable tool label from the AgentTool definition. */
  label: string;
  args: unknown;
}

/** Emitted when a running tool reports progress (pi `tool_execution_update`). */
export interface ToolUpdateEvent extends WireEventBase {
  type: 'tool_update';
  toolCallId: string;
  text: string;
}

/** Emitted when a tool call finishes, successfully or not (pi `tool_execution_end`). */
export interface ToolEndEvent extends WireEventBase {
  type: 'tool_end';
  toolCallId: string;
  isError: boolean;
  /** Short text for the tool row in the chat; the error message when isError. */
  summary: string;
  /** UI-only data from AgentToolResult.details. */
  details?: unknown;
}

/** Emitted when a tool waits for the user to review a proposal (SPEC 2.2). */
export interface AwaitingUserEvent extends WireEventBase {
  type: 'awaiting_user';
  toolCallId: string;
  proposal: Proposal;
}

/** Emitted once a proposal's review ends, so every tab drops it from its queue (SPEC 3.7). */
export interface ReviewResolvedEvent extends WireEventBase {
  type: 'review_resolved';
  toolCallId: string;
  decision: ReviewOutcome;
}

/**
 * Emitted when a thread's title is set (after its first run) or the thread is deleted, so
 * thread lists refresh (SPEC 5.4).
 */
export interface ThreadUpdatedEvent extends WireEventBase {
  type: 'thread_updated';
  threadId: string;
  title?: string;
  deleted?: boolean;
}

/** A short note on what the server is doing, e.g. "Retrying (2/3)…" (SPEC 8.2). */
export interface StatusEvent extends WireEventBase {
  type: 'status';
  message: string;
}

/**
 * Emitted when older messages were replaced by a summary to stay within the model's context
 * (SPEC 8.1); the chat shows a "conversation summarized" divider here.
 */
export interface CompactedEvent extends WireEventBase {
  type: 'compacted';
  summary: string;
}

/** Emitted when an LLM call and its tool executions are complete. */
export interface TurnEndEvent extends WireEventBase {
  type: 'turn_end';
}

/** Emitted once when the run stops, always last (pi `agent_end`). */
export interface RunEndEvent extends WireEventBase {
  type: 'run_end';
  reason: 'done' | 'aborted' | 'error';
  /** Present when reason is "error". */
  error?: string;
}

export type WireEvent =
  | UserMessageEvent
  | RunStartEvent
  | TurnStartEvent
  | TextDeltaEvent
  | ThinkingDeltaEvent
  | MessageEndEvent
  | ToolStartEvent
  | ToolUpdateEvent
  | ToolEndEvent
  | AwaitingUserEvent
  | ReviewResolvedEvent
  | ThreadUpdatedEvent
  | StatusEvent
  | CompactedEvent
  | TurnEndEvent
  | RunEndEvent;

export type WireEventType = WireEvent['type'];

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A WireEvent before the thread stamps it with `seq`. */
export type UnsequencedWireEvent = DistributiveOmit<WireEvent, 'seq'>;
