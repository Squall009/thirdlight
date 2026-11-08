/**
 * The voxel world page's view: its relief and sun: the relief switches (`?relief=n|tier`,
 * `?reliefRadius=`, `?reliefFade=a,b`, `?displace=0`, `?bump=0`, see
 * page.ts) turned into the streamer's relief ring and the surface's options and settings, and the sun
 * (`?sun=` elevation, `?shadows=1`), both kept on the camera's target as it
 * moves: the relief ring's fade is centred there, and so is the shadow map;
 * and the page's view input (drag to orbit, wheel to zoom, keys held to
 * move, click to pick, Z to undo).
 */
import * as THREE from 'three';
import { RELIEF_TEST_SIZE, reliefTestHeights, voxelStandInLook, voxelTestRelief, type VoxelMaterialLook, type VoxelSurface, type VoxelSurfaceOptions } from '@thirdlight/three-adapter';
import { reliefFade, VOXEL_SIZE_M, VOXEL_STREAM_BUDGET_BYTES, type ReliefRingSettings, type StreamRelief } from '@thirdlight/voxel';
import { engineQualityLevel, resolveVoxelWorld } from '@thirdlight/project-model/voxel-world';

/** Metres of the sun's shadow map round the focus, and its texels. */
const SHADOW_SPAN_M = 80;
const SHADOW_MAP_TEXELS = 2048;

/** What the page's URL asks of relief (n null: none; 'tier': the quality level's steps and distance). */
export interface ReliefParams {
  readonly n: number | 'tier' | null;
  /** Metres within which relief displaces (null: the quality level's, the engine's default scaled by it). */
  readonly radiusM: number | null;
  readonly fade: readonly number[] | null;
  readonly displace: boolean;
  readonly bump: boolean;
}

export function reliefParams(params: URLSearchParams): ReliefParams {
  const n = params.get('relief');
  const radius = params.get('reliefRadius');
  return {
    n: n === null ? null : n === 'tier' ? 'tier' : Number(n),
    radiusM: radius === null ? null : Number(radius),
    fade: params.get('reliefFade')?.split(',').map(Number) ?? null,
    displace: params.get('displace') !== '0',
    bump: params.get('bump') !== '0',
  };
}

/** What a quality level gives the page's world, as a scene with no distances of its own resolves it: the stream budget and the relief ring (cells). */
export function pageLevel(quality: string, p: ReliefParams): { readonly id: string; readonly budgetBytes: number; readonly relief: ReliefRingSettings } {
  const level = engineQualityLevel(quality);
  const s = resolveVoxelWorld({ world: 'page' }, level);
  const radiusM = p.radiusM ?? s.levels.relief;
  const n = p.n === null ? 0 : p.n === 'tier' ? s.reliefSteps : p.n;
  return { id: level.id, budgetBytes: s.budgetBytes ?? VOXEL_STREAM_BUDGET_BYTES.low, relief: { n, radius: n === 0 ? 0 : radiusM / VOXEL_SIZE_M } };
}

/** The hook's `setQuality`: the engine level's texel density cap on the arrays (`textures`), its stream budget, and with `?relief=tier` its relief ring. */
export function pageQualityHook(textures: (id: string) => unknown, streamer: { budgetBytes: number }, relief: PageRelief): (id: string) => unknown {
  return (id) => {
    const out = textures(id);
    const l = pageLevel(id, relief.params);
    streamer.budgetBytes = l.budgetBytes;
    relief.setRing(l.relief);
    return out;
  };
}

/**
 * The page's relief: the surface options it adds, and the settings it keeps the surface at. The fade follows the
 * streamer's relief ring (where it displaces now, `reliefFade`), so no section the ring holds plain moves.
 */
export class PageRelief {
  private fadeStartM = 0;
  private fadeEndM = 0;
  private n = 0;
  private readonly on: { displace: boolean; bump: boolean };
  private surface: VoxelSurface | null = null;
  private relief: StreamRelief | null = null;
  private readonly focus = new THREE.Vector3();

  constructor(readonly params: ReliefParams) {
    this.on = { displace: params.displace, bump: params.bump };
  }

  /**
   * The surface options: each material's stand-in look with the bench materials' test depths (a material record's
   * own depth wins), relief when asked; under `patterns` (no normal maps to carry heights) the test heights.
   */
  surfaceOptions(patterns: boolean): Pick<VoxelSurfaceOptions, 'look' | 'heights' | 'relief'> {
    const on = this.params.n !== null;
    const look = (m: number): VoxelMaterialLook => {
      const r = voxelTestRelief(m);
      return { ...voxelStandInLook(m), ...(r === null ? {} : { heightDepthMetres: r.depthMetres, ...(on && patterns ? { testHeightLayer: r.layer } : {}) }) };
    };
    return { look, ...(on ? { relief: true, ...(patterns ? { heights: { size: RELIEF_TEST_SIZE, layers: reliefTestHeights() } } : {}) } : {}) };
  }

  /** The surface made with {@link surfaceOptions} and the streamer whose ring it fades with. */
  attach(surface: VoxelSurface, relief: StreamRelief | null, ring: ReliefRingSettings): void {
    this.surface = surface;
    this.relief = relief;
    this.n = ring.n;
    if (this.params.n !== null) surface.setRelief({ n: Math.max(1, ring.n), ...this.on });
  }

  /** A quality level's ring (`?relief=tier`): the streamer meshes it, the surface takes its steps. */
  setRing(ring: ReliefRingSettings): void {
    if (this.params.n !== 'tier' || this.relief === null) return;
    this.relief.set(ring);
    this.n = ring.n;
    if (ring.n > 0) this.surface?.setRelief({ n: ring.n });
  }

  /** The ring's centre (scene metres) moved; the fade follows where the streamer's ring displaces now. */
  follow(x: number, y: number, z: number): void {
    if (this.surface === null || this.params.n === null) return;
    const f = this.params.fade;
    const fade = reliefFade(this.relief?.radius ?? 0);
    const start = f?.[0] ?? fade.start * VOXEL_SIZE_M;
    const end = f?.[1] ?? fade.end * VOXEL_SIZE_M;
    const changed = start !== this.fadeStartM || end !== this.fadeEndM;
    this.fadeStartM = start;
    this.fadeEndM = end;
    this.surface.setRelief({ focus: this.focus.set(x, y, z), ...(changed ? { fadeStartM: start, fadeEndM: end } : {}) });
  }

  set(s: { displace?: boolean; bump?: boolean }): void {
    Object.assign(this.on, s);
    this.surface?.setRelief(s);
  }

  state(ring: Record<string, unknown> | null): Record<string, unknown> | null {
    if (this.params.n === null) return null;
    return { n: this.n, fadeStartM: this.fadeStartM, fadeEndM: this.fadeEndM, depthM: this.surface?.reliefDepthM ?? 0, ...this.on, ring };
  }
}

/** The page's sky light and sun: ~60° high by default, `elevationDeg` lowers it (same azimuth); with `shadows` it casts them round the focus. */
export class PageSun {
  readonly sun = new THREE.DirectionalLight(0xfff2dc, 2.2);
  private readonly dir: THREE.Vector3;

  constructor(
    scene: THREE.Scene,
    elevationDeg: number | null,
    readonly shadows: boolean,
  ) {
    scene.add(new THREE.HemisphereLight(0xdfefff, 0x4a4030, 1.3));
    const sun = this.sun;
    const horizontal = Math.hypot(0.5, 0.3);
    sun.position.set(0.5, elevationDeg === null ? 1 : Math.tan((elevationDeg * Math.PI) / 180) * horizontal, 0.3);
    this.dir = sun.position.clone().normalize();
    scene.add(sun);
    if (!shadows) return;
    sun.castShadow = true;
    sun.shadow.mapSize.set(SHADOW_MAP_TEXELS, SHADOW_MAP_TEXELS);
    const cam = sun.shadow.camera;
    cam.left = cam.bottom = -SHADOW_SPAN_M / 2;
    cam.right = cam.top = SHADOW_SPAN_M / 2;
    cam.near = 1;
    cam.far = 400;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.02;
    scene.add(sun.target);
  }

  /** The focus moved (scene metres): the shadow map follows it. */
  follow(x: number, y: number, z: number): void {
    if (!this.shadows) return;
    this.sun.target.position.set(x, y, z);
    this.sun.position.set(x, y, z).addScaledVector(this.dir, 200);
    this.sun.target.updateMatrixWorld();
  }
}

/** What the view input calls: a click without a drag picks (shift: add), Z undoes, a resize resizes. */
export interface ViewInputActions {
  pick(x: number, y: number, mode: 'dig' | 'add'): void;
  undo(): void;
  resize(): void;
}

/** Binds the page's orbit, zoom and pick input to `view`; returns the keys held now (lower case), for moving. */
export function bindViewInput(canvas: HTMLCanvasElement, view: { yaw: number; pitch: number; distM: number }, act: ViewInputActions): Set<string> {
  const keys = new Set<string>();
  let drag: { x: number; y: number; moved: boolean } | null = null;
  canvas.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, moved: false };
  });
  addEventListener('pointerup', (e) => {
    const d = drag;
    drag = null;
    if (d !== null && !d.moved && e.target === canvas) act.pick(e.clientX, e.clientY, e.shiftKey ? 'add' : 'dig');
  });
  addEventListener('pointermove', (e) => {
    if (drag === null) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    if (!drag.moved) return;
    drag.x = e.clientX;
    drag.y = e.clientY;
    view.yaw -= dx * 0.005;
    view.pitch = Math.min(1.45, Math.max(-0.2, view.pitch + dy * 0.005));
  });
  canvas.addEventListener('wheel', (e) => {
    view.distM = Math.min(400, Math.max(4, view.distM * Math.exp(e.deltaY * 0.001)));
    e.preventDefault();
  });
  addEventListener('keydown', (e) => {
    keys.add(e.key.toLowerCase());
    if (e.key.toLowerCase() === 'z') act.undo();
  });
  addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
  addEventListener('resize', () => act.resize());
  return keys;
}
