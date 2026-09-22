/**
 * End-to-end export test (packet 12): the REAL backend + REAL workspace
 * service + REAL filesystem + the admin export route
 * (`POST /api/v1/admin/projects/:projectId/export`, sessions.md §6.3)
 * driving `exportProject` (the exporter's injected-service + injected-fs
 * design). The export bundle is built for real (esbuild + the real
 * installed three@0.186.0), so the §5.4.1 recorded-exception record is
 * re-verified against the current install here as well (independently of
 * the exporter's unit tests).
 *
 * The independent-static-server verification (export.md: "verify exported
 * output through an independent static server with the editor backend
 * stopped") is a one-off bash probe (python3 -m http.server) recorded in
 * the handoff — it needs a process the backend test cannot spawn
 * (the backend's node: edge set has no child_process).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createTestBackend } from './backend';
import { AUTHORING_ORIGIN, PREVIEW_ORIGIN } from './test-helpers';

const PROJECT = 'demo-0001';

/**
 * The engine installation root for the REAL engine (this test file is
 * `packages/backend/src/export.test.ts` → the repo root is the directory
 * containing the `packages/` segment). The export pipeline runs against the
 * real installed three/esbuild from here. String-derived (no node:url — the
 * backend's allowed node builtins are http/fs/path/crypto only).
 */
const REPO_ROOT = new URL('.', import.meta.url).pathname.slice(0, new URL('.', import.meta.url).pathname.lastIndexOf('/packages/'));
const ADMIN_TOKEN = 'admin-e2e-export-token';
const AUTH_TOKEN = 'auth-e2e-export-token';

function hex(n: number): string {
  let out = '';
  for (let i = 0; i < n; i += 1) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

interface Ctx {
  base: string;
  exportRoot: string;
  teardown: () => Promise<void>;
}

let ctx: Ctx;

function treeFiles(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string): void => {
    for (const e of readdirSync(d)) {
      const full = join(d, e);
      const r = rel === '' ? e : `${rel}/${e}`;
      if (statSync(full).isDirectory()) walk(full, r);
      else out[r] = readFileSync(full, 'utf8');
    }
  };
  walk(dir, '');
  return out;
}

function count(s: string, needle: string): number {
  let n = 0;
  let i = s.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = s.indexOf(needle, i + needle.length);
  }
  return n;
}

describe('POST /api/v1/admin/projects/:projectId/export (real backend e2e)', () => {
  beforeAll(async () => {
    const exportRoot = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'tl-export-e2e-'));
    const t = await createTestBackend({
      authoringOrigin: AUTHORING_ORIGIN,
      previewOrigin: PREVIEW_ORIGIN,
      authoringOrigins: [AUTHORING_ORIGIN],
      exportRoot,
      engineRoot: REPO_ROOT,
      tokens: [
        { token: ADMIN_TOKEN, scope: 'admin' },
        { token: AUTH_TOKEN, scope: `authoring:${PROJECT}` },
      ],
    });
    t.backend._test.service.createProject(PROJECT, 'Export Demo');
    ctx = {
      base: `http://127.0.0.1:${t.backend.portAuthoring}`,
      exportRoot,
      teardown: t.teardown,
    };
  }, 60000);

  afterAll(async () => {
    if (ctx) {
      await ctx.teardown();
      rmSync(ctx.exportRoot, { recursive: true, force: true });
    }
  }, 60000);

  it(
    'exports: auth, success shape, on-disk layout, real-bundle scan counts, reproducibility, errors',
    async () => {
      // Advance the revision by one (an mcp-origin command — no browser
      // session needed; the backend's origin-tag path, commands.md:90).
      const cmd = await fetch(`${ctx.base}/api/v1/projects/${PROJECT}/commands`, {
        method: 'POST',
        headers: { authorization: `Bearer ${AUTH_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          op: 'createEntity',
          projectId: PROJECT,
          requestId: `req-${hex(32)}`,
          expectedRevision: 0,
          args: { kind: 'box', name: 'Exported Box' },
          origin: { kind: 'mcp', clientId: 'export-e2e' },
        }),
      });
      expect(cmd.status).toBe(200);
      const cmdBody = (await cmd.json()) as { ok: boolean; revision: number; createdId: string };
      expect(cmdBody.ok).toBe(true);
      expect(cmdBody.revision).toBe(1);

      // --- auth boundaries -------------------------------------------------
      const noAuth = await fetch(`${ctx.base}/api/v1/admin/projects/${PROJECT}/export`, { method: 'POST' });
      expect(noAuth.status).toBe(401);
      const noAuthBody = (await noAuth.json()) as { error: { code: string; message: string } };
      expect(noAuthBody.error.code).toBe('unauthorized');
      expect(noAuthBody.error.message).toContain('bearer');
      const wrongScope = await fetch(`${ctx.base}/api/v1/admin/projects/${PROJECT}/export`, {
        method: 'POST',
        headers: { authorization: `Bearer ${AUTH_TOKEN}` },
      });
      expect(wrongScope.status).toBe(401);
      const wrongScopeBody = (await wrongScope.json()) as { error: { message: string } };
      expect(wrongScopeBody.error.message).toContain('admin token');
      const badBody = await fetch(`${ctx.base}/api/v1/admin/projects/${PROJECT}/export`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ notAllowed: true }),
      });
      expect(badBody.status).toBe(400);

      // --- the export itself (admin) ----------------------------------------
      const res = await fetch(`${ctx.base}/api/v1/admin/projects/${PROJECT}/export`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        outputDir: string;
        snapshotId: string;
        revision: number;
        files: Record<string, number>;
        scanHits: number;
      };
      expect(body.ok).toBe(true);
      expect(body.outputDir).toBe(`${PROJECT}@r1`);
      expect(body.revision).toBe(1);
      const files = Object.keys(body.files);
      for (const f of ['index.html', 'js/main.js', 'scene.json', 'manifest.json', 'meta.json']) expect(files).toContain(f);

      // --- the on-disk tree matches the result --------------------------------
      const target = join(ctx.exportRoot, body.outputDir);
      expect(existsSync(target)).toBe(true);
      const onDisk = treeFiles(target);
      expect(Object.keys(onDisk).sort()).toEqual(files.sort());
      // No temp/backup litter in the export root.
      const litter = readdirSync(ctx.exportRoot).filter((e) => e.startsWith('.export-tmp-') || e.includes('.replacing'));
      expect(litter).toEqual([]);

      // --- the game runs without the editor: no server/editor/MCP/credentials --
      const bundle = onDisk['js/main.js'] as string;
      expect(count(bundle, 'WebSocket')).toBe(0);
      expect(count(bundle, 'node:')).toBe(0);
      expect(count(bundle, '/api/v1/')).toBe(0);
      expect(count(bundle, 'modelcontextprotocol')).toBe(0);
      expect(count(bundle, AUTHORING_ORIGIN)).toBe(0);
      expect(count(bundle, PREVIEW_ORIGIN)).toBe(0);
      expect(count(bundle, ADMIN_TOKEN)).toBe(0);
      expect(count(bundle, AUTH_TOKEN)).toBe(0);

      // --- the exported scene is the authored one ------------------------------
      const scene = JSON.parse(onDisk['scene.json'] as string) as { entities: Array<{ name?: string }> };
      expect(scene.entities.map((e) => e.name)).toContain('Exported Box');

      // --- reproducibility (export.md §7): re-export the same snapshot ---------
      const res2 = await fetch(`${ctx.base}/api/v1/admin/projects/${PROJECT}/export`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res2.status).toBe(200);
      const body2 = (await res2.json()) as { ok: boolean };
      expect(body2.ok).toBe(true);
      const onDisk2 = treeFiles(target);
      expect(onDisk2['js/main.js']).toBe(onDisk['js/main.js']); // byte-identical
      expect(onDisk2['scene.json']).toBe(onDisk['scene.json']); // byte-identical
      expect(onDisk2['index.html']).toBe(onDisk['index.html']);
      const meta1 = JSON.parse(onDisk['meta.json'] as string) as Record<string, unknown>;
      const meta2 = JSON.parse(onDisk2['meta.json'] as string) as Record<string, unknown>;
      expect(Object.keys(meta2)).toEqual(Object.keys(meta1));
      for (const k of Object.keys(meta1)) {
        if (k === 'exportedAt' || k === 'outputDigest') continue; // both cover the per-build buildId
        // buildId identifies the build instance (capture time); content digests must match.
        const strip = (v: unknown): string => JSON.stringify(v, (key, val: unknown) => (key === 'buildId' ? undefined : val));
        expect(strip(meta2[k]), k).toBe(strip(meta1[k]));
      }
    },
    240000,
  );

  it('a missing project fails with the structured export_scene_invalid', async () => {
    const res = await fetch(`${ctx.base}/api/v1/admin/projects/no-such-project/export`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: { code: string; cls: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('export_scene_invalid');
    expect(body.error.cls).toBe('validation');
  }, 60000);
});

describe('export route on a backend WITHOUT exportRoot configured', () => {
  it('returns the structured unavailable error', async () => {
    const t = await createTestBackend({
      authoringOrigin: AUTHORING_ORIGIN,
      previewOrigin: PREVIEW_ORIGIN,
      authoringOrigins: [AUTHORING_ORIGIN],
      tokens: [{ token: ADMIN_TOKEN, scope: 'admin' }],
    });
    t.backend._test.service.createProject(PROJECT, 'Demo');
    const base = `http://127.0.0.1:${t.backend.portAuthoring}`;
    try {
      const res = await fetch(`${base}/api/v1/admin/projects/${PROJECT}/export`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as { ok: boolean; error: { code: string; cls: string; message: string } };
      expect(body.ok).toBe(false);
      expect(body.error.cls).toBe('unavailable');
      expect(body.error.message).toContain('exportRoot');
    } finally {
      await t.teardown();
    }
  }, 60000);
});