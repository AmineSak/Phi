import { KeyRound, Settings, TriangleAlert } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Spinner } from '@/components/ui/spinner';

import { sendMessage } from '../../agent/client.ts';
import { formatUsage } from '../../agent/usage.ts';
import { useAgentStore } from '../../store/agent-store.ts';
import { openSettings } from '../../store/project-store.ts';
import { Composer } from './Composer.tsx';
import { MessageList } from './MessageList.tsx';
import { ThreadSwitcher } from './ThreadSwitcher.tsx';

const SUGGESTIONS = [
  'Compile the project and tell me if there are errors',
  'Summarise how the document is structured',
  'Find undefined references or citations',
];

function Suggestions() {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>Ask the agent</EmptyTitle>
        <EmptyDescription>
          It can read, search and compile your project, and propose edits that you review before
          anything changes.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="items-stretch">
        {SUGGESTIONS.map((text) => (
          <Button
            key={text}
            variant="outline"
            size="sm"
            className="h-auto justify-start py-1.5 text-left whitespace-normal"
            onClick={() => void sendMessage(text)}
          >
            {text}
          </Button>
        ))}
      </EmptyContent>
    </Empty>
  );
}

/** SPEC 7.2: without a key the chat asks for one instead of failing runs. */
function SetupCard({ envVar, provider }: { envVar: string; provider: string }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <KeyRound />
        </EmptyMedia>
        <EmptyTitle>Add your {provider} key</EmptyTitle>
        <EmptyDescription>
          The agent needs a key for {provider}, or another provider chosen in Settings. Keys are
          stored on this computer only and never sent to the browser. (Setting{' '}
          <code className="rounded-sm bg-muted px-1 font-mono text-[0.9em]">{envVar}</code> in the
          .env file works too.)
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button size="sm" onClick={() => openSettings()}>
          <Settings />
          Open Settings
        </Button>
      </EmptyContent>
    </Empty>
  );
}

/** Thread totals (SPEC 5.5) and the stream's state. */
function HeaderStatus() {
  const totals = useAgentStore((s) => s.chat.totals);
  const running = useAgentStore((s) => s.chat.runStatus === 'running');
  const connection = useAgentStore((s) => s.connection);
  const used = totals.input + totals.output > 0;
  return (
    <div className="ml-auto flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
      {connection === 'reconnecting' && <span>Reconnecting…</span>}
      {used && (
        <span className="truncate tabular-nums" title="Tokens and cost of this conversation">
          {formatUsage(totals)}
        </span>
      )}
      {running && <Spinner className="size-3.5 shrink-0" aria-label="Working" />}
    </div>
  );
}

export function ChatPanel() {
  const empty = useAgentStore((s) => s.chat.messages.length === 0);
  const missingKey = useAgentStore((s) => s.missingKey);
  const error = useAgentStore((s) => s.error);

  let body: React.ReactNode = <MessageList />;
  if (missingKey) body = <SetupCard envVar={missingKey.envVar} provider={missingKey.provider} />;
  else if (empty) body = <Suggestions />;

  return (
    <section aria-label="Agent" className="flex h-full min-h-0 flex-col bg-card">
      <header className="flex h-9 shrink-0 items-center gap-3 overflow-hidden border-b px-3">
        <h2 className="sr-only">Agent</h2>
        <ThreadSwitcher />
        <HeaderStatus />
      </header>
      <div className="min-h-0 flex-1">{body}</div>
      {error && (
        <Alert variant="destructive" className="rounded-none border-x-0 border-b-0">
          <TriangleAlert />
          <AlertTitle>Message not sent</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Composer />
    </section>
  );
}
