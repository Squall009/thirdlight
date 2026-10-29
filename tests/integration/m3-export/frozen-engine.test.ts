/**
 * Exports bundle from the frozen engine `npm run build` writes, never from the
 * working tree. A real backend over HTTP exports from a scratch engine root
 * whose live exporter source is broken (what an edit in progress looks like)
 * while its frozen engine is whole: the export succeeds, and every script it
 * ships is byte-identical to the same build from the live sources the copy was
 * frozen from. The physics and mesh workers (an export ships them only for a
 * game that needs them) are compared directly, frozen against live.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkBundleGraphM3, EXPORT_BOOTSTRAP, EXPORT_ENGINE_DIR } from '@thirdlight/exporter';
import { buildM3Bundle, buildSimWorkerBundle } from '../../../packages/exporter/src/export-bundle';
import { createTestBackend } from '../../../packages/backend/src/testing';
import { AUTHORING_ORIGIN, PREVIEW_ORIGIN } from '../../../packages/backend/src/test-helpers';
// @ts-expect-error -- a build tool in plain JavaScript (no declarations); the test calls what build.mjs calls.
import { freezeExportEngine } from '../../../tools/export-engine.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PROJECT = 'frozen-0001';
const ADMIN = 'admin-frozen-engine-token';
const ALL_MODULES = ['thirdlight.character3d:controller', 'thirdlight.input:keyboard-gamepad', 'thirdlight.physics-rapier:3d'];

/**
 * A source map with its third-party sources named as in the engine root. The scratch engine root
 * links the installed node_modules from elsewhere, so a map built there names them under
 * `external/`; inside a real installation (dist/export-engine) the maps are byte-identical.
 */
function mapOf(bytes: Uint8Array): unknown {
  const map = JSON.parse(Buffer.from(bytes).toString('utf8')) as { sources: string[] };
  map.sources = map.sources.map((s) => (s.includes('node_modules/') ? s.slice(s.lastIndexOf('node_modules/')) : s));
  return map;
}

let scratch = '';
let exportRoot = '';
let teardown: (() => Promise<void>) | null = null;
let base = '';

beforeAll(async () => {
  const tmp = tmpdir();
  scratch = mkdtempSync(join(tmp, 'tl-frozen-engine-'));
  exportRoot = mkdtempSync(join(tmp, 'tl-frozen-export-'));
  // The scratch engine root: the frozen copy, the installed dependencies, and a live tree mid-edit.
  await freezeExportEngine(REPO_ROOT, scratch);
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(scratch, 'node_modules'));
  for (const f of ['package.json', 'package-lock.json']) cpSync(join(REPO_ROOT, f), join(scratch, f));
  mkdirSync(join(scratch, 'packages/exporter/src'), { recursive: true });
  writeFileSync(join(scratch, EXPORT_BOOTSTRAP), "import { notExportedYet } from '@thirdlight/project-model';\nexport const half = notExportedYet(;\n");
  const t = await createTestBackend({
    authoringOrigin: AUTHORING_ORIGIN,
    previewOrigin: PREVIEW_ORIGIN,
    authoringOrigins: [AUTHORING_ORIGIN],
    exportRoot,
    engineRoot: scratch,
    tokens: [{ token: ADMIN, scope: 'admin' }],
  });
  t.backend._test.service.createProject(PROJECT, 'Frozen Engine');
  base = `http://127.0.0.1:${t.backend.portAuthoring}`;
  teardown = t.teardown;
}, 120000);

afterAll(async () => {
  await teardown?.();
  rmSync(scratch, { recursive: true, force: true });
  rmSync(exportRoot, { recursive: true, force: true });
}, 60000);

describe('exports bundle the frozen engine', () => {
  it('a broken working tree does not reach the export; the shipped scripts equal the live build', async () => {
    // The live entry really is broken: an export reading the working tree fails.
    expect((await buildM3Bundle({ bootstrapEntry: join(scratch, EXPORT_BOOTSTRAP), closure: { moduleIds: [] } })).ok).toBe(false);

    const res = await fetch(`${base}/api/v1/admin/projects/${PROJECT}/export`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: '{}' });
    const body = (await res.json()) as { ok: boolean; outputDir: string; files: Record<string, number> };
    expect(res.status, JSON.stringify(body)).toBe(200);
    const out = join(exportRoot, body.outputDir);
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as { modules: { id: string }[] };
    const moduleIds = manifest.modules.map((m) => m.id);

    const livePage = await buildM3Bundle({ bootstrapEntry: join(REPO_ROOT, EXPORT_BOOTSTRAP), closure: { moduleIds } });
    const liveWorker = await buildSimWorkerBundle(join(REPO_ROOT, 'packages/exporter/src/export-sim-worker.ts'), moduleIds);
    if (!livePage.ok || !liveWorker.ok) throw new Error('the live build failed');
    expect(Buffer.from(readFileSync(join(out, 'js/main.js'))).equals(Buffer.from(livePage.bytes))).toBe(true);
    expect(mapOf(readFileSync(join(out, 'js/main.js.map')))).toEqual(mapOf(livePage.map));
    expect(Buffer.from(readFileSync(join(out, 'js/sim-worker.js'))).equals(Buffer.from(liveWorker.bytes))).toBe(true);
    expect(mapOf(readFileSync(join(out, 'js/sim-worker.js.map')))).toEqual(mapOf(liveWorker.map));
  }, 120000);

  it('the workers a game may ship build the same from the frozen engine as from the live tree', async () => {
    const read = (p: string): Uint8Array => readFileSync(p);
    for (const [entry, name, wasm] of [
      ['export-physics-3d.ts', 'js/physics-3d.js', true],
      ['export-mesh-worker.ts', 'js/mesh-worker.js', false],
      ['export-sim-worker.ts', 'js/sim-worker.js', false],
    ] as const) {
      const rel = `packages/exporter/src/${entry}`;
      const frozenEntry = join(scratch, EXPORT_ENGINE_DIR, rel);
      const frozen = await buildSimWorkerBundle(frozenEntry, ALL_MODULES, { name, ...(wasm ? { read } : {}) });
      const live = await buildSimWorkerBundle(join(REPO_ROOT, rel), ALL_MODULES, { name, ...(wasm ? { read } : {}) });
      if (!frozen.ok || !live.ok) throw new Error(`${name}: a build failed`);
      expect(Buffer.from(frozen.bytes).equals(Buffer.from(live.bytes)), name).toBe(true);
      expect(mapOf(frozen.map), name).toEqual(mapOf(live.map));
      expect(frozen.wasm === null ? null : Buffer.from(frozen.wasm).length, name).toBe(live.wasm === null ? null : live.wasm.length);
      expect(checkBundleGraphM3(frozen.metafile, frozenEntry, ALL_MODULES).ok, name).toBe(true);
    }
  }, 120000);

  it('a frozen bundle that links a working-tree source fails the graph check', () => {
    const entry = join(scratch, EXPORT_ENGINE_DIR, EXPORT_BOOTSTRAP);
    const inputs = { [`${EXPORT_ENGINE_DIR}/packages/runtime/src/index.ts`]: {}, 'packages/runtime/src/index.ts': {} };
    expect(checkBundleGraphM3({ inputs }, entry, [])).toEqual({ ok: false, forbidden: ['packages/runtime/src/index.ts'] });
    expect(existsSync(entry)).toBe(true);
  });
});
