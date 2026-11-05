// The deployed project screen (SPEC 9.2) in happy-dom: the server's projects and the templates,
// against a fake `fetch` that records what was asked.
/// <reference types="bun" />
// First: the DOM must exist before React loads.
import { registerDom, unregisterDom } from '../../../tests/dom.ts';

import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';

import { useProjectStore } from '../../../store/project-store.ts';
import { ManagedProjects, NewProjectForm } from '../ProjectPicker.tsx';

const requests: { method: string; path: string; body?: unknown }[] = [];
let host: HTMLElement;
let root: Root;
const realFetch = globalThis.fetch;

function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input), 'http://127.0.0.1:3000');
  const method = init?.method ?? 'GET';
  requests.push({
    method,
    path: url.pathname,
    ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
  });
  const json = (body: unknown, status = 200) => Promise.resolve(Response.json(body, { status }));
  if (url.pathname === '/api/projects') {
    return json({
      projects: [
        { name: 'paper', path: '/data/projects/paper' },
        { name: 'thesis', path: '/data/projects/thesis' },
      ],
    });
  }
  if (url.pathname === '/api/templates') {
    return json([
      { id: 'blank', name: 'Blank', description: 'An empty article' },
      { id: 'thesis', name: 'Thesis', description: 'Chapters in separate files' },
    ]);
  }
  // Opening fails here: the test only looks at what was asked.
  return json({ error: 'not in this test' }, 500);
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await tick();
}

beforeAll(() => {
  registerDom();
  globalThis.fetch = fakeFetch as typeof fetch;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

beforeEach(() => {
  requests.length = 0;
  useProjectStore.setState({ managed: true, root: null, switching: false, error: null });
});

afterAll(async () => {
  root.unmount();
  globalThis.fetch = realFetch;
  await unregisterDom();
});

test("the server's projects are listed by name; clicking one opens it by its path", async () => {
  root.render(<ManagedProjects key={Math.random()} />);
  await until(() => host.querySelectorAll('button').length === 2);
  const buttons = [...host.querySelectorAll('button')];
  expect(buttons.map((b) => b.textContent)).toEqual(['paper', 'thesis']);
  buttons[1]!.click();
  await until(() => requests.some((r) => r.path === '/api/project'));
  expect(requests.find((r) => r.path === '/api/project')).toEqual({
    method: 'POST',
    path: '/api/project',
    body: { path: '/data/projects/thesis' },
  });
});

test('the new project form offers every template, blank chosen, and needs a name', async () => {
  root.render(<NewProjectForm key={Math.random()} />);
  await until(() => host.querySelectorAll('[data-slot="radio-group-item"]').length === 2);
  expect(host.textContent).toContain('An empty article');
  expect(host.textContent).toContain('Chapters in separate files');
  const checked = host.querySelector('[data-slot="radio-group-item"][data-checked]');
  expect(checked?.closest('label')?.textContent).toContain('Blank');
  const submit = [...host.querySelectorAll('button')].find(
    (b) => b.textContent === 'Create project',
  );
  expect(submit?.disabled).toBe(true);
});
