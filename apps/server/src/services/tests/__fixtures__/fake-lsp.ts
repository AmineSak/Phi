// A stand-in language server for tests. Logs every message it receives to received.jsonl in
// its working directory, writes its pid to fake-lsp.pid, and answers each request with what
// it got. On didOpen it publishes diagnostics and asks for its settings, like texlab.

import { appendFileSync, writeFileSync } from 'node:fs';

import { createFrameReader, frame } from '../../lsp.ts';

writeFileSync('fake-lsp.pid', String(process.pid));

const send = (message: object) => {
  process.stdout.write(frame(JSON.stringify({ jsonrpc: '2.0', ...message })));
};

const read = createFrameReader((json) => {
  appendFileSync('received.jsonl', `${json}\n`);
  const message = JSON.parse(json) as { id?: number | string; method?: string; params?: unknown };
  if (message.method === 'textDocument/didOpen') {
    send({ method: 'textDocument/publishDiagnostics', params: { uri: 'x', diagnostics: [] } });
    send({ id: 'settings', method: 'workspace/configuration', params: { items: [{}] } });
    return;
  }
  if (message.id === undefined || !message.method) return;
  const result =
    message.method === 'initialize'
      ? { capabilities: { textDocumentSync: 2, completionProvider: {} }, received: message.params }
      : { method: message.method, params: message.params };
  send({ id: message.id, result });
});

for await (const chunk of Bun.stdin.stream()) read(chunk);
