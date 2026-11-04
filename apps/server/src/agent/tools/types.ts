import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { TextContent } from '@earendil-works/pi-ai';

/** A tool plus the text the prompt builder uses to describe it. */
export interface ProjectTool {
  // `any` matches pi's own AgentState.tools; each tool is fully typed where it is defined.
  tool: AgentTool<any>;
  /** One line for the prompt's tool list. */
  snippet: string;
  /** Rules merged into the prompt; identical lines across tools appear once. */
  guidelines: string[];
}

export function textContent(text: string): TextContent[] {
  return [{ type: 'text', text }];
}
