# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

One person: the owner of the machine, writing a mix of LaTeX documents (papers, CVs, letters, notes, beamer slides). Documents vary in length and structure; some are single files, some span several. The app is single-user by design and runs only on 127.0.0.1.

## Product Purpose

A local, browser-based LaTeX editor in the spirit of Overleaf, with an AI agent built in. The user edits files, compiles with latexmk, reads the PDF, and fixes errors in one window. Success: the write → compile → fix loop feels immediate, and the agent is a trustworthy collaborator on the actual project files.

## Positioning

- **Local and private.** Files live in an ordinary folder on disk (PROJECT_ROOT), usable with git and any other editor. Nothing goes to a cloud service except the model API calls the agent makes.
- **An agent that edits.** The agent reads the project, searches it, compiles it, and proposes edits the user reviews as diffs before they land. It is central to the product, not a sidebar novelty.

## Operating Context

- Long writing sessions, often hours at a time.
- Workflow: edit a .tex file → autosave → compile → read errors (file:line) → jump to the line → fix → recompile → check the PDF.
- The agent conversation runs alongside: the user asks for changes, watches tool activity (list/read/search/compile), and accepts or rejects proposed edits.
- Files can also change on disk from outside the app (git, another editor), so the app must surface conflicts rather than silently overwrite.

## Capabilities and Constraints

- Panes: file tree, CodeMirror 6 source editor, PDF preview (pdf.js), agent chat (later milestone).
- Compile: latexmk with -no-shell-escape; one compile at a time; errors and warnings parsed from the log with file and line where LaTeX gives them. Warnings often have no file.
- Saving: autosave with conflict detection (mtime); a stale save is rejected with a 409, never silently applied.
- Agent: streamed over SSE; runs can be aborted; messages sent mid-run are queued into the same run.
- Stack (fixed by the repo): Bun, React 18, CodeMirror 6, pdf.js, zustand; UI components from shadcn/ui on Tailwind CSS v4.
- Undecided: multiple open tabs vs single active file; chat panel layout details.

## Evidence on Hand

- `sample-project/main.tex`: a minimal article used for development.
- No screenshots, branding, logo, or name beyond "Phi". Do not invent a brand, testimonials, or usage claims.

## Product Principles

1. **The document is the main thing.** Chrome around the editor and PDF stays quiet and out of the way of the text.
2. **Every error is one step from its line.** Compile output always points at file:line when LaTeX provides it, and never hides the raw log when it doesn't.
3. **Nothing changes without the user seeing it.** Disk conflicts and agent edits are shown and decided on, never applied silently.
4. **Local first.** Behave like a desktop tool: fast, offline-capable apart from the model, no accounts.

## Accessibility & Inclusion

- Built for long sessions: dark mode is a first-class mode, not an afterthought, and the interface should stay calm and low-noise around the text to limit eye strain.
- Sensible baseline beyond that: WCAG AA contrast and visible keyboard focus.
