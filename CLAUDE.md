# Phi

Guide for AI coding assistants working on this repo (human contributors: see
CONTRIBUTING.md, which links back here).

A local, browser-based LaTeX editor (like a local Overleaf) with an AI agent.
Runs only on 127.0.0.1. Single user.

## Stack

- Runtime: Bun (>= 1.2). TypeScript everywhere. No Node-specific tooling.
- Monorepo with Bun workspaces:
  - `apps/server`: Bun.serve. Serves the web app via HTML import AND the API.
  - `apps/web`: React 19, CodeMirror 6, PDF.js, zustand. UI components are shadcn/ui
    (base-nova, Tailwind v4 via bun-plugin-tailwind); add them with the shadcn CLI.
  - `packages/shared`: types shared by server and web (wire protocol, API types).
- Agent engine: `@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`,
  pinned to exact version 1.4.0. Tool schemas use `typebox` (required by pi).
- Server-to-browser streaming: our own SSE protocol (see packages/shared/src/wire.ts).
  Do NOT use AG-UI, CopilotKit, or forward raw pi events to the browser.

## Architecture rules

- Product behavior is defined in SPEC.md. Read it at the start of every task and
  cite the SPEC items you implement in your summary.
- Each thread has an event channel (`agent/threads.ts`): `thread.publish(event)`
  assigns seq, stores it in the ring buffer, and fans out to all subscribers.
- Pi events are translated to wire events only in `agent/wire.ts`. Server events
  that don't come from pi (run_start, run_end, review_resolved, status, compacted,
  thread_updated) are published with `thread.publish()` from route or agent code.
  Tools never publish; they report through pi's onUpdate.
- Edit matching (`applyEdits`) lives in `packages/shared` and is used by both the
  server (validation) and the web app (re-validation on accept).

## Pi usage rules

- Before using any pi API, read its types in `node_modules/@earendil-works/*/dist`.
  Do not guess signatures or event field names.
- Tools are `AgentTool` objects: name, label, description, typebox parameters,
  execute(toolCallId, params, signal, onUpdate). On failure, THROW; never return
  error text as success. Put UI-only data in `details`.
- Tests never call real LLM APIs. Use pi's faux provider
  (`@earendil-works/pi-ai/providers/faux`) with scripted responses.

## Security (non-negotiable)

- Bind to 127.0.0.1 only. Every /api route checks the Origin header.
- All file paths are resolved against PROJECT_ROOT; reject anything outside it.
- latexmk always runs with -no-shell-escape. No generic bash/shell tool for the agent.
- The API key lives only in the server's .env, never sent to the browser.

## Commands

- `bun dev`: dev server with hot reload (http://127.0.0.1:3000)
- `bun test`: all tests
- `bun run typecheck`: tsc across all packages

After any change: run typecheck and the tests you touched. Fix all errors before finishing.

## Conventions

- No `any` unless unavoidable. Top-level imports only.
- Tests live in a `tests/` folder next to the code they test (`services/tests/fs.test.ts`),
  with their fixtures in `tests/__fixtures__/`; `*.test.ts`, using `bun:test`.
- Keep functions small; don't add abstractions that have one caller.
- Don't add dependencies without saying why in your summary.
