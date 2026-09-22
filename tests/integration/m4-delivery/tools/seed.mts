/**
 * Packet 70 (70-A) — the disposable-workspace seeder for the both-production-
 * hosts evidence.
 *
 * Seeds ONE v3 project (`m470-0001`) whose scene is the committed packet-69
 * fixture scene (20 entities: the player `group-0001` = controller + model +
 * modelAnimation [courier], `model-0001` = a second animated courier
 * instance, `model-0002..0005` = static beacons, the course boxes/zones) and
 * whose content catalog carries the seven declared assets — the two
 * packet-69 GLB sources (the documented `sourceSubstitution` of the
 * defective template/sample `courier.glb` bytes, see the 69 fixture
 * `index.json`) and the five template WAV cues — with import recipes +
 * metrics derived by the REAL `@thirdlight/asset-pipeline` inspectors
 * (no hand-authored facts). The envelope is the accepted v3
 * `authoring-state` shape (envelope.ts §4.4: canonical key order, 2-space
 * indent, one trailing newline) and the blobs land at
 * `sources/sha256/<digest>` (workspace §13.5 digest-addressed reads).
 *
 * This is the same status as the packet-63 committed-envelope seed: a
 * deterministic, documented fixture workspace, verified loadable through the
 * public `openWorkspaceService.query(queryProject)`.
 *
 * Run: `npx tsx tests/integration/m4-delivery/tools/seed.mts <dataRoot>`
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectAudio, inspectGlb } from '@thirdlight/asset-pipeline';
import { openWorkspaceService } from '@thirdlight/workspace';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..', '..');

export const PROJECT_ID = 'm470-0001';
const SIXTY_NINE = join(ROOT, 'tests/integration/m4-render/fixtures');
const TEMPLATE_SOURCES = join(ROOT, 'fixtures/m4/templates/templates/platformer-starter/sources');

export interface SeededProject {
  projectId: string;
  sceneId: string;
  revision: number;
  assets: Array<{ assetId: string; kind: string; version: number; sourceDigest: string; sourceByteLength: number }>;
}

/** The seven declared assets (two packet-69 GLBs + five template WAV cues). */
const MODEL_SOURCES: Array<{ assetId: string; displayName: string; file: string }> = [
  { assetId: 'br-model-courier', displayName: 'Courier model', file: 'courier.glb' },
  { assetId: 'br-model-beacon', displayName: 'Beacon model', file: 'beacon.glb' },
];
const AUDIO_SOURCES: Array<{ assetId: string; displayName: string; file: string }> = [
  { assetId: 'br-audio-start', displayName: 'Cue: Start', file: 'cue-start.wav' },
  { assetId: 'br-audio-jump', displayName: 'Cue: Jump', file: 'cue-jump.wav' },
  { assetId: 'br-audio-checkpoint', displayName: 'Cue: Checkpoint', file: 'cue-checkpoint.wav' },
  { assetId: 'br-audio-death', displayName: 'Cue: Death', file: 'cue-death.wav' },
  { assetId: 'br-audio-goal', displayName: 'Cue: Goal', file: 'cue-goal.wav' },
];

function sha256Hex(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Seed the disposable workspace. Idempotent (re-seeds a fresh project dir). */
export function seedProject(dataRoot: string): SeededProject {
  const projDir = join(dataRoot, 'projects', PROJECT_ID);
  rmSync(projDir, { recursive: true, force: true });
  mkdirSync(join(projDir, 'scenes'), { recursive: true });
  mkdirSync(join(projDir, 'sources', 'sha256'), { recursive: true });

  const sceneDoc = JSON.parse(readFileSync(join(SIXTY_NINE, 'scene.json'), 'utf8')) as { sceneId: string; revision: number; entities: unknown[] };
  const indexDoc = JSON.parse(readFileSync(join(SIXTY_NINE, 'index.json'), 'utf8')) as {
    settings: Record<string, number>;
    game: Record<string, unknown>;
  };

  const assets: Array<{ assetId: string; kind: string; displayName: string; currentVersion: number; versions: unknown[]; file: string; isModel: boolean; sourceDigest: string; sourceByteLength: number }> = [];
  for (const m of MODEL_SOURCES) {
    const bytes = new Uint8Array(readFileSync(join(SIXTY_NINE, 'sources', m.file)));
    const proposal = inspectGlb(bytes, { profile: 'gltf-glb', recipeVersion: 1, toolchain: { three: '0.186.0' } });
    if (proposal.status !== 'ok' || proposal.metrics === undefined || proposal.kind !== 'model') {
      throw new Error(`inspectGlb rejected ${m.file}: ${proposal.status}`);
    }
    const digest = sha256Hex(bytes);
    writeFileSync(join(projDir, 'sources', 'sha256', digest), bytes);
    assets.push({
      assetId: m.assetId,
      kind: 'model',
      displayName: m.displayName,
      currentVersion: 1,
      versions: [
        {
          version: 1,
          sourceDigest: digest,
          sourceByteLength: proposal.sourceByteLength,
          importRecipe: proposal.importRecipe,
          metrics: proposal.metrics,
          importedAt: '2026-09-22T00:00:00Z',
          publishedRevision: 1,
        },
      ],
      file: m.file,
      isModel: true,
      sourceDigest: digest,
      sourceByteLength: proposal.sourceByteLength,
    });
  }
  for (const a of AUDIO_SOURCES) {
    const bytes = new Uint8Array(readFileSync(join(TEMPLATE_SOURCES, 'audio', a.file)));
    const proposal = inspectAudio(bytes, { profile: 'pcm-wav', recipeVersion: 1, toolchain: { 'asset-pipeline': '0.1.0' } });
    if (proposal.status !== 'ok' || proposal.metrics === undefined || proposal.kind !== 'audio') {
      throw new Error(`inspectAudio rejected ${a.file}: ${proposal.status}`);
    }
    const digest = sha256Hex(bytes);
    writeFileSync(join(projDir, 'sources', 'sha256', digest), bytes);
    assets.push({
      assetId: a.assetId,
      kind: 'audio',
      displayName: a.displayName,
      currentVersion: 1,
      versions: [
        {
          version: 1,
          sourceDigest: digest,
          sourceByteLength: proposal.sourceByteLength,
          importRecipe: proposal.importRecipe,
          metrics: proposal.metrics,
          importedAt: '2026-09-22T00:00:00Z',
          publishedRevision: 1,
        },
      ],
      file: a.file,
      isModel: false,
      sourceDigest: digest,
      sourceByteLength: proposal.sourceByteLength,
    });
  }

  const envelope = {
    storageVersion: 3,
    type: 'authoring-state',
    projectId: PROJECT_ID,
    scene: sceneDoc,
    content: {
      assets: assets.map((a) => ({
        assetId: a.assetId,
        kind: a.kind,
        displayName: a.displayName,
        currentVersion: a.currentVersion,
        versions: a.versions,
      })),
      prefabs: [],
      behaviors: [],
      settings: indexDoc.settings,
      behaviorTrust: { entries: [] },
      game: indexDoc.game,
    },
    retry: { retention: 128, records: [] },
  };
  writeFileSync(join(projDir, 'scenes', 'main.json'), JSON.stringify(envelope, null, 2) + '\n');
  writeFileSync(
    join(projDir, 'project.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        engineVersion: '0.1.0',
        id: PROJECT_ID,
        name: 'Packet 70 both hosts',
        createdAt: '2026-09-22T00:00:00Z',
        scenes: [{ id: sceneDoc.sceneId, path: 'scenes/main.json' }],
      },
      null,
      2,
    ) + '\n',
  );

  // Loadability gate: the public query must see the project (the accepted 63
  // seed pattern) + the normalized v3 scene must be readable.
  const service = openWorkspaceService({ root: dataRoot });
  const q = service.query({ op: 'queryProject', projectId: PROJECT_ID });
  if (!q.ok || typeof q.revision !== 'number') {
    throw new Error(`the seeded project is not loadable: ${JSON.stringify(q.ok ? { schemaVersion: q.scene?.schemaVersion } : (q as { error?: unknown }).error).slice(0, 300)}`);
  }
  const revision = q.revision;
  const v3 = service.readCapturedV3(PROJECT_ID);
  if (!v3.ok) {
    throw new Error(`the seeded project is not a loadable v3: ${JSON.stringify(v3.error).slice(0, 300)}`);
  }
  const capturedRevision = v3.read.revision;
  service.close();
  if (capturedRevision !== revision) {
    throw new Error(`revision mismatch: queryProject ${revision} vs readCapturedV3 ${capturedRevision}`);
  }

  return {
    projectId: PROJECT_ID,
    sceneId: q.scene.sceneId,
    revision,
    assets: assets.map((a) => ({ assetId: a.assetId, kind: a.kind, version: 1, sourceDigest: a.sourceDigest, sourceByteLength: a.sourceByteLength })),
  };
}

// Direct invocation: `npx tsx .../seed.mts <dataRoot>`.
if (process.argv[1] && resolve(process.argv[1]).startsWith(HERE)) {
  const dataRoot = process.argv[2];
  if (dataRoot === undefined) throw new Error('usage: seed.mts <dataRoot>');
  const seeded = seedProject(dataRoot);
  console.log(JSON.stringify(seeded, null, 2));
}