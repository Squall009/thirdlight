/**
 * The light volume's read: a light of the scene whose node every lit draw builds after the lights the volume does not
 * hold (probe-lighting.ts orders them), reading the volume's cells round its pixel in place of the held ambient and
 * hemisphere light and the environment's diffuse light. The CPU reference is `volumeReadLevels` (voxel-light-volume-
 * layout.ts); the store, its update and its windows are voxel-light-volume.ts.
 *
 * What a pixel loads, and why it is few: the eight cells round its point half a cell off the surface (on an axis face
 * the far four have weight 0 by the leak rule and are skipped), for each the slot of its brick from the index (one load
 * shared by every cell in the first cell's brick: eight cells lie in one brick unless the point is in a brick's last
 * cell along an axis), then only the faces the normal takes a weight from (`ambientCubeFaceWeights` with the tier's
 * face floor: one on an axis face, two or three on a slope).
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';
import type { N } from './effects-tsl';
import { KEPT_IRRADIANCE } from './probe-lighting';
import { texelTexture } from './texel-texture-node';
import { ambientCubeFaceWeights, ambientCubeSteps, VOLUME_BRICK_CELLS, VOLUME_BRICK_TEXELS, VOLUME_FACES, VOLUME_FULL_WEIGHT, VOLUME_INDEX_ROW_BASE, VOLUME_LEFT_MIN, VOLUME_LEVEL_WINDOWS, VOLUME_LEVELS, VOLUME_POOL_WIDTH, VOLUME_PARTICLE_CENTRE_KEY, VOLUME_READ_KEY, VOLUME_READ_KIND_KEY, VOLUME_READ_KINDS, VOLUME_READ_OFFSET_CELLS, VOLUME_WORD, volumeCellM, volumeReadFlag, type VolumeReadFlag, type VolumeReadKind } from './voxel-light-volume-layout';
import { TSL_SCALAR_OPS } from './field-ops';
import { VOXEL_KIT_PIECE_KEY } from './voxel-piece-draw';
import { sunFieldCover } from './voxel-sun-field';

const TSL: N = TSLTyped;
const { Fn, If, Loop, bool, cameraPosition, float, int, ivec2, luminance, max, mix, normalWorld, normalWorldGeometry, positionWorld, renderGroup, select, smoothstep, uint, uniform, vec3, vec4, vertexStage } = TSL;

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
  /** The face floor of the read (the tier's `readFaceFloor`; set by the store each frame). */
  readonly faceFloor: N = uniform(0).setGroup(renderGroup);
  /** Metres from the eye within which level 0 is read from its eight cells (the tier's `readFullM`; set each frame). */
  readonly fullM: N = uniform(1e9).setGroup(renderGroup);
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
        const v = volumeReadLevels(this.pool, this.index, this.light.gpu.originNodes, centre, vec3(0), toEye, this.light.faceFloor, bool(true), flag);
        return vec4(v.light, v.weight);
      });
      const at = vertexStage(read());
      r = { light: at.xyz, weight: at.w };
    } else {
      const nearest = positionWorld.sub(cameraPosition).length().greaterThan(this.light.fullM);
      r = volumeReadLevels(this.pool, this.index, this.light.gpu.originNodes, positionWorld, normalWorldGeometry.normalize(), normalWorld, this.light.faceFloor, nearest, flag);
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
  readonly faceFloor: N;
  /** True where level 0 reads its nearest cell alone (past the tier's `readFullM`). */
  readonly nearest: N;
  readonly flag: VolumeReadFlag;
}

/**
 * The surfaces' read of one level (TSL; the CPU reference is `volumeReadAt`): the light at `p` facing `n`, from the
 * eight cells of the level round the point half a cell off it along `ng`, and the weight of those holding light. A
 * level whose window holds none of the eight bricks they can lie in is not read at all (its weight is 0 there anyway);
 * the eight cells are one loop, not eight copies of the code; past `readFullM` level 0 reads the cell the point half a
 * cell off the surface lies in, alone (the cell in front of an axis face: on its own side of any wall).
 */
function volumeRead(r: LevelRead): { light: N; weight: N } {
  const { level, pool, index, origin, p, ng, n, faceFloor, flag } = r;
  if (flag.allFaces) return volumeReadAsBuilt(r);
  const cellM = volumeCellM(level);
  const win = VOLUME_LEVEL_WINDOWS[level]!;
  const tag = `tlVolume${level}`;
  const q = p.add(ng.mul(VOLUME_READ_OFFSET_CELLS * cellM)).div(cellM).toVar(`${tag}Point`);
  const g = q.sub(0.5);
  const i0 = g.floor().toVar(`${tag}Cell`);
  const f = g.sub(i0).toVar(`${tag}Frac`);
  const sum = vec3(0).toVar(`${tag}Sum`);
  const ws = float(0).toVar(`${tag}Weights`);
  const dims = vec3(win[0], win[1], win[2]);
  const face = [select(n.x.lessThan(0), uint(1), uint(0)), select(n.y.lessThan(0), uint(3), uint(2)), select(n.z.lessThan(0), uint(5), uint(4))];
  const fw = ambientCubeFaceWeights(TSL_SCALAR_OPS, n.x, n.y, n.z, faceFloor).map((v, a) => (v as N).toVar(`${tag}Face${a}`));
  const word = (base: N, faceIndex: N): N => {
    const i = base.add(faceIndex);
    return pool.load(ivec2(int(i.mod(uint(VOLUME_POOL_WIDTH))), int(i.div(uint(VOLUME_POOL_WIDTH))))).x;
  };
  // A brick's slot + 1 (0: none, or outside the level's window).
  const slotOf = (b: N): N => {
    const inside = b.greaterThanEqual(origin).all().and(b.lessThan(origin.add(dims)).all());
    const s = b.sub(dims.mul(b.div(dims).floor()));
    const slot = index.load(ivec2(int(s.x.add(s.z.mul(win[0]))), int(s.y).add(VOLUME_INDEX_ROW_BASE[level]!))).x;
    return select(inside, slot, uint(0));
  };
  const b0 = i0.div(VOLUME_BRICK_CELLS).floor().toVar(`${tag}Brick`);
  const b1 = i0.add(1).div(VOLUME_BRICK_CELLS).floor();
  // A cell (world cell coordinates, float) of weight `w`: its slot (shared with the first cell's brick), its faces.
  const cell = (c: N, w: N, slot0: N): void => {
    const b = c.div(VOLUME_BRICK_CELLS).floor();
    const slot = slot0.toVar();
    If(b.notEqual(b0).any(), () => slot.assign(slotOf(b)));
    If(slot.greaterThan(uint(0)), () => {
      const l = c.sub(b.mul(VOLUME_BRICK_CELLS));
      const local = uint(l.x.add(l.y.mul(VOLUME_BRICK_CELLS)).add(l.z.mul(VOLUME_BRICK_CELLS * VOLUME_BRICK_CELLS)));
      const base = slot.sub(uint(1)).mul(uint(VOLUME_BRICK_TEXELS)).add(local.mul(uint(VOLUME_FACES))).toVar();
      if (flag.probe === 'index') {
        sum.addAssign(vec3(0.3).mul(w));
        ws.addAssign(w);
        return;
      }
      // Only the faces the normal takes a weight from; a cell holds light when its words are not 0 (all or none).
      const e = vec3(0).toVar();
      const held = float(0).toVar();
      for (let a = 0; a < 3; a++) {
        If(fw[a]!.greaterThan(0), () => {
          const wd = word(base, face[a]).toVar();
          held.assign(max(held, select(wd.notEqual(uint(0)), float(1), float(0))));
          e.addAssign(wordLight(wd, flag.probe).mul(fw[a]!));
        });
      }
      sum.addAssign(e.mul(w.mul(held)));
      ws.addAssign(w.mul(held));
    });
  };
  // The level's window holds one of the bricks the eight cells lie in.
  If(b1.greaterThanEqual(origin).all().and(b0.lessThan(origin.add(dims)).all()), () => {
    const slot0 = slotOf(b0).toVar(`${tag}Slot`);
    const loop = (): void => {
      Loop(8, ({ i }: { i: N }) => {
        const bits = vec3(float(i.bitAnd(1)), float(i.shiftRight(1).bitAnd(1)), float(i.shiftRight(2).bitAnd(1)));
        const fk = mix(f.oneMinus(), f, bits);
        const w = fk.x.mul(fk.y).mul(fk.z);
        If(w.greaterThan(1e-4), () => cell(i0.add(bits), w, slot0));
      });
    };
    if (level > 0) loop();
    else If(r.nearest, () => cell(q.floor(), float(1), slot0)).Else(loop);
  });
  return { light: sum.div(max(ws, float(1e-4))), weight: ws };
}

/** The read of one level as it was first built (`allfaces`, a comparison): eight copies, an index load and every face toward the normal a cell. */
function volumeReadAsBuilt(r: LevelRead): { light: N; weight: N } {
  const { level, pool, index, origin, p, ng, n, flag } = r;
  const cellM = volumeCellM(level);
  const win = VOLUME_LEVEL_WINDOWS[level]!;
  const tag = `tlVolume${level}`;
  const g = p.add(ng.mul(VOLUME_READ_OFFSET_CELLS * cellM)).div(cellM).sub(0.5);
  const i0 = g.floor().toVar(`${tag}Cell`);
  const f = g.sub(i0).toVar(`${tag}Frac`);
  const sum = vec3(0).toVar(`${tag}Sum`);
  const ws = float(0).toVar(`${tag}Weights`);
  const dims = vec3(win[0], win[1], win[2]);
  const face = [select(n.x.lessThan(0), uint(1), uint(0)), select(n.y.lessThan(0), uint(3), uint(2)), select(n.z.lessThan(0), uint(5), uint(4))];
  const word = (base: N, faceIndex: N): N => {
    const i = base.add(faceIndex);
    return pool.load(ivec2(int(i.mod(uint(VOLUME_POOL_WIDTH))), int(i.div(uint(VOLUME_POOL_WIDTH))))).x;
  };
  for (let k = 0; k < 8; k++) {
    const pick = (a: 'x' | 'y' | 'z', bit: number): N => (((k >> bit) & 1) === 1 ? f[a] : f[a].oneMinus());
    const w = pick('x', 0).mul(pick('y', 1)).mul(pick('z', 2));
    If(w.greaterThan(1e-4), () => {
      const c = i0.add(vec3((k >> 0) & 1, (k >> 1) & 1, (k >> 2) & 1));
      const b = c.div(VOLUME_BRICK_CELLS).floor();
      const inside = b.greaterThanEqual(origin).all().and(b.lessThan(origin.add(dims)).all());
      If(inside, () => {
        const s = b.sub(dims.mul(b.div(dims).floor()));
        const slot = index.load(ivec2(int(s.x.add(s.z.mul(win[0]))), int(s.y).add(VOLUME_INDEX_ROW_BASE[level]!))).x;
        If(slot.greaterThan(uint(0)), () => {
          const l = c.sub(b.mul(VOLUME_BRICK_CELLS));
          const local = uint(l.x.add(l.y.mul(VOLUME_BRICK_CELLS)).add(l.z.mul(VOLUME_BRICK_CELLS * VOLUME_BRICK_CELLS)));
          const base = slot.sub(uint(1)).mul(uint(VOLUME_BRICK_TEXELS)).add(local.mul(uint(VOLUME_FACES))).toVar();
          if (flag.probe === 'index') {
            sum.addAssign(vec3(0.3).mul(w));
            ws.addAssign(w);
            return;
          }
          const wx = word(base, face[0]).toVar();
          If(wx.notEqual(uint(0)), () => {
            const lx = wordLight(wx, flag.probe);
            const ly = wordLight(word(base, face[1]), flag.probe);
            const lz = wordLight(word(base, face[2]), flag.probe);
            sum.addAssign(ambientCubeSteps(TSL_SCALAR_OPS, n.x, n.y, n.z, [lx, lx, ly, ly, lz, lz]).mul(w));
            ws.addAssign(w);
          });
        });
      });
    });
  }
  return { light: sum.div(max(ws, float(1e-4))), weight: ws };
}

/**
 * The read over the levels (TSL; the CPU reference is `volumeReadLevels`): level 0, then each coarser level for what the
 * finer ones left (a level takes the smooth step of its weight to {@link VOLUME_FULL_WEIGHT} of what is left; a coarse
 * level is not read once less than {@link VOLUME_LEFT_MIN} is left, so a surface beside its 0.5 m cells reads only them).
 * Returns the light and the weight it holds (0: no level holds light here; the flat term stays).
 */
function volumeReadLevels(pool: N, index: N, origins: readonly N[], p: N, ng: N, n: N, faceFloor: N, nearest: N, flag: VolumeReadFlag): { light: N; weight: N } {
  const acc = vec3(0).toVar('tlVolumeLight');
  const left = float(1).toVar('tlVolumeLeft');
  const first = flag.levels === 'coarse' ? 1 : 0;
  const last = flag.levels === 'level0' ? 1 : VOLUME_LEVELS;
  for (let level = first; level < last; level++) {
    const read = (): void => {
      const r = volumeRead({ level, pool, index, origin: origins[level]!, p, ng, n, faceFloor, nearest, flag });
      const a = smoothstep(float(0), float(VOLUME_FULL_WEIGHT), r.weight);
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
