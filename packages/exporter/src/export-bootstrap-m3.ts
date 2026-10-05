/**
 * The export bundle bootstrap.
 *
 * Runs in the exported static page (`<script type="module">`, IIFE bundle — no
 * top-level `await`). It starts the game with the same game page as Play
 * (`game-host/game-page`: the one composition of runtime content into
 * `createGameHost`); only what an exported page reads and links differs.
 * There is no backend, no bridge, no token and no credential in the page.
 *
 * Load order (all relative; every file checked against the row that names it):
 *   1. `./manifest.json` — its `buildId` is re-derived before anything else
 *      loads, then the catalog's blocks and what the start scenes need
 *      (`openRuntimeContent`);
 *   2. `./scene.json` — the start scene, digest-verified against
 *      `manifest.sceneDigest`;
 *   3. the game page: the start scenes' assets (each read once and re-hashed
 *      to its catalog row), the simulation, the renderer and the overlays; the
 *      rest of the catalog and the assets as the game asks for them.
 *
 * Every file is read by its manifest or catalog path relative to the page:
 * the bundle names no artifact itself, so its code is the same for any
 * project size. A model that fails to prepare is an on-page error and the
 * game plays on without it.
 *
 * Browser-only: DOM + WebGL/WebGPU.
 */
import { sha256HexAsync } from '@thirdlight/project-model';
import { loadPhysics2D, openRuntimeContent, type HostDomNode } from '@thirdlight/game-host';
import { startGamePage, type GamePageManifest } from '@thirdlight/game-host/game-page';
import type { RuntimeSnapshot, SimulationModuleSpec } from '@thirdlight/runtime';
// The simulation module specs this manifest names (generated per export; nothing else is linked).
import { moduleSpecs } from 'thirdlight:export-modules';

/** The simulation worker's bundle, next to this one (relative to the page). */
const EXPORT_SIM_WORKER_PATH = './js/sim-worker.js';
/** The block mesh worker (`js/mesh-worker.js`, only in an export with block layers; without it chunks mesh on the page). */
const EXPORT_MESH_WORKER_PATH = './js/mesh-worker.js';
/** The 3D physics backend (`js/physics-3d.js`, only in a 3D project's export). */
const EXPORT_PHYSICS_3D_PATH = './js/physics-3d.js';
/** The 2D physics backend (`js/physics-2d.js`, only in an export on the 2D plane). */
const EXPORT_PHYSICS_2D_PATH = './js/physics-2d.js';
/** Three's Draco and Basis decoders next to index.html (shipped when a file needs them). */
const EXPORT_DECODER_BASE = './decoders/';

function hud(text: string, isError: boolean): void {
  const el = document.getElementById('hud');
  if (el !== null) {
    el.textContent = text;
    el.className = isError ? 'error' : '';
  }
}

/**
 * A declared artifact, by its manifest or catalog path, next to index.html.
 * Only a plain relative path is read (never a URL, an absolute path or a
 * step out of the export); what comes back is checked by its reader.
 */
function readArtifact(path: string): Promise<ArrayBuffer> {
  if (!/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.@-]+)*$/.test(path) || path.split('/').some((part) => part === '..' || part === '.')) {
    return Promise.reject(new Error(`not a relative artifact path: ${path.slice(0, 80)}`));
  }
  return fetch(`./${path}`, { credentials: 'omit' }).then((res) => {
    if (!res.ok) return Promise.reject(new Error(`artifact read failed for ${path} (HTTP ${String(res.status)})`));
    return res.arrayBuffer();
  });
}

async function main(): Promise<void> {
  const canvas = document.getElementById('game');
  if (canvas === null || !(canvas instanceof HTMLCanvasElement)) {
    hud('export error: the page has no canvas#game', true);
    return;
  }
  try {
    const io = { read: readArtifact, sha256Hex: sha256HexAsync };
    const manifestDoc = JSON.parse(new TextDecoder().decode(await readArtifact('manifest.json'))) as unknown;
    const content = await openRuntimeContent<GamePageManifest>(manifestDoc, io);
    const manifest = content.manifest;
    // The start scene (digest-verified against manifest.sceneDigest).
    const sceneBytes = new Uint8Array(await readArtifact('scene.json'));
    if ((await sha256HexAsync(sceneBytes)) !== manifest.sceneDigest) throw new Error('the scene document digest does not match manifest.sceneDigest');
    const scene = JSON.parse(new TextDecoder().decode(sceneBytes)) as unknown;
    const snapshot = { snapshotId: manifest.snapshotId, projectId: manifest.projectId, revision: manifest.revision, scene, ...(manifest.tags !== undefined ? { tags: manifest.tags } : {}) } as unknown as RuntimeSnapshot;
    const game = await startGamePage({
      content,
      snapshot,
      read: readArtifact,
      scriptUrl: (path) => new URL(path, document.baseURI).href,
      // A streamed audio file plays from its path next to index.html.
      assetUrl: (path) => new URL(path, document.baseURI).href,
      workerUrl: new URL(EXPORT_SIM_WORKER_PATH, document.baseURI).href,
      meshWorkerUrl: new URL(EXPORT_MESH_WORKER_PATH, document.baseURI).href,
      physics3dUrl: new URL(EXPORT_PHYSICS_3D_PATH, location.href).href,
      physics2d: () => loadPhysics2D(new URL(EXPORT_PHYSICS_2D_PATH, location.href).href),
      decoderBase: EXPORT_DECODER_BASE,
      moduleSpecs: moduleSpecs as readonly SimulationModuleSpec[],
      canvas,
      container: (document.getElementById('hud-root') ?? document.body) as unknown as HostDomNode,
      // This game's saves in the player's browser (Play uses its own namespace).
      saveNamespace: `thirdlight:${String(manifest.projectId ?? 'game')}`,
      // The debug console only when the project turns debug_console on (absent/0: a release game has none).
      debugConsole: (manifest.settings as unknown as Record<string, unknown>)['debug_console'] === 1,
      onModelsFailed: (code) => hud(`export error: the model prepare hard-failed (${code}); the game continues without the failed model`, true),
    });
    const host = game.host;
    // Where the simulation runs (worker or this thread, and how transforms come back), for tooling and tests.
    (window as unknown as { __thirdlightThreading?: unknown }).__thirdlightThreading = game.threading;
    // The static export's own observation (there is no relay): its step, play state and the character's position; read by tooling and tests.
    (window as unknown as { __thirdlightObserve?: () => unknown }).__thirdlightObserve = () => {
      const res = host.observe();
      return res.ok ? res.observation : null;
    };
    const res = host.observe();
    // The debug line names the build and the play state only (no game rules).
    hud(res.ok ? `${manifest.snapshotId} · build ${manifest.buildId.slice(0, 12)} · ${res.observation.state}` : '', false);
    window.addEventListener('pagehide', () => game.dispose(), { once: true });
  } catch (e) {
    hud(`export error: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`, true);
  }
}

void main();
