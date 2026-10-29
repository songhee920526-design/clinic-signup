// 테스트 장치: 실제 화면(index.html·admin.html)을 jsdom에서 그대로 실행하고,
// 서버는 실제 핸들러(createHandler)를 메모리 저장소와 연결해 그대로 사용한다.
import { JSDOM, ResourceLoader, VirtualConsole } from 'jsdom';
import fs from 'fs';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ORIGIN = 'https://clinic.test';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function loadClinic() {
  return import(pathToFileURL(path.join(REPO, 'netlify/functions/clinic.mjs')).href + '?r=' + Math.random());
}

// 낙관적 락(etag)까지 흉내 내는 메모리 저장소
export function fakeStore() {
  let value = null; let ver = 0;
  return {
    async getWithMetadata() { return value == null ? null : { data: JSON.parse(value), etag: 'v' + ver }; },
    async set(_k, v, opts = {}) {
      if (opts.onlyIfNew && value != null) return { modified: false };
      if (opts.onlyIfMatch && opts.onlyIfMatch !== 'v' + ver) return { modified: false };
      value = v; ver++; return { modified: true };
    },
    peek() { return value == null ? null : JSON.parse(value); },
  };
}

// 서버 + 시계. clock.now 를 바꾸면 서버·화면 모두 그 시각으로 동작
export async function makeSite(startIso = '2026-10-29T20:35:00+09:00') {
  const clinic = await loadClinic();
  const store = fakeStore();
  const clock = { now: new Date(startIso) };
  const handler = clinic.createHandler(() => store, () => clock.now);
  const server = { pending: 0 };
  server.fetch = async (url, init = {}) => {
    server.pending++;
    try {
      const req = new Request(new URL(String(url), ORIGIN), { method: init.method || 'GET', body: init.body, headers: init.headers });
      const res = await handler(req);
      const text = await res.text();
      return { ok: res.ok, status: res.status, json: async () => JSON.parse(text), text: async () => text };
    } finally { server.pending--; }
  };
  const call = async (method, body) => {
    const res = await handler(new Request(new URL('/.netlify/functions/clinic', ORIGIN), { method, body: body ? JSON.stringify(body) : undefined }));
    return res.json();
  };
  return { clinic, store, clock, handler, server, get: () => call('GET'), post: (b) => call('POST', b) };
}

class RepoLoader extends ResourceLoader {
  fetch(url) {
    const u = new URL(url);
    if (u.origin !== ORIGIN) return Promise.resolve(Buffer.from(''));
    const p = path.join(REPO, 'public', decodeURIComponent(u.pathname));
    if (/\.(css|png)$/.test(p)) return Promise.resolve(Buffer.from(''));
    try { return Promise.resolve(fs.readFileSync(p)); } catch (e) { return Promise.reject(e); }
  }
}

export async function openPage(site, page = 'index.html', { errors = [], storage = null } = {}) {
  const html = fs.readFileSync(path.join(REPO, 'public', page), 'utf8');
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push('jsdomError: ' + (e.detail ? e.detail.stack || e.detail : e.message)));
  vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
  const dom = new JSDOM(html, {
    url: `${ORIGIN}/${page}`, runScripts: 'dangerously', resources: new RepoLoader(),
    pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(win) {
      win.fetch = site.server.fetch;
      if (storage) Object.entries(storage).forEach(([k, v]) => win.localStorage.setItem(k, v));
    },
  });
  const win = dom.window;
  await new Promise((r) => win.addEventListener('load', r));
  await settle(site.server);
  return { win, doc: win.document, errors };
}

export async function settle(server, quietMs = 60, max = 5000) {
  const t0 = Date.now(); let quietSince = Date.now();
  while (Date.now() - t0 < max) {
    await sleep(15);
    if (server.pending > 0) quietSince = Date.now();
    else if (Date.now() - quietSince >= quietMs) return;
  }
}
export async function waitFor(fn, max = 4000, msg = 'condition') {
  const t0 = Date.now();
  while (Date.now() - t0 < max) { if (fn()) return; await sleep(20); }
  throw new Error('timeout waiting for ' + msg);
}
