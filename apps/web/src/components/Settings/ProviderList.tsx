import { useRef, useState } from 'react';
import type { ProviderId, ProviderStatus } from '@phi/shared';
import { ArrowUpRight, KeyRound } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

import { updateSettings } from '../../agent/settings.ts';
import { useProjectStore } from '../../store/project-store.ts';
import { ProviderIcon } from './ProviderIcon.tsx';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** What the row says about its key: where it comes from, and its last 4 characters. */
function KeyState({ provider }: { provider: ProviderStatus }) {
  if (!provider.keyConfigured) return <span className="text-muted-foreground">No key</span>;
  return (
    <span
      className="text-foreground/80"
      title={provider.keySource === 'env' ? `From ${provider.envVar} in .env` : undefined}
    >
      {provider.keySource === 'env' ? '.env' : 'Key'}{' '}
      <span className="font-mono tabular-nums">{provider.keyHint}</span>
    </span>
  );
}

/** The key editor under a row: the stored key with Replace / Remove, or the paste form. */
function KeyEditor({
  provider,
  active,
  onDone,
}: {
  provider: ProviderStatus;
  active: boolean;
  onDone: () => void;
}) {
  const [replacing, setReplacing] = useState(!provider.keyConfigured);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fromEnv = provider.keySource === 'env';

  const save = async (value: string) => {
    setBusy(true);
    setError(null);
    try {
      // A first key for a provider that isn't in use also switches to it: that's why it's added.
      const use = value && !active && !provider.keyConfigured;
      await updateSettings({
        apiKeys: { [provider.id]: value },
        ...(use ? { provider: provider.id } : {}),
      });
      setKey('');
      onDone();
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 border-t border-border/70 bg-muted/45 py-3 pr-3 pl-[5.25rem]">
      {fromEnv ? (
        <p className="text-xs text-muted-foreground">
          Set by <code className="font-mono">{provider.envVar}</code> in the .env file, which
          overrides a key saved here.
        </p>
      ) : provider.keyConfigured && !replacing ? (
        <div className="flex items-center gap-2">
          <p className="mr-auto text-xs text-muted-foreground">
            Stored on this computer only, never sent to the browser.
          </p>
          <Button variant="outline" size="sm" onClick={() => setReplacing(true)}>
            Replace
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => void save('')}
          >
            Remove
          </Button>
        </div>
      ) : (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (key.trim()) void save(key.trim());
          }}
        >
          <div className="flex gap-2">
            <Input
              autoFocus
              type="password"
              autoComplete="off"
              spellCheck={false}
              aria-label={`${provider.name} API key`}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={`Paste your ${provider.name} API key`}
              className="h-8 bg-card font-mono text-[0.8rem]"
            />
            <Button type="submit" size="sm" className="h-8" disabled={busy || !key.trim()}>
              {busy && <Spinner />}
              {active || provider.keyConfigured ? 'Save key' : 'Save and use'}
            </Button>
            {provider.keyConfigured && (
              <Button type="button" variant="ghost" size="sm" className="h-8" onClick={onDone}>
                Cancel
              </Button>
            )}
          </div>
          <a
            href={provider.keyUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex w-fit items-center gap-0.5 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
          >
            Get your {provider.name} key
            <ArrowUpRight className="size-3" />
          </a>
        </form>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

function ProviderRow({
  provider,
  active,
  locked,
  open,
  busy,
  onSelect,
  onToggleKey,
  onFocusMove,
}: {
  provider: ProviderStatus;
  active: boolean;
  /** LLM_PROVIDER pins another provider: this one can't be chosen. */
  locked: boolean;
  open: boolean;
  busy: boolean;
  onSelect: () => void;
  onToggleKey: () => void;
  onFocusMove: (step: 1 | -1) => void;
}) {
  return (
    <li className={cn('transition-colors', active && 'bg-accent/70')}>
      <div className="flex items-center gap-1 pr-2">
        <button
          type="button"
          role="radio"
          aria-checked={active}
          aria-disabled={locked}
          tabIndex={active ? 0 : -1}
          data-provider={provider.id}
          onClick={() => !locked && onSelect()}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowRight') onFocusMove(1);
            else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') onFocusMove(-1);
            else return;
            e.preventDefault();
          }}
          className={cn(
            'group/row flex min-w-0 flex-1 items-center gap-3 rounded-md py-2.5 pl-3 text-left outline-none',
            'focus-visible:ring-3 focus-visible:ring-ring/50',
            locked ? 'cursor-not-allowed opacity-55' : 'cursor-pointer',
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              'grid size-4 shrink-0 place-items-center rounded-full border transition-colors',
              active ? 'border-primary' : 'border-input group-hover/row:border-muted-foreground',
            )}
          >
            {busy ? (
              <Spinner className="size-3" />
            ) : (
              <span
                className={cn(
                  'size-2 rounded-full bg-primary transition-transform duration-150 ease-out',
                  active ? 'scale-100' : 'scale-0',
                )}
              />
            )}
          </span>
          <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border bg-card text-foreground">
            <ProviderIcon id={provider.id} className="size-[18px]" />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-semibold text-foreground">{provider.name}</span>
            <span className="truncate text-xs text-muted-foreground">
              {provider.vendor} · <span className="font-mono">{provider.model}</span>
            </span>
          </span>
          <span className="ml-auto shrink-0 pl-2 text-xs">
            <KeyState provider={provider} />
          </span>
        </button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-expanded={open}
          aria-label={`${provider.keyConfigured ? 'Manage' : 'Add'} the ${provider.name} key`}
          title={provider.keyConfigured ? 'Manage key' : 'Add key'}
          className={cn('text-muted-foreground', open && 'bg-muted text-foreground')}
          onClick={onToggleKey}
        >
          <KeyRound />
        </Button>
      </div>
      {open && (
        <KeyEditor
          key={`${provider.keyConfigured}`}
          provider={provider}
          active={active}
          onDone={onToggleKey}
        />
      )}
    </li>
  );
}

/**
 * SPEC 7.1: the providers, one row each. Clicking a row uses that provider; one without a key
 * opens its key field first. The key button manages a key without switching.
 */
export function ProviderList() {
  const settings = useProjectStore((s) => s.settings)!;
  const [open, setOpen] = useState<ProviderId | null>(null);
  const [switching, setSwitching] = useState<ProviderId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const pinned = settings.providerSource === 'env';

  const select = async (p: ProviderStatus) => {
    setError(null);
    if (!p.keyConfigured) {
      setOpen(p.id);
      return;
    }
    if (p.id === settings.provider) return;
    setOpen(null);
    setSwitching(p.id);
    try {
      await updateSettings({ provider: p.id });
    } catch (err) {
      setError(message(err));
    }
    setSwitching(null);
  };

  const moveFocus = (from: number, step: 1 | -1) => {
    const rows = [...(list.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])];
    rows[(from + step + rows.length) % rows.length]?.focus();
  };

  return (
    <div className="flex flex-col gap-2">
      <ul
        ref={list}
        role="radiogroup"
        aria-label="Model provider"
        className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card"
      >
        {settings.providers.map((p, i) => (
          <ProviderRow
            key={p.id}
            provider={p}
            active={p.id === settings.provider}
            locked={pinned && p.id !== settings.provider}
            open={open === p.id}
            busy={switching === p.id}
            onSelect={() => void select(p)}
            onToggleKey={() => setOpen((o) => (o === p.id ? null : p.id))}
            onFocusMove={(step) => moveFocus(i, step)}
          />
        ))}
      </ul>
      {pinned && (
        <p className="text-xs text-muted-foreground">
          <code className="font-mono">LLM_PROVIDER</code> in the .env file picks the provider. Keys
          for the others can still be saved.
        </p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
