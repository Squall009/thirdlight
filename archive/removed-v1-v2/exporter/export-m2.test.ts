/**
 * @thirdlight/exporter — packet-36 M2 pipeline unit tests.
 *
 * The full M2 pipeline runs against an INJECTED fake workspace service (a real
 * captured v2 view + verified blob reads), an INJECTED fake packet-33 compiler
 * and the in-memory `ExportFs`, with the REAL esbuild 0.28.2 build of the real
 * M2 bootstrap over the real installed three/GLTFLoader/Rapier modules. The
 * real-fs + real-backend + real-HTTP integration lives in
 * `tests/integration/m2-export/**`.
 */
import { describe, expect, it } from 'vitest';
import { capturedViewDigest, digestBytes, sha256HexOfText } from '@thirdlight/project-model';
import type { WorkspaceService } from '@thirdlight/workspace';

import { exportProject, type ExportContext } from './export';
import type { ExportFs } from './export-types';
import { scanGlbContainer, scanWasmContainer } from './export-content-scan';
import { checkBundleGraphM2 } from './graph';
import { verifyManifestIdentity } from './export-composition';

// ---- a real (minimal) GLB built in memory -------------------------------------

function glb(jsonText: string, bin: Uint8Array): Uint8Array {
  const jsonBytes = new TextEncoder().encode(jsonText);
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const binPad = (4 - (bin.length % 4)) % 4;
  const jsonLen = jsonBytes.length + jsonPad;
  const binLen = bin.length + binPad;
  const total = 12 + 8 + jsonLen + 8 + binLen;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLen, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  for (let i = 0; i < jsonPad; i += 1) out[20 + jsonBytes.length + i] = 0x20;
  const binHeader = 20 + jsonLen;
  dv.setUint32(binHeader, binLen, true);
  dv.setUint32(binHeader + 4, 0x004e4942, true);
  out.set(bin, binHeader + 8);
  return out;
}

const GLB_JSON = JSON.stringify({
  asset: { version: '2.0' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
  buffers: [{ byteLength: 36 }],
  bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
  accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
});
const GLB_BIN = new Uint8Array(36);
const GLB_BYTES = glb(GLB_JSON, GLB_BIN);
const GLB_DIGEST = digestBytes(GLB_BYTES);

const BEHAVIOR_OUTPUT = new TextEncoder().encode('export default { /*packet36-behavior-output-marker*/ step() { return null; } };\n');
const BEHAVIOR_OUTPUT_DIGEST = digestBytes(BEHAVIOR_OUTPUT);
const BEHAVIOR_SOURCE = new TextEncoder().encode('{"behavior-source":1}');
const BEHAVIOR_SOURCE_DIGEST = digestBytes(BEHAVIOR_SOURCE);

const DECLARATION = { properties: [{ key: 'speed', label: 'Speed', type: 'number', default: 3.5, min: -1000, max: 1000, step: 0.25 }] };

const PROJECT = 'demo-m2-01';
const MANIFEST = {
  schemaVersion: 1,
  engineVersion: '0.1.0',
  id: PROJECT,
  name: 'M2 Demo',
  createdAt: '2026-09-19T00:00:00Z',
  scenes: [{ id: 'scene-main', path: 'scenes/main.json' }],
};

const ENTITIES = [
  {
    id: 'cam-main',
    name: 'Main Camera',
    components: {
      transform: { position: [0, 0.5, 4], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      camera: { type: 'perspective', fovY: 60, near: 0.1, far: 100 },
    },
  },
  {
    id: 'model-0001',
    name: 'Pinned Model',
    components: {
      transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      model: { asset: { assetId: 'asset-00000000000000a1' } },
    },
  },
  {
    id: 'floor-0001',
    name: 'Floor',
    components: {
      transform: { position: [0, -0.25, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      collider: { shape: { type: 'box', hx: 5, hy: 0.25 } },
    },
  },
  {
    id: 'char-0001',
    name: 'Character',
    components: {
      transform: { position: [0, 0.9, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      controller: {},
      behavior: { behaviorId: 'behavior-0001', values: { speed: 2 } },
    },
  },
];

const VIEW_ASSETS = [
  {
    assetId: 'asset-00000000000000a1',
    version: 1,
    sourceDigest: GLB_DIGEST,
    sourceByteLength: GLB_BYTES.length,
    importRecipe: { profile: 'gltf-glb', recipeVersion: 1, toolchain: { three: '0.186.0' }, extensions: [] },
  },
];

const VIEW = {
  contentVersion: 1,
  projectId: PROJECT,
  revision: 4,
  assets: VIEW_ASSETS,
  // The workspace computes this digest; the test derives it with the same
  // canonical rule (project-model §19.1).
  contentDigest: capturedViewDigest({ projectId: PROJECT, revision: 4, assets: VIEW_ASSETS }),
};

const BEHAVIOR_ROW = {
  behaviorId: 'behavior-0001',
  displayName: 'Packet 36 behavior',
  declaration: DECLARATION,
  source: {
    sourceDigest: BEHAVIOR_SOURCE_DIGEST,
    sourceByteLength: BEHAVIOR_SOURCE.length,
    manifestDigest: digestBytes(new TextEncoder().encode('manifest')),
    outputDigest: BEHAVIOR_OUTPUT_DIGEST,
    ownedTransforms: [],
    requiredModules: [],
  },
  publishedRevision: 4,
};

function makeM2Service(opts: {
  revision?: number;
  revisionOnReread?: number;
  blobDigestOverride?: string;
  blobMissing?: boolean;
  behaviorRows?: readonly unknown[];
  assetBytes?: Uint8Array;
} = {}): WorkspaceService {
  const assetBytes = opts.assetBytes ?? GLB_BYTES;
  const assetDigest = digestBytes(assetBytes);
  const view = {
    contentVersion: 1 as const,
    projectId: PROJECT,
    revision: 4,
    assets: [
      {
        assetId: 'asset-00000000000000a1',
        version: 1,
        sourceDigest: assetDigest,
        sourceByteLength: assetBytes.length,
        importRecipe: { profile: 'gltf-glb', recipeVersion: 1, toolchain: { three: '0.186.0' }, extensions: [] },
      },
    ],
    contentDigest: capturedViewDigest({
      projectId: PROJECT,
      revision: 4,
      assets: [
        {
          assetId: 'asset-00000000000000a1',
          version: 1,
          sourceDigest: assetDigest,
          sourceByteLength: assetBytes.length,
          importRecipe: { profile: 'gltf-glb', recipeVersion: 1, toolchain: { three: '0.186.0' }, extensions: [] },
        },
      ],
    }),
  };
  let projectCalls = 0;
  const revision = opts.revision ?? 4;
  const reread = opts.revisionOnReread ?? revision;
  const query = (req: unknown): unknown => {
    const r = req as { op?: string; args?: { offset?: number; limit?: number } };
    if (r.op === 'queryProject') {
      projectCalls += 1;
      return {
        ok: true,
        projectId: PROJECT,
        revision: projectCalls === 1 ? revision : reread,
        manifest: MANIFEST,
        scene: { sceneId: 'scene-main', entityCount: ENTITIES.length, cameraId: 'cam-main' },
        history: { undoDepth: 0, redoDepth: 0 },
        workspace: { writePaused: false },
      };
    }
    if (r.op === 'queryEntities') {
      const offset = r.args?.offset ?? 0;
      const limit = r.args?.limit ?? 100;
      return { ok: true, projectId: PROJECT, revision, total: ENTITIES.length, offset, limit, entities: ENTITIES.slice(offset, offset + limit) };
    }
    if (r.op === 'queryBehaviors') {
      return {
        ok: true,
        projectId: PROJECT,
        revision,
        total: (opts.behaviorRows ?? [BEHAVIOR_ROW]).length,
        offset: 0,
        limit: 128,
        behaviors: opts.behaviorRows ?? [BEHAVIOR_ROW],
      };
    }
    return { ok: false, error: { code: 'invalid_request', cls: 'validation', message: 'unknown op' } };
  };
  return {
    backendId: 'fake-backend',
    query,
    captureContentView: () => ({ ok: true, view }),
    readBlob: () =>
      opts.blobMissing === true
        ? { ok: false, error: { code: 'blob_missing', cls: 'unavailable', message: 'missing' } }
        : {
            ok: true,
            assetId: 'asset-00000000000000a1',
            version: 1,
            digest: opts.blobDigestOverride ?? assetDigest,
            byteLength: assetBytes.length,
            verified: true,
            bytes: assetBytes,
          },
    readSourceBlob: () => ({ ok: true, digest: BEHAVIOR_SOURCE_DIGEST, byteLength: BEHAVIOR_SOURCE.length, bytes: BEHAVIOR_SOURCE, verified: true }),
    runCommand: () => {
      throw new Error('unused');
    },
    createProject: () => {
      throw new Error('unused');
    },
    releaseWorkspace: () => {
      throw new Error('unused');
    },
    takeoverWorkspace: () => {
      throw new Error('unused');
    },
    acceptExternalState: () => {
      throw new Error('unused');
    },
    discardExternalState: () => {
      throw new Error('unused');
    },
    scan: () => {
      throw new Error('unused');
    },
    dispose: () => undefined,
    lastScan: { entries: [], total: 0, truncated: false } as never,
  } as unknown as WorkspaceService;
}

const COMPILER = {
  pinnedModules: [{ id: '@thirdlight/runtime', version: '0.1.0', apiVersion: 1 }],
  compile: async () => ({ ok: true as const, outputBytes: BEHAVIOR_OUTPUT, outputDigest: BEHAVIOR_OUTPUT_DIGEST }),
};

const REPO = import.meta.url.replace('file://', '').replace(/\/packages\/exporter\/src\/export-m2\.test\.ts$/, '');

class MemFs implements ExportFs {
  private files = new Map<string, Uint8Array>();
  private dirs = new Set<string>();
  private tempSeq = 0;
  failWriteAt: string | null = null;
  join(...parts: string[]): string {
    let out = '';
    for (const p of parts) {
      if (p.startsWith('/')) out = '';
      out = out === '' ? p : `${out}/${p}`;
    }
    return out.replace(/\/+/g, '/');
  }
  realpath(p: string): string {
    return p;
  }
  isDirectory(p: string): boolean {
    if (this.dirs.has(p)) return true;
    const prefix = `${p}/`;
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
    for (const k of [...this.files.keys()]) {
      if (k === from || k.startsWith(`${from}/`)) {
        const v = this.files.get(k);
        if (v !== undefined) this.files.set(to + k.slice(from.length), v);
        this.files.delete(k);
      }
    }
  }
  rm(p: string): void {
    for (const k of [...this.files.keys()]) if (k === p || k.startsWith(`${p}/`)) this.files.delete(k);
  }
  mkdtemp(prefix: string): string {
    this.tempSeq += 1;
    const d = `${prefix}tmp${this.tempSeq}`;
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
  readBytes(p: string): Uint8Array {
    return this.read(p);
  }
  allPaths(): string[] {
    return [...this.files.keys()].sort();
  }
}

function makeCtx(service: WorkspaceService, fs: MemFs): ExportContext {
  fs.seed('/x/repo/node_modules/three/package.json', JSON.stringify({ name: 'three', version: '0.186.0' }));
  fs.seed('/x/repo/node_modules/typescript/package.json', JSON.stringify({ name: 'typescript', version: '5.9.3' }));
  fs.seed('/x/repo/node_modules/@dimforge/rapier2d-compat/package.json', JSON.stringify({ name: '@dimforge/rapier2d-compat', version: '0.20.0' }));
  fs.seed(
    '/x/repo/package-lock.json',
    JSON.stringify({
      packages: {
        'node_modules/three': {
          version: '0.186.0',
          integrity: 'sha512-cr/fIM2ddMSVbYVgkfD4jLJv7Fh/8ZTjvo+7gQeSVGUZHxpx9FDwoL5iC7hUz/LiRA8wMbqfnb90xKfm1/HHkQ==',
        },
      },
    }),
  );
  fs.mkdir('/x/exports');
  return {
    projectId: PROJECT,
    service,
    fs,
    exportRoot: '/x/exports',
    repoRoot: REPO,
    authoringRoot: '/x/data',
    authoringOrigin: 'http://127.0.0.1:8501',
    previewOrigin: 'http://127.0.0.1:8502',
    tokenValues: ['auth-secret-token-123'],
    bootstrapEntry: `${REPO}/packages/exporter/src/export-bootstrap.ts`,
    m2BootstrapEntry: `${REPO}/packages/exporter/src/export-bootstrap-m2.ts`,
    compiler: COMPILER,
    threePackageJson: '/x/repo/node_modules/three/package.json',
    typescriptPackageJson: '/x/repo/node_modules/typescript/package.json',
    lockfile: '/x/repo/package-lock.json',
  };
}

describe('exportProject — the M2 pipeline (packet 36)', () => {
  it('exports the closure: manifest v2, scene, GLB + behavior artifacts, meta.json v2, atomic write', async () => {
    const fs = new MemFs();
    const res = await exportProject(makeCtx(makeM2Service(), fs));
    if (!res.ok) throw new Error(JSON.stringify(res.error));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.outputDir).toBe(`${PROJECT}@r4`);
    expect(res.schemaVersion).toBe(2);
    expect(res.snapshotId).toBe(`${PROJECT}@r4`);
    expect(res.scanHits).toBe(0);
    expect(Object.keys(res.files).sort()).toEqual(
      ['behaviors/' + BEHAVIOR_OUTPUT_DIGEST + '.js', `content/sha256/${GLB_DIGEST}`, 'index.html', 'js/main.js', 'manifest.json', 'meta.json', 'scene.json'].sort(),
    );

    const target = `/x/exports/${PROJECT}@r4`;
    const manifest = JSON.parse(new TextDecoder().decode(fs.readBytes(`${target}/manifest.json`))) as Record<string, unknown>;
    expect(Object.keys(manifest)).toEqual([
      'manifestVersion',
      'type',
      'projectId',
      'revision',
      'snapshotId',
      'capturedAt',
      'sceneDigest',
      'contentDigest',
      'assets',
      'behaviors',
      'modules',
      'enginePins',
      'recipes',
      'toolchain',
      'buildOptionsDigest',
      'buildId',
    ]);
    expect(manifest['manifestVersion']).toBe(1);
    expect(manifest['type']).toBe('thirdlight-runtime-content');
    expect((manifest['assets'] as Array<Record<string, unknown>>)[0]!['path']).toBe(`content/sha256/${GLB_DIGEST}`);
    expect((manifest['behaviors'] as Array<Record<string, unknown>>)[0]!['path']).toBe(`behaviors/${BEHAVIOR_OUTPUT_DIGEST}.js`);
    expect((manifest['modules'] as Array<Record<string, unknown>>).map((m) => m['id'])).toEqual([
      'thirdlight.input:keyboard-gamepad',
      'thirdlight.physics-rapier:2d',
      'thirdlight.platformer:controller',
      'thirdlight.three-adapter:gltf-loader',
    ]);
    // The manifest is self-identifying (a browser re-derivation uses the same rule).
    const identity = await verifyManifestIdentity(manifest, async (text) => sha256HexOfText(text));
    expect(identity.ok).toBe(true);

    // The emitted scene document is exactly the digest input of sceneDigest.
    const sceneBytes = fs.readBytes(`${target}/scene.json`);
    expect(digestBytes(sceneBytes)).toBe(manifest['sceneDigest']);

    const meta = JSON.parse(new TextDecoder().decode(fs.readBytes(`${target}/meta.json`))) as Record<string, unknown>;
    expect(Object.keys(meta)).toEqual([
      'schemaVersion',
      'type',
      'engineVersion',
      'projectId',
      'snapshotId',
      'revision',
      'exportedAt',
      'dependencies',
      'scene',
      'behaviors',
      'behaviorTrust',
      'manifest',
      'licenses',
      'artifacts',
      'outputDigest',
    ]);
    expect(meta['schemaVersion']).toBe(2);
    expect(meta['behaviorTrust']).toEqual({ acknowledgedSourceDigests: [BEHAVIOR_SOURCE_DIGEST] });
    expect((meta['dependencies'] as Record<string, unknown>)['three']).toBe('0.186.0');
    expect(meta['outputDigest']).toMatch(/^[0-9a-f]{64}$/);
    const manifestBlock = meta['manifest'] as Record<string, unknown>;
    expect(manifestBlock['buildId']).toBe(manifest['buildId']);
    expect(manifestBlock['contentDigest']).toBe(manifest['contentDigest']);

    // The emitted bundle: the single manifest + scene reads and one relative
    // fetch per declared asset path; no forbidden patterns.
    const bundle = new TextDecoder().decode(fs.readBytes(`${target}/js/main.js`));
    expect(bundle.split('fetch("./manifest.json"').length - 1).toBe(1);
    expect(bundle.split('fetch("./scene.json"').length - 1).toBe(1);
    expect(bundle.split(`fetch("./content/sha256/${GLB_DIGEST}"`).length - 1).toBe(1);
    expect(bundle).not.toContain('/api/v1/');
    expect(bundle).not.toContain('node:');
    expect(bundle).not.toContain('auth-secret-token-123');
    expect(bundle).not.toContain('http://127.0.0.1:8501');
    // The linked behavior output bytes are static bundle inputs.
    expect(bundle).toContain('packet36-behavior-output-marker');
    // The two virtual closure modules appear exactly as the per-snapshot facts.
    expect(bundle).toContain('export-artifacts');
    expect(bundle).toContain('export-behaviors');

    // No temp/backup litter.
    expect(fs.allPaths().filter((p) => p.includes('.export-tmp-') || p.includes('.replacing'))).toEqual([]);
  }, 300_000);

  it('is byte-reproducible: two exports differ only in meta.json.exportedAt', async () => {
    const fs = new MemFs();
    // A fixed capture clock: export.md §7's M2 claim is "two exports of the
    // same CAPTURED MANIFEST" — the capture second is part of the manifest
    // identity (`capturedAt`), so the byte-identity scope pins it.
    let clock = Date.parse('2026-09-19T12:00:00.000Z');
    const ctx = { ...makeCtx(makeM2Service(), fs), now: () => clock };
    void clock;
    const first = await exportProject(ctx);
    if (!first.ok) throw new Error(JSON.stringify(first.error));
    const target = `/x/exports/${PROJECT}@r4`;
    const names = ['index.html', 'js/main.js', 'manifest.json', 'scene.json', `content/sha256/${GLB_DIGEST}`, `behaviors/${BEHAVIOR_OUTPUT_DIGEST}.js`];
    const before = names.map((n) => digestBytes(fs.readBytes(`${target}/${n}`)));
    const metaBefore = JSON.parse(new TextDecoder().decode(fs.readBytes(`${target}/meta.json`))) as Record<string, unknown>;
    const second = await exportProject(ctx);
    if (!second.ok) throw new Error(JSON.stringify(second.error));
    const after = names.map((n) => digestBytes(fs.readBytes(`${target}/${n}`)));
    expect(after).toEqual(before);
    const metaAfter = JSON.parse(new TextDecoder().decode(fs.readBytes(`${target}/meta.json`))) as Record<string, unknown>;
    for (const key of Object.keys(metaBefore)) {
      if (key === 'exportedAt') continue;
      expect(metaAfter[key], key).toEqual(metaBefore[key]);
    }
    expect(second.ok && first.ok && second.outputDigest).toBe(first.ok ? first.outputDigest : null);
  }, 300_000);

  it('rejects a forbidden module in the M2 graph (backend/editor/workspace)', () => {
    const report = checkBundleGraphM2(
      {
        inputs: {
          [`${REPO}/packages/exporter/src/export-bootstrap-m2.ts`]: {},
          [`${REPO}/packages/runtime/src/index.ts`]: {},
          [`${REPO}/packages/input/src/index.ts`]: {},
          [`${REPO}/packages/platformer/src/index.ts`]: {},
          [`${REPO}/packages/physics-rapier/src/index.ts`]: {},
          [`${REPO}/packages/three-adapter/src/gltf-loader.ts`]: {},
          [`${REPO}/node_modules/three/build/three.module.js`]: {},
          [`${REPO}/node_modules/@dimforge/rapier2d-compat/rapier.js`]: {},
          'thirdlight-export:export-artifacts': {},
          'thirdlight-export:export-behaviors': {},
          'thirdlight-behavior:thirdlight:behavior-output:behavior-0001': {},
          [`${REPO}/packages/exporter/src/export-composition.ts`]: {},
        },
      },
      `${REPO}/packages/exporter/src/export-bootstrap-m2.ts`,
    );
    expect(report.ok).toBe(true);
    const bad = checkBundleGraphM2(
      {
        inputs: {
          [`${REPO}/packages/exporter/src/export-bootstrap-m2.ts`]: {},
          [`${REPO}/packages/backend/src/backend.ts`]: {},
          [`${REPO}/packages/workspace/src/service.ts`]: {},
          [`${REPO}/packages/behavior-build/src/compile.ts`]: {},
          [`${REPO}/packages/exporter/src/export.ts`]: {},
          'node:fs': {},
        },
      },
      `${REPO}/packages/exporter/src/export-bootstrap-m2.ts`,
    );
    expect(bad.ok).toBe(false);
    expect(bad.forbidden.join(' ')).toContain('packages/backend');
    expect(bad.forbidden.join(' ')).toContain('packages/behavior-build');
    expect(bad.forbidden.join(' ')).toContain('node:fs');
  });

  it('rejects a stale capture (revision advanced between read and re-read)', async () => {
    const fs = new MemFs();
    const res = await exportProject(makeCtx(makeM2Service({ revision: 4, revisionOnReread: 5 }), fs));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('export_snapshot_mismatch');
    expect(fs.allPaths().filter((p) => p.startsWith('/x/exports/'))).toEqual([]);
  }, 300_000);

  it('rejects a missing/corrupt asset blob and leaves no output', async () => {
    const fsMissing = new MemFs();
    const missing = await exportProject(makeCtx(makeM2Service({ blobMissing: true }), fsMissing));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('export_scene_invalid');
    expect(fsMissing.allPaths().filter((p) => p.startsWith('/x/exports/'))).toEqual([]);

    const fsCorrupt = new MemFs();
    const corrupt = await exportProject(makeCtx(makeM2Service({ blobDigestOverride: 'f'.repeat(64) }), fsCorrupt));
    expect(corrupt.ok).toBe(false);
    if (!corrupt.ok) expect(corrupt.error.code).toBe('export_scene_invalid');
    expect(fsCorrupt.allPaths().filter((p) => p.startsWith('/x/exports/'))).toEqual([]);
  }, 300_000);

  it('rejects a declared asset whose bytes are not a GLB container', async () => {
    const fs = new MemFs();
    const notGlb = new TextEncoder().encode('this is not a GLB container at all');
    const res = await exportProject(makeCtx(makeM2Service({ assetBytes: notGlb }), fs));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('scan_forbidden_content');
    expect(res.error.detail?.hits?.[0]?.pattern).toBe('glb_magic');
    expect(fs.allPaths().filter((p) => p.startsWith('/x/exports/'))).toEqual([]);
  }, 300_000);

  it('leaves the previous output untouched when a write fails', async () => {
    const fs = new MemFs();
    const ctx = makeCtx(makeM2Service(), fs);
    const first = await exportProject(ctx);
    expect(first.ok).toBe(true);
    const target = `/x/exports/${PROJECT}@r4`;
    const before = fs.allPaths().filter((p) => p.startsWith(target));
    const hashes = before.map((p) => digestBytes(fs.readBytes(p)));
    fs.failWriteAt = '/x/exports/.export-tmp-tmp2/js/main.js';
    const second = await exportProject(ctx);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('export_output_not_writable');
    const after = fs.allPaths().filter((p) => p.startsWith(target));
    expect(after).toEqual(before);
    expect(after.map((p) => digestBytes(fs.readBytes(p)))).toEqual(hashes);
  }, 300_000);
});

describe('format-aware containers (sessions.md §17.5.1)', () => {
  it('accepts a well-formed GLB and rejects magic/length/uri deviations', () => {
    expect(scanGlbContainer(GLB_BYTES).ok).toBe(true);
    const truncated = GLB_BYTES.slice(0, 30);
    const t = scanGlbContainer(truncated);
    expect(t.ok).toBe(false);
    const badMagic = new Uint8Array(GLB_BYTES);
    badMagic[0] = 0x00;
    expect(scanGlbContainer(badMagic).ok).toBe(false);
    const badLength = new Uint8Array(GLB_BYTES);
    new DataView(badLength.buffer).setUint32(8, GLB_BYTES.length + 4, true);
    expect(scanGlbContainer(badLength).ok).toBe(false);
    const remoteUri = glb(
      JSON.stringify({ asset: { version: '2.0' }, images: [{ uri: 'https://evil.example/x.png' }] }),
      GLB_BIN,
    );
    const r = scanGlbContainer(remoteUri);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('glb_uri_forbidden');
    for (const uri of ['data:image/png;base64,AAAA', 'file:///x', '//host/x', '/abs/x', '../x', 'a\\b']) {
      const bytes = glb(JSON.stringify({ asset: { version: '2.0' }, images: [{ uri }] }), GLB_BIN);
      expect(scanGlbContainer(bytes).ok, uri).toBe(false);
    }
    const dupKey = glb('{"asset":{"version":"2.0"},"asset":{"version":"2.0"}}', GLB_BIN);
    expect(scanGlbContainer(dupKey).ok).toBe(false);
  });

  it('validates WASM containers by magic/version/pin (no WASM artifact is emitted today)', () => {
    const wasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    expect(scanWasmContainer(wasm, 'a'.repeat(64)).ok).toBe(true);
    expect(scanWasmContainer(wasm, 'nope').ok).toBe(false);
    const badVersion = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x02, 0x00, 0x00, 0x00]);
    expect(scanWasmContainer(badVersion, 'a'.repeat(64)).ok).toBe(false);
  });
});
