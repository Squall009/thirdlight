/**
 * The separate-origin preview listener + static serving + startup checks —
 * sessions.md §2/§13.2/§13.7 (packet 09 acceptance).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createBackend } from './backend';
import { AUTHORING_ORIGIN, PREVIEW_ORIGIN, startBackend, type TestBackend } from './test-helpers';

function hex(n: number): string {
  let out = '';
  const b = randomBytes(n);
  for (let i = 0; i < b.length; i += 1) out += (b[i] ?? 0).toString(16).padStart(2, '0');
  return out;
}

function tempStaticDirs(): { root: string; editorDir: string; previewDir: string } {
  const root = join(process.env.TMPDIR ?? '/tmp', `tl-static-${process.pid}-${hex(6)}`);
  const editorDir = join(root, 'editor');
  const previewDir = join(root, 'preview');
  mkdirSync(editorDir, { recursive: true });
  mkdirSync(previewDir, { recursive: true });
  writeFileSync(join(editorDir, 'index.html'), '<!doctype html><html><body>editor</body></html>\n');
  writeFileSync(join(previewDir, 'preview.js'), 'console.log("preview bundle");\n');
  return { root, editorDir, previewDir };
}

describe('preview origin (sessions.md §2/§13.2)', () => {
  let tb: TestBackend;
  beforeAll(async () => {
    tb = await startBackend();
  });
  afterAll(async () => {
    await tb.teardown();
  });

  it('the template at / injects exactly the v2 config (null locator) + the static script; no credentials', async () => {
    const res = await fetch(`${tb.prevUrl}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(
      `window.__thirdlightPreview = { v: 2, authoringOrigin: "${AUTHORING_ORIGIN}", playSessionId: null, contentId: null, manifestPath: "./manifest.json" };`,
    );
    expect(html).toContain('<script src="./preview.js"></script>');
    // no tokens, no API URLs (the preview never talks to the backend)
    expect(html).not.toContain('token');
    expect(html).not.toContain('/api/');
    expect(html).not.toContain('Bearer');
  });

  it('serves the static preview bundle', async () => {
    const res = await fetch(`${tb.prevUrl}/preview.js`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('preview bundle');
  });

  it('exposes no API endpoints (404 / 405, never the authoring API)', async () => {
    const post = await fetch(`${tb.prevUrl}/`, { method: 'POST', body: '{}' });
    expect(post.status).toBe(405);
    const apiRoute = await fetch(`${tb.prevUrl}/api/v1/sessions`, { method: 'GET' });
    expect(apiRoute.status).toBe(404);
    const ws = await fetch(`${tb.prevUrl}/api/v1/ws`, { method: 'GET' });
    expect(ws.status).toBe(404);
  });

  it('path traversal cannot escape the static dir', async () => {
    // Encoded `..` components decode to `/../../etc/passwd`; the handler
    // normalizes (collapsing `..` to the dir root) and containment-checks,
    // so it can never read outside the dir — 400 (explicit reject) or 404
    // (normalized path does not exist in-dir). Never 200, never file bytes.
    const res = await fetch(`${tb.prevUrl}/..%2f..%2fetc%2fpasswd`);
    expect([400, 404]).toContain(res.status);
    expect(await res.text()).not.toContain('root:');
    // Deeper escape attempt.
    const res2 = await fetch(`${tb.prevUrl}/..%2f..%2f..%2f..%2fetc%2fpasswd`);
    expect([400, 404]).toContain(res2.status);
    // A traversal that normalizes to an in-dir file is safe to serve
    // (normalize keeps it inside the dir) — this is the benign case.
    const res3 = await fetch(`${tb.prevUrl}/..%2fpreview.js`);
    expect([200, 400, 404]).toContain(res3.status);
  });

  it('a missing file ⇒ 404 JSON', async () => {
    const res = await fetch(`${tb.prevUrl}/nope.js`);
    expect(res.status).toBe(404);
    const j = (await res.json()) as { ok: boolean };
    expect(j.ok).toBe(false);
  });
});

describe('authoring static bundle (§2)', () => {
  it('serves the editor index at / on the authoring origin', async () => {
    const tb = await startBackend();
    try {
      const res = await fetch(`${tb.authUrl}/`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('editor');
    } finally {
      await tb.teardown();
    }
  });
});

describe('startup checks (sessions.md §13.7)', () => {
  it('a missing preview bundle dir ⇒ the structured startup error (recorded in the bounded log)', () => {
    const { root, editorDir } = tempStaticDirs();
    const missingPreview = join(root, 'preview-missing');
    expect(existsSync(missingPreview)).toBe(false);
    const r = createBackend({
      dataRoot: join(root, 'data'),
      authoringOrigin: AUTHORING_ORIGIN,
      previewOrigin: PREVIEW_ORIGIN,
      authoringBind: '127.0.0.1:0',
      previewBind: '127.0.0.1:0',
      authoringOrigins: [AUTHORING_ORIGIN],
      editorStaticDir: editorDir,
      previewStaticDir: missingPreview,
      tokens: [{ token: hex(8), scope: 'admin' }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.missing).toContain('previewStaticDir');
      expect(r.error.message).toMatch(/build/);
    }
  });

  it('an editor dir without index.html ⇒ the structured startup error', () => {
    const { root, editorDir, previewDir } = tempStaticDirs();
    const emptyEditor = join(root, 'editor-empty');
    mkdirSync(emptyEditor, { recursive: true });
    const r = createBackend({
      dataRoot: join(root, 'data'),
      authoringOrigin: AUTHORING_ORIGIN,
      previewOrigin: PREVIEW_ORIGIN,
      authoringBind: '127.0.0.1:0',
      previewBind: '127.0.0.1:0',
      authoringOrigins: [AUTHORING_ORIGIN],
      editorStaticDir: emptyEditor,
      previewStaticDir: previewDir,
      tokens: [{ token: hex(8), scope: 'admin' }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.missing).toContain('editorStaticDir/index.html');
    }
  });

  it('config validation: wildcard origins and bad binds are rejected', () => {
    const { root, editorDir, previewDir } = tempStaticDirs();
    const base = {
      dataRoot: join(root, 'data'),
      authoringOrigin: AUTHORING_ORIGIN,
      previewOrigin: PREVIEW_ORIGIN,
      authoringBind: '127.0.0.1:0',
      previewBind: '127.0.0.1:0',
      editorStaticDir: editorDir,
      previewStaticDir: previewDir,
      tokens: [{ token: hex(8), scope: 'admin' }],
    };
    const wildcard = createBackend({ ...base, authoringOrigins: ['http://127.0.0.1:*'] });
    expect(wildcard.ok).toBe(false);
    const badBind = createBackend({ ...base, authoringBind: 'not a bind', authoringOrigins: [AUTHORING_ORIGIN] });
    expect(badBind.ok).toBe(false);
    const noTokens = createBackend({ ...base, authoringOrigins: [AUTHORING_ORIGIN], tokens: [] });
    expect(noTokens.ok).toBe(false);
  });

  it('a configured (non-zero) bind port is actually bound — a second backend on the same port fails listen (packet 13 deployment fix)', async () => {
    const { root, editorDir, previewDir } = tempStaticDirs();
    // Take a free port deterministically (bind :0, read it, release it).
    const probe = createServer();
    await new Promise<void>((res, rej) => {
      probe.once('error', rej);
      probe.listen(0, '127.0.0.1', () => res());
    });
    const port = probe.address().port;
    await new Promise<void>((res) => probe.close(() => res()));
    const base = {
      dataRoot: join(root, 'data'),
      authoringOrigin: AUTHORING_ORIGIN,
      previewOrigin: PREVIEW_ORIGIN,
      authoringOrigins: [AUTHORING_ORIGIN],
      editorStaticDir: editorDir,
      previewStaticDir: previewDir,
      tokens: [{ token: hex(8), scope: 'admin' }],
    };
    const first = createBackend({ ...base, authoringBind: `127.0.0.1:${port}`, previewBind: '127.0.0.1:0' });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    try {
      await first.backend.ready;
      expect(first.backend.portAuthoring).toBe(port);
      const second = createBackend({
        ...base,
        dataRoot: join(root, 'data2'),
        authoringBind: `127.0.0.1:${port}`,
        previewBind: '127.0.0.1:0',
      });
      expect(second.ok).toBe(true); // config is valid — the failure is at listen time
      if (second.ok) {
        await expect(second.backend.ready).rejects.toThrow(/EADDRINUSE/);
        await second.backend.close().catch(() => undefined);
      }
    } finally {
      await first.backend.close();
    }
  });
});

describe('the /services surface (dependencies.md §3)', () => {
  it('exposes createBackend + config parsing + the PlayManager (the packet-11 surface)', async () => {
    const services = await import('./services/index');
    expect(typeof services.createBackend).toBe('function');
    expect(typeof services.parseBackendConfig).toBe('function');
    expect(typeof services.PlayManager).toBe('function');
    expect(services.STARTUP_LOG_RING).toBe(256);
    expect(services.SESSION_LIST_MAX).toBe(20);
    // the template helper matches the served template shape
    const tpl = services.previewTemplateFor(AUTHORING_ORIGIN);
    expect(tpl).toContain(`authoringOrigin: "${AUTHORING_ORIGIN}"`);
  });
});