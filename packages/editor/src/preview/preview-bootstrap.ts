/**
 * Play-preview bootstrap (sessions.md §13 + §17.6; delivery.md §7; packet 35).
 *
 * Runs in the SEPARATE-origin preview iframe. It is backend-free by design: it
 * receives NO credentials and NO authoring API URL — the only page config is
 * `{ v: 2, authoringOrigin, playSessionId, contentId, manifestPath }`
 * (sessions.md §13.2/§17.6). The snapshot arrives only through the checked
 * bridge (the nonce-verified `tl.snapshot`); the content arrives only through
 * the read-only play-content locator (the `contentId` capability).
 *
 * The production play composition:
 *   runtime (the same runtime as export) + the pinned behavior outputs
 *   + `@thirdlight/input` (keyboard/gamepad binding) + `@thirdlight/platformer`
 *   + `@thirdlight/physics-rapier` + three/GLTFLoader for the pinned GLB models.
 *
 * Readiness is truthful (delivery §7): `tl.ready` is posted only after the
 * manifest `buildId` matches the expected one, every declared asset read
 * completed and verified, the physics port initialized, and the behavior
 * outputs are linked and the runtime instantiated. A failed/cancelled load
 * posts `tl.error` with the phase and never reports ready.
 *
 * Browser-only: DOM + WebGL. No authoring call, no token, no `fetch` other than
 * the manifest-declared relative artifact reads.
 */

import { sha256HexAsync } from '@thirdlight/project-model';
import {
  BUILTIN_MODULES,
  behaviorModuleId,
  createBehaviorModuleSpec,
  createSimulationRegistry,
  instantiateRuntime,
  neutralFrame,
  registerSimulationModule,
  type ActionFrame,
  type ActionSource,
  type PhysicsPort,
  type Runtime,
  type RuntimeSnapshot,
  type SimulationRegistry,
} from '@thirdlight/runtime';
import { attachBrowserInput } from '@thirdlight/input';
import { CONTROLLER_CONSTANTS, PLATFORMER_MODULE_ID, platformerSpec } from '@thirdlight/platformer';
import { createPhysicsPort, type RapierPhysicsInitConfig, type RapierStaticColliderSpec } from '@thirdlight/physics-rapier';
import { createGltfLoaderPort } from '@thirdlight/three-adapter/gltf-loader';
import * as THREE from 'three';
import { Bridge } from './bridge';
import { RelayActionSource } from './relay-input';

/** The injected preview page config (sessions.md §13.2/§17.6 — config, not secrets). */
interface PreviewPageConfig {
  v: 2;
  authoringOrigin: string;
  playSessionId: string | null;
  contentId: string | null;
  manifestPath: string;
}

declare global {
  interface Window {
    __thirdlightPreview?: PreviewPageConfig;
    /** The artifact root `/play-content/<contentId>/` (packet-35 shell). */
    __thirdlightContentRoot?: string;
  }
}

const NO_PLAY_HTML =
  '<div style="font:14px/1.5 system-ui,sans-serif;color:#9aa4b2;padding:24px;">' +
  'No active play. Open this preview from the editor&#39;s Play button.</div>';

/** The `export.md §5.3`-ingest runtime-content manifest (only the fields play reads). */
interface ContentManifest {
  manifestVersion: number;
  type: string;
  projectId: string;
  revision: number;
  snapshotId: string;
  sceneDigest: string;
  contentDigest: string;
  assets: ReadonlyArray<{ assetId: string; version: number; sourceDigest: string; sourceByteLength: number; path: string }>;
  behaviors: ReadonlyArray<{
    behaviorId: string;
    sourceDigest: string;
    sourceByteLength: number;
    manifestDigest: string;
    outputDigest: string;
    outputByteLength: number;
    apiVersion: number;
    declaration: { properties: ReadonlyArray<Record<string, unknown>> };
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

function showNoPlay(): void {
  const el = document.createElement('div');
  el.className = 'tl-preview-no-play';
  el.innerHTML = NO_PLAY_HTML;
  document.body.appendChild(el);
}

/** Lowercase hex SHA-256 (Web Crypto when the page has it, pure JS otherwise). */
const sha256Hex = sha256HexAsync;

/** The preview-owned three.js rendering of the snapshot + realized GLB models. */
class PreviewRenderer {
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

  /** Build one Object3D per snapshot entity (box primitives; models attach later). */
  build(snapshot: RuntimeSnapshot): void {
    for (const entity of snapshot.scene.entities) {
      const components = (entity.components ?? {}) as unknown as Record<string, unknown>;
      const node = new THREE.Object3D();
      node.name = entity.id;
      if (components['model'] !== undefined) {
        // The realized GLB instance attaches here after the asset loads.
      } else if (components['box'] !== undefined) {
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
    const node = this.nodes.get(entityId);
    if (node === undefined) return;
    node.add(object);
  }

  setAspect(width: number, height: number): void {
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
      // The snapshot camera entity's transform is applied to the node list; the
      // projection follows the snapshot's camera components.
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

  /** A bounded PNG data URL (≤ maxWidth). */
  capture(maxWidth: number): { dataUrl: string; width: number; height: number } {
    const size = new THREE.Vector2();
    this.renderer.getSize(size);
    const sourceWidth = Math.max(1, Math.floor(size.x));
    const sourceHeight = Math.max(1, Math.floor(size.y));
    const width = Math.min(maxWidth, sourceWidth);
    const height = Math.max(1, Math.round((sourceHeight / sourceWidth) * width));
    const out = document.createElement('canvas');
    out.width = width;
    out.height = height;
    const ctx = out.getContext('2d');
    if (ctx !== null) ctx.drawImage(this.canvas, 0, 0, width, height);
    return { dataUrl: out.toDataURL('image/png'), width, height };
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

export function bootstrapPreview(): void {
  const cfg = window.__thirdlightPreview;
  const query = new URLSearchParams(window.location.search);
  const rawPlayId = cfg?.playSessionId ?? query.get('play');
  const rawContentId = cfg?.contentId ?? query.get('content');
  if (!cfg || cfg.v !== 2 || rawPlayId === null || rawContentId === null) {
    showNoPlay();
    return;
  }
  const playId: string = rawPlayId;
  const contentId: string = rawContentId;
  const authoringOrigin = cfg.authoringOrigin;
  const contentRoot = window.__thirdlightContentRoot ?? `/play-content/${contentId}/`;
  const manifestPath = `${contentRoot}manifest.json`;

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'width:100vw;height:100vh;display:block;background:#0e1015;';
  document.body.style.margin = '0';
  document.body.appendChild(canvas);

  let trustedSource: unknown = null;
  const bridge = new Bridge({
    direction: 'preview',
    expectedOrigin: authoringOrigin,
    targetOrigin: authoringOrigin,
    post: (data, target) => window.parent.postMessage(data, target),
    isTrustedSource: (s) => s === trustedSource || s === window.parent || s === window.opener,
  });

  let runtime: Runtime | null = null;
  let physics: PhysicsPort | null = null;
  let renderer: PreviewRenderer | null = null;
  let browserInput: (ActionSource & { detach(): void; dispose(): void; unavailable(): unknown }) | null = null;
  let actionSource: RelayActionSource | null = null;
  let loading = false;
  let expectedBuildId: string | null = null;
  let manifest: ContentManifest | null = null;
  let stepForTest = 0;

  const disposePlay = (): void => {
    if (runtime !== null) {
      runtime.stop();
      runtime.dispose();
      runtime = null;
    }
    if (physics !== null) {
      physics.dispose();
      physics = null;
    }
    if (renderer !== null) {
      renderer.dispose();
      renderer = null;
    }
    if (browserInput !== null) {
      browserInput.detach();
      browserInput = null;
    }
    actionSource = null;
    loading = false;
  };

  const reportProgress = (phase: string, loadedBytes: number, totalBytes: number): void => {
    bridge.sendLoadProgress(playId, phase, loadedBytes, totalBytes);
  };

  const fail = (phase: string, code: string, message?: string): void => {
    disposePlay();
    bridge.sendError(playId, code, message, phase);
  };

  async function loadContent(snapshot: RuntimeSnapshot, buildIdFromHandshake: string): Promise<void> {
    if (loading) return;
    loading = true;
    try {
      reportProgress('shell', 0, 0);
      // 1. Manifest (the buildId must match the handshake's expectation — §17.6).
      const manifestRes = await fetch(manifestPath, { credentials: 'omit' });
      if (!manifestRes.ok) {
        fail('manifest', 'play_content_not_ready', `manifest read failed (${manifestRes.status})`);
        return;
      }
      const parsed = (await manifestRes.json()) as ContentManifest;
      if (parsed.type !== 'thirdlight-runtime-content' || parsed.manifestVersion !== 1) {
        fail('manifest', 'play_content_not_ready', 'unsupported manifest document');
        return;
      }
      if (parsed.buildId !== buildIdFromHandshake) {
        fail('manifest', 'play_content_not_ready', 'manifest buildId does not match the expected build');
        return;
      }
      manifest = parsed;
      reportProgress('manifest', 1, 1);

      // 2. Assets: exactly one read per declared path, digest-verified.
      const declaredAssets = parsed.assets ?? [];
      const totalAssetBytes = declaredAssets.reduce((n, a) => n + a.sourceByteLength, 0);
      let loadedAssetBytes = 0;
      const loader = createGltfLoaderPort();
      const modelInstances = new Map<string, THREE.Object3D>();
      for (const asset of declaredAssets) {
        const res = await fetch(`${contentRoot}${asset.path}`, { credentials: 'omit' });
        if (!res.ok) {
          fail('assets', 'play_content_not_ready', `asset read failed: ${asset.assetId}@${asset.version}`);
          return;
        }
        const bytes = new Uint8Array(await res.arrayBuffer());
        const digest = await sha256Hex(bytes);
        if (digest !== asset.sourceDigest) {
          fail('assets', 'play_content_not_ready', `asset digest mismatch: ${asset.assetId}`);
          return;
        }
        const loaded = await loader.load(bytes, {
          signal: new AbortController().signal,
          descriptor: { assetId: asset.assetId, version: asset.version, sourceDigest: asset.sourceDigest, sourceByteLength: asset.sourceByteLength },
        });
        for (const entity of snapshot.scene.entities) {
          const components = (entity.components ?? {}) as unknown as Record<string, unknown>;
          const model = components['model'] as { asset?: { assetId?: string } } | undefined;
          if (model?.asset?.assetId === asset.assetId) {
            modelInstances.set(entity.id, loaded.createInstance());
          }
        }
        loadedAssetBytes += bytes.length;
        reportProgress('assets', loadedAssetBytes, totalAssetBytes);
      }

      // 3. Behavior outputs (linked modules; the manifest digest is the identity).
      const declaredBehaviors = parsed.behaviors ?? [];
      const registry: SimulationRegistry = createSimulationRegistry();
      for (const spec of BUILTIN_MODULES) registerSimulationModule(registry, spec.id, spec);
      registerSimulationModule(registry, PLATFORMER_MODULE_ID, platformerSpec);
      for (const behavior of declaredBehaviors) {
        const mod = (await import(/* @vite-ignore */ `${contentRoot}${behavior.path}`)) as { default?: unknown };
        registerSimulationModule(
          registry,
          behaviorModuleId(behavior.behaviorId),
          createBehaviorModuleSpec({
            declaration: behavior.declaration as never,
            artifact: {
              behaviorId: behavior.behaviorId,
              sourceDigest: behavior.sourceDigest,
              manifestDigest: behavior.manifestDigest,
              outputDigest: behavior.outputDigest,
              ownedTransforms: behavior.ownedTransforms ?? [],
              requiredModules: behavior.requiredModules ?? [],
              enginePins: parsed.enginePins,
              namespace: mod,
            },
          }),
        );
      }
      reportProgress('behaviors', declaredBehaviors.length, declaredBehaviors.length);

      // 4. Renderer + physics + runtime.
      const previewRenderer = new PreviewRenderer(canvas);
      previewRenderer.setAspect(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight);
      previewRenderer.build(snapshot);
      for (const [entityId, object] of modelInstances) previewRenderer.attachModel(entityId, object);
      renderer = previewRenderer;

      const physicsConfig = physicsConfigFromSnapshot(snapshot);
      if (physicsConfig !== null) {
        const init = await createPhysicsPort(physicsConfig);
        if (!init.ok) {
          fail('runtime', init.error.code, init.error.message);
          return;
        }
        physics = init.port;
      }

      const input = attachBrowserInput(window, {});
      browserInput = input;
      const inputUnavailable = input.unavailable();
      if (inputUnavailable !== null) {
        // Denied/absent gamepad: keyboard-only degradation (input.md §5).
        bridge.sendError(playId, 'input_unavailable', 'gamepad unavailable; keyboard-only', 'runtime');
      }
      const action = new RelayActionSource(input);
      actionSource = action;

      const modules: string[] = [];
      if (snapshot.scene.entities.some((e) => ((e.components ?? {}) as unknown as Record<string, unknown>)['controller'] !== undefined)) {
        modules.push(PLATFORMER_MODULE_ID);
      }
      for (const behavior of declaredBehaviors) modules.push(behaviorModuleId(behavior.behaviorId));

      const rt = instantiateRuntime({
        snapshot,
        registry,
        modules,
        actions: action,
        ...(physics !== null ? { physics } : {}),
        clock: () => (typeof performance !== 'undefined' ? performance.now() / 1000 : Date.now() / 1000),
        onFrame: () => {
          if (renderer !== null && runtime !== null) renderer.render(runtime);
        },
      });
      if (!rt.ok) {
        fail('runtime', rt.error.code, rt.error.message);
        return;
      }
      runtime = rt.runtime;
      const started = rt.runtime.start();
      if (!started.ok) {
        fail('runtime', started.error.code, started.error.message);
        return;
      }
      reportProgress('runtime', 1, 1);
      const diagnostics = rt.runtime.getDiagnostics();
      stepForTest = diagnostics.ok ? diagnostics.diagnostics.stepIndex : 0;
      bridge.sendReady(playId, parsed.snapshotId, parsed.revision, parsed.buildId, parsed.contentDigest, stepForTest);
    } catch (e) {
      fail('runtime', 'play_content_not_ready', e instanceof Error ? e.message : String(e));
    }
  }

  /** The snapshot the current play was instantiated from (bridge-delivered). */
  let snapshotRef: RuntimeSnapshot | null = null;
  void snapshotRef;

  bridge.on('tl.handshake', (m, event) => {
    const body = m as { playSessionId: string; nonce: string; demo: boolean; contentId: string; buildId: string };
    trustedSource = event.source;
    expectedBuildId = body.buildId;
    bridge.ackHandshake(body.playSessionId, body.nonce);
  });

  bridge.on('tl.playContent.expect', (m) => {
    const body = m as { buildId: string };
    expectedBuildId = body.buildId;
  });

  bridge.on('tl.snapshot', (m) => {
    const body = m as { snapshot: RuntimeSnapshot };
    snapshotRef = body.snapshot;
    void loadContent(body.snapshot, expectedBuildId ?? '');
  });

  bridge.on('tl.input.request', (m) => {
    const body = m as { requestId: string; frames: ReadonlyArray<{ stepOffset: number; moveX: number; jump: string }> };
    if (actionSource === null || runtime === null) {
      bridge.sendInputResult(playId, body.requestId, { ok: false, error: { code: 'not_ready', message: 'the play is not ready' } });
      return;
    }
    const diagnostics = runtime.getDiagnostics();
    const firstStep = (diagnostics.ok ? diagnostics.diagnostics.stepIndex : stepForTest) + 1;
    const accepted = actionSource.beginTest(body.frames, firstStep, (from, to) => {
      bridge.sendInputResult(playId, body.requestId, { ok: true, appliedFromStep: from, appliedToStep: to });
    });
    if (!accepted) {
      bridge.sendInputResult(playId, body.requestId, { ok: false, error: { code: 'input_relay_conflict', message: 'a relay is already active' } });
    }
  });

  bridge.on('tl.screenshot.request', (m) => {
    const body = m as { relayId: string; maxWidth?: number };
    if (renderer === null || runtime === null) {
      bridge.sendScreenshotResult(playId, body.relayId, { ok: false, error: { code: 'not_ready' } });
      return;
    }
    try {
      renderer.render(runtime);
      const shot = renderer.capture(body.maxWidth ?? 1024);
      bridge.sendScreenshotResult(playId, body.relayId, { ok: true, dataUrl: shot.dataUrl, width: shot.width, height: shot.height });
    } catch (e) {
      bridge.sendScreenshotResult(playId, body.relayId, { ok: false, error: { code: 'screenshot_failed', message: e instanceof Error ? e.message.slice(0, 256) : 'capture failed' } });
    }
  });

  bridge.on('tl.diagnostics.request', (m) => {
    const body = m as { relayId: string };
    if (runtime === null) {
      bridge.sendDiagnosticsResult(playId, body.relayId, { ok: false, error: { code: 'not_ready' } });
      return;
    }
    const rd = runtime.getDiagnostics();
    const diagnostics = {
      runtime: rd.ok ? rd.diagnostics : { error: rd.error.code },
      renderer: renderer !== null ? renderer.diagnostics() : null,
      input: browserInput?.unavailable() ?? null,
      buildId: manifest?.buildId ?? null,
      frameDrops: bridge.drops,
    };
    bridge.sendDiagnosticsResult(playId, body.relayId, { ok: true, diagnostics });
  });

  bridge.on('tl.play.stop', () => {
    disposePlay();
    bridge.sendStopped(playId);
  });

  bridge.on('tl.ping', () => {
    bridge.sendPong();
  });

  const onMsg = (ev: MessageEvent): void => {
    bridge.handleMessage({ origin: ev.origin, source: ev.source, data: ev.data });
  };
  window.addEventListener('message', onMsg);
}

// The preview bundle entry: bootstrap immediately on load.
bootstrapPreview();
