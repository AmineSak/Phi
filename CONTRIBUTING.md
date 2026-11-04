# Contributing to Phi

Thanks for helping. Bug reports, fixes, templates and new providers are all welcome.

## Setup

```sh
bun install
cp .env.example .env     # optional: a key, or LLM_PROVIDER=faux to work offline
bun dev                  # http://127.0.0.1:3000, reloads on change
```

With `LLM_PROVIDER=faux` the agent is a scripted offline model, so you can work on the chat
without an API key.

## Before you open a pull request

```sh
bun run typecheck
bun test
bun run format:check     # `bun run format` fixes it
```

CI runs the same three checks. Tests that need latexmk or texlab are skipped when those tools
are missing; CI installs latexmk, so they run there.

## Conventions

- **Spec first.** Product behavior is defined in [SPEC.md](SPEC.md). A change in behavior
  updates the SPEC, and the pull request names the SPEC items it touches.
- **Tests** live in a `tests/` folder next to the code they test
  (`apps/server/src/services/tests/fs.test.ts`), with their fixtures in `tests/__fixtures__/`,
  and use `bun:test`. Browser tests use happy-dom through `apps/web/src/tests/dom.ts`, which
  must be imported first.
- **No real LLM calls in tests.** Use pi's faux provider (`@earendil-works/pi-ai/providers/faux`)
  with scripted responses.
- **TypeScript:** no `any` unless unavoidable, top-level imports only, small functions, no
  abstraction with a single caller.
- **Dependencies:** exact versions only, and say in the pull request why a new one is needed.
- **UI:** shadcn/ui components, added with the shadcn CLI. Follow
  [apps/web/DESIGN.md](apps/web/DESIGN.md) for colors, type and layout.
- **Security rules** (see [SECURITY.md](SECURITY.md)) are not negotiable: 127.0.0.1 only, Origin
  checks on every `/api` route, paths confined to the project, `-no-shell-escape`, no shell tool
  for the agent, API keys never sent to the browser.

[CLAUDE.md](CLAUDE.md) holds the architecture rules in more detail; it is also the guide AI
coding assistants read when working on this repo.

## Adding a template

Add a folder under `templates/` with a `template.json` (`name`, `description`, `order`) and the
files a new project starts with. The template must be redistributable; put its license in the
folder. See [templates/README.md](templates/README.md).

## Adding a model provider

1. Add an entry to `PROVIDERS` in `apps/server/src/agent/llm.ts` (pi provider, key variables,
   key URL, default model) and its id to `PROVIDER_IDS` in `packages/shared/src/api.ts`.
2. Add its mark to `apps/web/src/components/Settings/ProviderIcon.tsx` (and to
   [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) if it comes from elsewhere).
3. Extend the provider tests in `apps/server/src/agent/tests/llm.test.ts` and
   `apps/server/src/routes/tests/settings.test.ts`.

## Reporting bugs

Open an issue with your OS, Bun version (`bun --version`), TeX distribution, model provider,
and the steps to reproduce. For agent problems, the conversation file in
`<project>/.latex-agent/threads/` helps a lot; remove anything private first.
