/**
 * M2 export bundle bootstrap (packet 36; export.md §3/§5.1–§5.5, §6, §17.5).
 *
 * Runs in the exported static page (`<script type="module">`, IIFE bundle — no
 * top-level `await`). It is the SAME runtime as play mode and links the same
 * pinned behavior outputs (§5.1); there is no backend, no bridge, no token and
 * no credential in the page.
 *
 * Load order (all relative, all declared):
 *   1. `fetch("./manifest.json")` — the single manifest read; the manifest's
 *      own `buildId` is re-derived and verified before anything else loads.
 *   2. `fetch("./scene.json")` — the captured scene document, digest-verified
 *      against `manifest.sceneDigest` (the export layout addition recorded as
 *      contract-change request C36-1).
 *   3. one `fetch("./<declared asset path>")` per manifest asset, digest
 *      verified (WebCrypto) before the GLB is handed to the pinned
 *      `three-adapter/gltf-loader` port through the packet-26 visual resource
 *      store (the single resource-owner path).
 *   4. the statically linked behavior outputs (build inputs, never fetched and
 *      never dynamically imported).
 *   5. `composeExportRuntime` — the shared composition (runtime + input +
 *      platformer + physics-rapier + the linked behaviors).
 *   6. the three.js/WebGL renderer frame hook; the HUD reports the
 *      `snapshotId`/`buildId` and the selected backend.
 *
 * When the manifest declares behaviors the page presents the mandatory
 * `behaviors.md` §2.3 trust notice and requires an explicit acknowledgment
 * before starting (§6: "the exported page must present the trust notice before
 * starting").
 *
 * Browser-only: DOM + WebGL. The real-browser walkthrough is UNVERIFIED in this
 * container (no browser) — procedure in docs/acceptance/evidence-m2/36/.
 */
import { sha256HexAsync } from '@thirdlight/project-model';
import {
  type ActionFrame,
  type PhysicsPort,
  type Runtime,
  type RuntimeSnapshot,
} from '@thirdlight/runtime';
import { attachBrowserInput } from '@thirdlight/input';
import { CONTROLLER_CONSTANTS } from '@thirdlight/platformer';
import { createPhysicsPort, type RapierPhysicsInitConfig, type RapierStaticColliderSpec } from '@thirdlight/physics-rapier';
import { createGltfLoaderPort } from '@thirdlight/three-adapter/gltf-loader';
import { createVisualResourceStore, injectedResolver } from '@thirdlight/three-adapter';
import * as THREE from 'three';
import { assetPaths, readAsset } from 'thirdlight:export-artifacts';
import { behaviors } from 'thirdlight:export-behaviors';
import { composeExportRuntime, verifyManifestIdentity, type ExportBehaviorLink } from './export-composition';
import { BEHAVIOR_TRUST_NOTICE } from './export-page';

interface ExportManifest {
  manifestVersion: number;
  type: string;
  projectId: string;
  revision: number;
  snapshotId: string;
  capturedAt: string;
  sceneDigest: string;
  contentDigest: string;
  assets: ReadonlyArray<{ assetId: string; version: number; sourceDigest: string; sourceByteLength: number; path: string }>;
  behaviors: ReadonlyArray<{
    behaviorId: string;
    sourceDigest: string;
    manifestDigest: string;
    outputDigest: string;
    apiVersion: number;
    ownedTransforms: readonly string[];
    requiredModules: readonly string[];
    path: string;
  }>;
  modules: ReadonlyArray<{ id: string; apiVersion: number; package: string; version: string }>;
  enginePins: ReadonlyArray<{ id: string; version: string; apiVersion: number }>;
  buildOptionsDigest: string;
  buildId: string;
}

const DEFAULT_GRAVITY_Y = -19.62;

function hud(text: string, isError: boolean): void {
  const el = document.getElementById('hud');
  if (el !== null) {
    el.textContent = text;
    el.className = isError ? 'error' : '';
  }
}

/** Lowercase hex SHA-256 (Web Crypto when the page has it, pure JS otherwise). */
const sha256Hex = sha256HexAsync;

/** The scene-derived Rapier init config (the same derivation as preview/play). */
function physicsConfigFromSnapshot(snapshot: RuntimeSnapshot): RapierPhysicsInitConfig | null {
  const statics: RapierStaticColliderSpec[] = [];
  let character: RapierPhysicsInitConfig['character'] | null = null;
  for (const entity of snapshot.scene.entities) {
    const components = (entity.components ?? {}) as unknown as Record<string, unknown>;
    const transform = components['transform'] as { position?: number[]; rotation?: number[]; scale?: number[] } | undefined;
    const position = transform?.position ?? [0, 0, 0];
    if (components['collider'] !== undefined) {
      const collider = components['collider'] as { shape?: unknown; rotationZ?: number };
      statics.push({
        entityId: entity.id,
        position: { x: position[0] ?? 0, y: position[1] ?? 0 },
        rotationZ: collider.rotationZ ?? 0,
        shape: collider.shape as never,
      });
    }
    if (components['controller'] !== undefined) {
      character = {
        x: position[0] ?? 0,
        y: position[1] ?? 0,
        parentId: (entity as { parentId?: string | null }).parentId ?? null,
        rotation: (transform?.rotation ?? [0, 0, 0, 1]) as [number, number, number, number],
        scale: (transform?.scale ?? [1, 1, 1]) as [number, number, number],
      };
    }
  }
  if (character === null) return null;
  return {
    character,
    statics,
    solver: { hz: 120, gravityY: DEFAULT_GRAVITY_Y },
    controller: {
      offsetSkin: CONTROLLER_CONSTANTS.offsetSkin,
      groundSnap: CONTROLLER_CONSTANTS.groundSnap,
      maxSlopeClimbRad: (45 * Math.PI) / 180,
      minSlopeSlideRad: (30 * Math.PI) / 180,
      autostep: false,
    },
  };
}

/** The exported page's three.js renderer (box primitives + realized GLB models). */
class ExportRenderer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly nodes = new Map<string, THREE.Object3D>();
  private readonly owned: Array<{ dispose(): void }> = [];

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.scene.background = new THREE.Color(0x0e1015);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const dir = new THREE.DirectionalLight(0xffffff, 1.1);
    dir.position.set(2, 4, 3);
    this.scene.add(dir);
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    this.camera.position.set(0, 0.5, 4);
  }

  build(snapshot: RuntimeSnapshot): void {
    for (const entity of snapshot.scene.entities) {
      const components = (entity.components ?? {}) as unknown as Record<string, unknown>;
      const node = new THREE.Object3D();
      node.name = entity.id;
      if (components['model'] === undefined && components['box'] !== undefined) {
        const geometry = new THREE.BoxGeometry(1, 1, 1);
        const material = new THREE.MeshStandardMaterial({ color: 0x9aa4b2 });
        node.add(new THREE.Mesh(geometry, material));
        this.owned.push(geometry, material);
      }
      this.nodes.set(entity.id, node);
      this.scene.add(node);
    }
  }

  attachModel(entityId: string, object: THREE.Object3D): void {
    this.nodes.get(entityId)?.add(object);
  }

  setSize(width: number, height: number): void {
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  render(runtime: Runtime): void {
    const state = runtime.getInterpolatedState();
    if (state.ok) {
      for (const t of state.state.transforms) {
        const node = this.nodes.get(t.id);
        if (node === undefined) continue;
        node.position.set(t.position[0], t.position[1], t.position[2]);
        node.quaternion.set(t.rotation[0], t.rotation[1], t.rotation[2], t.rotation[3]);
        node.scale.set(t.scale[0], t.scale[1], t.scale[2]);
      }
    }
    const cam = runtime.getCamera();
    if (cam.ok) {
      this.camera.fov = cam.camera.fovY;
      this.camera.near = cam.camera.near;
      this.camera.far = cam.camera.far;
      this.camera.updateProjectionMatrix();
      const camNode = this.nodes.get(cam.camera.id);
      if (camNode !== undefined) {
        this.camera.position.copy(camNode.position);
        this.camera.quaternion.copy(camNode.quaternion);
      }
    }
    this.renderer.render(this.scene, this.camera);
  }

  diagnostics(): Record<string, unknown> {
    const info = this.renderer.info;
    return {
      renderBackend: this.renderer.capabilities.isWebGL2 ? 'webgl2' : 'webgl1',
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      drawCalls: info.render.calls,
      nodes: this.nodes.size,
    };
  }

  dispose(): void {
    for (const r of this.owned) r.dispose();
    this.owned.length = 0;
    this.renderer.dispose();
    this.scene.clear();
    this.nodes.clear();
  }
}

/** Load the scene + declared assets and realize the pinned GLB models. */
async function loadClosure(
  manifest: ExportManifest,
): Promise<{ snapshot: RuntimeSnapshot; instances: Map<string, THREE.Object3D>; store: ReturnType<typeof createVisualResourceStore> }> {
  // The captured scene (digest-verified against manifest.sceneDigest).
  const sceneRes = await fetch('./scene.json', { credentials: 'omit' });
  if (!sceneRes.ok) throw new Error(`scene read failed (HTTP ${String(sceneRes.status)})`);
  const sceneBytes = new Uint8Array(await sceneRes.arrayBuffer());
  if ((await sha256Hex(sceneBytes)) !== manifest.sceneDigest) throw new Error('the scene document digest does not match manifest.sceneDigest');
  const scene = JSON.parse(new TextDecoder().decode(sceneBytes)) as RuntimeSnapshot['scene'];
  const snapshot = {
    snapshotId: manifest.snapshotId,
    projectId: manifest.projectId,
    revision: manifest.revision,
    scene,
  } as unknown as RuntimeSnapshot;

  // The declared asset reads (one per declared path, digest-verified) through
  // the packet-26 visual resource store (the single resource-owner path).
  const store = createVisualResourceStore();
  const loader = createGltfLoaderPort();
  const instances = new Map<string, THREE.Object3D>();
  for (const asset of manifest.assets ?? []) {
    const path = asset.path ?? `content/sha256/${asset.sourceDigest}`;
    if (!assetPaths.includes(path)) throw new Error(`the manifest declares an undeclared asset path: ${path}`);
    const read = readAsset(path, undefined);
    if (read === null) throw new Error(`no relative reader for the declared asset path: ${path}`);
    const res = await read;
    if (!res.ok) throw new Error(`asset read failed for ${asset.assetId} (HTTP ${String(res.status)})`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if ((await sha256Hex(bytes)) !== asset.sourceDigest) throw new Error(`asset digest mismatch: ${asset.assetId}`);
    const descriptor = { assetId: asset.assetId, version: asset.version, sourceDigest: asset.sourceDigest, sourceByteLength: asset.sourceByteLength };
    const handle = store.load(injectedResolver(descriptor, async () => bytes), { loader });
    const prepared = await handle.result;
    if (!prepared.ok) throw new Error(`asset realization failed: ${asset.assetId} (${prepared.error.code})`);
    const created = prepared.resource.createInstance();
    if (!created.ok) throw new Error(`asset instance failed: ${asset.assetId} (${created.error.code})`);
    for (const entity of scene.entities) {
      const model = ((entity.components ?? {}) as unknown as Record<string, unknown>)['model'] as
        | { asset?: { assetId?: string } }
        | undefined;
      if (model?.asset?.assetId === asset.assetId) instances.set(entity.id, created.instance.root);
    }
  }
  return { snapshot, instances, store };
}

/** Start the exported game for one verified manifest. */
async function start(canvas: HTMLCanvasElement, manifest: ExportManifest): Promise<void> {
  const loaded = await loadClosure(manifest);
  const snapshot = loaded.snapshot;

  const renderer = new ExportRenderer(canvas);
  renderer.setSize(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight);
  renderer.build(snapshot);
  for (const [entityId, object] of loaded.instances) renderer.attachModel(entityId, object);

  const physicsConfig = physicsConfigFromSnapshot(snapshot);
  let physics: PhysicsPort | null = null;
  if (physicsConfig !== null) {
    const init = await createPhysicsPort(physicsConfig);
    if (!init.ok) throw new Error(`physics init failed: ${init.error.code}`);
    physics = init.port;
  }
  const input = attachBrowserInput(window, {});

  let runtime: Runtime | null = null;
  const composed = composeExportRuntime({
    snapshot,
    manifest,
    behaviors: behaviors as unknown as readonly ExportBehaviorLink[],
    actions: input,
    physics,
    clock: () => performance.now() / 1000,
    onFrame: () => {
      if (runtime !== null) renderer.render(runtime);
    },
  });
  if (!composed.ok) throw new Error(`runtime composition failed: ${composed.error.code} ${composed.error.message}`);
  const rt = composed.runtime;
  runtime = rt;
  const started = rt.start();
  if (!started.ok) throw new Error(`runtime start failed: ${started.error.code}`);

  const refresh = (): void => {
    const d = renderer.diagnostics();
    hud(`${manifest.snapshotId} \u00b7 build ${manifest.buildId.slice(0, 12)} \u00b7 render ${String(d['renderBackend'])}`, false);
  };
  refresh();
  setTimeout(refresh, 500);
  setTimeout(refresh, 2000);
}

/** The mandatory §2.3 trust notice gate (only when behaviors are declared). */
function showNoticeThenStart(canvas: HTMLCanvasElement, manifest: ExportManifest, count: number): void {
  const panel = document.createElement('div');
  panel.style.cssText =
    'position:fixed;inset:0;background:#0e1015;color:#cbd5e1;font:13px/1.5 system-ui,sans-serif;padding:24px;overflow:auto;z-index:10;';
  const heading = document.createElement('h1');
  heading.textContent = 'Behavior trust notice';
  heading.style.cssText = 'font-size:16px;margin:0 0 12px;';
  panel.appendChild(heading);
  for (const line of BEHAVIOR_TRUST_NOTICE) {
    const p = document.createElement('p');
    p.textContent = line;
    p.style.margin = '0 0 10px';
    panel.appendChild(p);
  }
  const button = document.createElement('button');
  button.textContent = 'I understand the limits and start the game';
  button.style.cssText = 'padding:8px 14px;font:inherit;cursor:pointer;';
  button.addEventListener('click', () => {
    panel.remove();
    void start(canvas, manifest).catch((e: unknown) => {
      hud(`export error: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`, true);
    });
  });
  panel.appendChild(button);
  document.body.appendChild(panel);
  hud(`${String(count)} behavior(s) require acknowledgment`, false);
}

async function main(): Promise<void> {
  const canvas = document.getElementById('game');
  if (canvas === null || !(canvas instanceof HTMLCanvasElement)) {
    hud('export error: the page has no canvas#game', true);
    return;
  }
  try {
    // The single manifest read (export.md §5.3: exactly one literal
    // `fetch("./manifest.json")` in the emitted bundle).
    const res = await fetch('./manifest.json', { credentials: 'omit' });
    if (!res.ok) throw new Error(`manifest read failed (HTTP ${String(res.status)})`);
    const manifest = JSON.parse(await res.text()) as ExportManifest;
    if (manifest.type !== 'thirdlight-runtime-content' || manifest.manifestVersion !== 1) throw new Error('unsupported manifest document');
    const identity = await verifyManifestIdentity(manifest as unknown as Record<string, unknown>, sha256HexOfUtf8);
    if (!identity.ok) throw new Error(`manifest identity check failed: ${identity.reason}`);
    const count = (manifest.behaviors ?? []).length;
    if (count > 0) {
      showNoticeThenStart(canvas, manifest, count);
      return;
    }
    await start(canvas, manifest);
  } catch (e) {
    hud(`export error: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`, true);
  }
}

/** SHA-256 (lowercase hex) of UTF-8 text via WebCrypto. */
async function sha256HexOfUtf8(text: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(text));
}

void main();
