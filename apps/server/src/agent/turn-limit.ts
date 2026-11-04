// SPEC 2.3: a run stops after 30 turns, the last of which asks the model for a summary.

import type {
  AgentLoopTurnUpdate,
  AgentTurnDecision,
  BeforeToolCallResult,
} from '@earendil-works/pi-agent-core';

export const MAX_TURNS = 30;

export const SUMMARY_REQUEST =
  'You have reached the limit of turns for this request, so this is your last reply and your ' +
  'tools are disabled. Summarize for the user what you did, what you found, and what remains ' +
  'to be done, so they can ask you to continue.';

const BLOCKED_REASON =
  'The turn limit for this request is reached; tools are disabled. Reply with your summary.';

/**
 * Counts a run's turns. After turn maxTurns - 1, the next request carries SUMMARY_REQUEST
 * and runs with tools blocked; after turn maxTurns, the run ends. `startRun` resets the count.
 */
export function createTurnLimit(maxTurns = MAX_TURNS) {
  let turns = 0;
  let summaryRequested = false;
  const lastTurn = () => turns >= maxTurns - 1;

  return {
    startRun() {
      turns = 0;
      summaryRequested = false;
    },

    /** Whether the last run was stopped by the limit. */
    get reached() {
      return turns >= maxTurns;
    },

    /** pi finishTurn: ends the run once the summary turn is done. */
    finishTurn(): AgentTurnDecision | undefined {
      turns++;
      return turns >= maxTurns ? { action: 'end' } : undefined;
    },

    /** pi prepareNextTurn: before the final turn, asks for the summary. */
    prepareNextTurn(): AgentLoopTurnUpdate | undefined {
      if (!lastTurn() || summaryRequested) return undefined;
      summaryRequested = true;
      return { messages: [{ role: 'user', content: SUMMARY_REQUEST, timestamp: Date.now() }] };
    },

    /** pi beforeToolCall: no tools in the summary turn. */
    blockOnLastTurn(): BeforeToolCallResult | undefined {
      return summaryRequested ? { block: true, reason: BLOCKED_REASON } : undefined;
    },
  };
}

export type TurnLimit = ReturnType<typeof createTurnLimit>;
