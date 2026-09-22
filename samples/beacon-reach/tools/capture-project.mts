/**
 * Beacon Reach — captured-sample authoring runner (packet 61).
 *
 * Authors the Beacon Reach playable layout through the REAL editing path —
 * the same `@thirdlight/commands` `applyMutation` the browser and MCP use —
 * applied to a fresh v3 scene document. It (1) publishes the self-generated
 * assets (five WAV cues + the courier/beacon GLBs) with their provenance
 * metrics, (2) authors the entities (ground, hazards, checkpoint, camera,
 * player, zones, lights, decoration model instances) in dependency order
 * (capturing each generated entity ID so references resolve), (3) sets the
 * game configuration + the default gameplay settings, and (4) captures the
 * resulting v3 envelope (scene + content) as the committed sample source
 * project.
 *
 * It does NOT write an active envelope directly: the captured project is the
 * RESULT of applying the recorded command recipe (`recipe/commands.json`),
 * which is reproducible by re-running this script (the scene + content
 * digests are stable for the same recipe + assets).
 *
 * Run: `npx tsx samples/beacon-reach/tools/capture-project.mts`.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMutation, createCommandState } from '@thirdlight/commands';
import type { CommandState, MutationSuccess } from '@thirdlight/commands';
import type { SceneV3 } from '@thirdlight/project-model';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE_ROOT = dirname(HERE);
const ASSETS = join(SAMPLE_ROOT, 'assets');
const PROJECT_ID = 'beacon-reach';
const IMPORTED_AT = '2026-09-21T00:00:00Z';

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/* ------------------------------------------------------------- assets --- */

interface PcmWavMetrics {
  container: 'riff-wave';
  encoding: 'pcm-s16le';
  channels: 1;
  sampleRate: 48000;
  bitsPerSample: 16;
  frames: number;
  durationMs: number;
  pcmBytes: number;
  dataChunkBytes: number;
  riffChunkBytes: number;
}

function wavMetrics(path: string): PcmWavMetrics {
  const b = readFileSync(join(ASSETS, path));
  const pcmBytes = b.length - 44;
  const frames = pcmBytes / 2;
  return {
    container: 'riff-wave',
    encoding: 'pcm-s16le',
    channels: 1,
    sampleRate: 48000,
    bitsPerSample: 16,
    frames,
    durationMs: Math.floor(frames / 48),
    pcmBytes,
    dataChunkBytes: pcmBytes,
    riffChunkBytes: 36 + pcmBytes,
  };
}

function glbMetrics(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLen = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLen)));
  let vertices = 0;
  let triangles = 0;
  const accessors: Array<Record<string, unknown>> = json.accessors ?? [];
  const primitivePositionAcc = new Set<number>();
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      const posAcc = prim.attributes?.POSITION;
      if (typeof posAcc === 'number') primitivePositionAcc.add(posAcc);
      if (typeof prim.indices === 'number') {
        const idxAcc = accessors[prim.indices];
        if (idxAcc && typeof idxAcc.count === 'number') triangles += Math.round(idxAcc.count / 3);
      }
    }
  }
  for (const [i, acc] of accessors.entries()) {
    if (primitivePositionAcc.has(i) && typeof acc.count === 'number') vertices += acc.count;
  }
  const animations: Array<Record<string, unknown>> = json.animations ?? [];
  let animationChannels = 0;
  for (const a of animations) animationChannels += (a.channels as unknown[]).length;
  const binOffset = 20 + Math.ceil(jsonLen / 4) * 4 + 8;
  return {
    nodes: (json.nodes ?? []).length,
    meshes: (json.meshes ?? []).length,
    primitives: (json.meshes ?? []).reduce((n: number, m: Record<string, unknown>) => n + ((m.primitives as unknown[]).length), 0),
    materials: (json.materials ?? []).length,
    images: (json.images ?? []).length,
    textures: (json.textures ?? []).length,
    vertices,
    triangles,
    animations: animations.length,
    animationChannels,
    clipDurationMs: 0,
    decodedGeometryBytes: bytes.length - binOffset,
    decodedImageBytes: 0,
  };
}

interface AuthorState {
  state: CommandState;
  counter: number;
  applied: Array<Record<string, unknown>>;
}

function runCommand(
  author: AuthorState,
  op: string,
  args: Record<string, unknown>,
): MutationSuccess {
  author.counter += 1;
  const scene = author.state.scene as unknown as { revision: number };
  const request = {
    op,
    projectId: PROJECT_ID,
    expectedRevision: scene.revision,
    requestId: `req-${author.counter.toString(16).padStart(32, '0')}`,
    args,
  };
  const outcome = applyMutation(author.state, request);
  if (!outcome.ok) {
    console.error(`FAILED at ${op} (revision ${scene.revision}):`, JSON.stringify(outcome.result, null, 2));
    process.exit(1);
  }
  author.state = outcome.state;
  author.applied.push({ op, args, appliedRevision: scene.revision + 1 });
  return outcome.result;
}

/* -------------------------------------------------------------- main --- */

const T = (x: number, y: number): Record<string, unknown> => ({
  position: [x, y, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
});

function main() {
  // Fresh v3 content (the v3 envelope's content always carries `game`).
  // Fresh v3 content (the v3 envelope's content always carries `game`). The
  // baseline scene is the workspace's NEW v3 project (the reviewed operator
  // path): it carries the single default camera, which the v3 scene validator
  // requires (exactly one camera). The recipe then authors the rest of the
  // layout via commands — it does not write the active envelope directly.
  const CAMERA_ENTITY = {
    id: 'br-cam-main',
    name: 'Gameplay camera',
    components: {
      // z is the fixed view depth (CAMERA_Z = 12, gameplay.md §7.1): the
      // camera sits 12 m in front of the z=0 scene plane looking down −Z at
      // it. The cameraFollow writes only position.x/y; position.z is never
      // written. (Authored at z=0 the camera is *in* the plane and sees void.)
      transform: { position: [0, 4, 12], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      camera: { type: 'perspective', fovY: 45, near: 0.1, far: 100 },
      cameraFollow: { deadZone: { x: 0.5, y: 0.5 }, smoothing: 0.2, bounds: { minX: 0, maxX: 48, minY: 0, maxY: 8 } },
    },
  };
  const author: AuthorState = {
    state: createCommandState(
      { schemaVersion: 3, sceneId: 'scene-main', revision: 0, entities: [CAMERA_ENTITY] } as unknown as SceneV3,
      { assets: [], prefabs: [], behaviors: [], settings: {}, behaviorTrust: { entries: [] }, game: null } as never,
    ),
    counter: 0,
    applied: [],
  };
  const camId = 'br-cam-main'; // the baseline's default camera (not created by a command)

  // (1) Publish the self-generated assets.
  for (const cue of ['start', 'jump', 'checkpoint', 'death', 'goal'] as const) {
    const path = `audio/cue-${cue}.wav`;
    const bytes = new Uint8Array(readFileSync(join(ASSETS, path)));
    runCommand(author, 'publishAsset', {
      mode: 'create',
      assetId: `br-audio-${cue}`,
      kind: 'audio',
      displayName: `Cue ${cue[0]!.toUpperCase()}${cue.slice(1)}`,
      sourceDigest: sha256Hex(bytes),
      sourceByteLength: bytes.byteLength,
      importRecipe: { profile: 'pcm-wav', recipeVersion: 1, toolchain: { 'asset-pipeline': '0.1.0' } },
      metrics: wavMetrics(path),
      importedAt: IMPORTED_AT,
    });
  }
  for (const [id, path] of [
    ['br-model-courier', 'model/courier.glb'],
    ['br-model-beacon', 'model/beacon.glb'],
  ] as const) {
    const bytes = new Uint8Array(readFileSync(join(ASSETS, path)));
    const metrics = glbMetrics(bytes);
    const result = runCommand(author, 'publishAsset', {
      mode: 'create',
      assetId: id,
      kind: 'model',
      displayName: id === 'br-model-courier' ? 'Courier' : 'Beacon pillar',
      sourceDigest: sha256Hex(bytes),
      sourceByteLength: bytes.byteLength,
      importRecipe: { profile: 'gltf-glb', recipeVersion: 1, toolchain: { three: '0.186.0' }, extensions: [] },
      metrics,
      importedAt: IMPORTED_AT,
    });
    void result;
  }

  // (2) Author the entities in dependency order, capturing the generated IDs.
  // (The camera is the baseline default — not created by a command.)

  runCommand(author, 'createEntity', {
    kind: 'box',
    name: 'Start ground',
    transform: T(8, -0.2),
    box: { size: [16, 0.4, 1], material: { color: '#6f6f6f' } },
    components: { collider: { shape: { type: 'box', hx: 8, hy: 0.2 } } },
  });
  runCommand(author, 'createEntity', {
    kind: 'box',
    name: 'Low step',
    transform: T(6.5, 0.1),
    box: { size: [1, 0.4, 1], material: { color: '#7d7d7d' } },
    components: { collider: { shape: { type: 'box', hx: 0.5, hy: 0.2 } } },
  });
  runCommand(author, 'createEntity', {
    kind: 'box',
    name: 'First hazard',
    transform: T(10.9, 0.125),
    box: { size: [0.8, 0.25, 1], material: { color: '#b03030' } },
    components: { gameZone: { role: 'hazard', size: [0.8, 0.25] } },
  });
  runCommand(author, 'createEntity', {
    kind: 'box',
    name: 'Middle ground',
    transform: T(24.75, -0.2),
    box: { size: [14.5, 0.4, 1], material: { color: '#6f6f6f' } },
    components: { collider: { shape: { type: 'box', hx: 7.25, hy: 0.2 } } },
  });
  // Checkpoint safe spawn (created BEFORE the checkpoint zone so the zone can
  // reference it).
  const cpSpawn = runCommand(author, 'createEntity', {
    kind: 'group',
    name: 'Checkpoint spawn',
    transform: T(24, 0.91),
    components: { playerSpawn: {} },
  });
  const cpSpawnId = cpSpawn.createdId!;
  runCommand(author, 'createEntity', {
    kind: 'box',
    name: 'Checkpoint',
    transform: T(22, 1),
    box: { size: [1.5, 2, 1], material: { color: '#3fae6a' } },
    components: {
      gameZone: {
        role: 'checkpoint',
        size: [1.5, 2],
        safeSpawnId: cpSpawnId,
        activation: { emissive: '#1bc8ff', emissiveIntensity: 1.2, cueAssetId: null },
      },
    },
  });
  runCommand(author, 'createEntity', {
    kind: 'box',
    name: 'Second hazard',
    transform: T(28.4, 0.125),
    box: { size: [0.8, 0.25, 1], material: { color: '#b03030' } },
    components: { gameZone: { role: 'hazard', size: [0.8, 0.25] } },
  });
  runCommand(author, 'createEntity', {
    kind: 'box',
    name: 'Final ground',
    transform: T(40.75, -0.2),
    box: { size: [14.5, 0.4, 1], material: { color: '#6f6f6f' } },
    components: { collider: { shape: { type: 'box', hx: 7.25, hy: 0.2 } } },
  });
  runCommand(author, 'createEntity', {
    kind: 'box',
    name: 'Final step',
    transform: T(36.5, 0.1),
    box: { size: [1, 0.4, 1], material: { color: '#7d7d7d' } },
    components: { collider: { shape: { type: 'box', hx: 0.5, hy: 0.2 } } },
  });
  runCommand(author, 'createEntity', {
    kind: 'box',
    name: 'Beacon',
    transform: T(44.5, 1),
    box: { size: [1, 2, 1], material: { color: '#2f7fd4' } },
    components: { gameZone: { role: 'goal', size: [1, 2] } },
  });
  // The player: the controller capsule rendered as the animated courier.
  const player = runCommand(author, 'createEntity', {
    kind: 'model',
    name: 'Player',
    transform: T(3, 0.91),
    model: { asset: { assetId: 'br-model-courier' } },
    components: {
      controller: {},
      modelAnimation: {
        assetId: 'br-model-courier',
        version: 1,
        roles: {
          idle: { clipIndex: 0, clipName: 'Idle' },
          run: { clipIndex: 1, clipName: 'Run' },
          airborne: { clipIndex: 2, clipName: 'Airborne' },
        },
      },
    },
  });
  const playerId = player.createdId!;
  const startSpawn = runCommand(author, 'createEntity', {
    kind: 'group',
    name: 'Start spawn',
    transform: T(3, 0.91),
    components: { playerSpawn: {} },
  });
  const spawnId = startSpawn.createdId!;
  runCommand(author, 'createEntity', {
    kind: 'group',
    name: 'Key light',
    transform: T(24, 10),
    components: { light: { type: 'directional', color: '#fff4e0', intensity: 1.6, direction: [0.4, -1, -0.6], castShadow: true } },
  });
  runCommand(author, 'createEntity', {
    kind: 'group',
    name: 'Ambient fill',
    transform: T(0, 0),
    components: { light: { type: 'ambient', color: '#8a94b0', intensity: 0.9 } },
  });
  // Decoration: two beacon pillars.
  runCommand(author, 'createEntity', {
    kind: 'model',
    name: 'Beacon pillar A',
    transform: T(44.5, 0),
    model: { asset: { assetId: 'br-model-beacon' } },
  });
  runCommand(author, 'createEntity', {
    kind: 'model',
    name: 'Beacon pillar B',
    transform: T(18, 0),
    model: { asset: { assetId: 'br-model-beacon' } },
  });

  // (3) Game configuration + default gameplay settings (references resolved).
  runCommand(author, 'setGameConfig', {
    game: {
      configVersion: 1,
      title: 'Beacon Reach',
      objective: 'Reach the beacon',
      instructions:
        'A / D or arrow keys to move, Space to jump. Gamepad stick or D-pad to move, primary face button to jump. Avoid the hazards; the checkpoint saves your progress.',
      playerId,
      cameraId: camId,
      spawnId,
      level: { minX: 0, maxX: 48, minY: -10, maxY: 8 },
      killY: -4,
      cues: {
        start: 'br-audio-start',
        jump: 'br-audio-jump',
        checkpoint: 'br-audio-checkpoint',
        death: 'br-audio-death',
        goal: 'br-audio-goal',
      },
    },
  });
  runCommand(author, 'setSettings', {
    settings: {
      gravity_y: -19.62,
      run_speed: 4,
      jump_velocity: 7,
      max_fall_speed: -30,
      max_slope_climb_deg: 45,
      min_slope_slide_deg: 30,
    },
  });

  const scene = author.state.scene as unknown as { revision: number; entities: unknown[] };
  const content = (author.state as unknown as { content: unknown }).content as {
    assets: unknown[];
    game: { title: string };
  };

  const captured = {
    storageVersion: 3,
    type: 'authoring-state',
    projectId: PROJECT_ID,
    scene: author.state.scene,
    content: (author.state as unknown as { content: unknown }).content,
    recipe: {
      generatedBy: 'samples/beacon-reach/tools/capture-project.mjs',
      commandCount: author.applied.length,
      importedAt: IMPORTED_AT,
    },
  };

  mkdirSync(join(SAMPLE_ROOT, 'captured'), { recursive: true });
  mkdirSync(join(SAMPLE_ROOT, 'recipe'), { recursive: true });
  writeFileSync(join(SAMPLE_ROOT, 'captured', 'project.json'), JSON.stringify(captured, null, 2) + '\n');
  writeFileSync(
    join(SAMPLE_ROOT, 'recipe', 'commands.json'),
    JSON.stringify(
      {
        projectId: PROJECT_ID,
        importedAt: IMPORTED_AT,
        note: 'Authoring recipe: applied in order via @thirdlight/commands applyMutation to a fresh v3 scene. Entity IDs are generated; the checkpoint zone and game config reference the generated IDs (resolved at authoring time).',
        commands: author.applied.map(({ op, args }) => ({ op, args })),
      },
      null,
      2,
    ) + '\n',
  );

  const sceneDigest = sha256Hex(new TextEncoder().encode(JSON.stringify(author.state.scene) + '\n'));
  const contentDigest = sha256Hex(new TextEncoder().encode(JSON.stringify((author.state as unknown as { content: unknown }).content) + '\n'));
  console.log(`captured ${PROJECT_ID}: scene.revision=${scene.revision}, entities=${scene.entities.length}`);
  console.log(`content.assets=${content.assets.length}, game.title=${content.game.title}`);
  console.log(`camId=${camId} playerId=${playerId} spawnId=${spawnId} cpSpawnId=${cpSpawnId}`);
  console.log(`sceneDigest=${sceneDigest}`);
  console.log(`contentDigest=${contentDigest}`);
}

main();