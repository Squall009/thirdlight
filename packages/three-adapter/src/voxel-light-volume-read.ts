/**
 * The light volume's read: a light of the scene whose node every lit draw builds after the lights the volume does not
 * hold (probe-lighting.ts orders them), reading the volume's cells round its pixel in place of the held ambient and
 * hemisphere light and the environment's diffuse light. The CPU reference is `volumeReadLevels` (voxel-light-volume-
 * layout.ts); the store, its update and its windows are voxel-light-volume.ts.
 *
 * What a pixel loads: the eight cells round its point half a cell off the surface (on an axis face the far four have
 * weight 0 by the leak rule and are skipped), for each the slot of its brick from the index and its three faces toward
 * the normal; a level whose window holds none of the cells' bricks is not read. Of the eight a surface counts only
 * those on its own side (reached a face step at a time through cells holding light).
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';
import type { N } from './effects-tsl';
import { KEPT_IRRADIANCE } from './probe-lighting';
import { texelTexture } from './texel-texture-node';
import { ambientCubeSteps, VOLUME_BRICK_CELLS, VOLUME_BRICK_TEXELS, VOLUME_FACES, VOLUME_FULL_WEIGHT, VOLUME_INDEX_ROW_BASE, VOLUME_LEFT_MIN, VOLUME_LEVEL_WINDOWS, VOLUME_LEVELS, VOLUME_POOL_WIDTH, VOLUME_PARTICLE_CENTRE_KEY, VOLUME_READ_KEY, VOLUME_READ_KIND_KEY, VOLUME_READ_KINDS, VOLUME_READ_MIN_WEIGHT, VOLUME_READ_OFF_SURFACE, VOLUME_READ_OFFSET_CELLS, VOLUME_WORD, volumeCellM, volumeReadFlag, type VolumeReadFlag, type VolumeReadKind } from './voxel-light-volume-layout';
import { TSL_SCALAR_OPS } from './field-ops';
import { VOXEL_KIT_PIECE_KEY } from './voxel-piece-draw';
import { sunFieldCover } from './voxel-sun-field';

const TSL: N = TSLTyped;
const { Fn, If, cameraPosition, float, int, ivec2, luminance, max, mix, normalWorld, normalWorldGeometry, positionWorld, renderGroup, select, smoothstep, uint, uniform, vec3, vec4, vertexStage } = TSL;

/** What the read reads of the store: its pool and index textures and each level's window corner (uniforms). */
export interface VolumeReadSource {
  readonly pool: THREE.Texture;
  readonly indexTex: THREE.Texture;
  readonly originNodes: readonly N[];
}

/** The volume as a light of the scene: lit programs find its node among their lights (and are built again when it comes). */
export class VoxelVolumeLight extends THREE.Light {
  readonly isVoxelLightVolume = true;
  /** The eye of the last frame drawn (world metres; NaN before one) and the way it looks (unit). */
  readonly eye = [NaN, NaN, NaN];
  readonly forward = [0, 0, -1];
  /** The flat term's share under a roof where the volume holds no light (the tier's `indoorShare`; set each frame). */
  readonly indoorShare: N = uniform(1).setGroup(renderGroup);
  constructor(
    readonly gpu: VolumeReadSource,
    readonly flag: VolumeReadFlag = volumeReadFlag(null),
  ) {
    super(0xffffff, 0);
    this.name = 'voxel light volume';
  }

  /** False: the volume is lit but no surface reads it (a comparison of what reading costs and changes). */
  get read(): boolean {
    return this.flag.read;
  }
}

/** The light node of {@link VoxelVolumeLight}: the surfaces' read, built after every light the volume does not hold. */
class VoxelVolumeLightNode extends (THREE.Node as unknown as new () => { updateType: string; [k: string]: unknown }) {
  static get type(): string {
    return 'VoxelVolumeLightNode';
  }
  readonly isVoxelLightVolumeNode = true;
  private readonly pool: N;
  private readonly index: N;

  constructor(readonly light: VoxelVolumeLight) {
    super();
    this.pool = texelTexture(light.gpu.pool);
    this.index = texelTexture(light.gpu.indexTex);
    this.updateType = TSL.NodeUpdateType.RENDER;
  }

  update(frame: { camera?: THREE.Camera | null }): void {
    const c = frame.camera;
    if (c === null || c === undefined) return;
    const e = this.light.eye;
    const m = c.matrixWorld.elements;
    e[0] = m[12]!;
    e[1] = m[13]!;
    e[2] = m[14]!;
    const len = Math.hypot(m[8]!, m[9]!, m[10]!) || 1;
    this.light.forward[0] = -m[8]! / len;
    this.light.forward[1] = -m[9]! / len;
    this.light.forward[2] = -m[10]! / len;
  }

  setup(builder: N): void {
    const m = builder.material as { userData?: Record<string, unknown> } | undefined;
    const flag = this.light.flag;
    // Every lit draw reads it (voxel surfaces, kit pieces, props, moving objects, lit particles: one light for all) but
    // one that says not to: a screen-space shade whose pixel is not its geometry's (the far field's).
    if (!flag.read || m?.userData?.[VOLUME_READ_KEY] === false || builder.renderer?.backend?.isWebGPUBackend !== true) return;
    const own = m?.userData?.[VOLUME_READ_KIND_KEY];
    const kind: VolumeReadKind = own === 'surface' || own === 'particle' ? own : (builder.object as THREE.Object3D | undefined)?.userData?.[VOXEL_KIT_PIECE_KEY] === true ? 'kit' : 'prop';
    if ((flag.kinds & VOLUME_READ_KINDS[kind]) === 0) return;
    const ctx = builder.context;
    let r: { light: N; weight: N };
    if (kind === 'particle' && !flag.particlePixel) {
      // A lit particle reads once a vertex at its centre, facing the eye, and its pixels take that (particles overdraw:
      // a read a pixel would be paid many times over; across a particle the light changes little).
      const centre = (m?.userData?.[VOLUME_PARTICLE_CENTRE_KEY] as N | undefined) ?? positionWorld;
      const toEye = cameraPosition.sub(centre).normalize();
      const read = Fn(() => {
        const v = volumeReadLevels(this.pool, this.index, this.light.gpu.originNodes, centre, vec3(0), toEye, true, flag);
        return vec4(v.light, v.weight);
      });
      const at = vertexStage(read());
      r = { light: at.xyz, weight: at.w };
    } else {
      r = volumeReadLevels(this.pool, this.index, this.light.gpu.originNodes, positionWorld, normalWorldGeometry.normalize(), normalWorld, false, flag);
    }
    const w = r.weight;
    const replaced = ctx.irradiance.sub(KEPT_IRRADIANCE).add(ctx.iblIrradiance);
    const darker = luminance(r.light).div(max(luminance(replaced), float(1e-4))).clamp(0, 1);
    // What the volume leaves (1 − w) keeps the flat term; under a roof only its indoor share of it (a surface lit by the
    // volume is not changed: w is 1 there). Particles read at their centres and keep the plain term.
    const covered = kind === 'particle' ? null : sunFieldCover(builder, positionWorld, normalWorldGeometry);
    const k = covered === null ? float(1) : mix(float(1), this.light.indoorShare, covered);
    ctx.radiance.mulAssign(mix(k, darker, w));
    ctx.irradiance.assign(mix(KEPT_IRRADIANCE.add(ctx.irradiance.sub(KEPT_IRRADIANCE).mul(k)), KEPT_IRRADIANCE.add(r.light), w));
    ctx.iblIrradiance.mulAssign(w.oneMinus().mul(k));
  }
}

/** A pool word's light (TSL; the CPU twin is `volumeDecode`). */
function decodeNode(w: N): N {
  const scale = TSL.exp2(float(w.shiftRight(uint(27))).sub(VOLUME_WORD.expBias + VOLUME_WORD.mantissaBits));
  return vec3(float(w.bitAnd(uint(511))), float(w.shiftRight(uint(9)).bitAnd(uint(511))), float(w.shiftRight(uint(18)).bitAnd(uint(511)))).mul(scale);
}

/** A word's light for the read's probe: decoded, or (`nodecode`, a comparison) its low bits as a plain number. */
function wordLight(w: N, probe: VolumeReadFlag['probe']): N {
  return probe === 'nodecode' ? vec3(float(w.bitAnd(uint(511))).mul(1 / 511)) : decodeNode(w);
}

/** What one level's read takes: its pool, index and window corner, the point, its normals, and the read's options. */
interface LevelRead {
  readonly level: number;
  readonly pool: N;
  readonly index: N;
  readonly origin: N;
  readonly p: N;
  readonly ng: N;
  readonly n: N;
  /** The one cell the point lies in, alone (a lit particle's read at its centre; never a surface's). */
  readonly nearest: boolean;
  /** A surface's read (cells across a solid one from it are not counted); false: a particle's, read at its centre. */
  readonly surface: boolean;
  readonly flag: VolumeReadFlag;
}

/**
 * The surfaces' read of one level (TSL; the CPU reference is `volumeReadAt`): the light at `p` facing `n` from the
 * eight cells of the level round the point half a cell off it along `ng`, weighted trilinearly, only those holding
 * light counted, and the weight of those. A level whose window holds none of the bricks the eight cells lie in is not
 * read at all (its weight is 0 there anyway).
 *
 * Each cell is its own copy of the code with its own index load and all three faces toward the normal, at every
 * distance. A shorter program (the eight cells as one loop sharing the first cell's index load, only the faces with a
 * weight loaded, and one cell alone past a distance) drew white, green, magenta and black pixels on roofs, gables and
 * the ground by walls on the integrated GPU, while every value it computed, tested in the same program, was finite and
 * in range and the cells it read held sane light; this form draws none.
 */
function volumeRead(r: LevelRead): { light: N; weight: N; known: N } {
  const { level, pool, index, origin, p, ng, n, flag } = r;
  const cellM = volumeCellM(level);
  const win = VOLUME_LEVEL_WINDOWS[level]!;
  const tag = `tlVolume${level}`;
  const q = p.add(ng.mul(VOLUME_READ_OFFSET_CELLS * cellM)).div(cellM);
  const g = q.sub(0.5);
  const i0 = g.floor().toVar(`${tag}Cell`);
  const f = g.sub(i0).toVar(`${tag}Frac`);
  const sum = vec3(0).toVar(`${tag}Sum`);
  const ws = float(0).toVar(`${tag}Weights`);
  // Each cell's light and weight, and a bit a cell holding light (k = x + 2y + 4z of the eight), counted once the
  // cells a surface may read are known (volumeReadReach).
  const lights = Array.from({ length: 8 }, (_, k) => vec3(0).toVar(`${tag}Light${k}`));
  const weights = Array.from({ length: 8 }, (_, k) => float(0).toVar(`${tag}W${k}`));
  const held = uint(0).toVar(`${tag}Held`);
  // The weight of the cells the level knows (in its window, in a kept brick), whether they hold light or not.
  const known = float(0).toVar(`${tag}Known`);
  const dims = vec3(win[0], win[1], win[2]);
  const face = [select(n.x.lessThan(0), uint(1), uint(0)), select(n.y.lessThan(0), uint(3), uint(2)), select(n.z.lessThan(0), uint(5), uint(4))];
  const word = (base: N, faceIndex: N): N => {
    const i = base.add(faceIndex);
    return pool.load(ivec2(int(i.mod(uint(VOLUME_POOL_WIDTH))), int(i.div(uint(VOLUME_POOL_WIDTH))))).x;
  };
  // A cell (world cell coordinates, float) of weight `w`, the `k`th of the eight: its brick's slot from the index (none
  // outside the window), its faces toward the normal; it holds light when its words are not 0 (all or none).
  const cell = (c: N, w: N, k: number): void => {
    const b = c.div(VOLUME_BRICK_CELLS).floor();
    const inside = b.greaterThanEqual(origin).all().and(b.lessThan(origin.add(dims)).all());
    If(inside, () => {
      const s = b.sub(dims.mul(b.div(dims).floor()));
      const slot = index.load(ivec2(int(s.x.add(s.z.mul(win[0]))), int(s.y).add(VOLUME_INDEX_ROW_BASE[level]!))).x;
      If(slot.greaterThan(uint(0)), () => {
        known.addAssign(w);
        const l = c.sub(b.mul(VOLUME_BRICK_CELLS));
        const local = uint(l.x.add(l.y.mul(VOLUME_BRICK_CELLS)).add(l.z.mul(VOLUME_BRICK_CELLS * VOLUME_BRICK_CELLS)));
        const base = slot.sub(uint(1)).mul(uint(VOLUME_BRICK_TEXELS)).add(local.mul(uint(VOLUME_FACES))).toVar();
        if (flag.probe === 'index') {
          lights[k]!.assign(vec3(0.3));
          weights[k]!.assign(w);
          held.bitOrAssign(uint(1 << k));
          return;
        }
        const wx = word(base, face[0]).toVar();
        If(wx.notEqual(uint(0)), () => {
          const lx = wordLight(wx, flag.probe);
          const ly = wordLight(word(base, face[1]), flag.probe);
          const lz = wordLight(word(base, face[2]), flag.probe);
          lights[k]!.assign(ambientCubeSteps(TSL_SCALAR_OPS, n.x, n.y, n.z, [lx, lx, ly, ly, lz, lz]));
          weights[k]!.assign(w);
          held.bitOrAssign(uint(1 << k));
        });
      });
    });
  };
  const b0 = i0.div(VOLUME_BRICK_CELLS).floor();
  const b1 = i0.add(1).div(VOLUME_BRICK_CELLS).floor();
  // The level's window holds one of the bricks the eight cells lie in.
  If(b1.greaterThanEqual(origin).all().and(b0.lessThan(origin.add(dims)).all()), () => {
    if (r.nearest) {
      cell(q.floor(), float(1), 0);
      sum.assign(lights[0]!.mul(weights[0]!));
      ws.assign(weights[0]!);
      return;
    }
    for (let k = 0; k < 8; k++) {
      const pick = (a: 'x' | 'y' | 'z', bit: number): N => (((k >> bit) & 1) === 1 ? f[a] : f[a].oneMinus());
      const w = pick('x', 0).mul(pick('y', 1)).mul(pick('z', 2));
      If(w.greaterThan(VOLUME_READ_MIN_WEIGHT), () => cell(i0.add(vec3((k >> 0) & 1, (k >> 1) & 1, (k >> 2) & 1)), w, k));
    }
    const counted = r.surface ? reach(held, f, ng, tag) : held;
    for (let k = 0; k < 8; k++) {
      const on = float(counted.shiftRight(uint(k)).bitAnd(uint(1)));
      sum.addAssign(lights[k]!.mul(weights[k]!.mul(on)));
      ws.addAssign(weights[k]!.mul(on));
    }
  });
  return { light: sum.div(max(ws, float(1e-4))), weight: ws, known };
}

/**
 * The cells of the eight a surface counts (TSL; the CPU twin is `volumeReadReach`): those a face step at a time from the
 * cell its point lies in through cells holding light (`held`: a bit a cell, k = x + 2y + 4z), or, where that cell holds
 * none, from another holding light: first one reached by steps off the surface alone, most toward the normal less the
 * point's distance to it, else the nearest; so a cell across a solid one (a roof's step, a turned wall's staircase, a
 * room's inner corner) is never read from the other side.
 */
function reach(held: N, f: N, ng: N, tag: string): N {
  const b = vec3(select(f.x.greaterThanEqual(0.5), float(1), float(0)), select(f.y.greaterThanEqual(0.5), float(1), float(0)), select(f.z.greaterThanEqual(0.5), float(1), float(0)));
  const k0 = uint(b.x).add(uint(b.y).mul(uint(2))).add(uint(b.z).mul(uint(4))).toVar(`${tag}K0`);
  const has = (m: N, k: N): N => m.shiftRight(k).bitAnd(uint(1)).equal(uint(1));
  const seed = uint(0).toVar(`${tag}Seed`);
  If(has(held, k0), () => {
    seed.assign(uint(1).shiftLeft(k0));
  }).Else(() => {
    const axes = ['x', 'y', 'z'] as const;
    // Per axis: a step's move along the normal (a cell's middle, toward the box's other half), the point's distance to
    // that half, and whether the normal has a part on the axis (a step off the surface).
    const toward = axes.map((a) => ng[a].mul(b[a].mul(-2).add(1)));
    const away = axes.map((a) => f[a].sub(0.5).abs());
    const along = axes.map((a) => select(ng[a].abs().lessThan(VOLUME_READ_OFF_SURFACE), float(1), float(0)));
    const best = float(-1e9).toVar(`${tag}Best`);
    for (let k = 0; k < 8; k++) {
      const j = uint(k).bitXor(k0);
      const step = axes.map((_, a) => float(j.shiftRight(uint(a)).bitAnd(uint(1))));
      const sum = (v: N[]): N => v[0]!.mul(step[0]!).add(v[1]!.mul(step[1]!)).add(v[2]!.mul(step[2]!));
      const far = sum(away);
      // Off the surface first (ranks above −4), then by nearness alone (below it).
      const rank = select(sum(along).greaterThan(0), far.add(4).negate(), sum(toward).sub(far));
      If(j.notEqual(uint(0)).and(has(held, uint(k))).and(rank.greaterThan(best)), () => {
        best.assign(rank);
        seed.assign(uint(1 << k));
      });
    }
  });
  const m = seed.toVar(`${tag}Reach`);
  // A shortest way between two of the eight through some of them is at most four steps (the longest path of a cube's
  // corners that never passes beside itself).
  for (let step = 0; step < 4; step++) {
    const spread = m.bitAnd(uint(0x55)).shiftLeft(uint(1)).bitOr(m.bitAnd(uint(0xaa)).shiftRight(uint(1)))
      .bitOr(m.bitAnd(uint(0x33)).shiftLeft(uint(2))).bitOr(m.bitAnd(uint(0xcc)).shiftRight(uint(2)))
      .bitOr(m.bitAnd(uint(0x0f)).shiftLeft(uint(4))).bitOr(m.bitAnd(uint(0xf0)).shiftRight(uint(4)));
    m.assign(held.bitAnd(m.bitOr(spread)));
  }
  return m;
}

/**
 * The read over the levels (TSL; the CPU reference is `volumeReadLevels`): level 0, then each coarser level for what the
 * finer ones left (a level takes the smooth step to {@link VOLUME_FULL_WEIGHT} of what is left: a surface's of the
 * weight of the cells the level knows where it reads some light, a particle's of its weight; a coarse level is not read
 * once less than {@link VOLUME_LEFT_MIN} is left, so a surface beside its 0.5 m cells reads only them).
 * Returns the light and the weight it holds (0: no level holds light here; the flat term stays).
 */
function volumeReadLevels(pool: N, index: N, origins: readonly N[], p: N, ng: N, n: N, nearest: boolean, flag: VolumeReadFlag): { light: N; weight: N } {
  const acc = vec3(0).toVar('tlVolumeLight');
  const left = float(1).toVar('tlVolumeLeft');
  const first = flag.levels === 'coarse' ? 1 : 0;
  const last = flag.levels === 'level0' ? 1 : VOLUME_LEVELS;
  for (let level = first; level < last; level++) {
    const read = (): void => {
      const r = volumeRead({ level, pool, index, origin: origins[level]!, p, ng, n, nearest: nearest && level === 0, surface: !nearest, flag });
      // A surface's level takes its share by the cells it knows where it reads some light (the CPU twin's rule).
      const by = nearest ? r.weight : select(r.weight.greaterThan(0), r.known, float(0));
      const a = smoothstep(float(0), float(VOLUME_FULL_WEIGHT), by);
      acc.addAssign(r.light.mul(a.mul(left)));
      left.mulAssign(a.oneMinus());
    };
    if (level === first) read();
    else If(left.greaterThan(VOLUME_LEFT_MIN), read);
  }
  const weight = left.oneMinus().toVar('tlVolumeWeight');
  return { light: acc.div(max(weight, float(1e-4))), weight };
}

/** Teach a renderer the volume's light. */
export function registerVoxelLightVolume(): void {
  VoxelVolumeLight.registerNode(VoxelVolumeLightNode as never);
}
