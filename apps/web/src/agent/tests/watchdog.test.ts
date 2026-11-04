import { afterEach, expect, test } from 'bun:test';

import { checkStalledRun, LOST_RUN_ERROR, STALL_MS } from '../client.ts';
import { initialChatState, reduce } from '../reducer.ts';
import { useAgentStore } from '../../store/agent-store.ts';

const running = () =>
  useAgentStore.setState({
    chat: reduce(initialChatState, { type: 'run_start', runId: 'r', seq: 1 }),
  });

afterEach(() => useAgentStore.setState({ chat: initialChatState }));

test('quiet for 60 s and the server runs nothing: the run ends with an error', async () => {
  running();
  let asked = 0;
  const idle = async () => (asked++, { running: false, runId: null });
  expect(await checkStalledRun(1000 + STALL_MS - 1, 1000, idle)).toBe(false);
  expect(asked).toBe(0);
  expect(await checkStalledRun(1000 + STALL_MS, 1000, idle)).toBe(true);
  expect(useAgentStore.getState().chat).toMatchObject({
    runStatus: 'error',
    runError: LOST_RUN_ERROR,
  });
});

test('the server still runs it (a long compile, a pending review): nothing changes', async () => {
  running();
  const busy = async () => ({ running: true, runId: 'r' });
  expect(await checkStalledRun(10 * STALL_MS, 0, busy)).toBe(false);
  expect(useAgentStore.getState().chat.runStatus).toBe('running');
});

test('the server cannot be reached: wait, the stream reconnects by itself', async () => {
  running();
  expect(await checkStalledRun(10 * STALL_MS, 0, async () => null)).toBe(false);
  expect(useAgentStore.getState().chat.runStatus).toBe('running');
});

test('no run believed active: no check at all', async () => {
  let asked = 0;
  expect(await checkStalledRun(10 * STALL_MS, 0, async () => (asked++, null))).toBe(false);
  expect(asked).toBe(0);
});
