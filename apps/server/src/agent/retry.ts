// SPEC 8.2: transient provider errors are retried up to 3 times, with a visible status.
// pi-ai classifies errors (isRetryableAssistantError: 429, 5xx, network; never quota or
// billing) and computes backoff (retryDelayMs); pi-agent-core has no retry loop of its own,
// and provider-SDK retries are silent. So this wraps the stream function: an attempt that
// fails before any content streamed is retried, and never reaches the transcript.

import type { StreamFn } from '@earendil-works/pi-agent-core';
import {
  createAssistantMessageEventStream,
  isRetryableAssistantError,
  retryDelayMs,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
  type RetryPolicy,
} from '@earendil-works/pi-ai';

export const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000;

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  /** Called before each retry's wait: attempt is 1-based. */
  onRetry: (attempt: number, maxRetries: number, delayMs: number, error: string) => void;
  /** Errors pi would retry that are known to be permanent for this provider. */
  isPermanent?: (errorMessage: string) => boolean;
}

/** Resolves after `ms`, or false at once when `signal` aborts. */
function wait(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const done = (ok: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(ok);
    };
    const onAbort = () => done(false);
    const timer = setTimeout(() => done(true), ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** A final error message, for failures that happen outside the provider stream. */
function failedMessage(model: Model<Api>, error: unknown): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'error',
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
}

export function withRetry(streamFn: StreamFn, options: RetryOptions): StreamFn {
  const policy: RetryPolicy = {
    enabled: true,
    maxRetries: options.maxRetries ?? MAX_RETRIES,
    baseDelayMs: options.baseDelayMs ?? BASE_DELAY_MS,
  };

  return (model, context, streamOptions) => {
    const out = createAssistantMessageEventStream();
    const signal = streamOptions?.signal;

    void (async () => {
      for (let attempt = 0; ; attempt++) {
        const inner = await streamFn(model, context, streamOptions);
        // Hold back "start" until real content arrives: until then the attempt can be redone.
        const held: AssistantMessageEvent[] = [];
        let committed = false;
        let failure: Extract<AssistantMessageEvent, { type: 'error' }> | null = null;
        for await (const event of inner) {
          if (committed) {
            out.push(event);
          } else if (event.type === 'start') {
            held.push(event);
          } else if (event.type === 'error') {
            failure = event;
          } else {
            committed = true;
            for (const h of held) out.push(h);
            out.push(event);
          }
        }
        if (committed) return;
        if (!failure) {
          out.end(await inner.result());
          return;
        }

        const retryable =
          failure.reason === 'error' &&
          isRetryableAssistantError(failure.error) &&
          !options.isPermanent?.(failure.error.errorMessage ?? '') &&
          attempt < policy.maxRetries &&
          !signal?.aborted;
        if (retryable) {
          const delay = retryDelayMs(policy, attempt + 1);
          options.onRetry(attempt + 1, policy.maxRetries, delay, failure.error.errorMessage ?? '');
          if (await wait(delay, signal)) continue;
          // Stopped while waiting: end the turn as aborted, as a provider abort would.
          const { errorMessage: _e, ...rest } = failure.error;
          const aborted = { ...rest, stopReason: 'aborted' as const };
          for (const h of held) out.push(h);
          out.push({ type: 'error', reason: 'aborted', error: aborted });
          return;
        }
        for (const h of held) out.push(h);
        out.push(failure);
        return;
      }
    })().catch((err: unknown) => {
      // pi's contract: never throw; a failure is a final error message.
      out.push({ type: 'error', reason: 'error', error: failedMessage(model, err) });
    });

    return out;
  };
}
