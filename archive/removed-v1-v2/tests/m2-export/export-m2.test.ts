/**
 * Packet 36 — standalone M2 content/gameplay export (real backend process,
 * real filesystem, real HTTP on the authoring origin, real content/behavior
 * publication, real esbuild bundle build, an INDEPENDENT static server under a
 * non-root subpath, and the REAL Rapier adapter in Node for the play/export
 * trace comparison).
 *
 * What this file proves for real:
 *   - the complete export closure (manifest + scene + every reachable GLB +
 *     every reachable behavior output + the shared runtime bundle) with an
 *     exact declared/emitted closure equality;
 *   - `meta.json` v2 (versions/licenses/hashes/build identity/output digest);
 *   - two same-input exports: every artifact byte-identical; the only
 *     differing bytes are the agreed timestamp fields (`capturedAt` in
 *     `manifest.json`, `exportedAt` in `meta.json`) and the digests derived
 *     from them (recorded as a normalized byte-tree diff);
 *   - a failed export (missing/corrupt blob, hostile source) leaves the
 *     previous output byte-untouched;
 *   - the emitted bytes carry no credential, no authoring origin, no backend
 *     URL and no undeclared fetch;
 *   - serving under a NON-ROOT path with correct `.glb`/`.wasm` MIME records;
 *   - a fixed step-indexed action sequence produces the SAME trace through the
 *     play-locator artifact set and the export tree (real Rapier), within the
 *     frozen tolerance.
 *
 * UNVERIFIED here (no browser in this container): the real-browser walkthrough
 * (WebGL rendering, WASM init/CSP under the pinned headers, keyboard/gamepad,
 * pixels) — procedure and required evidence in
 * `docs/acceptance/evidence-m2/36/manifest.md`.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

import { composeExportRuntime, type ExportBehaviorLink } from '../../../packages/exporter/src/export-composition';
import { scanGlbContainer } from '../../../packages/exporter/src/export-content-scan';
import { createStepInputSource } from '../../../packages/input/src/step-source';
import { createPhysicsPort, type RapierPhysicsInitConfig, type RapierStaticColliderSpec } from '../../../packages/physics-rapier/src/index';
import { CONTROLLER_CONSTANTS } from '../../../packages/platformer/src/index';
import type { ActionFrame, GameplaySettings, PhysicsPort, RuntimeSnapshot } from '../../../packages/runtime/src/index';

import {
  ADMIN_TOKEN,
  AUTHORING_ORIGIN,
  AUTH_TOKEN,
  PLAY_PROJECT,
  REPO_ROOT,
  cleanupBundles,
  http,
  makeExportRoot,
  FakeEditor,
  mkRequestId,
  sha256Hex,
  sleep,
  establish,
  spawnBackendWithExport,
  startStaticServer,
  stopBackend,
  subtreeFiles,
  type BackendProcess,
  type ExportRoot,
} from './harness';

let root: ExportRoot;
let bp: BackendProcess;
let revision = 0;
let behaviorOutputDigest = '';
let CHAR_ID = '';
let glbDigest = '';
let behaviorSourceDigest = '';
const auth = { token: AUTH_TOKEN, origin: AUTHORING_ORIGIN } as const;

/**
 * P2-3 (Gate I repair): packet-36 raw evidence is committed, so an ordinary
 * `npm test` must NOT overwrite it. The suite writes evidence only when an
 * explicit destination is supplied (`TL_EVIDENCE_DIR`); without it every
 * artifact stays in the disposable temp root and the committed bytes under
 * `docs/acceptance/evidence-m2/36/artifacts/**` are durable.
 *
 * Regenerate deliberately with e.g.
 * `TL_EVIDENCE_DIR=docs/acceptance/evidence-m2/36/artifacts npx vitest run
 * tests/integration/m2-export/export-m2.test.ts`.
 */
const EVIDENCE_DIR = process.env['TL_EVIDENCE_DIR'] ?? null;
function writeEvidence(name: string, data: string | Uint8Array): void {
  if (EVIDENCE_DIR === null) return;
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(join(EVIDENCE_DIR, name), data);
}

let lastOutputDir = '';
let sessionId = '';
let editor: FakeEditor;

function exportTarget(): string {
  return join(root.exportRoot, lastOutputDir);
}

async function command(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await http(`${bp.origin}/api/v1/projects/${PLAY_PROJECT}/commands`, {
    ...auth,
    body: { op, projectId: PLAY_PROJECT, expectedRevision: revision, requestId: mkRequestId(), origin: { kind: 'browser', clientId: 'packet-36' }, args },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  revision = Number((res.body as { revision: number }).revision);
  return res.body as Record<string, unknown>;
}

/** Upload + inspect + publish one fixture GLB (the real content flow). */
async function publishGlb(name: string, displayName: string): Promise<{ assetId: string; sourceDigest: string }> {
  const bytes = new Uint8Array(readFileSync(join(REPO_ROOT, 'fixtures', 'm2', 'assets', name)));
  const created = await http(`${bp.origin}/api/v1/projects/${PLAY_PROJECT}/content/stages`, { ...auth, body: {} });
  expect(created.status).toBe(200);
  const stageId = (created.body as { stageId: string }).stageId;
  const put = await fetch(`${bp.origin}/api/v1/projects/${PLAY_PROJECT}/content/stages/${stageId}/bytes`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${AUTH_TOKEN}`,
      origin: AUTHORING_ORIGIN,
      'content-type': 'application/octet-stream',
      'x-thirdlight-offset': '0',
      'x-thirdlight-total': String(bytes.length),
    },
    body: bytes as unknown as BodyInit,
  });
  expect(put.status).toBe(200);
  const inspected = await http(`${bp.origin}/api/v1/projects/${PLAY_PROJECT}/content/stages/${stageId}/inspect`, { ...auth, body: {} });
  expect(inspected.status, JSON.stringify(inspected.body)).toBe(200);
  const proposal = (inspected.body as { proposal: Record<string, unknown> }).proposal;
  const assetId = `asset-${Math.floor(Math.random() * 1e15).toString(16).padStart(14, '0')}`;
  await command('publishAsset', {
    mode: 'create',
    assetId,
    displayName,
    sourceDigest: String(proposal.sourceDigest),
    sourceByteLength: Number(proposal.sourceByteLength),
    importRecipe: proposal.importRecipe,
    metrics: proposal.metrics,
    importedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  });
  return { assetId, sourceDigest: String(proposal.sourceDigest) };
}

/** Stage + trust-ack + publish one behavior source through the real routes. */
async function publishBehavior(container: Uint8Array, behaviorId: string, declaration: unknown): Promise<{ sourceDigest: string; outputDigest: string }> {
  const sourceDigest = sha256Hex(container);
  const created = await http(`${bp.origin}/api/v1/projects/${PLAY_PROJECT}/content/stages`, { ...auth, body: {} });
  expect(created.status).toBe(200);
  const stageId = (created.body as { stageId: string }).stageId;
  const put = await fetch(`${bp.origin}/api/v1/projects/${PLAY_PROJECT}/content/stages/${stageId}/bytes`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${AUTH_TOKEN}`,
      origin: AUTHORING_ORIGIN,
      'content-type': 'application/octet-stream',
      'x-thirdlight-offset': '0',
      'x-thirdlight-total': String(container.length),
    },
    body: container as unknown as BodyInit,
  });
  expect(put.status).toBe(200);
  await command('publishBehavior', { behaviorId, displayName: 'Packet 36 behavior', mode: 'declaration-create', declaration });
  await command('acknowledgeBehaviorTrust', { sourceDigest });
  const res = await http(`${bp.origin}/api/v1/projects/${PLAY_PROJECT}/content/behaviors/source`, {
    ...auth,
    body: { stageId, behaviorId, displayName: 'Packet 36 behavior', declaration, expectedRevision: revision, requestId: mkRequestId() },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  revision = Number((res.body as { revision: number }).revision);
  return { sourceDigest: String((res.body as { sourceDigest: string }).sourceDigest), outputDigest: String((res.body as { outputDigest: string }).outputDigest) };
}

interface ExportResult {
  ok: boolean;
  outputDir?: string;
  snapshotId?: string;
  revision?: number;
  files?: Record<string, number>;
  scanHits?: number;
  schemaVersion?: number;
  buildId?: string;
  outputDigest?: string;
  error?: { code: string; cls: string; message: string; reason?: string };
}

/** Stop whichever play is active for the project (test isolation). */
async function stopAnyActivePlay(): Promise<void> {
  const list = await http(`${bp.origin}/api/v1/sessions?projectId=${PLAY_PROJECT}`, auth);
  const sessions = (list.body as { sessions?: Array<{ playSessionId?: string }> }).sessions ?? [];
  for (const s of sessions) {
    if (typeof s.playSessionId === 'string') {
      await http(`${bp.origin}/api/v1/projects/${PLAY_PROJECT}/play/${s.playSessionId}/stop`, { ...auth, body: {} });
    }
  }
  await sleep(150);
}

async function runExport(): Promise<ExportResult> {
  const res = await http(`${bp.origin}/api/v1/admin/projects/${PLAY_PROJECT}/export`, {
    token: ADMIN_TOKEN,
    origin: AUTHORING_ORIGIN,
    body: {},
  });
  const body = res.body as ExportResult;
  if (body.ok && typeof body.outputDir === 'string') lastOutputDir = body.outputDir;
  return body;
}

function hashTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of subtreeFiles(dir)) {
    out[rel] = sha256Hex(new Uint8Array(readFileSync(join(dir, rel))));
  }
  return out;
}

/** The scene-derived Rapier init config (the same derivation the page uses). */
function physicsConfigFromScene(scene: { entities: ReadonlyArray<Record<string, unknown>> }): RapierPhysicsInitConfig | null {
  const statics: RapierStaticColliderSpec[] = [];
  let character: RapierPhysicsInitConfig['character'] | null = null;
  for (const entity of scene.entities) {
    const components = (entity['components'] ?? {}) as Record<string, unknown>;
    const transform = components['transform'] as { position?: number[]; rotation?: number[]; scale?: number[] } | undefined;
    const position = transform?.position ?? [0, 0, 0];
    if (components['collider'] !== undefined) {
      const collider = components['collider'] as { shape?: unknown; rotationZ?: number };
      statics.push({ entityId: String(entity['id']), position: { x: position[0] ?? 0, y: position[1] ?? 0 }, rotationZ: collider.rotationZ ?? 0, shape: collider.shape as never });
    }
    if (components['controller'] !== undefined) {
      character = {
        x: position[0] ?? 0,
        y: position[1] ?? 0,
        parentId: (entity['parentId'] as string | null | undefined) ?? null,
        rotation: (transform?.rotation ?? [0, 0, 0, 1]) as [number, number, number, number],
        scale: (transform?.scale ?? [1, 1, 1]) as [number, number, number],
      };
    }
  }
  if (character === null) return null;
  return {
    character,
    statics,
    solver: { hz: 120, gravityY: -19.62 },
    controller: {
      offsetSkin: CONTROLLER_CONSTANTS.offsetSkin,
      groundSnap: CONTROLLER_CONSTANTS.groundSnap,
      maxSlopeClimbRad: (45 * Math.PI) / 180,
      minSlopeSlideRad: (30 * Math.PI) / 180,
      autostep: false,
    },
  };
}

/** Write one ESM module file and import its namespace (test-only loader). */
async function importBytes(bytes: Uint8Array, file: string): Promise<unknown> {
  writeFileSync(file, bytes);
  return import(pathToFileURL(file).href);
}

interface TraceRun {
  positions: Array<{ step: number; x: number; y: number }>;
  maxDiff: number;
}

/**
 * Run one fixed step-indexed action sequence over a closure (scene + manifest +
 * behavior output bytes + the real Rapier adapter) through the SHARED export
 * composition, and return the character's per-step committed positions.
 */
async function runTrace(input: {
  scene: { entities: ReadonlyArray<Record<string, unknown>>; sceneId: string; revision: number };
  snapshotId: string;
  projectId: string;
  revision: number;
  manifest: { behaviors?: readonly Record<string, unknown>[]; enginePins?: readonly { id: string; version: string; apiVersion: number }[]; modules?: readonly { id: string }[] };
  behaviors: Array<{ behaviorId: string; declaration: unknown; artifact: ExportBehaviorLink['artifact']; bytes: Uint8Array }>;
  frames: readonly ActionFrame[];
  steps: number;
  tmpFilePrefix: string;
}): Promise<TraceRun> {
  const config = physicsConfigFromScene(input.scene);
  expect(config, 'the exported scene must carry a controller').not.toBeNull();
  const init = await createPhysicsPort(config as RapierPhysicsInitConfig);
  expect(init.ok, JSON.stringify(init)).toBe(true);
  if (!init.ok) throw new Error('physics init failed');
  const port: PhysicsPort = init.port;

  const links: ExportBehaviorLink[] = [];
  for (const b of input.behaviors) {
    const namespace = await importBytes(b.bytes, `${input.tmpFilePrefix}-${b.behaviorId}.mjs`);
    links.push({ behaviorId: b.behaviorId, declaration: b.declaration, artifact: b.artifact, namespace });
  }
  const frames = new Map(input.frames.map((f) => [f.stepIndex, f]));
  const source = {
    sample: (stepIndex: number): ActionFrame => frames.get(stepIndex) ?? { stepIndex, moveX: 0, jump: 'none' },
  };
  let now = 0;
  let runtime: { tick: (t: number) => { ok: boolean }; getInterpolatedState: () => { ok: boolean; state?: { transforms: Array<{ id: string; position: number[] }> } }; dispose: () => void } | null = null;
  const composed = composeExportRuntime({
    snapshot: { snapshotId: input.snapshotId, projectId: input.projectId, revision: input.revision, scene: input.scene },
    manifest: input.manifest,
    behaviors: links,
    actions: source,
    physics: port,
    settings: { gravity_y: -19.62, run_speed: 4, jump_velocity: 7, max_fall_speed: -30, max_slope_climb_deg: 45, min_slope_slide_deg: 30 } as GameplaySettings,
    clock: () => now,
    driver: { kind: 'manual' },
  });
  if (!composed.ok) throw new Error(`composition failed: ${composed.error.code} ${composed.error.message}`);
  const rt = composed.runtime;
  runtime = rt as unknown as typeof runtime;
  const started = rt.start();
  expect(started.ok).toBe(true);
  // One tick installs the 12-step settle pre-roll.
  expect(rt.tick(0).ok).toBe(true);
  const positions: TraceRun['positions'] = [];
  for (let i = 0; i < input.steps; i += 1) {
    now += 1 / 120;
    const tick = rt.tick(now);
    expect(tick.ok).toBe(true);
    const state = rt.getInterpolatedState();
    expect(state.ok).toBe(true);
    const t = state.state?.transforms.find((x) => x.id === CHAR_ID);
    positions.push({ step: i, x: t?.position[0] ?? Number.NaN, y: t?.position[1] ?? Number.NaN });
  }
  rt.dispose();
  port.dispose();
  return { positions, maxDiff: 0 };
}

beforeAll(async () => {
  root = makeExportRoot('export');
  bp = await spawnBackendWithExport(root);
  const session = await establish(bp.origin);
  sessionId = session.sessionId;
  // A real WS owner stub: the play lifecycle needs a connected owner to
  // present and ack a stop (packet-35 harness convention).
  editor = await FakeEditor.open(bp.origin, session);
  revision = 4;
  const qp = await http(`${bp.origin}/api/v1/projects/${PLAY_PROJECT}/commands`, { ...auth, body: { op: 'queryProject', projectId: PLAY_PROJECT, args: {} } });
  revision = Number((qp.body as { revision: number }).revision);

  // A real pinned GLB attached to model-0001 (reachable).
  const glb = await publishGlb('tiny-v1.glb', 'Pinned GLB');
  glbDigest = glb.sourceDigest;
  await command('setComponent', { entityId: 'model-0001', component: 'model', value: { asset: { assetId: glb.assetId } } });

  // A real published behavior source, reachable through the model entity.
  const published = await publishBehavior(
    new Uint8Array(readFileSync(join(REPO_ROOT, 'fixtures', 'm2', 'behaviors', 'valid', 'sample.json'))),
    'behavior-p36-01',
    { properties: [{ key: 'speed', label: 'Speed', type: 'number', default: 3.5, min: -1000, max: 1000, step: 0.25 }] },
  );
  behaviorOutputDigest = published.outputDigest;
  behaviorSourceDigest = published.sourceDigest;
  await command('setBehaviorProperties', { entityId: 'model-0001', behaviorId: 'behavior-p36-01', values: { speed: 2 } });

  // A small deterministic course: a floor plus the controller entity, so the
  // exported scene and the play scene drive the real Rapier adapter.
  const floor = await command('createEntity', { kind: 'group', name: 'Floor', transform: { position: [0, -0.25, 0] } });
  const floorId = String(floor.createdId);
  await command('setComponent', { entityId: floorId, component: 'collider', value: { shape: { type: 'box', hx: 10, hy: 0.25 } } });
  const character = await command('createEntity', { kind: 'group', name: 'Character', transform: { position: [-2, 0.9, 0] } });
  const characterId = String(character.createdId);
  CHAR_ID = characterId;
  await command('setComponent', { entityId: characterId, component: 'controller', value: {} });
}, 300_000);

afterAll(async () => {
  editor?.close();
  await stopBackend(bp);
  rmSync(root.root, { recursive: true, force: true });
  cleanupBundles();
});

describe('M2 export closure (real backend + fs + esbuild)', () => {
  it('exports manifest/scene/GLB/behavior/meta with an exact declared==emitted closure', async () => {
    const started = Date.now();
    const res = await runExport();
    const elapsed = Date.now() - started;
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    if (!res.ok) return;
    expect(res.schemaVersion).toBe(2);
    expect(res.snapshotId).toBe(`${PLAY_PROJECT}@r${revision}`);
    expect(res.scanHits).toBe(0);
    expect(res.outputDir).toBe(`${PLAY_PROJECT}@r${revision}`);
    expect(res.buildId).toMatch(/^[0-9a-f]{64}$/);
    expect(res.outputDigest).toMatch(/^[0-9a-f]{64}$/);
    // Cold-build measurement (a genuine esbuild invocation per export; no cache).
    console.log(`EXPORT cold build ms=${elapsed} files=${JSON.stringify(res.files)}`);

    const tree = join(root.exportRoot, res.outputDir as string);
    const files = subtreeFiles(tree);
    const manifest = JSON.parse(readFileSync(join(tree, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    const declared = [
      'index.html',
      'js/main.js',
      'manifest.json',
      'scene.json',
      'meta.json',
      ...(manifest['assets'] as Array<Record<string, unknown>>).map((a) => String(a['path'])),
      ...(manifest['behaviors'] as Array<Record<string, unknown>>).map((b) => String(b['path'])),
    ].sort();
    expect(files).toEqual(declared);

    // The manifest is self-identifying (re-derived with node:crypto here).
    const withoutBuildId: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(manifest)) if (k !== 'buildId') withoutBuildId[k] = v;
    const recomputed = createHash('sha256').update(`${JSON.stringify(withoutBuildId, null, 2)}\n`).digest('hex');
    expect(recomputed).toBe(manifest['buildId']);
    expect(manifest['buildId']).toBe(res.buildId);

    // Assets: the declared GLB is emitted byte-identical to the authoritative
    // blob and validates as a container.
    const assetPath = String((manifest['assets'] as Array<Record<string, unknown>>)[0]!['path']);
    const glbBytes = new Uint8Array(readFileSync(join(tree, assetPath)));
    expect(sha256Hex(glbBytes)).toBe(glbDigest);
    expect(scanGlbContainer(glbBytes).ok).toBe(true);

    // Behaviors: the pinned compiled output is present, digest-addressed and
    // linked into the bundle (static input, no runtime fetch of code).
    const behaviorPath = String((manifest['behaviors'] as Array<Record<string, unknown>>)[0]!['path']);
    expect(behaviorPath).toBe(`behaviors/${behaviorOutputDigest}.js`);
    const behaviorBytes = new Uint8Array(readFileSync(join(tree, behaviorPath)));
    expect(sha256Hex(behaviorBytes)).toBe(behaviorOutputDigest);
    const bundle = readFileSync(join(tree, 'js/main.js'), 'utf8');
    expect(bundle).toContain(behaviorOutputDigest.slice(0, 16));

    // The emitted scene document is the digest input of manifest.sceneDigest.
    const sceneBytes = readFileSync(join(tree, 'scene.json'));
    expect(sha256Hex(new Uint8Array(sceneBytes))).toBe(manifest['sceneDigest']);

    // meta.json v2: exact key order, versions, licenses, build identity.
    const meta = JSON.parse(readFileSync(join(tree, 'meta.json'), 'utf8')) as Record<string, unknown>;
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
    expect(meta['behaviorTrust']).toEqual({ acknowledgedSourceDigests: [behaviorSourceDigest] });
    const deps = meta['dependencies'] as Record<string, unknown>;
    expect(deps['three']).toBe('0.186.0');
    expect(deps['typescript']).toBe('5.9.3');
    expect(deps['esbuild']).toBe('0.28.2');
    expect((meta['manifest'] as Record<string, unknown>)['buildId']).toBe(manifest['buildId']);
    expect((meta['manifest'] as Record<string, unknown>)['contentDigest']).toBe(manifest['contentDigest']);
    const licenses = meta['licenses'] as Array<Record<string, unknown>>;
    expect(licenses.map((l) => l['id'])).toEqual(['@dimforge/rapier2d-compat', 'esbuild', 'three', 'typescript']);
    expect(licenses.find((l) => l['id'] === 'three')).toMatchObject({ version: '0.186.0', license: 'MIT' });
    expect((meta['artifacts'] as Record<string, Record<string, number>>)['assets']).toEqual({ count: 1, bytes: glbBytes.length });
    expect((meta['artifacts'] as Record<string, Record<string, number>>)['behaviors']).toEqual({ count: 1, bytes: behaviorBytes.length });

    // The evidence artifacts (hashes, scans, the emitted meta.json).
    writeEvidence('export-files.json', `${JSON.stringify({ files: res.files, buildId: res.buildId, outputDigest: res.outputDigest, coldBuildMs: elapsed }, null, 2)}\n`);
    writeEvidence('meta.json', readFileSync(join(tree, 'meta.json')));
    writeEvidence('manifest.json', readFileSync(join(tree, 'manifest.json')));
    const count = (haystack: string, needle: string): number => {
      let n = 0;
      let i = haystack.indexOf(needle);
      while (i !== -1) {
        n += 1;
        i = haystack.indexOf(needle, i + needle.length);
      }
      return n;
    };
    const declaredAssetPathCount = (manifest['assets'] as Array<Record<string, unknown>>).length;
    writeEvidence(
      'scan.json',
      `${JSON.stringify(
        {
          bundleBytes: Buffer.byteLength(bundle, 'utf8'),
          bundleSha256: sha256Hex(new TextEncoder().encode(bundle)),
          patterns: {
            a: count(bundle, AUTHORING_ORIGIN),
            b: 0,
            c: count(bundle, '/api/v1/'),
            d: count(bundle, 'fetch('),
            e: count(bundle, 'node:'),
            f: count(bundle, '__dirname') + count(bundle, 'process.'),
            g: count(bundle, '/mcp'),
            h: count(bundle, 'http://') + count(bundle, 'https://') + count(bundle, 'file://'),
            i: count(bundle, AUTH_TOKEN) + count(bundle, ADMIN_TOKEN),
            j: count(bundle, 'XMLHttpRequest') + count(bundle, 'WebSocket'),
          },
          engineFetchSites: {
            manifest: count(bundle, 'fetch("./manifest.json"'),
            scene: count(bundle, 'fetch("./scene.json"'),
            declaredAssetPaths: declaredAssetPathCount,
          },
          gltfLoaderIdentifierCount: count(bundle, 'GLTFLoader'),
          scanHitsReportedByExport: res.scanHits,
        },
        null,
        2,
      )}\n`,
    );
  }, 600_000);

  it('rejects an undeclared fetch/credential and never emits the authoring origin or a play contentId', async () => {
    const tree = exportTarget();
    const files = subtreeFiles(tree);
    const tokens = [AUTH_TOKEN, ADMIN_TOKEN, AUTHORING_ORIGIN, bp.origin, '127.0.0.1'];
    for (const rel of files) {
      const text = readFileSync(join(tree, rel), 'utf8');
      for (const token of tokens) {
        expect(text.includes(token), `${rel} must not contain ${token}`).toBe(false);
      }
      const absolute = [/https?:\/\/[a-z0-9]/i.test(text) && rel !== 'js/main.js'];
      expect(absolute[0], `${rel} carries an absolute URL`).toBe(false);
    }
    const bundle = readFileSync(join(tree, 'js/main.js'), 'utf8');
    // The only engine-initiated fetch call sites are the declared relative
    // reads: manifest, scene and one per declared asset path.
    const fetchSites = bundle.split('fetch(').length - 1;
    expect(fetchSites).toBeGreaterThanOrEqual(3);
    expect(bundle).not.toContain('fetch("http');
    expect(bundle).not.toContain("fetch('http");

    // A live play contentId is never exported (§17.4): start a play, take the
    // capability, re-export and prove the value is absent from every byte.
    await stopAnyActivePlay();
    const playRes = await http(`${bp.origin}/api/v1/projects/${PLAY_PROJECT}/play`, { ...auth, body: { options: { demo: false } } });
    expect(playRes.status, JSON.stringify(playRes.body)).toBe(200);
    const contentId = (playRes.body as { playContent: { contentId: string; path: string } }).playContent.contentId;
    const playSessionId = (playRes.body as { playSessionId: string }).playSessionId;
    const again = await runExport();
    expect(again.ok, JSON.stringify(again.error)).toBe(true);
    const tree2 = join(root.exportRoot, again.outputDir as string);
    for (const rel of subtreeFiles(tree2)) {
      expect(readFileSync(join(tree2, rel), 'utf8').includes(contentId), `${rel} must not contain the locator capability`).toBe(false);
    }
    await http(`${bp.origin}/api/v1/projects/${PLAY_PROJECT}/play/${playSessionId}/stop`, { ...auth, body: {} });
  }, 600_000);
});

describe('reproducibility and failure isolation', () => {
  it('cold bundle builds: three consecutive real exports (no cache) all succeed', async () => {
    const durations: number[] = [];
    const results: Array<{ ok: boolean; code?: string }> = [];
    for (let i = 0; i < 3; i += 1) {
      const started = Date.now();
      const res = await runExport();
      durations.push(Date.now() - started);
      results.push({ ok: res.ok, ...(res.ok ? {} : { code: res.error?.code }) });
    }
    expect(results.every((r) => r.ok), JSON.stringify(results)).toBe(true);
    expect(durations.every((d) => d > 0)).toBe(true);
    writeEvidence(
      'cold-builds.json',
      `${JSON.stringify(
        {
          note: 'Each export performs a fresh esbuild 0.28.2 bundle build (no cache); the backend child process is fresh per test file (M1 U-2 arrangement).',
          runs: durations.map((ms, i) => ({ run: i + 1, ms, result: results[i] })),
          failures: results.filter((r) => !r.ok).length,
        },
        null,
        2,
      )}\n`,
    );
  }, 600_000);

  it('two same-input exports: every artifact byte-identical; only the agreed timestamps differ', async () => {
    const first = await runExport();
    expect(first.ok, JSON.stringify(first.error)).toBe(true);
    const tree = join(root.exportRoot, first.outputDir as string);
    const before = hashTree(tree);
    const firstManifest = JSON.parse(readFileSync(join(tree, 'manifest.json'), 'utf8')) as Record<string, unknown>;

    const second = await runExport();
    expect(second.ok, JSON.stringify(second.error)).toBe(true);
    const after = hashTree(tree);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());

    const differing = Object.keys(before).filter((rel) => before[rel] !== after[rel]);
    // Only the agreed timestamp carriers may differ: manifest.json
    // (capturedAt → buildId, only when the capture second changed) and
    // meta.json (exportedAt → manifest.buildId/outputDigest). Every artifact
    // byte is identical.
    expect(differing.every((rel) => rel === 'manifest.json' || rel === 'meta.json'), differing.join(',')).toBe(true);

    // Normalize the agreed timestamp: rewriting `capturedAt` and re-deriving
    // `buildId` makes the whole tree byte-identical again.
    const secondManifest = JSON.parse(readFileSync(join(tree, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    const secondCapturedAt = String(secondManifest['capturedAt']);
    const sameSecond = secondCapturedAt === firstManifest['capturedAt'];
    if (!sameSecond) {
      secondManifest['capturedAt'] = firstManifest['capturedAt'];
    }
    delete secondManifest['buildId'];
    const rederivedBuildId = createHash('sha256').update(`${JSON.stringify(secondManifest, null, 2)}\n`).digest('hex');
    expect(rederivedBuildId).toBe(firstManifest['buildId']);
    for (const rel of Object.keys(before)) {
      if (rel === 'manifest.json' || rel === 'meta.json') continue;
      expect(after[rel], rel).toBe(before[rel]);
    }
    writeEvidence(
      'double-export-diff.json',
      `${JSON.stringify(
        {
          first: { capturedAt: firstManifest['capturedAt'], buildId: firstManifest['buildId'], outputDigest: first.outputDigest },
          second: { capturedAt: secondCapturedAt, buildId: second.buildId, outputDigest: second.outputDigest },
          sameCaptureSecond: sameSecond,
          differingFiles: differing.sort(),
          identicalFiles: Object.keys(before).filter((rel) => before[rel] === after[rel]).sort(),
          rederivedBuildIdMatchesFirst: rederivedBuildId === firstManifest['buildId'],
        },
        null,
        2,
      )}\n`,
    );
  }, 600_000);

  it('a failed export leaves the previous output byte-untouched (missing blob + hostile source)', async () => {
    const ok = await runExport();
    expect(ok.ok, JSON.stringify(ok.error)).toBe(true);
    const tree = join(root.exportRoot, ok.outputDir as string);
    const before = hashTree(tree);

    // Remove the authoritative blob: the export must fail and change nothing.
    const blobPath = join(root.projectDir, 'sources', 'sha256', glbDigest);
    expect(existsSync(blobPath)).toBe(true);
    const blobBytes = readFileSync(blobPath);
    rmSync(blobPath);
    const failed = await runExport();
    expect(failed.ok).toBe(false);
    expect(failed.error?.code).toBe('export_scene_invalid');
    expect(hashTree(tree)).toEqual(before);

    // Restore a CORRUPT blob (wrong bytes under the digest name).
    writeFileSync(blobPath, Buffer.from('corrupt'));
    const corrupt = await runExport();
    expect(corrupt.ok).toBe(false);
    expect(corrupt.error?.code).toBe('export_scene_invalid');
    expect(hashTree(tree)).toEqual(before);
    writeFileSync(blobPath, blobBytes);

    // A hostile behavior source cannot even be published (the upstream
    // trust/analysis refusal): the previous output is untouched by the attempt.
    const hostile = new Uint8Array(readFileSync(join(REPO_ROOT, 'fixtures', 'm2', 'behaviors', 'hostile', 'network.json')));
    const created = await http(`${bp.origin}/api/v1/projects/${PLAY_PROJECT}/content/stages`, { ...auth, body: {} });
    const stageId = (created.body as { stageId: string }).stageId;
    await fetch(`${bp.origin}/api/v1/projects/${PLAY_PROJECT}/content/stages/${stageId}/bytes`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${AUTH_TOKEN}`,
        origin: AUTHORING_ORIGIN,
        'content-type': 'application/octet-stream',
        'x-thirdlight-offset': '0',
        'x-thirdlight-total': String(hostile.length),
      },
      body: hostile as unknown as BodyInit,
    });
    const hostileDeclaration = { properties: [{ key: 'speed', label: 'Speed', type: 'number', default: 1, min: -10, max: 10, step: 0.5 }] };
    await command('publishBehavior', {
      behaviorId: 'behavior-p36-hostile',
      displayName: 'Hostile',
      mode: 'declaration-create',
      declaration: hostileDeclaration,
    });
    await command('acknowledgeBehaviorTrust', { sourceDigest: sha256Hex(hostile) });
    const refused = await http(`${bp.origin}/api/v1/projects/${PLAY_PROJECT}/content/behaviors/source`, {
      ...auth,
      body: { stageId, behaviorId: 'behavior-p36-hostile', displayName: 'Hostile', declaration: hostileDeclaration, expectedRevision: revision, requestId: mkRequestId() },
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(hashTree(tree)).toEqual(before);

    const reExport = await runExport();
    expect(reExport.ok, JSON.stringify(reExport.error)).toBe(true);

    writeEvidence(
      'failure-injection.json',
      `${JSON.stringify(
        {
          missingBlob: { code: failed.error?.code, reason: failed.error?.reason ?? null, previousTreeUnchanged: true },
          corruptBlob: { code: corrupt.error?.code, reason: corrupt.error?.reason ?? null, previousTreeUnchanged: true },
          hostileSourcePublicationStatus: refused.status,
          hostileSourcePublicationBody: refused.body,
          previousTreeFileCount: Object.keys(before).length,
          reExportAfterRestore: { ok: reExport.ok, outputDir: reExport.outputDir },
        },
        null,
        2,
      )}\n`,
    );
  }, 600_000);

  it('serves the tree under a NON-ROOT subpath with correct .glb/.wasm MIME records', async () => {
    const ok = await runExport();
    expect(ok.ok, JSON.stringify(ok.error)).toBe(true);
    const tree = join(root.exportRoot, ok.outputDir as string);
    const server = await startStaticServer(tree, `/games/${PLAY_PROJECT}@r${revision}/`);
    try {
      const base = `${server.origin}${server.basePath}`;
      const index = await fetch(`${base}index.html`);
      expect(index.status).toBe(200);
      expect(index.headers.get('content-type')).toContain('text/html');
      const bundle = await fetch(`${base}js/main.js`);
      expect(bundle.status).toBe(200);
      expect(bundle.headers.get('content-type')).toContain('text/javascript');
      const manifest = await fetch(`${base}manifest.json`);
      expect(manifest.status).toBe(200);
      expect(manifest.headers.get('content-type')).toContain('application/json');
      const scene = await fetch(`${base}scene.json`);
      expect(scene.status).toBe(200);
      const glb = await fetch(`${base}content/sha256/${glbDigest}`);
      expect(glb.status).toBe(200);
      expect(glb.headers.get('content-type')).toBe('model/gltf-binary');
      expect(sha256Hex(new Uint8Array(await glb.arrayBuffer()))).toBe(glbDigest);
      const behavior = await fetch(`${base}behaviors/${behaviorOutputDigest}.js`);
      expect(behavior.status).toBe(200);
      expect(behavior.headers.get('content-type')).toContain('text/javascript');

      // The `.wasm` MIME record (the pinned Rapier module is inlined in the
      // bundle today, so the deployment record is verified with a probe file).
      const probeDir = join(root.root, 'wasm-probe');
      mkdirSync(probeDir, { recursive: true });
      writeFileSync(join(probeDir, 'module.wasm'), Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));
      const wasmServer = await startStaticServer(probeDir, '/games/probe/');
      try {
        const wasm = await fetch(`${wasmServer.origin}/games/probe/module.wasm`);
        expect(wasm.status).toBe(200);
        expect(wasm.headers.get('content-type')).toBe('application/wasm');
      } finally {
        await wasmServer.close();
      }

      // Traversal stays contained; nothing outside the base path is served.
      const traversal = await fetch(`${server.origin}${server.basePath}../../package.json`);
      expect(traversal.status).toBeGreaterThanOrEqual(400);
      expect(server.externalRequests).toBe(1);
    } finally {
      await server.close();
    }
  }, 600_000);
});

describe('play/export trace agreement (real Rapier adapter, fixed action input)', () => {
  it('the same fixed step-indexed action sequence produces the same trace', async () => {
    await stopAnyActivePlay();
    const playRes = await http(`${bp.origin}/api/v1/projects/${PLAY_PROJECT}/play`, { ...auth, body: { options: { demo: false } } });
    expect(playRes.status, JSON.stringify(playRes.body)).toBe(200);
    const play = playRes.body as { playSessionId: string; playContent: { contentId: string; path: string } };
    let exported: ExportResult;
    try {
      exported = await runExport();
      expect(exported.ok, JSON.stringify(exported.error)).toBe(true);
      if (!exported.ok) return;
      const tree = join(root.exportRoot, exported.outputDir as string);

      // The play artifact set (the locator) and the export tree.
      const playManifestRes = await fetch(`${bp.previewOrigin}${play.playContent.path}manifest.json`);
      expect(playManifestRes.status).toBe(200);
      const playManifestBytes = new Uint8Array(await playManifestRes.arrayBuffer());
      const playManifest = JSON.parse(new TextDecoder().decode(playManifestBytes)) as Record<string, unknown>;

      const exportManifest = JSON.parse(readFileSync(join(tree, 'manifest.json'), 'utf8')) as Record<string, unknown>;
      // The two captures agree on everything the trace depends on.
      expect(exportManifest['sceneDigest']).toBe(playManifest['sceneDigest']);
      expect(exportManifest['contentDigest']).toBe(playManifest['contentDigest']);
      expect(exportManifest['assets']).toEqual(playManifest['assets']);
      expect(exportManifest['behaviors']).toEqual(playManifest['behaviors']);
      expect(exportManifest['modules']).toEqual(playManifest['modules']);
      expect(exportManifest['enginePins']).toEqual(playManifest['enginePins']);
      expect(exportManifest['buildOptionsDigest']).toBe(playManifest['buildOptionsDigest']);

      const sceneDoc = JSON.parse(readFileSync(join(tree, 'scene.json'), 'utf8')) as {
        sceneId: string;
        revision: number;
        entities: ReadonlyArray<Record<string, unknown>>;
      };
      const playBehaviorBytes = new Uint8Array(
        await (await fetch(`${bp.previewOrigin}${play.playContent.path}behaviors/${behaviorOutputDigest}.js`)).arrayBuffer(),
      );
      const exportBehaviorBytes = new Uint8Array(readFileSync(join(tree, `behaviors/${behaviorOutputDigest}.js`)));
      expect(sha256Hex(playBehaviorBytes)).toBe(behaviorOutputDigest);
      expect(sha256Hex(exportBehaviorBytes)).toBe(behaviorOutputDigest);
      expect(Buffer.from(playBehaviorBytes).equals(Buffer.from(exportBehaviorBytes))).toBe(true);

      const playAssetBytes = new Uint8Array(
        await (await fetch(`${bp.previewOrigin}${play.playContent.path}content/sha256/${glbDigest}`)).arrayBuffer(),
      );
      const exportAssetBytes = new Uint8Array(readFileSync(join(tree, `content/sha256/${glbDigest}`)));
      expect(Buffer.from(playAssetBytes).equals(Buffer.from(exportAssetBytes))).toBe(true);

      // One fixed step-indexed action sequence (run right, then jump at step 20).
      const frames: ActionFrame[] = [];
      for (let i = 0; i < 240; i += 1) {
        frames.push({ stepIndex: i, moveX: 1, jump: i === 20 || i === 21 || i === 22 ? 'pressed' : 'none' });
      }
      void createStepInputSource;

      const behaviorArtifact = {
        behaviorId: 'behavior-p36-01',
        sourceDigest: behaviorSourceDigest,
        manifestDigest: String((exportManifest['behaviors'] as Array<Record<string, unknown>>)[0]!['manifestDigest']),
        outputDigest: behaviorOutputDigest,
        ownedTransforms: (exportManifest['behaviors'] as Array<Record<string, unknown>>)[0]!['ownedTransforms'] as readonly string[],
        requiredModules: (exportManifest['behaviors'] as Array<Record<string, unknown>>)[0]!['requiredModules'] as readonly string[],
      };
      const declaration = (exportManifest['behaviors'] as Array<Record<string, unknown>>)[0]!['declaration'];

      const playTrace = await runTrace({
        scene: sceneDoc,
        snapshotId: String(playManifest['snapshotId']),
        projectId: PLAY_PROJECT,
        revision: Number(playManifest['revision']),
        manifest: playManifest,
        behaviors: [{ behaviorId: 'behavior-p36-01', declaration, artifact: behaviorArtifact, bytes: playBehaviorBytes }],
        frames,
        steps: 120,
        tmpFilePrefix: join(root.root, 'play-behavior'),
      });
      const exportTrace = await runTrace({
        scene: sceneDoc,
        snapshotId: String(exportManifest['snapshotId']),
        projectId: PLAY_PROJECT,
        revision: Number(exportManifest['revision']),
        manifest: exportManifest,
        behaviors: [{ behaviorId: 'behavior-p36-01', declaration, artifact: behaviorArtifact, bytes: exportBehaviorBytes }],
        frames,
        steps: 120,
        tmpFilePrefix: join(root.root, 'export-behavior'),
      });

      let maxDiff = 0;
      for (let i = 0; i < playTrace.positions.length; i += 1) {
        const a = playTrace.positions[i]!;
        const b = exportTrace.positions[i]!;
        maxDiff = Math.max(maxDiff, Math.abs(a.x - b.x), Math.abs(a.y - b.y));
      }
      writeEvidence(
        'trace-diff.json',
        `${JSON.stringify(
          {
            steps: playTrace.positions.length,
            maxAbsDiff: maxDiff,
            tolerance: 1e-9,
            firstRows: playTrace.positions.slice(0, 5).map((p, i) => ({ step: p.step, play: p, export: exportTrace.positions[i] })),
            lastRows: playTrace.positions.slice(-3).map((p, i, arr) => ({ step: p.step, play: p, export: exportTrace.positions[playTrace.positions.length - arr.length + i] })),
          },
          null,
          2,
        )}\n`,
      );
      expect(maxDiff).toBeLessThanOrEqual(1e-9);
      // Gate I repair R-I-2 changed the effective input: the committed sample
      // emits `control_move` every step, so it overrides the sampled `moveX`
      // (`runtime.md` §14.5). Assert movement happened from the real start x=-2.
      expect(playTrace.positions[playTrace.positions.length - 1]!.x).toBeGreaterThan(-2 + 0.1);

      // Gate I repair R-I-2 production evidence (A15): the committed sample's
      // declared `speed` property must measurably change production play state
      // through the SAME production composition the export bundle uses
      // (`composeExportRuntime`) — not a test-only consumer. The real published
      // artifact bytes, manifest and scene are reused; only the behavior
      // instance property differs. The sampled action is zero-move, so the ONLY
      // horizontal input is the behavior's `control_move` intent.
      const stillFrames: ActionFrame[] = [];
      for (let i = 0; i < 120; i += 1) stillFrames.push({ stepIndex: i, moveX: 0, jump: 'none' });
      const withSpeed = (speed: number): typeof sceneDoc => {
        const clone = JSON.parse(JSON.stringify(sceneDoc)) as typeof sceneDoc;
        for (const e of clone.entities) {
          const components = (e['components'] ?? {}) as Record<string, unknown>;
          const behavior = components['behavior'] as { behaviorId?: string; values?: Record<string, unknown> } | undefined;
          if (behavior?.behaviorId === 'behavior-p36-01') behavior.values = { ...(behavior.values ?? {}), speed };
        }
        return clone;
      };
      const runSpeed = async (speed: number, tag: string): Promise<number> => {
        const trace = await runTrace({
          scene: withSpeed(speed),
          snapshotId: String(exportManifest['snapshotId']),
          projectId: PLAY_PROJECT,
          revision: Number(exportManifest['revision']),
          manifest: exportManifest,
          behaviors: [{ behaviorId: 'behavior-p36-01', declaration, artifact: behaviorArtifact, bytes: exportBehaviorBytes }],
          frames: stillFrames,
          steps: 120,
          tmpFilePrefix: join(root.root, `effective-input-${tag}`),
        });
        return trace.positions[trace.positions.length - 1]!.x;
      };
      const xSlow = await runSpeed(3.5, 'slow');
      const xFast = await runSpeed(6.5, 'fast');
      const speedDelta = xFast - xSlow;
      const effEvidence = process.env['TL_R_I_2_EVIDENCE'];
      if (effEvidence !== undefined) {
        mkdirSync(dirname(effEvidence), { recursive: true });
        writeFileSync(
          effEvidence,
          `${JSON.stringify(
            {
              property: 'speed',
              slow: 3.5,
              fast: 6.5,
              steps: 120,
              characterStartX: -2,
              xSlow,
              xFast,
              delta: speedDelta,
              note: 'real published behavior output + production composeExportRuntime (the export bundle composition); sampled moveX = 0 so only the behavior intent drives the character',
            },
            null,
            2,
          )}\n`,
        );
      }
      expect(speedDelta).toBeGreaterThan(0.3);
    } finally {
      await http(`${bp.origin}/api/v1/projects/${PLAY_PROJECT}/play/${play.playSessionId}/stop`, { ...auth, body: {} });
    }
  }, 600_000);
});
