# Security

## Threat model

Phi is a single-user application for the user's own machine. Its server holds API keys and can
read, write and compile files, so it must only ever be driven by its own browser tab.

What Phi defends against:

- **Other web pages.** The server listens on 127.0.0.1 only, and every `/api` route (and the
  language-server WebSocket) refuses a foreign `Origin` header. A page you visit cannot call it.
- **DNS rebinding.** A request whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>` is
  refused, so a domain re-pointed at 127.0.0.1 gets nothing.
- **Path escapes.** Every file path is resolved inside the open project. Absolute paths, `..`,
  null bytes and symlinks leading outside are refused. The app's own data folder
  (`.latex-agent/`) is off limits to the agent and the file API.
- **Code execution from documents.** latexmk always runs with `-no-shell-escape` and `-norc`, so
  neither `\write18` nor a project `latexmkrc` can run commands. The agent has no shell tool;
  its tools are list, read, search, compile and proposed edits that you review.
- **Key exposure.** API keys stay on the server, in `.env` or `~/.latex-agent/settings.json`
  (mode 0600). The browser only ever sees their last 4 characters.
- **The language server.** Only completion and document-sync messages reach texlab; commands,
  builds and formatting are blocked, and documents must be inside the project.

What Phi does not defend against:

- Other users or programs on the same machine; they can reach 127.0.0.1 and read your files.
- Exposing the port to a network yourself (port forwarding, a reverse proxy, `0.0.0.0`): Phi has
  no login of its own and refuses to listen beyond 127.0.0.1 unless Google IAP is configured.
  To reach Phi remotely, use the IAP deployment in [deploy/gcp](deploy/gcp/README.md), where
  every API request must carry IAP's signed token for the one allowed account.
- What a model provider does with the text you send it. Requests go to the provider you choose
  in Settings.
- TeX packages themselves: compiling a document runs TeX, with shell escape disabled.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's
[security advisories](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
("Report a vulnerability" on the repository's Security tab), not in a public issue. Include the
version (commit), the steps to reproduce and the impact.
