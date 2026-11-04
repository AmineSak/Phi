import { Brain, CircleStop, FoldVertical, Loader, RotateCw } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Bubble, BubbleContent } from '@/components/ui/bubble';
import { Message, MessageContent, MessageFooter } from '@/components/ui/message';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/components/ui/message-scroller';
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '@/components/ui/trace';

import type {
  AssistantMessage,
  ChatMessage,
  CompactionMarker,
  UserMessage,
} from '../../agent/reducer.ts';
import { formatUsage } from '../../agent/usage.ts';
import { useAgentStore } from '../../store/agent-store.ts';
import { Markdown } from './Markdown.tsx';
import { ToolCallCard } from './ToolCallCard.tsx';

function UserTurn({ message }: { message: UserMessage }) {
  return (
    <Message align="end">
      <MessageContent>
        <Bubble align="end" variant="muted">
          <BubbleContent className="whitespace-pre-wrap">{message.text}</BubbleContent>
        </Bubble>
        {message.queued && (
          <MessageFooter className="px-0">
            Queued: the agent reads it after its current step
          </MessageFooter>
        )}
      </MessageContent>
    </Message>
  );
}

function Reasoning({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <Trace>
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceLine status={streaming ? 'running' : undefined}>
            <TraceIcon>
              <Brain />
            </TraceIcon>
            <TraceTitle>{streaming ? 'Thinking' : 'Thought'}</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent className="whitespace-pre-wrap">{text}</TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}

function AssistantTurn({ message }: { message: AssistantMessage }) {
  const thinking = message.streaming && !message.text;
  const hasBody = !!(message.thinking || message.text);
  return (
    <Message>
      <MessageContent>
        {message.thinking && <Reasoning text={message.thinking} streaming={thinking} />}
        {message.text && <Markdown text={message.text} streaming={message.streaming} />}
        {message.usage && (
          // A step that only called tools has no text, but its usage still counts (SPEC 5.5).
          <MessageFooter className="px-0 tabular-nums" title="Tokens and cost of this response">
            {hasBody ? '' : 'Tool step · '}
            {formatUsage(message.usage)}
          </MessageFooter>
        )}
      </MessageContent>
    </Message>
  );
}

/** SPEC 8.1: older messages above this line reached the model only as this summary. */
function CompactionDivider({ marker }: { marker: CompactionMarker }) {
  return (
    <div role="separator" aria-label="Conversation summarized" className="flex flex-col gap-1">
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        <span className="flex items-center gap-1.5">
          <FoldVertical className="size-3.5" />
          Conversation summarized
        </span>
        <span className="h-px flex-1 bg-border" />
      </div>
      <Trace>
        <TraceCollapsible>
          <TraceCollapsibleTrigger>
            <TraceLine>
              <TraceTitle className="text-xs text-muted-foreground">
                The agent now sees this summary instead of the messages above
              </TraceTitle>
            </TraceLine>
          </TraceCollapsibleTrigger>
          <TraceCollapsibleContent>
            <Markdown text={marker.summary} streaming={false} />
          </TraceCollapsibleContent>
        </TraceCollapsible>
      </Trace>
    </div>
  );
}

function Turn({ message }: { message: ChatMessage }) {
  if (message.role === 'user') return <UserTurn message={message} />;
  if (message.role === 'assistant') return <AssistantTurn message={message} />;
  if (message.role === 'compaction') return <CompactionDivider marker={message} />;
  return <ToolCallCard id={message.id} />;
}

/** Shown while the agent is working but nothing is streaming yet; with the server's status. */
function Working() {
  const status = useAgentStore((s) => s.chat.status);
  const retrying = status?.startsWith('Retrying');
  return (
    <TraceLine status="running" aria-live="polite">
      <TraceIcon>{retrying ? <RotateCw /> : <Loader />}</TraceIcon>
      <TraceTitle>{status ?? 'Working'}</TraceTitle>
    </TraceLine>
  );
}

function RunOutcome() {
  const runStatus = useAgentStore((s) => s.chat.runStatus);
  const runError = useAgentStore((s) => s.chat.runError);
  if (runStatus === 'aborted') {
    return (
      <TraceLine>
        <TraceIcon>
          <CircleStop />
        </TraceIcon>
        <TraceTitle>Stopped</TraceTitle>
      </TraceLine>
    );
  }
  if (runStatus === 'error') {
    return (
      <Alert variant="destructive">
        <AlertTitle>The agent stopped with an error</AlertTitle>
        {/* Provider errors carry long JSON and URLs: wrap them anywhere. */}
        <AlertDescription className="[overflow-wrap:anywhere]">
          {runError ?? 'Unknown error'}
        </AlertDescription>
      </Alert>
    );
  }
  return null;
}

export function MessageList() {
  const messages = useAgentStore((s) => s.chat.messages);
  const running = useAgentStore((s) => s.chat.runStatus === 'running');
  const tools = useAgentStore((s) => s.chat.tools);
  const last = messages.at(-1);
  const status = useAgentStore((s) => s.chat.status);
  const busy =
    !status &&
    ((last?.role === 'assistant' && last.streaming) ||
      (last?.role === 'tool' && tools[last.id]?.status === 'running'));

  return (
    <MessageScrollerProvider autoScroll>
      <MessageScroller>
        <MessageScrollerViewport>
          <MessageScrollerContent className="gap-4 px-4 py-4">
            {messages.map((message) => (
              <MessageScrollerItem
                key={message.id}
                messageId={message.id}
                scrollAnchor={message.role === 'user'}
              >
                <Turn message={message} />
              </MessageScrollerItem>
            ))}
            <MessageScrollerItem messageId="__status">
              {running && !busy ? <Working /> : <RunOutcome />}
            </MessageScrollerItem>
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
