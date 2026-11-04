import { useState } from 'react';
import { ChevronsUpDown, MessageSquarePlus, Trash2 } from 'lucide-react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import { connect, deleteThread, newThread, refreshThreads } from '../../agent/client.ts';
import { threadDetail, threadTitle } from '../../agent/thread-label.ts';
import { useAgentStore } from '../../store/agent-store.ts';

/** Conversations (SPEC 5.4): switch, start a new one, delete the current one. */
export function ThreadSwitcher() {
  const threadId = useAgentStore((s) => s.threadId);
  const threads = useAgentStore((s) => s.threads);
  const current = threads.find((t) => t.id === threadId);
  const [confirming, setConfirming] = useState(false);

  return (
    <>
      <DropdownMenu onOpenChange={(open) => open && void refreshThreads()}>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className="-ml-2 min-w-0 shrink justify-start gap-1 overflow-hidden px-2 font-semibold"
              aria-label="Conversations"
            />
          }
        >
          <span className="truncate">{threadTitle(current)}</span>
          <ChevronsUpDown className="shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-80">
          <DropdownMenuItem onClick={() => void newThread()}>
            <MessageSquarePlus />
            New conversation
          </DropdownMenuItem>
          {threads.length > 0 && <DropdownMenuSeparator />}
          <DropdownMenuRadioGroup
            value={threadId ?? ''}
            onValueChange={(id: string) => void connect(id)}
          >
            {threads.map((thread) => (
              <DropdownMenuRadioItem
                key={thread.id}
                value={thread.id}
                closeOnClick
                className="items-start"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{threadTitle(thread)}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {threadDetail(thread)}
                  </span>
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          {threadId && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => setConfirming(true)}>
                <Trash2 />
                Delete conversation…
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{threadTitle(current)}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The conversation and its history are deleted for good. Work the agent is doing in it
              stops. Changes already applied to your files stay.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirming(false);
                if (threadId) void deleteThread(threadId);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
