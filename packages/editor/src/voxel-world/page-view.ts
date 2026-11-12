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
import { createOcclusionFrame, fineBricksFromUrl, occlusionFromUrl, shadowSeesCutaways, RELIEF_TEST_SIZE, reliefTestHeights, type OcclusionFrame, voxelStandInLook, voxelTestRelief, type VoxelFarView, type VoxelMaterialLook, type VoxelSurface, type VoxelSurfaceOptions } from '@thirdlight/three-adapter';
import { FAR_BRICK_BUILD, FAR_FIELD_MODES, farViewOf, reliefFade, setFineBricks, VOXEL_SIZE_M, VOXEL_STREAM_BUDGET_BYTES, type FarDrawKind, type FarFieldMode, type FloatingOrigin, type ReliefRingSettings, type StreamRelief, type VoxelStreamer } from '@thirdlight/voxel';
import { engineQualityLevel, resolveVoxelWorld, type ResolvedVoxelWorld } from '@thirdlight/project-model/voxel-world';

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
    // Absent: the quality level's, as Play draws it (`?relief=0`: none).
    n: n === null || n === 'tier' ? 'tier' : Number(n),
    radiusM: radius === null ? null : Number(radius),
    fade: params.get('reliefFade')?.split(',').map(Number) ?? null,
    displace: params.get('displace') !== '0',
    bump: params.get('bump') !== '0',
  };
}

/** What a quality level gives the page's world, as a scene with no distances of its own resolves it: the stream budget and the relief ring (cells). */
export function pageLevel(quality: string, p: ReliefParams): { readonly id: string; readonly budgetBytes: number; readonly relief: ReliefRingSettings; readonly far: ResolvedVoxelWorld['far'] } {
  const level = engineQualityLevel(quality);
  const s = resolveVoxelWorld({ world: 'page' }, level);
  const radiusM = p.radiusM ?? s.levels.relief;
  const n = p.n === null ? 0 : p.n === 'tier' ? s.reliefSteps : p.n;
  return { id: level.id, budgetBytes: s.budgetBytes ?? VOXEL_STREAM_BUDGET_BYTES.low, relief: { n, radius: n === 0 ? 0 : radiusM / VOXEL_SIZE_M }, far: s.far };
}

/**
 * The page's far field switch (`?farField=bricks|mesh|off`, default the quality level's mode), detail
 * (`?farError=` pixels, default the level's) and the bricks' half-resolution march (`?farRes=half`, off by
 * default): what the streamer's far field and the view are made with.
 */
export function pageFar(params: URLSearchParams, level: Pick<ReturnType<typeof pageLevel>, 'far'>): { enabled: boolean; draw?: FarDrawKind; errorPixels: number; pinned: boolean; fine: boolean } {
  const asked = params.get('farField');
  const mode = (FAR_FIELD_MODES as readonly string[]).includes(asked ?? '') ? (asked as FarFieldMode) : null;
  const error = params.get('farError');
  const retired = RETIRED_FAR_PARAMS.filter((k) => params.has(k));
  if (retired.length > 0) console.warn(`voxel world page: ${retired.map((k) => `?${k}`).join(', ')} ignored: ${RETIRED_FAR_SWITCHES}`);
  // `?fineBricks=1`: fine far bricks past the detail ring (WebGPU; the page leaves it off on WebGL 2).
  return { ...farViewOf(mode ?? level.far.mode), errorPixels: error === null ? level.far.errorPixels : Number(error), pinned: mode !== null || error !== null, fine: fineBricksFromUrl(`?${params.toString()}`) };
}

/** The page's far brick switches from before one build was chosen: refused (the URL's ignored with a warning, the hook's an error). */
const RETIRED_FAR_PARAMS = ['farBricks', 'farShade', 'farMarch', 'farRes'] as const;
const RETIRED_FAR_SWITCHES = 'the far bricks have one build (faces from the children), one shading (baked), one march (a node a box) at full resolution';

/** WASD walks the view's target over the ground at 30 m/s along the view's yaw (`dt` ms). */
export function walkByKeys(keys: ReadonlySet<string>, view: { readonly yaw: number }, target: { x: number; z: number }, dt: number): void {
  if (!(keys.has('w') || keys.has('s') || keys.has('a') || keys.has('d'))) return;
  const step = (dt / 1000) * 30;
  const f = (keys.has('w') ? -1 : 0) + (keys.has('s') ? 1 : 0);
  const s = (keys.has('d') ? 1 : 0) + (keys.has('a') ? -1 : 0);
  target.x += (Math.sin(view.yaw) * f + Math.cos(view.yaw) * s) * step;
  target.z += (Math.cos(view.yaw) * f - Math.sin(view.yaw) * s) * step;
}

/**
 * The hook's far field controls: on or off, its mode (`mode`: bricks, mesh or off, switched without a reload), its
 * detail (pixels a far node's cell may cover), and a wait until it draws its selection. The retired brick switches
 * (`bricks`, `shade`, `march`, `res`: the half-resolution march) are refused.
 */
export function pageFarHooks(streamer: VoxelStreamer, view: Pick<VoxelFarView, 'setVisible' | 'checkFine' | 'solidAt' | 'setFineTextured'>): { setFar(o: { enabled?: boolean; errorPixels?: number; mode?: FarFieldMode; fine?: boolean; fineTextured?: boolean }): void; settleFar(): Promise<void>; showFar(on: boolean): void; checkFine(n: number): void; farSolidAt(x: number, y: number, z: number): { level: number; inside: boolean } | null } {
  return {
    setFar: (o) => {
      const { mode, fine, fineTextured, ...rest } = o;
      // Fine bricks textured or in the palette's colours (a comparison on the page's draws alone).
      if (fineTextured !== undefined) view.setFineTextured(fineTextured);
      // Fine far bricks (levels 0–1 past the detail ring, built on the GPU): the near field's levels 1–2 go with them.
      if (fine !== undefined) setFineBricks(streamer, fine);
      const retired = RETIRED_FAR_PARAMS.map((k) => (k === 'farBricks' ? 'bricks' : k === 'farShade' ? 'shade' : k === 'farMarch' ? 'march' : 'res')).filter((k) => k in rest);
      if (retired.length > 0) throw new Error(`setFar: ${retired.join(', ')} retired: ${RETIRED_FAR_SWITCHES}`);
      if (mode !== undefined || Object.keys(rest).length > 0) streamer.far?.setView({ ...rest, ...(mode !== undefined ? farViewOf(mode) : {}) });
    },
    settleFar: async () => {
      await streamer.far?.settle();
    },
    // Hides the far draws without changing what the far field selects (a picture of the near field alone).
    showFar: (on) => view.setVisible(on),
    // The next fine builds are checked against the CPU build of the same blocks (`state().far.fineBuild.checks`).
    checkFine: (n) => view.checkFine(n),
    // The far node drawn at a cell and whether its bricks hold the cell inside their solid (null: none drawn there).
    farSolidAt: (x, y, z) => view.solidAt(x, y, z),
  };
}

/** What the far field selects, holds and draws (the hook's `state().far`; null: the page has none). */
export function pageFarState(streamer: Pick<VoxelStreamer, 'far'>, view: VoxelFarView): Record<string, unknown> | null {
  if (streamer.far === null) return null;
  return { ...streamer.far.metrics(), fineBuild: view.fineState, fineBaked: { drawn: [...view.fineDrawn], read: view.fineBakedIn }, brickBuild: FAR_BRICK_BUILD, pass: view.brickPass, trims: view.trims, recoloured: view.recoloured, recolourMs: view.recolourMs, gpuBytes: view.bytes, triangles: view.triangles, bricks: view.bricks, draws: view.draws, drawnNodes: view.nodes, rebuilds: view.rebuilds, buildMs: view.lastBuildMs, visible: view.visible, cover: view.coverState };
}

/** The hook's `setQuality`: the engine level's texel density cap on the arrays (`textures`), its stream budget, with `?relief=tier` its relief ring, and the far field's mode and detail unless the page pins them. */
export function pageQualityHook(textures: (id: string) => unknown, streamer: { budgetBytes: number; readonly far: { setView(o: { enabled?: boolean; errorPixels?: number; gpuBudgetBytes?: number; fineHoldM?: number; draw?: FarDrawKind }): void } | null }, relief: PageRelief, farPinned = false): (id: string) => unknown {
  return (id) => {
    const out = textures(id);
    const l = pageLevel(id, relief.params);
    streamer.budgetBytes = l.budgetBytes;
    relief.setRing(l.relief);
    // The GPU budget is the tier's whatever the page pins: it bounds memory, not the look.
    streamer.far?.setView(farPinned ? { gpuBudgetBytes: l.far.gpuBudgetBytes, ...(l.far.fineHoldM !== undefined ? { fineHoldM: l.far.fineHoldM } : {}) } : { ...farViewOf(l.far.mode), errorPixels: l.far.errorPixels, gpuBudgetBytes: l.far.gpuBudgetBytes, ...(l.far.fineHoldM !== undefined ? { fineHoldM: l.far.fineHoldM } : {}) });
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
    if (s.displace !== undefined && this.box !== null) this.box.checked = s.displace;
  }

  private box: HTMLInputElement | null = null;

  /** The page's relief switch: relief moved by the heights (checked) or its mesh drawn flat, to compare the two. */
  toggle(): HTMLLabelElement {
    const label = document.createElement('label');
    label.style.cssText = 'position:fixed;right:8px;bottom:8px;padding:2px 6px;background:rgba(0,0,0,.55);color:#fff;font:12px system-ui,sans-serif;border-radius:4px';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = this.on.displace;
    box.setAttribute('aria-label', 'relief');
    box.addEventListener('change', () => this.set({ displace: box.checked }));
    this.box = box;
    label.append(box, ' relief');
    return label;
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
    // Relief chunks cast from their plain surfaces, drawn off the view.
    shadowSeesCutaways(cam);
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

/** A picker of the cell under a screen point among `pickable()`: the one behind the hit surface (dig) or in front of it (add). */
export function cellPicker(camera: THREE.Camera, pickable: () => THREE.Object3D[], origin: FloatingOrigin): (px: number, py: number, mode: 'dig' | 'add') => [number, number, number] | null {
  const raycaster = new THREE.Raycaster();
  return (px, py, mode) => {
    raycaster.setFromCamera(new THREE.Vector2((px / innerWidth) * 2 - 1, -(py / innerHeight) * 2 + 1), camera);
    const hit = raycaster.intersectObjects(pickable(), false)[0];
    if (hit === undefined || hit.face === null || hit.face === undefined) return null;
    const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    const p = hit.point.addScaledVector(n, mode === 'dig' ? -0.25 : 0.25);
    const o = origin.origin;
    return [Math.floor(p.x / VOXEL_SIZE_M) + o.x, Math.floor(p.y / VOXEL_SIZE_M) + o.y, Math.floor(p.z / VOXEL_SIZE_M) + o.z];
  };
}

/**
 * `?occlusion=hiz|off`: the page's frames drawn through the engine's occlusion culler and a scene pass (the pyramid
 * path culls the kit pieces' copies on WebGPU; `off` the same pass without it, to compare); null: no flag, the page
 * draws its scene itself. It follows the window's size.
 */
export function pageOcclusion(renderer: unknown, backend: string, scene: THREE.Scene, camera: THREE.Camera): OcclusionFrame | null {
  const path = occlusionFromUrl(location.search);
  if (path === null) return null;
  const frame = createOcclusionFrame({ renderer: renderer as never, backend: backend === 'webgl2' ? 'webgl2' : 'webgpu', scene, camera, path });
  const fit = (): void => frame.setSize(innerWidth, innerHeight, 1);
  fit();
  addEventListener('resize', fit);
  return frame;
}
