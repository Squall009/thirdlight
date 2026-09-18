/**
 * @thirdlight/exporter tests (packet 12).
 *
 * The pipeline is exercised with an INJECTED fake workspace service and an
 * INJECTED in-memory `ExportFs` (the exporter's own edge set has no Node
 * builtins — the real-fs + real-service + real-HTTP end-to-end lives in the
 * backend package's export.test.ts, where `node:fs` is allowed). The esbuild
 * build is REAL: the actual `export-bootstrap.ts` entry is bundled against
 * the real installed `three@0.186.0`, so the graph check and the §5.4 scan
 * (incl. the §5.4.1 recorded-exception counts) run against genuine bytes.
 */
import { describe, it, expect } from 'vitest';
import type { Entity } from '@thirdlight/project-model';
import type { WorkspaceService } from '@thirdlight/workspace';

import { exportProject, type ExportContext, type ExportFs } from './export';
import { checkBundleGraph } from './graph';
import { scanExportFiles, THREE_RECORD } from './scan';
import { canonicalDocument, canonicalJson } from './canonical';

// ---- fixtures --------------------------------------------------------------------

const PROJECT = 'demo-0001';

const ENTITIES: Entity[] = [
  {
    id: 'cam-main',
    name: 'Main Camera',
    components: {
      transform: { position: [0, 0.5, 4], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      camera: { type: 'perspective', fovY: 60, near: 0.1, far: 100 },
    },
  },
  {
    id: 'box-0001',
    components: {
      transform: { position: [0, 1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      box: { size: [1, 1, 1], material: { color: '#ff8800' } },
    },
  },
  {
    id: 'box-0002',
    parentId: 'box-0001',
    components: {
      transform: { position: [0, 0.5, 0], rotation: [0, 0, 0, 1], scale: [0.5, 0.5, 0.5] },
      box: { size: [1, 1, 1], material: { color: '#33cc66' } },
    },
  },
];

const MANIFEST = {
  schemaVersion: 1,
  engineVersion: '0.1.0',
  id: PROJECT,
  name: 'Demo',
  createdAt: '2026-09-16T23:40:00Z',
  scenes: [{ id: 'scene-main', path: 'scenes/main.json' }],
};

/** A fake workspace service (only `query` is exercised by the pipeline). */
function makeService(opts: {
  revision?: number;
  /** The revision to report on the SECOND queryProject (step 2 re-read). */
  revisionOnReread?: number;
  queryProjectError?: unknown;
}): WorkspaceService {
  const state = {
    revision: opts.revision ?? 3,
    rereadRevision: opts.revisionOnReread ?? (opts.revision ?? 3),
    queryProjectCalls: 0,
  };
  const query = (req: unknown): unknown => {
    const r = req as { op?: string; projectId?: string; args?: { offset?: number; limit?: number } };
    if (r.op === 'queryProject') {
      if (opts.queryProjectError !== undefined) {
        return {
          ok: false,
          projectId: PROJECT,
          error: opts.queryProjectError,
        };
      }
      state.queryProjectCalls += 1;
      const revision = state.queryProjectCalls === 1 ? state.revision : state.rereadRevision;
      return {
        ok: true,
        projectId: PROJECT,
        revision,
        manifest: MANIFEST,
        scene: { sceneId: 'scene-main', entityCount: ENTITIES.length, cameraId: 'cam-main' },
        history: { undoDepth: 0, redoDepth: 0 },
        workspace: { writePaused: false },
      };
    }
    if (r.op === 'queryEntities') {
      const offset = r.args?.offset ?? 0;
      const limit = r.args?.limit ?? 100;
      return {
        ok: true,
        projectId: PROJECT,
        revision: state.revision,
        total: ENTITIES.length,
        offset,
        limit,
        entities: ENTITIES.slice(offset, offset + limit),
      };
    }
    return { ok: false, error: { code: 'invalid_request', cls: 'validation', message: 'unknown op' } };
  };
  return {
    backendId: 'fake-backend',
    query,
    runCommand: () => {
      throw new Error('unused in this test');
    },
    createProject: () => {
      throw new Error('unused in this test');
    },
    releaseWorkspace: () => {
      throw new Error('unused in this test');
    },
    takeoverWorkspace: () => {
      throw new Error('unused in this test');
    },
    acceptExternalState: () => {
      throw new Error('unused in this test');
    },
    discardExternalState: () => {
      throw new Error('unused in this test');
    },
    scan: () => {
      throw new Error('unused in this test');
    },
    dispose: () => {
      /* noop */
    },
    lastScan: { entries: [], total: 0, truncated: false } as never,
  } as unknown as WorkspaceService;
}

// ---- in-memory ExportFs -----------------------------------------------------------

function pjoin(...parts: string[]): string {
  let out = '';
  for (const p of parts) {
    if (p.startsWith('/')) out = '';
    out = out === '' ? p : out + '/' + p;
  }
  const stack: string[] = [];
  const abs = out.startsWith('/');
  for (const s of out.split('/')) {
    if (s === '' || s === '.') continue;
    if (s === '..') stack.pop();
    else stack.push(s);
  }
  return (abs ? '/' : '') + stack.join('/');
}

class MemFs implements ExportFs {
  private files = new Map<string, Uint8Array>();
  private dirs = new Set<string>();
  private tempSeq = 0;
  failWriteAt: string | null = null;

  join(...parts: string[]): string {
    return pjoin(...parts);
  }
  realpath(p: string): string {
    return p;
  }
  isDirectory(p: string): boolean {
    if (this.dirs.has(p)) return true;
    const prefix = p + '/';
    for (const k of this.files.keys()) if (k.startsWith(prefix)) return true;
    return false;
  }
  exists(p: string): boolean {
    return this.isDirectory(p) || this.files.has(p);
  }
  mkdir(p: string): void {
    this.dirs.add(p);
  }
  write(p: string, data: Uint8Array): void {
    if (this.failWriteAt === p) throw new Error('simulated write failure');
    this.files.set(p, data);
  }
  rename(from: string, to: string): void {
    const prefix = from + '/';
    for (const k of [...this.files.keys()]) {
      if (k === from || k.startsWith(prefix)) {
        const moved = to + k.slice(from.length);
        const v = this.files.get(k);
        if (v !== undefined) this.files.set(moved, v);
        this.files.delete(k);
      }
    }
  }
  rm(p: string): void {
    const prefix = p + '/';
    for (const k of [...this.files.keys()]) {
      if (k === p || k.startsWith(prefix)) this.files.delete(k);
    }
  }
  mkdtemp(prefix: string): string {
    this.tempSeq += 1;
    const d = prefix + `tmp${this.tempSeq}`;
    this.dirs.add(d);
    return d;
  }
  read(p: string): Uint8Array {
    const v = this.files.get(p);
    if (v === undefined) throw new Error(`read: no such file ${p}`);
    return v;
  }
  seed(p: string, text: string): void {
    this.files.set(p, new TextEncoder().encode(text));
  }
  readText(p: string): string {
    return new TextDecoder().decode(this.read(p));
  }
  allPaths(): string[] {
    return [...this.files.keys()].sort();
  }
}

// ---- context factory ---------------------------------------------------------------

const REPO = import.meta.url.replace('file://', '').replace(/\/packages\/exporter\/src\/export\.test\.ts$/, '');

function makeCtx(service: WorkspaceService, fs: MemFs): ExportContext {
  const threeJson = JSON.stringify({ name: 'three', version: THREE_RECORD.version });
  const tsJson = JSON.stringify({ name: 'typescript', version: '5.9.3' });
  const lockJson = JSON.stringify({
    packages: { 'node_modules/three': { version: THREE_RECORD.version, integrity: THREE_RECORD.integrity } },
  });
  fs.seed('/x/repo/node_modules/three/package.json', threeJson);
  fs.seed('/x/repo/node_modules/typescript/package.json', tsJson);
  fs.seed('/x/repo/package-lock.json', lockJson);
  // The backend creates the exportRoot at startup (backend.ts); mirror that.
  fs.mkdir('/x/exports');
  return {
    projectId: PROJECT,
    service,
    fs,
    exportRoot: '/x/exports',
    repoRoot: REPO, // the REAL repo (the reference build resolves three from it)
    authoringRoot: '/x/data',
    authoringOrigin: 'http://127.0.0.1:8501',
    previewOrigin: 'http://127.0.0.1:8502',
    tokenValues: ['auth-secret-token-123', 'admin-secret-token-456'],
    bootstrapEntry: pjoin(REPO, 'packages/exporter/src/export-bootstrap.ts'),
    threePackageJson: '/x/repo/node_modules/three/package.json',
    typescriptPackageJson: '/x/repo/node_modules/typescript/package.json',
    lockfile: '/x/repo/package-lock.json',
  };
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

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ---- tests --------------------------------------------------------------------------

describe('exportProject pipeline (fake service + in-memory fs, real esbuild build)', () => {
  it(
    'exports a valid snapshot: layout, canonical bytes, meta.json, scan, atomic replacement, reproducibility',
    async () => {
      const fs = new MemFs();
      const service = makeService({});
      const ctx = makeCtx(service, fs);

      const res = await exportProject(ctx);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.outputDir).toBe(`${PROJECT}@r3`);
      expect(res.snapshotId).toBe(`${PROJECT}@r3`);
      expect(res.revision).toBe(3);
      expect(res.scanHits).toBe(0);
      expect(Object.keys(res.files).sort()).toEqual(['index.html', 'js/main.js', 'meta.json', 'snapshot.json']);
      for (const size of Object.values(res.files)) expect(size).toBeGreaterThan(0);

      // The target tree exists; no temp/backup litter.
      const target = '/x/exports/demo-0001@r3';
      for (const name of ['index.html', 'js/main.js', 'snapshot.json', 'meta.json']) {
        expect(fs.exists(`${target}/${name}`)).toBe(true);
      }
      const litter = fs.allPaths().filter((p) => p.includes('.export-tmp-') || p.includes('.replacing'));
      expect(litter).toEqual([]);

      // snapshot.json — canonical bytes: field order, 2-space indent, LF, one
      // trailing newline, no BOM; the document content.
      const snapText = fs.readText(`${target}/snapshot.json`);
      expect(snapText.charCodeAt(0)).not.toBe(0xfeff);
      expect(snapText.endsWith('\n')).toBe(true);
      expect(snapText.endsWith('\n\n')).toBe(false);
      const snap = JSON.parse(snapText) as Record<string, unknown>;
      expect(Object.keys(snap)).toEqual(['snapshotId', 'projectId', 'revision', 'scene']);
      expect(snap.snapshotId).toBe(`${PROJECT}@r3`);
      expect(snap.revision).toBe(3);
      const scene = snap.scene as { schemaVersion: number; sceneId: string; revision: number; entities: unknown[] };
      expect([scene.schemaVersion, scene.sceneId, scene.revision, scene.entities.length]).toEqual([1, 'scene-main', 3, 3]);

      // meta.json — exact field set/order (export.md §6) + recorded versions.
      const metaText = fs.readText(`${target}/meta.json`);
      const meta = JSON.parse(metaText) as Record<string, unknown>;
      expect(Object.keys(meta)).toEqual([
        'schemaVersion', 'type', 'engineVersion', 'projectId', 'snapshotId', 'revision', 'exportedAt', 'dependencies', 'scene',
      ]);
      expect(meta.schemaVersion).toBe(1);
      expect(meta.type).toBe('thirdlight-export');
      expect(meta.engineVersion).toBe('0.1.0');
      const deps = meta.dependencies as Record<string, unknown>;
      expect(Object.keys(deps)).toEqual(['three', 'typescript', 'esbuild', 'runtime']);
      expect(deps.three).toBe('0.186.0');
      expect(deps.typescript).toBe('5.9.3');
      expect(deps.esbuild).toBe('0.28.2');
      expect(deps.runtime).toEqual({ fixedStepHz: 120, modules: ['thirdlight.demo:box-motion'] });
      const sceneSummary = meta.scene as Record<string, unknown>;
      expect(sceneSummary).toEqual({ entityCount: 3, cameraId: 'cam-main', boxCount: 2 });

      // index.html — minimal, relative references only, no absolute URLs.
      const html = fs.readText(`${target}/index.html`);
      expect(html).toContain('<canvas id="game">');
      expect(html).toContain('<script src="./js/main.js" type="module">');
      expect(html).not.toContain('http://');
      expect(html).not.toContain('https://');

      // The bundle bytes — the §5.4.1 recorded-exception counts (exact) and
      // the single engine fetch; absolute patterns are 0.
      const bundle = fs.readText(`${target}/js/main.js`);
      expect(count(bundle, 'fetch("./snapshot.json")')).toBe(1);
      expect(count(bundle, 'fetch(')).toBe(THREE_RECORD.fetch + 1);
      expect(count(bundle, 'process.')).toBe(THREE_RECORD.processDot);
      expect(count(bundle, '__dirname')).toBe(0);
      expect(count(bundle, 'http://')).toBe(THREE_RECORD.http);
      expect(count(bundle, 'https://')).toBe(THREE_RECORD.https);
      expect(count(bundle, 'file://')).toBe(0);
      expect(count(bundle, 'XMLHttpRequest')).toBe(THREE_RECORD.xhr);
      expect(count(bundle, 'WebSocket')).toBe(0);
      expect(count(bundle, 'node:')).toBe(0);
      expect(count(bundle, '/api/v1/')).toBe(0);
      expect(count(bundle, '/mcp')).toBe(0);
      expect(count(bundle, ctx.authoringOrigin)).toBe(0);
      expect(count(bundle, ctx.previewOrigin)).toBe(0);
      expect(count(bundle, 'auth-secret-token-123')).toBe(0);
      expect(count(bundle, 'admin-secret-token-456')).toBe(0);

      // No credentials/URLs in the other files either.
      for (const name of ['index.html', 'snapshot.json', 'meta.json']) {
        const t = fs.readText(`${target}/${name}`);
        expect(count(t, 'node:')).toBe(0);
        expect(count(t, '/api/v1/')).toBe(0);
        expect(count(t, ctx.authoringOrigin)).toBe(0);
        expect(count(t, 'auth-secret-token-123')).toBe(0);
        expect(count(t, 'http://')).toBe(0);
      }

      // Reproducibility (export.md §7): re-export the same snapshot —
      // snapshot.json + js/main.js byte-identical; meta.json identical in
      // every field except exportedAt.
      const firstMain = fs.read(`${target}/js/main.js`);
      const firstSnap = fs.read(`${target}/snapshot.json`);
      const firstMeta = JSON.parse(metaText) as Record<string, unknown>;
      const res2 = await exportProject(ctx);
      expect(res2.ok).toBe(true);
      const secondMain = fs.read(`${target}/js/main.js`);
      const secondSnap = fs.read(`${target}/snapshot.json`);
      const secondMetaText = fs.readText(`${target}/meta.json`);
      const secondMeta = JSON.parse(secondMetaText) as Record<string, unknown>;
      expect(bytesEqual(firstMain, secondMain)).toBe(true);
      expect(bytesEqual(firstSnap, secondSnap)).toBe(true);
      expect(Object.keys(secondMeta)).toEqual(Object.keys(firstMeta));
      for (const k of Object.keys(firstMeta)) {
        if (k === 'exportedAt') continue;
        expect(JSON.stringify(secondMeta[k])).toEqual(JSON.stringify(firstMeta[k]));
      }
    },
    120000,
  );

  it(
    'export_scene_invalid when the project does not load',
    async () => {
      const fs = new MemFs();
      const wsError = {
        code: 'project_not_found',
        cls: 'not_found',
        message: "no such project 'demo-0001'",
      };
      const res = await exportProject(makeCtx(makeService({ queryProjectError: wsError }), fs));
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe('export_scene_invalid');
      expect(res.error.cls).toBe('validation');
      expect(res.error.detail?.errors).toEqual([wsError]);
      expect(res.error.detail?.errorTotal).toBe(1);
      expect(fs.allPaths().length).toBe(3); // only the seeded fixture files
    },
    30000,
  );

  it(
    'export_snapshot_mismatch when the revision advances between read and re-read',
    async () => {
      const fs = new MemFs();
      const res = await exportProject(makeCtx(makeService({ revision: 3, revisionOnReread: 4 }), fs));
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe('export_snapshot_mismatch');
      expect(res.error.cls).toBe('conflict');
      expect(res.error.detail?.frozenRevision).toBe(3);
      expect(res.error.detail?.currentRevision).toBe(4);
      // Nothing was written (the pipeline fails before step 6).
      expect(fs.allPaths().filter((p) => p.startsWith('/x/exports/'))).toEqual([]);
    },
    120000,
  );

  it('export_output_path_invalid when exportRoot is inside the repository tree', async () => {
    const fs = new MemFs();
    const ctx = makeCtx(makeService({}), fs);
    const res = await exportProject({ ...ctx, exportRoot: pjoin(ctx.repoRoot, 'exports') });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('export_output_path_invalid');
    expect(res.error.cls).toBe('validation');
  }, 30000);

  it('export_output_path_invalid when exportRoot is inside the authoring tree', async () => {
    const fs = new MemFs();
    const ctx = makeCtx(makeService({}), fs);
    const res = await exportProject({ ...ctx, exportRoot: pjoin(ctx.authoringRoot, 'exports') });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('export_output_path_invalid');
  }, 30000);

  it('export_output_not_writable when a write fails (temp dir removed)', async () => {
    const fs = new MemFs();
    const ctx = makeCtx(makeService({}), fs);
    fs.failWriteAt = '/x/exports/.export-tmp-tmp1/index.html';
    const res = await exportProject(ctx);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('export_output_not_writable');
    expect(res.error.cls).toBe('unavailable');
    expect(fs.allPaths().filter((p) => p.includes('.export-tmp-'))).toEqual([]);
  }, 120000);
});

describe('bundle graph check (export.md §5.2)', () => {
  const REPO = '/home/u/thirdlight';
  it('accepts the exact allowed graph', () => {
    const report = checkBundleGraph(
      {
        inputs: {
          [`${REPO}/packages/exporter/src/export-bootstrap.ts`]: {},
          [`${REPO}/packages/runtime/src/index.ts`]: {},
          [`${REPO}/packages/three-adapter/src/adapter.ts`]: {},
          [`${REPO}/packages/project-model/src/validate.ts`]: {},
          [`${REPO}/node_modules/three/build/three.core.js`]: {},
        },
      },
      `${REPO}/packages/exporter/src/export-bootstrap.ts`,
    );
    expect(report.ok).toBe(true);
    expect(report.forbidden).toEqual([]);
  });
  it('rejects forbidden modules (backend, another exporter file, node: builtin)', () => {
    const report = checkBundleGraph(
      {
        inputs: {
          [`${REPO}/packages/exporter/src/export-bootstrap.ts`]: {},
          [`${REPO}/packages/backend/src/backend.ts`]: {},
          [`${REPO}/packages/exporter/src/export.ts`]: {},
          [`${REPO}/packages/protocol/src/index.ts`]: {},
          'node:fs': {},
        },
      },
      `${REPO}/packages/exporter/src/export-bootstrap.ts`,
    );
    expect(report.ok).toBe(false);
    expect(report.forbidden.length).toBeLessThanOrEqual(8);
    expect(report.forbidden.join(' ')).toContain('packages/backend');
    expect(report.forbidden.join(' ')).toContain('packages/exporter/src/export.ts');
    expect(report.forbidden.join(' ')).toContain('node:fs');
  });
});

describe('forbidden-content scan (export.md §5.4/§5.4.1)', () => {
  const patterns = { authoringOrigin: 'http://127.0.0.1:8501', previewOrigin: 'http://127.0.0.1:8502', tokenValues: ['tok-abc'] };

  function referenceBytes(): Uint8Array {
    // A synthetic "reference three" with exactly the recorded counts.
    const parts: string[] = [];
    for (let i = 0; i < THREE_RECORD.fetch; i += 1) parts.push('fetch(');
    for (let i = 0; i < THREE_RECORD.processDot; i += 1) parts.push('process.env.X');
    for (let i = 0; i < THREE_RECORD.http; i += 1) parts.push('http://x');
    for (let i = 0; i < THREE_RECORD.https; i += 1) parts.push('https://x');
    for (let i = 0; i < THREE_RECORD.xhr; i += 1) parts.push('XMLHttpRequest');
    return new TextEncoder().encode(parts.join('\n'));
  }

  function bundleBytes(extra = ''): Uint8Array {
    const parts: string[] = [];
    for (let i = 0; i < THREE_RECORD.fetch; i += 1) parts.push('fetch(');
    parts.push('fetch("./snapshot.json")');
    for (let i = 0; i < THREE_RECORD.processDot; i += 1) parts.push('process.env.X');
    for (let i = 0; i < THREE_RECORD.http; i += 1) parts.push('http://x');
    for (let i = 0; i < THREE_RECORD.https; i += 1) parts.push('https://x');
    for (let i = 0; i < THREE_RECORD.xhr; i += 1) parts.push('XMLHttpRequest');
    parts.push(extra);
    return new TextEncoder().encode(parts.join('\n'));
  }

  const identity = { version: THREE_RECORD.version, integrity: THREE_RECORD.integrity };

  it('passes with the exact recorded counts when the binding holds', () => {
    const report = scanExportFiles(
      [
        { name: 'index.html', bytes: new TextEncoder().encode('<html><script src="./js/main.js"></script></html>') },
        { name: 'js/main.js', bytes: bundleBytes() },
        { name: 'snapshot.json', bytes: new TextEncoder().encode('{"projectId":"demo-0001"}\n') },
        { name: 'meta.json', bytes: new TextEncoder().encode('{"type":"thirdlight-export"}\n') },
      ],
      patterns,
      'js/main.js',
      identity,
      referenceBytes(),
    );
    expect(report.binding.identityOk).toBe(true);
    expect(report.binding.referenceOk).toBe(true);
    expect(report.ok).toBe(true);
    expect(report.scanHits).toBe(0);
  });

  it('fails when an EXTRA fetch( appears in the bundle (count deviation)', () => {
    const report = scanExportFiles(
      [{ name: 'js/main.js', bytes: bundleBytes('fetch("https://evil")') }],
      patterns,
      'js/main.js',
      identity,
      referenceBytes(),
    );
    expect(report.ok).toBe(false);
    expect(report.scanHits).toBeGreaterThanOrEqual(1);
    // The deviation is reported for BOTH the extra fetch( and the extra
    // https:// (the injected literal); assert the fetch( hit is among them.
    expect(report.hits.some((h) => h.pattern === 'fetch(')).toBe(true);
    expect(report.hits.some((h) => h.context.includes('fetch('))).toBe(true);
  });

  it('fails when the three identity is wrong (the exception table is void)', () => {
    const report = scanExportFiles(
      [{ name: 'js/main.js', bytes: bundleBytes() }],
      patterns,
      'js/main.js',
      { version: '0.186.1', integrity: THREE_RECORD.integrity },
      referenceBytes(),
    );
    expect(report.binding.identityOk).toBe(false);
    expect(report.ok).toBe(false);
  });

  it('fails when the reference build deviates from the recorded table (fails closed)', () => {
    const badRef = new TextEncoder().encode('fetch(\nfetch(\nfetch(\nfetch('); // 4 ≠ 3
    const report = scanExportFiles(
      [{ name: 'js/main.js', bytes: bundleBytes() }],
      patterns,
      'js/main.js',
      identity,
      badRef,
    );
    expect(report.binding.referenceOk).toBe(false);
    expect(report.ok).toBe(false);
  });

  it('fails when a token value or the authoring origin appears in any file', () => {
    const r1 = scanExportFiles(
      [{ name: 'meta.json', bytes: new TextEncoder().encode('{"x":"tok-abc"}') }],
      patterns,
      'js/main.js',
      identity,
      referenceBytes(),
    );
    expect(r1.ok).toBe(false);
    expect(r1.hits[0]?.pattern).toBe('tok-abc');
    const r2 = scanExportFiles(
      [{ name: 'index.html', bytes: new TextEncoder().encode('<!-- http://127.0.0.1:8501 -->') }],
      patterns,
      'js/main.js',
      identity,
      referenceBytes(),
    );
    expect(r2.ok).toBe(false);
  });

  it('fails on node: / __dirname / WebSocket / /api/v1/ / file:// anywhere', () => {
    for (const bad of ['node:fs', '__dirname', 'new WebSocket', '/api/v1/sessions', 'file:///x']) {
      const report = scanExportFiles(
        [{ name: 'index.html', bytes: new TextEncoder().encode(`<i>${bad}</i>`) }],
        patterns,
        'js/main.js',
        identity,
        referenceBytes(),
      );
      expect(report.ok, bad).toBe(false);
    }
  });
});

describe('canonical serialization (export.md §3, project-model §12.2 style)', () => {
  it('emits fixed field order, 2-space indent, LF, one trailing newline, no BOM', () => {
    const doc = { a: 1, b: ['x', 'y'], c: { d: true, e: null }, f: 's' };
    const text = canonicalJson(doc, 0) + '\n';
    expect(text).toBe('{\n  "a": 1,\n  "b": [\n    "x",\n    "y"\n  ],\n  "c": {\n    "d": true,\n    "e": null\n  },\n  "f": "s"\n}\n');
    const bytes = canonicalDocument(doc);
    expect(bytes[0]).not.toBe(0xef);
    expect(new TextDecoder().decode(bytes).endsWith('}\n')).toBe(true);
  });
  it('escapes strings per JSON semantics', () => {
    expect(canonicalJson({ s: 'a"b\nc' }, 0)).toBe('{\n  "s": "a\\"b\\nc"\n}');
  });
});