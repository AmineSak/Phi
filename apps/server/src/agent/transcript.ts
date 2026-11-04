// Making a stored transcript valid again after the server stopped mid-run (SPEC 5.4, 8).

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ToolResultMessage } from '@earendil-works/pi-ai';

export const INTERRUPTED = 'Interrupted: the server restarted before this finished.';

/**
 * Error results for tool calls of the last assistant message that have none (the server
 * stopped while a tool ran or a proposal waited for review). Providers reject a transcript
 * with unanswered tool calls; these results answer them. Returns [] when nothing is missing.
 */
export function missingToolResults(
  messages: AgentMessage[],
  now = Date.now(),
): ToolResultMessage[] {
  const index = messages.findLastIndex((m) => m.role === 'assistant');
  const assistant = messages[index];
  if (!assistant || assistant.role !== 'assistant') return [];
  const answered = new Set(
    messages.slice(index + 1).flatMap((m) => (m.role === 'toolResult' ? [m.toolCallId] : [])),
  );
  return assistant.content.flatMap((part) =>
    part.type === 'toolCall' && !answered.has(part.id)
      ? [
          {
            role: 'toolResult' as const,
            toolCallId: part.id,
            toolName: part.name,
            content: [{ type: 'text' as const, text: INTERRUPTED }],
            isError: true,
            timestamp: now,
          },
        ]
      : [],
  );
}
