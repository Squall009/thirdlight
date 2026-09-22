/**
 * Packet 63 — Phase B: the production composition in a real browser (in-page
 * diagnostics entry).
 *
 * Composes the SAME production modules the export/preview wrappers use
 * (game-host + physics-rapier + three-adapter + input + platformer /
 * platformer-game via the host's registry) over the captured Beacon Reach
 * scene, and exposes a read-only diagnostic surface on `window.__tl` so the
 * CDP harness can read stepIndex, run state, interpolated transforms and
 * runtime diagnostics at known wall-clock points.
 *
 * This entry is a TEST HARNESS, not a product page: it exists only to
 * separate "did the simulation step and move the player" from "did the
 * canvas capture reflect it". The canvas element mirrors the shipped export
 * page (no tabindex — the harness adds one when it wants keyboard input,
 * exactly as the packet-62 probe did).
 */
import { attachBrowserInput } from '@thirdlight/input';
import { CONTROLLER_CONSTANTS } from '@thirdlight/platformer';
import {
  createPhysicsPort,
  type RapierPhysicsInitConfig,
  type RapierStaticColliderSpec,
} from '@thirdlight/physics-rapier';
import {
  browserContextFactory,
  createGameAudioOwner,
  createGameHost,
  type GameHostConfig,
  type HostDomNode,
} from '@thirdlight/game-host';
import { createSceneAdapter } from '@thirdlight/three-adapter';
import type { GameplaySettings, RuntimeSnapshot } from '@thirdlight/runtime';

interface ProbeManifest {
  scene: unknown;
  content: {
    settings: GameplaySettings | null;
    assets: Array<{ assetId: string; version: number; kind: string; path: string }>;
    game: Record<string, unknown> | null;
  };
}

const DEFAULT_SETTINGS: GameplaySettings = {
  run_speed: 4,
  jump_velocity: 7,
  max_fall_speed: -30,
  gravity_y: -19.62,
  max_slope_climb_deg: 45,
  min_slope_slide_deg: 30,
};

function physicsConfigFromScene(scene: { entities: unknown[] }, settings: GameplaySettings): RapierPhysicsInitConfig | null {
  const statics: RapierStaticColliderSpec[] = [];
  let character: RapierPhysicsInitConfig['character'] | null = null;
  for (const entity of scene.entities) {
    const e = entity as {
      id: string;
      parentId?: string | null;
      components?: Record<string, { position?: number[]; rotation?: number[]; scale?: number[]; shape?: unknown; rotationZ?: number } | Record<string, unknown>>;
    };
    const components = e.components ?? {};
    const transform = components['transform'];
    const position = transform?.position ?? [0, 0, 0];
    if (components['collider'] !== undefined) {
      statics.push({
        entityId: e.id,
        position: { x: position[0] ?? 0, y: position[1] ?? 0 },
        rotationZ: (components['collider'] as { rotationZ?: number }).rotationZ ?? 0,
        shape: (components['collider'] as { shape?: unknown }).shape as never,
      });
    }
    if (components['controller'] !== undefined) {
      character = {
        x: position[0] ?? 0,
        y: position[1] ?? 0,
        parentId: e.parentId ?? null,
        rotation: (transform?.rotation ?? [0, 0, 0, 1]) as [number, number, number, number],
        scale: (transform?.scale ?? [1, 1, 1]) as [number, number, number],
      };
    }
  }
  if (character === null) return null;
  return {
    character,
    statics,
    solver: { hz: 120, gravityY: settings.gravity_y },
    controller: {
      offsetSkin: CONTROLLER_CONSTANTS.offsetSkin,
      groundSnap: CONTROLLER_CONSTANTS.groundSnap,
      maxSlopeClimbRad: (settings.max_slope_climb_deg * Math.PI) / 180,
      minSlopeSlideRad: (settings.min_slope_slide_deg * Math.PI) / 180,
      autostep: false,
    },
  };
}

async function main(): Promise<void> {
  const canvas = document.getElementById('game');
  const hudRoot = document.getElementById('hud-root');
  if (!(canvas instanceof HTMLCanvasElement) || hudRoot === null) {
    document.body.innerHTML = '<div style="color:red">probe page missing #game / #hud-root</div>';
    return;
  }
  const manifest = (await fetch('./probe-manifest.json', { credentials: 'omit' }).then((r) => r.json())) as ProbeManifest;
  const settings: GameplaySettings = manifest.content.settings ?? DEFAULT_SETTINGS;
  const scene = manifest.scene as { entities: unknown[]; revision?: number };
  // The runtime snapshot contract (snapshot.ts): snapshotId must equal
  // `<projectId>@r<revision>`.
  const projectId = manifest.content['@id'] ?? 'beacon-reach';
  const revision = scene.revision ?? 0;
  const snapshot = {
    snapshotId: `${projectId}@r${revision}`,
    projectId,
    revision,
    scene,
    game: manifest.content.game ?? null,
  } as unknown as RuntimeSnapshot;

  const physicsInit = await createPhysicsPort(physicsConfigFromScene(scene, settings) as RapierPhysicsInitConfig);
  if (!physicsInit.ok) throw new Error(`physics init failed: ${physicsInit.error.code}`);
  const physics = physicsInit.port;
  const input = attachBrowserInput(canvas, {});
  const audio = createGameAudioOwner({ contextFactory: browserContextFactory() ?? undefined });
  const assetPathsById: Record<string, string> = {};
  for (const asset of manifest.content.assets ?? []) assetPathsById[asset.assetId] = asset.path;
  const readArtifact = (path: string): Promise<ArrayBuffer> =>
    fetch(`./assets/${path}`, { credentials: 'omit' }).then((r) => {
      if (!r.ok) return Promise.reject(new Error(`artifact read failed (HTTP ${String(r.status)}): ${path}`));
      return r.arrayBuffer();
    });

  const config: GameHostConfig = {
    snapshot,
    settings,
    physics,
    adapter: (runtime) => createSceneAdapter(canvas, { runtime, snapshot }),
    input,
    audio,
    readArtifact,
    container: hudRoot as unknown as HostDomNode,
    buildId: 'probe-build',
    assetPaths: assetPathsById,
  };
  const host = createGameHost(config);
  const mount = host.mount();
  if (!mount.ok) {
    document.body.innerHTML = `<div style="color:red">host mount failed: ${JSON.stringify(mount.error)}</div>`;
    return;
  }

  // The read-only diagnostic surface (the CDP harness polls it).
  const playerEntityId = (() => {
    for (const e of scene.entities) {
      const c = (e as { components?: Record<string, unknown> }).components ?? {};
      if (c['controller'] !== undefined) return (e as { id: string }).id;
    }
    return null;
  })();
  (window as Record<string, unknown>).__tl = {
    ready: true,
    playerEntityId,
    settings,
    modelEntityCount: scene.entities.filter((e) => ((e as { components?: Record<string, unknown> }).components ?? {})['model'] !== undefined).length,
    observe: () => {
      const r = host.observe();
      return r.ok ? r.observation : { error: r.error };
    },
    state: () => {
      const r = host.runtime.getInterpolatedState();
      if (!r.ok) return { error: r.error };
      const t = r.state.transforms.find((x) => x.id === playerEntityId);
      return {
        stepIndex: r.state.stepIndex,
        simTime: r.state.simTime,
        alpha: r.state.alpha,
        player: t === undefined ? null : { x: t.position[0], y: t.position[1], z: t.position[2] },
      };
    },
    gameView: () => {
      const r = host.runtime.getGameView();
      return r.ok ? { state: r.view.state, stepIndex: r.view.stepIndex, deathCount: r.view.deathCount, goalReached: r.view.goalReached, events: r.view.events } : { error: r.error };
    },
    diagnostics: () => {
      const r = host.runtime.getDiagnostics();
      return r.ok
        ? {
            frameCount: r.diagnostics.frameCount,
            stepCount: r.diagnostics.stepCount,
            catchUpDrops: r.diagnostics.catchUpDrops,
            state: r.diagnostics.state,
            errors: r.diagnostics.errors.slice(-8),
          }
        : { error: r.error };
    },
    audio: () => {
      const s = audio.status();
      return { state: s.state, diagnostics: audio.diagnostics().slice(-8) };
    },
    dispose: () => host.dispose(),
  };
}

void main().catch((e) => {
  document.body.innerHTML = `<div style="color:red">probe failed: ${e instanceof Error ? e.message : String(e)}</div>`;
});