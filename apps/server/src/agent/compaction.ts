// SPEC 8.1: long conversations are compacted before they reach the model's context limit.
// The pure parts (estimate, where to cut, the summary message) and the one LLM call that
// writes the summary. threads.ts decides when, and applies the result.

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, Message, Model, UserMessage } from '@earendil-works/pi-ai';
import {
  estimateContextTokens,
  estimateMessageTokens,
  estimateTextTokens,
} from '@earendil-works/pi-ai/utils/estimate';

import type { Llm } from './llm.ts';

/** Room left for the reply and tool results: compact above contextWindow minus this. */
export const RESERVE_TOKENS = 16_000;
/** About this many tokens of the most recent messages stay verbatim. */
export const KEEP_TOKENS = 20_000;
export const SUMMARY_OPEN = '<conversation_summary>';
const SUMMARY_CLOSE = '</conversation_summary>';
const MAX_TOOL_TEXT = 1500;

/** A message's size in tokens, as pi estimates it. */
export const estimateTokens = (message: AgentMessage): number =>
  estimateMessageTokens(message as Message);

/**
 * The context the next request will need: what the last answered request used, plus
 * estimates for the messages since then and the new message. pi's estimate counts cached
 * tokens too (usage.input alone leaves out cache reads, often most of the context).
 */
export function contextEstimate(messages: AgentMessage[], newText = ''): number {
  return estimateContextTokens(messages as Message[]).tokens + estimateTextTokens(newText);
}

export function needsCompaction(estimate: number, contextWindow: number): boolean {
  return contextWindow > 0 && estimate > contextWindow - RESERVE_TOKENS;
}

/**
 * Where the kept part starts: the most recent messages totalling about `keep` tokens. The
 * kept part never starts with a tool result, so a tool call always stays with its results.
 * Null when there is nothing worth summarizing before it.
 */
export function cutIndex(messages: AgentMessage[], keep = KEEP_TOKENS): number | null {
  let cut = messages.length;
  let total = 0;
  while (cut > 0 && total < keep) {
    cut--;
    total += estimateTokens(messages[cut]!);
  }
  while (cut > 0 && messages[cut]?.role === 'toolResult') cut--;
  // Only an earlier summary (or nothing) before the cut: summarizing would gain nothing.
  const older = messages.slice(0, cut);
  if (older.length === 0 || (older.length === 1 && isSummary(older[0]!))) return null;
  return cut;
}

/** The user-role message that stands in for everything summarized. */
export function summaryMessage(summary: string, timestamp = Date.now()): UserMessage {
  return {
    role: 'user',
    content:
      `${SUMMARY_OPEN}\n${summary.trim()}\n${SUMMARY_CLOSE}\n` +
      'The earlier part of this conversation was summarized above to save space; continue from it.',
    timestamp,
  };
}

export function isSummary(message: AgentMessage): boolean {
  return (
    message.role === 'user' &&
    typeof message.content === 'string' &&
    message.content.startsWith(SUMMARY_OPEN)
  );
}

const cutText = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}… [${text.length - max} more characters]` : text;

/** The messages as plain text for the summarizer: who said what, which tools did what. */
export function transcriptText(messages: AgentMessage[]): string {
  return messages
    .flatMap((m): string[] => {
      if (m.role === 'user') {
        const text =
          typeof m.content === 'string'
            ? m.content
            : m.content.map((c) => (c.type === 'text' ? c.text : '[image]')).join('\n');
        return [isSummary(m) ? `EARLIER SUMMARY:\n${text}` : `USER:\n${text}`];
      }
      if (m.role === 'assistant') {
        if (m.stopReason === 'error' || m.stopReason === 'aborted') return [];
        return m.content.flatMap((c) => {
          if (c.type === 'text' && c.text.trim()) return [`ASSISTANT:\n${c.text}`];
          if (c.type === 'toolCall') {
            return [
              `ASSISTANT called ${c.name}: ${cutText(JSON.stringify(c.arguments), MAX_TOOL_TEXT)}`,
            ];
          }
          return [];
        });
      }
      if (m.role === 'toolResult') {
        const text = m.content.map((c) => (c.type === 'text' ? c.text : '[image]')).join('\n');
        return [
          `TOOL ${m.toolName}${m.isError ? ' (error)' : ''}:\n${cutText(text, MAX_TOOL_TEXT)}`,
        ];
      }
      return [];
    })
    .join('\n\n');
}

const SUMMARIZER_PROMPT = `You summarize a conversation between a user and an AI assistant working on a LaTeX project, so the assistant can continue without the original messages. Write these four sections, in this order, as Markdown:

## Goal
What the user wants overall, and their latest request.

## Decisions
What was agreed or decided, including the user's preferences and anything they rejected.

## Files changed
Each file changed, as "path: what changed" and whether the user accepted or rejected the proposal.

## Open problems
Errors, unfinished steps, and questions still open.

Be specific: name files, labels, packages and error messages. Use at most 400 words. Write only the summary.`;

/** One LLM call that summarizes `messages`. Throws when the model fails. */
export async function summarize(
  llm: Pick<Llm, 'models' | 'apiKey'>,
  model: Model<Api>,
  messages: AgentMessage[],
  signal?: AbortSignal,
): Promise<string> {
  const request: Message = {
    role: 'user',
    content: `Summarize this conversation:\n\n${transcriptText(messages)}`,
    timestamp: Date.now(),
  };
  const apiKey = await llm.apiKey(model.provider);
  const result = await llm.models.completeSimple(
    model,
    { systemPrompt: SUMMARIZER_PROMPT, messages: [request] },
    { ...(apiKey ? { apiKey } : {}), ...(signal ? { signal } : {}) },
  );
  if (result.stopReason === 'error' || result.stopReason === 'aborted') {
    throw new Error(
      `Could not summarize the conversation: ${result.errorMessage ?? result.stopReason}`,
    );
  }
  const text = result.content
    .flatMap((c) => (c.type === 'text' ? [c.text] : []))
    .join('\n')
    .trim();
  if (!text) throw new Error('Could not summarize the conversation: the model returned no text');
  return text;
}
