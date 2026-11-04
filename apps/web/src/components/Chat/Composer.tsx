import { useEffect, useRef } from 'react';
import { ArrowUp, Square } from 'lucide-react';

import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from '@/components/ui/input-group';

import { abort, sendMessage } from '../../agent/client.ts';
import { setDraft, useAgentStore } from '../../store/agent-store.ts';

/** Enter sends, Shift+Enter adds a line. While the agent runs, a message is queued for it. */
export function Composer() {
  const text = useAgentStore((s) => s.draft);
  const focusRequest = useAgentStore((s) => s.draftFocus);
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const running = useAgentStore((s) => s.chat.runStatus === 'running');
  const canSend = text.trim().length > 0;

  // A shortcut prefilled the draft: focus it with the caret at the end, ready to type.
  useEffect(() => {
    const input = inputRef.current;
    if (!focusRequest || !input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    input.scrollTop = input.scrollHeight;
  }, [focusRequest]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSend) return;
    void sendMessage(text.trim());
    setDraft('');
  };

  return (
    <form ref={formRef} onSubmit={submit} className="shrink-0 border-t bg-card p-3">
      <InputGroup>
        <InputGroupTextarea
          ref={inputRef}
          value={text}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              formRef.current?.requestSubmit();
            }
          }}
          placeholder={
            running ? 'Add to the current request…' : 'Ask the agent about your document…'
          }
          aria-label="Message the agent"
          className="max-h-48 p-3"
        />
        <InputGroupAddon align="block-end">
          {running && (
            <InputGroupButton
              type="button"
              size="icon-sm"
              variant="outline"
              className="rounded-full"
              aria-label="Stop the agent"
              title="Stop"
              onClick={() => void abort()}
            >
              <Square />
            </InputGroupButton>
          )}
          <InputGroupButton
            type="submit"
            size="icon-sm"
            variant="default"
            className="ml-auto rounded-full"
            disabled={!canSend}
            aria-label={running ? 'Queue message' : 'Send'}
          >
            <ArrowUp />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </form>
  );
}
