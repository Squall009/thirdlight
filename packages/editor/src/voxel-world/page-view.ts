/**
 * The voxel world page's view: its relief and sun: the relief switches (`?relief=n`,
 * `?reliefRadius=`, `?reliefFade=a,b`, `?displace=0`, `?bump=0`, see
 * page.ts) turned into the surface's options and settings, and the sun
 * (`?sun=` elevation, `?shadows=1`), both kept on the camera's target as it
 * moves: the relief ring's fade is centred there, and so is the shadow map;
 * and the page's view input (drag to orbit, wheel to zoom, keys held to
 * move, click to pick, Z to undo).
 */
import * as THREE from 'three';
import { RELIEF_TEST_SIZE, reliefTestHeights, voxelStandInLook, voxelTestRelief, type VoxelMaterialLook, type VoxelSurface, type VoxelSurfaceOptions } from '@thirdlight/three-adapter';
import { VOXEL_SIZE_M } from '@thirdlight/voxel';

/** Metres of the sun's shadow map round the focus, and its texels. */
const SHADOW_SPAN_M = 80;
const SHADOW_MAP_TEXELS = 2048;
/** Metres over which relief fades out before the ring's edge. */
const RELIEF_FADE_M = 4;

/** What the page's URL asks of relief (n null: none). */
export interface ReliefParams {
  readonly n: number | null;
  readonly radiusM: number;
  readonly fade: readonly number[] | null;
  readonly displace: boolean;
  readonly bump: boolean;
}

export function reliefParams(params: URLSearchParams): ReliefParams {
  const n = params.get('relief');
  return {
    n: n === null ? null : Number(n),
    radiusM: Number(params.get('reliefRadius') ?? 32),
    fade: params.get('reliefFade')?.split(',').map(Number) ?? null,
    displace: params.get('displace') !== '0',
    bump: params.get('bump') !== '0',
  };
}

/** The page's relief: the surface options it adds, and the settings it keeps the surface at. */
export class PageRelief {
  readonly fadeStartM: number;
  readonly fadeEndM: number;
  private readonly on: { displace: boolean; bump: boolean };
  private surface: VoxelSurface | null = null;
  private readonly focus = new THREE.Vector3();

  constructor(
    readonly params: ReliefParams,
    chunkEdge: number,
  ) {
    // The fade ends a chunk's half diagonal inside the ring (chunks whose centre lies within it derive relief), so a
    // chunk at the ring's edge, relief or plain, does not move.
    this.fadeEndM = params.fade?.[1] ?? Math.max(0, params.radiusM - (chunkEdge * VOXEL_SIZE_M * Math.sqrt(3)) / 2);
    this.fadeStartM = params.fade?.[0] ?? Math.max(0, this.fadeEndM - RELIEF_FADE_M);
    this.on = { displace: params.displace, bump: params.bump };
  }

  /** The surface options: each material's stand-in look with its test relief, and the test heights (none without relief). */
  surfaceOptions(): Pick<VoxelSurfaceOptions, 'look' | 'heights'> {
    const n = this.params.n;
    const look = (m: number): VoxelMaterialLook => {
      const r = n === null ? null : voxelTestRelief(m);
      return { ...voxelStandInLook(m), ...(r === null ? {} : { relief: r }) };
    };
    return { look, ...(n === null ? {} : { heights: { size: RELIEF_TEST_SIZE, layers: reliefTestHeights() } }) };
  }

  /** The surface made with {@link surfaceOptions}: given its settings. */
  attach(surface: VoxelSurface): void {
    this.surface = surface;
    if (this.params.n !== null) surface.setRelief({ n: this.params.n, fadeStartM: this.fadeStartM, fadeEndM: this.fadeEndM, ...this.on });
  }

  /** The ring's centre (scene metres) moved. */
  follow(x: number, y: number, z: number): void {
    this.surface?.setRelief({ focus: this.focus.set(x, y, z) });
  }

  set(s: { displace?: boolean; bump?: boolean }): void {
    Object.assign(this.on, s);
    this.surface?.setRelief(s);
  }

  state(): Record<string, unknown> | null {
    const p = this.params;
    return p.n === null ? null : { n: p.n, radiusM: p.radiusM, fadeStartM: this.fadeStartM, fadeEndM: this.fadeEndM, depthM: this.surface?.reliefDepthM ?? 0, ...this.on };
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
