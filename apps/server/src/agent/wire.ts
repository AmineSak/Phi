// The only place pi AgentEvents are translated into wire events.

import type { Agent, AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { Proposal, UnsequencedWireEvent, Usage } from '@phi/shared';

import { CONTINUE_REQUEST } from './run.ts';
import { SUMMARY_REQUEST } from './turn-limit.ts';

const MAX_SUMMARY_CHARS = 200;

/** Per-thread translation state: pi messages carry no id, so assistant messages get one here. */
export interface WireContext {
  messageId: string;
  nextMessageId: () => string;
  /** Looks a tool's label up in the thread's tool registry (pi events carry only the name). */
  toolLabel: (name: string) => string | undefined;
}

export function createWireContext(
  toolLabel: (name: string) => string | undefined,
  nextMessageId: () => string = () => crypto.randomUUID(),
): WireContext {
  return { messageId: '', nextMessageId, toolLabel };
}

/** Text content of a pi tool result (AgentToolResult), or '' when it has none. */
function resultText(result: unknown): string {
  const content = (result as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c: { type?: string; text?: string }) => (c.type === 'text' ? (c.text ?? '') : ''))
    .join('');
}

/** The proposal of a `review_request` update (see tools/review.ts), if this is one. */
function reviewProposal(partialResult: unknown): Proposal | null {
  const details = (partialResult as { details?: unknown } | null)?.details as
    { kind?: unknown; proposal?: Proposal } | undefined;
  return details?.kind === 'review_request' && details.proposal ? details.proposal : null;
}

function summarize(text: string): string {
  const firstLine = text.split('\n').find((line) => line.trim() !== '') ?? '';
  return firstLine.length > MAX_SUMMARY_CHARS
    ? `${firstLine.slice(0, MAX_SUMMARY_CHARS)}…`
    : firstLine;
}

export function usageOf(message: AssistantMessage): Usage {
  const { input, output, cacheRead, cacheWrite, cost } = message.usage;
  return { input, output, cacheRead, cacheWrite, costUsd: cost.total };
}

/** Maps one pi event to a wire event, or null for events the browser doesn't need. */
export function toWire(event: AgentEvent, ctx: WireContext): UnsequencedWireEvent | null {
  switch (event.type) {
    case 'turn_start':
    case 'turn_end':
      return { type: event.type };

    case 'message_start':
      if (event.message.role === 'assistant') ctx.messageId = ctx.nextMessageId();
      return null;

    case 'message_update': {
      const update = event.assistantMessageEvent;
      if (update.type !== 'text_delta' && update.type !== 'thinking_delta') return null;
      return { type: update.type, messageId: ctx.messageId, delta: update.delta };
    }

    case 'message_end':
      if (event.message.role !== 'assistant') return null;
      return {
        type: 'message_end',
        messageId: ctx.messageId,
        role: 'assistant',
        usage: usageOf(event.message),
      };

    case 'tool_execution_start':
      return {
        type: 'tool_start',
        toolCallId: event.toolCallId,
        name: event.toolName,
        label: ctx.toolLabel(event.toolName) ?? event.toolName,
        args: event.args,
      };

    case 'tool_execution_update': {
      // A tool waiting for the user's review reports its proposal through onUpdate.
      const proposal = reviewProposal(event.partialResult);
      if (proposal) return { type: 'awaiting_user', toolCallId: event.toolCallId, proposal };
      return {
        type: 'tool_update',
        toolCallId: event.toolCallId,
        text: resultText(event.partialResult),
      };
    }

    case 'tool_execution_end': {
      const details = (event.result as { details?: unknown } | null)?.details;
      return {
        type: 'tool_end',
        toolCallId: event.toolCallId,
        isError: event.isError,
        summary: summarize(resultText(event.result)),
        ...(details === undefined ? {} : { details }),
      };
    }

    default:
      return null;
  }
}

/**
 * Subscribes once to a thread's pi Agent and publishes every mapped event on its channel.
 * Tool labels come from the agent's current tool registry. Returns the unsubscribe function.
 */
export function attachWire(
  agent: Agent,
  publish: (event: UnsequencedWireEvent) => void,
): () => void {
  const ctx = createWireContext((name) => agent.state.tools.find((t) => t.name === name)?.label);
  return agent.subscribe((event) => {
    const wire = toWire(event, ctx);
    if (wire) publish(wire);
  });
}

/** Text of a user message's content. */
function userText(content: string | { type: string; text?: string }[]): string {
  if (typeof content === 'string') return content;
  return content.map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('');
}

/**
 * A stored transcript as the wire events a live run would have produced, so the browser
 * renders history with the same reducer (SPEC 5.4), with a `compacted` divider where each
 * compaction happened (SPEC 8.1). System messages and the turn-limit summary request (never
 * shown live either) are left out.
 */
export function historyEvents(
  messages: AgentMessage[],
  ctx: WireContext,
  compactions: readonly { summary: string; at: number }[] = [],
): UnsequencedWireEvent[] {
  const events: UnsequencedWireEvent[] = [];
  const dividers = (index: number) => {
    for (const c of compactions) {
      if (c.at === index) events.push({ type: 'compacted', summary: c.summary });
    }
  };
  for (const [index, message] of messages.entries()) {
    // A compaction that happened when `index` messages were stored shows before this one.
    dividers(index);
    if (message.role === 'user') {
      const text = userText(message.content);
      // Requests the server added to a run, not typed by the user.
      if (text === SUMMARY_REQUEST || text === CONTINUE_REQUEST) continue;
      events.push({ type: 'user_message', messageId: ctx.nextMessageId(), text, queued: false });
    } else if (message.role === 'assistant') {
      const messageId = ctx.nextMessageId();
      const thinking = message.content.flatMap((c) => (c.type === 'thinking' ? [c.thinking] : []));
      const text = message.content.flatMap((c) => (c.type === 'text' ? [c.text] : []));
      if (thinking.length)
        events.push({ type: 'thinking_delta', messageId, delta: thinking.join('') });
      if (text.length) events.push({ type: 'text_delta', messageId, delta: text.join('') });
      events.push({ type: 'message_end', messageId, role: 'assistant', usage: usageOf(message) });
      for (const call of message.content) {
        if (call.type !== 'toolCall') continue;
        events.push({
          type: 'tool_start',
          toolCallId: call.id,
          name: call.name,
          label: ctx.toolLabel(call.name) ?? call.name,
          args: call.arguments,
        });
      }
    } else if (message.role === 'toolResult') {
      events.push({
        type: 'tool_end',
        toolCallId: message.toolCallId,
        isError: message.isError,
        summary: summarize(resultText(message)),
        ...(message.details === undefined ? {} : { details: message.details }),
      });
    }
  }
  dividers(messages.length);
  return events;
}
