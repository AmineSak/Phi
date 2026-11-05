# Phi: Product Spec

Each item is a requirement. The final review checks the app against this list.

## 1. Scope of the agent
1.1 The agent helps with both LaTeX (errors, structure, packages, figures, tables)
    and prose (rephrase, shorten, translate, fix grammar), always preserving LaTeX
    commands in the text it changes.
1.2 It never invents citations or bibliography entries. It never renames \cite keys,
    \label or \ref names unless the user asked for that in the current message.
1.3 It does not modify the preamble, \documentclass, .cls or .sty files unless the
    user's current message asks for it.

## 2. Autonomy
2.1 The agent may read, list, search and compile freely, without asking.
2.2 Every change to the project (edit, create, rename, delete) is a proposal the
    user reviews. Nothing is written without an accept.
2.3 The agent may make several proposals in one run. A run stops after 30 turns
    with a summary of what was done and what remains.
2.4 After an accepted edit that could affect compilation, the agent compiles and
    reports the result.

## 3. Reviewing proposals
3.1 A proposal concerns one file and contains one or more hunks, plus a one-line
    rationale shown to the user.
3.2 The user can accept all, reject all, or accept or reject each hunk, and can
    edit a hunk's text before accepting. Rejecting takes an optional reason, which
    the agent receives.
3.3 Several pending proposals form a queue, shown as "1 of N", in the order they
    were made.
3.4 If the file changed while the proposal was pending and a hunk no longer
    applies, the decision is "stale": nothing is applied and the agent receives the
    current text of the affected region to try again.
3.5 An accepted proposal is applied as one undo step (Ctrl/Cmd+Z), and saved
    immediately.
3.6 Each applied proposal has a "Revert" action while its region is unchanged. The
    agent is told about reverts in its next request.
3.7 With several tabs open, all tabs show the pending proposal; the first decision
    wins and the others update.
3.8 A proposal with no decision after 10 minutes is cancelled; the agent is told.

## 4. Files and project
4.1 The user can create, rename and delete files and folders. Deleting moves items
    to .latex-agent/trash/, never permanent deletion.
4.2 The user can upload images and PDFs for figures (png, jpg, pdf, eps, svg;
    20 MB max) by drag-and-drop. Images and PDFs are previewed, not opened in the
    editor.
4.3 The compile root for a file is, in order: a `% !TEX root = x.tex` comment in
    its first 5 lines; the root set in project settings; the only .tex file with
    \documentclass; main.tex.
4.4 The user opens a project by absolute folder path; recent projects are listed.
    Switching projects stops any running agent work.
4.5 Per-project app data lives in <project>/.latex-agent/ (threads, trash,
    settings), which is hidden from the file tree and the agent.
4.6 `phi init [path]` shows the Phi logo and a template menu (blank, beamer
    presentation, scientific paper, thesis; arrow keys), creates the project
    without overwriting existing files, serves it and opens the browser on it.
    `phi open [path]` opens an existing folder. A Phi server already running is
    reused (switched to the project) instead of starting a second one.

## 5. Chat
5.1 Replies stream token by token; tool activity shows as compact cards.
5.2 The user can send a message while the agent works; it is applied after the
    current step (steering), and shown as "queued" until then.
5.3 Stop ends the current run.
5.4 Conversations persist; the user can create, switch and delete threads.
5.5 Each assistant message shows token usage and cost; the thread header shows
    totals.
5.6 Reloading the page during a run resumes the live stream with nothing lost.
5.7 The agent sees what the user sees: active file, cursor line, selection, and
    unsaved edits.
5.8 Shortcuts: "Ask about selection" and a "Fix with AI" button on each compile
    error.

## 6. Editor and PDF
6.1 LaTeX syntax highlighting; compile errors shown on their lines; clickable
    error list.
6.2 Autosave 1 s after typing stops; conflicts with on-disk changes show a banner.
6.3 Ctrl/Cmd+S saves and compiles.
6.4 SyncTeX: Ctrl/Cmd+click in the PDF jumps to the source line; "Show in PDF"
    from the editor scrolls to and highlights the location.
6.5 The PDF keeps its scroll position across recompiles.
6.6 Light and dark mode.
6.7 Completion of commands, environments, labels, citations and file paths from the
    whole project (texlab; a basic list when it isn't installed). Finishing a
    \begin{name} adds its \end{name}; renaming either half renames the other.

## 7. Settings
7.1 The user picks the model provider (OpenRouter, Claude, OpenAI, Mistral) and
    its model from pi's catalog in a settings panel, and sets one API key per
    provider. Each provider keeps its own key and model; switching applies from
    the next message. Keys are stored server-side only and shown masked (last 4
    chars). LLM_PROVIDER, LLM_MODEL and the providers' key variables in .env win.
7.2 Without a key, the chat shows a setup card instead of failing runs.

## 8. Reliability
8.1 Long conversations are compacted automatically before hitting the model's
    context limit; the chat shows a "conversation summarized" divider.
8.2 Transient provider errors are retried up to 3 times, with a visible status.
8.3 Every run ends in a clear state (done, stopped, or error with a message). The
    UI is never stuck "running".
8.4 A reply cut off at the model's output limit (often mid-reasoning) is continued
    automatically, up to 2 times, with a visible status; if it is still cut off, the
    run ends with a message saying so. Models with a placeholder output limit
    (OpenRouter's routers) get a realistic one.

## 9. Deployment (optional, one user)
9.1 Phi can run in a container behind Google IAP. Off 127.0.0.1 it refuses to
    start without IAP; every API request and the completion WebSocket must carry
    IAP's signed token for the one allowed account, plus the public origin.
9.2 Deployed, projects are the folders of one server folder: picked by name,
    created from a template in the browser, and downloadable as a .zip. No other
    folder of the server can be opened.
9.3 Deployed, the web app is served bundled and minified; projects and settings
    live on a persistent disk with daily snapshots.
