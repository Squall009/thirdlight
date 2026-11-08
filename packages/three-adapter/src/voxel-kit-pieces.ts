/**
 * The meshes a voxel world's kit pieces draw with, as a chunk view asks for
 * them: an instance's piece is kit-local (piece-table.ts: a kit's filled
 * slot), so its mesh is found from its dressing cell's material (its own
 * cell or one beside it, derived-mesh.ts; read from the chunk's shader data), the material's kit in the world's piece table, the
 * kit's slot list (`kitPieceList`) and the instance's variant word (which of
 * the slot's meshes, and the mirror of its case transform).
 *
 * - **A kit's pieces** are its authored GLBs. Their bytes come from the host
 *   (a build's content files, the backend for the editor) and are parsed by
 *   the page's GLB loader port: never fetched by URL here. A mesh still
 *   loading draws nothing until it is there (the view builds the waiting
 *   chunks' pieces again); one that failed draws nothing. A material no kit
 *   binds, or a kit's empty slot, has no piece at all: nothing to draw.
 * - **A slot's mesh** is drawn with its cube rotation, which the view
 *   applies in the instance matrix before the case's turns: one mesh, one
 *   set of GPU buffers, for every slot it fills.
 *
 * Every mesh is in metres for a level-0 cell, centred on the cell; turned by
 * its slot rotation it is in its case's orientation (exposed face +z, run
 * along x, up +y). A mirrored case, or a slot mesh marked `mirror`, draws
 * a mirrored copy of the mesh (the case's x negated, triangles turned so
 * their fronts stay fronts and tangents' handedness flipped: the mesh axis
 * its rotation carries onto the case's x; both at once cancel), so instance
 * matrices never mirror (a cube rotation has determinant +1): one copy a
 * mesh, one draw more a chunk at most.
 * - **What a piece wears** is its kit's one texture set: its GLB's
 *   material (`voxel-kit-look.ts`), the file's images drawn from the texture
 *   assets an import extracted them into (the host's `texture` reader), at
 *   the world-anchored U for a kit with a trim layout. A GLB is read and
 *   parsed once however many of its nodes the kit names. A material with no
 *   image draws a stand-in colour a kit; the labelled debug UV textures (one
 *   cell of UV space, or a trim layout's debug set) only when the page asks
 *   (`debug`). Placed camera-relative in 64 bits like the voxel surface.
 *
 * A piece cut **flush** toward an opening (its instance names faces of its
 * cell) draws a copy of its mesh cut at those faces (voxel `cutFlush`), one
 * copy a mesh, rotation and set of faces.
 *
 * Meshes stay loaded until this is disposed: kits are a few dozen meshes, and a
 * world whose table changes keeps drawing its untouched chunks with the
 * meshes they were built with until they are derived again.
 */
import * as THREE from 'three';
import { MeshLambertNodeMaterial } from 'three/webgpu';
import { kitTrimLayout, voxelKitMeshKey, type TrimLayout, type VoxelKitSheetLayout } from '@thirdlight/project-model';
import { crc32, utf8Encode } from '@thirdlight/shared';
import {
  cutFlush,
  DAMAGE_PIECE_SLOTS,
  kitPieceList,
  meshRunAxis,
  mirrorAxisOf,
  NO_KIT,
  PIECE_VARIANT_MASK,
  PIECE_STAGGER_FRAMES,
  PIECE_VARIANT_MIRROR,
  pieceHalfRun,
  WORLD_RULES,
  worldPieceTable,
  type DamageStagesSource,
  type KitPiece,
  type PieceStaggerFrame,
  type PieceTable,
  VOXEL_SIZE_M,
} from '@thirdlight/voxel';
import { cameraRelative } from './camera-relative';
import { browserCrackDecoder, type CrackImageDecoder } from './voxel-crack-texture';
import { underHelperNode } from './pieces';
import { mergeLayout, mergeWorldGeometry } from './static-merge';
import type { GlbLoaderPort } from './visual';
import { drawGlyphs, trimDebugTexture } from './voxel-trim-debug-texture';
import { kitLookMaterial, kitLookOf, type VoxelKitLook } from './voxel-kit-look';
import { TEXTURE_ASSET_KEY } from './resource-bytes';
import { trimMaterial, trimRunGeometry, trimUPerMetre } from './voxel-trim-u';

/** One authored mesh of a kit: a model asset version by its source digest, optionally one node of it. */
export interface VoxelKitMeshRef {
  readonly assetId: string;
  readonly digest: string;
  readonly node?: string;
}

/** What the view reads of a kit record (project-model's `VoxelKit` fits it). */
export interface VoxelKitRecordLike {
  readonly voxelKitId: string;
  readonly materials?: readonly number[];
  /** The trim layout the kit's UVs follow: its pieces draw with that layout's debug set (absent or unknown: the cell debug texture). */
  readonly trimLayout?: string;
  /** The kit's own sheet layout, instead of a named one (project-model `kitTrimLayout`). */
  readonly sheetLayout?: VoxelKitSheetLayout;
  /** Slot (case id) → its meshes, each with its cube rotation, weight and whether it is drawn mirrored. */
  readonly slots: Readonly<Record<string, { readonly meshes: readonly { readonly mesh: VoxelKitMeshRef; readonly rotation?: number; readonly weight?: number; readonly mirror?: boolean }[] }>>;
  readonly jitter?: number;
  /** Its damage stages (voxel damage-stages.ts) and crack texture (an image whose red channel the crack overlay reads; absent: the engine's). */
  readonly damage?: DamageStagesSource & { readonly crackTexture?: VoxelKitImageRef };
}

/** An image a kit names (its crack texture): an asset version by its source digest. */
export interface VoxelKitImageRef {
  readonly assetId: string;
  readonly digest: string;
}

/** What draws one kit piece: its mesh and material, and a key equal for draws that can share an instanced mesh. */
export interface VoxelKitDraw {
  readonly key: string;
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.Material;
  /** A trim kit's piece (voxel-trim-u.ts): sheet U a metre, the draw gives each instance its world-anchored U offset. */
  readonly uPerMetre?: number;
  /** The cube rotation (cube-rotations.ts) the mesh is turned by first: its slot's. */
  readonly rotation: number;
  /** The axis the mesh runs along in its own space (0 x, 1 y, 2 z): where a trim piece's U grows. */
  readonly runAxis: 0 | 1 | 2;
  /** The drawn case's stagger frame (null: not staggered), what its hash reads (the table's seed, the case's index) and the kit's jitter. */
  readonly stagger: { readonly frame: PieceStaggerFrame; readonly seed: number; readonly caseIndex: number; readonly jitter: number } | null;
  /** How the drawn case's piece covers half its run on an instance flagged `half` (voxel `pieceHalfRun`). */
  readonly halfRun: 'x' | 'diagonal' | null;
  /** The drawn case (a 1:2 roof's edge piece is pitched by it, voxel `roofPitch`) and whether its mesh is mirrored. */
  readonly caseId: string;
  readonly mirror: boolean;
  /** A damage piece: how many its kit spreads over a face toward a hole, and the seed the spread hashes. */
  readonly scatterCount?: number;
  readonly seed?: number;
}

/**
 * A GLB's bytes as the host has them (its version and source digest), or null: not part of this build or project;
 * `textures`: the texture asset each of the file's images was extracted into (image index → asset id).
 */
export type VoxelKitBytes = (ref: VoxelKitMeshRef) => Promise<{ readonly bytes: Uint8Array; readonly version: number; readonly textures?: Readonly<Record<string, string>> } | null>;

/** A texture asset decoded (and held) by the host: what a kit GLB's extracted image draws (null: unavailable, its stand-in draws). */
export type VoxelKitTextures = (assetId: string) => Promise<THREE.Texture | null>;

/** An image's key: its asset and digest. */
function imageKey(m: VoxelKitImageRef): string {
  return `${m.assetId}@${m.digest}`;
}

/** Every image a kit names (its crack texture; each once). */
export function voxelKitImageRefs(kits: readonly VoxelKitRecordLike[]): VoxelKitImageRef[] {
  const out = new Map<string, VoxelKitImageRef>();
  for (const k of kits) if (k.damage?.crackTexture !== undefined) out.set(imageKey(k.damage.crackTexture), k.damage.crackTexture);
  return [...out.values()];
}

/** Every mesh a kit names (each once). */
export function voxelKitMeshRefs(kits: readonly VoxelKitRecordLike[]): VoxelKitMeshRef[] {
  const out = new Map<string, VoxelKitMeshRef>();
  for (const k of kits) for (const c of Object.values(k.slots)) for (const m of c.meshes) out.set(voxelKitMeshKey(m.mesh), m.mesh);
  return [...out.values()];
}

/** Side of the debug UV texture in texels (one cell of UV space; a 1/16-cell checker is 16 texels). */
export const KIT_DEBUG_TEXTURE_SIDE = 256;

/** Checker squares along each side of the debug texture: sixteenths of a cell. */
const DEBUG_CHECKS = 16;

/**
 * The labelled debug UV texture: a 1/16-cell checker over a U (red) and V
 * (green) ramp, a tick line every quarter cell with its number along U,
 * and U and V written at their axes, so a stretched, flipped or offset UV
 * shows at once. Generated, not painted (`KIT_DEBUG_TEXTURE_SIDE`² RGBA).
 */
export function voxelKitDebugTexture(): THREE.DataTexture {
  const n = KIT_DEBUG_TEXTURE_SIDE;
  const px = new Uint8Array(n * n * 4);
  const set = (x: number, y: number, r: number, g: number, b: number): void => {
    if (x < 0 || y < 0 || x >= n || y >= n) return;
    const o = (y * n + x) * 4;
    px[o] = r;
    px[o + 1] = g;
    px[o + 2] = b;
    px[o + 3] = 255;
  };
  const check = n / DEBUG_CHECKS;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dark = ((Math.floor(x / check) + Math.floor(y / check)) & 1) === 0;
      const k = dark ? 0.72 : 1;
      set(x, y, Math.round((150 + (x / n) * 100) * k), Math.round((150 + (y / n) * 100) * k), Math.round(170 * k));
    }
  }
  const glyph = (ch: string, x0: number, y0: number, scale: number): void => drawGlyphs((x, y) => set(x, y, 20, 20, 30), ch, x0, y0, scale, true);
  // Rows run up in V (texture row 0 is V 0: DataTexture is not flipped).
  for (let q = 0; q < 4; q++) {
    const x = (q * n) / 4;
    for (let y = 0; y < n; y++) set(x, y, 30, 30, 40);
    glyph(String(q), x + 4, 6, 4);
  }
  glyph('U', n - 20, 30, 4);
  glyph('V', 6, n - 26, 4);
  const t = new THREE.DataTexture(px, n, n, THREE.RGBAFormat);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/** A mesh mirrored across the plane through 0 normal to `axis` (0 x, 1 y, 2 z), its triangles turned so their fronts stay fronts. */
function mirrored(g: THREE.BufferGeometry, axis: number): THREE.BufferGeometry {
  return mergeWorldGeometry([{ geometry: g, matrixWorld: new THREE.Matrix4().makeScale(axis === 0 ? -1 : 1, axis === 1 ? -1 : 1, axis === 2 ? -1 : 1) }]);
}

/**
 * One mesh (or one node of it) of a parsed GLB, in the file root's space, as one geometry; null without a mesh.
 * Collision and occluder nodes (`_COL`, `_OCC`, the model import convention) are never drawn, as the kit check
 * leaves them out of what it measures.
 */
function glbGeometry(root: THREE.Object3D, node: string | undefined): THREE.BufferGeometry | null {
  let from: THREE.Object3D = root;
  if (node !== undefined) {
    const found = root.getObjectByName(node);
    if (found === undefined) return null;
    from = found;
  }
  root.updateMatrixWorld(true);
  const parts: { geometry: THREE.BufferGeometry; matrixWorld: THREE.Matrix4 }[] = [];
  from.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh === true && m.geometry !== undefined && !underHelperNode(o, root)) parts.push({ geometry: m.geometry, matrixWorld: m.matrixWorld.clone() });
  });
  if (parts.length === 0) return null;
  // The meshes of one layout merge (a piece is one draw); others in the file are left out.
  const layout = mergeLayout(parts[0]!.geometry);
  if (layout === null) return null;
  return mergeWorldGeometry(parts.filter((p) => mergeLayout(p.geometry) === layout));
}

/** Stand-in tints a kit (by a hash of its id), so neighbouring kits read apart: wood, stone, plaster, slate tones. */
const KIT_TINTS = [0xc8a070, 0xb8b4ac, 0xe0d4bc, 0x9098a4, 0xb07850, 0xd0c090];

/** A ready mesh keeps its mirrored copies by the axis mirrored, and the look of its material (null: no image). */
type MeshState = { state: 'loading' } | { state: 'ready'; geometry: THREE.BufferGeometry; mirrored: (THREE.BufferGeometry | undefined)[]; look: VoxelKitLook | null } | { state: 'failed'; reason: string };

/** The first drawn primitive's material under the node a kit names (or the whole file): its look (null: none or no image). */
function glbLook(root: THREE.Object3D, node: string | undefined, looks: Map<THREE.Material, VoxelKitLook | null>): VoxelKitLook | null {
  const from = node === undefined ? root : root.getObjectByName(node);
  let material: THREE.Material | null = null;
  from?.traverse((o) => {
    const m = o as THREE.Mesh;
    if (material === null && m.isMesh === true && !underHelperNode(o, root)) material = (Array.isArray(m.material) ? m.material[0] : m.material) ?? null;
  });
  if (material === null) return null;
  // One look a material of the file: every node of a kit's GLB draws the same, so their pieces share one draw material.
  if (!looks.has(material)) looks.set(material, kitLookOf(material));
  return looks.get(material)!;
}

/**
 * The page's kit meshes: every GLB mesh the kits name, parsed once,
 * mirrored copies, the debug texture and the stand-in materials. Shared by
 * every world's view on the page.
 */
export class VoxelKitMeshes {
  readonly texture = voxelKitDebugTexture();
  /** Whether pieces draw the labelled debug UV textures instead of their kits' own (a page's switch). */
  readonly debug: boolean;
  /** Parsed GLBs whose materials' textures pieces draw with (released on dispose). */
  private readonly held: { dispose(): void }[] = [];
  /** Draw materials made from a kit look, by look and whether it reads the trim U. */
  private readonly lookMaterials = new Map<VoxelKitLook, THREE.Material[]>();
  private readonly meshes = new Map<string, MeshState>();
  private readonly materials = new Map<string, THREE.Material>();
  private readonly trimTextures = new Map<string, THREE.Texture>();
  /** Trim pieces' run-flagged copies, by the mesh they were made from. */
  private readonly trimmed = new Map<THREE.BufferGeometry, THREE.BufferGeometry[]>();
  /** Copies cut flush toward openings, by the mesh they were made from, then slot rotation and case faces. */
  private readonly flushed = new Map<THREE.BufferGeometry, Map<number, THREE.BufferGeometry>>();
  private readonly waiting = new Set<() => void>();
  /** Kits' crack textures by asset and digest: their layer bytes once decoded, null when they failed. */
  private readonly cracks = new Map<string, Uint8Array | null | 'loading'>();
  private disposed = false;

  constructor(options: { readonly debug?: boolean } = {}) {
    this.debug = options.debug === true;
  }

  /** Calls `f` whenever meshes finished loading (views build the pieces that waited for them); returns its removal. */
  onLoaded(f: () => void): () => void {
    this.waiting.add(f);
    return () => void this.waiting.delete(f);
  }

  /**
   * Loads every mesh of `kits` not loaded yet: bytes from `read` (each file once), parsed by `loader`, its extracted
   * images from `texture`. Resolves when all have loaded or failed.
   */
  async load(kits: readonly VoxelKitRecordLike[], read: VoxelKitBytes, loader: GlbLoaderPort, decode: CrackImageDecoder = browserCrackDecoder, texture?: VoxelKitTextures): Promise<{ readonly loaded: number; readonly failed: readonly string[] }> {
    const todo = voxelKitMeshRefs(kits).filter((m) => !this.meshes.has(voxelKitMeshKey(m)));
    for (const m of todo) this.meshes.set(voxelKitMeshKey(m), { state: 'loading' });
    const images = voxelKitImageRefs(kits).filter((m) => !this.cracks.has(imageKey(m)));
    for (const m of images) this.cracks.set(imageKey(m), 'loading');
    const failed: string[] = [];
    const crackLoads = images.map(async (m) => {
      let layer: Uint8Array | null = null;
      try {
        const got = await read(m);
        layer = got === null ? null : await decode(got.bytes);
      } catch {
        layer = null;
      }
      if (this.disposed) return;
      this.cracks.set(imageKey(m), layer);
      if (layer === null) failed.push(`${imageKey(m)}: crack texture not drawn (the engine's draws)`);
    });
    // The meshes of one file (its asset version), read and parsed once.
    const files = new Map<string, VoxelKitMeshRef[]>();
    for (const m of todo) {
      const f = `${m.assetId}@${m.digest}`;
      files.set(f, [...(files.get(f) ?? []), m]);
    }
    await Promise.all([
      ...crackLoads,
      ...[...files.values()].map(async (refs) => {
        const first = refs[0]!;
        const states = new Map<VoxelKitMeshRef, MeshState>();
        let keep: { dispose(): void } | null = null;
        try {
          const got = await read(first);
          if (got === null) for (const m of refs) states.set(m, { state: 'failed', reason: 'not in this build' });
          else {
            const extracted = got.textures !== undefined && texture !== undefined && Object.keys(got.textures).length > 0 ? { images: { map: got.textures, load: texture } } : {};
            const glb = await loader.load(got.bytes, { signal: new AbortController().signal, descriptor: { assetId: first.assetId, version: got.version, sourceDigest: first.digest, sourceByteLength: got.bytes.byteLength }, ...extracted });
            const looks = new Map<THREE.Material, VoxelKitLook | null>();
            for (const m of refs) {
              const g = glbGeometry(glb.root, m.node);
              states.set(m, g === null ? { state: 'failed', reason: m.node !== undefined ? `no mesh node "${m.node}"` : 'no mesh' } : { state: 'ready', geometry: g, mirrored: [], look: glbLook(glb.root, m.node, looks) });
            }
            // The file's textures stay while a look draws them; otherwise the parse is released now (its geometry was copied).
            if ([...looks.values()].some((l) => l !== null)) keep = glb;
            else glb.dispose();
          }
        } catch (e) {
          for (const m of refs) states.set(m, { state: 'failed', reason: e instanceof Error ? e.message : String(e) });
        }
        if (this.disposed) {
          for (const st of states.values()) if (st.state === 'ready') st.geometry.dispose();
          keep?.dispose();
          return;
        }
        if (keep !== null) this.held.push(keep);
        for (const [m, st] of states) {
          this.meshes.set(voxelKitMeshKey(m), st);
          if (st.state === 'failed') failed.push(`${voxelKitMeshKey(m)}: ${st.reason}`);
        }
      }),
    ]);
    if (todo.length + images.length > 0 && !this.disposed) for (const f of [...this.waiting]) f();
    return { loaded: todo.length + images.length - failed.length, failed };
  }

  /** Adds a decoded crack texture directly (a host that decoded it itself, tests): {@link CRACK_TEXELS}² bytes. */
  addCrack(ref: VoxelKitImageRef, layer: Uint8Array): void {
    this.cracks.set(imageKey(ref), layer);
    for (const f of [...this.waiting]) f();
  }

  /** A kit's crack layer bytes, null while loading, failed or never asked for (the engine's draws). */
  crack(ref: VoxelKitImageRef): Uint8Array | null {
    const c = this.cracks.get(imageKey(ref));
    return c === undefined || c === 'loading' ? null : c;
  }

  /** Adds a parsed mesh directly (a host that parsed it itself, tests). */
  add(ref: VoxelKitMeshRef, geometry: THREE.BufferGeometry): void {
    const key = voxelKitMeshKey(ref);
    const was = this.meshes.get(key);
    if (was?.state === 'ready') {
      was.geometry.dispose();
      for (const m of was.mirrored) m?.dispose();
    }
    this.meshes.set(key, { state: 'ready', geometry, mirrored: [], look: null });
    for (const f of [...this.waiting]) f();
  }

  /** A loaded mesh's look (its material's maps and factors; null: no image, loading or failed). */
  look(ref: VoxelKitMeshRef): VoxelKitLook | null {
    const s = this.meshes.get(voxelKitMeshKey(ref));
    return s?.state === 'ready' ? s.look : null;
  }

  /** A loaded mesh (mirrored across `axis` on request); 'pending' while it loads or before it was asked for; null when it failed. */
  mesh(ref: VoxelKitMeshRef, mirror: boolean, axis = 0): THREE.BufferGeometry | 'pending' | null {
    const s = this.meshes.get(voxelKitMeshKey(ref));
    if (s === undefined || s.state === 'loading') return 'pending';
    if (s.state === 'failed') return null;
    if (!mirror) return s.geometry;
    return (s.mirrored[axis] ??= mirrored(s.geometry, axis));
  }

  /**
   * What a kit's pieces draw with: its look (`look`, from its GLB's material) at the trim U when it follows a
   * layout; without one a stand-in colour (a hash of its id). With `debug` every kit draws the stand-in with the
   * labelled debug texture, or untinted with its trim layout's debug set (a named one or its own), so its regions
   * read by their own hues.
   */
  material(kitId: string, layout?: TrimLayout, look: VoxelKitLook | null = null): THREE.Material {
    const tint = crc32(utf8Encode(kitId)) >>> 0;
    if (!this.debug) {
      if (look !== null) {
        let made = this.lookMaterials.get(look);
        if (made === undefined) this.lookMaterials.set(look, (made = []));
        const k = layout !== undefined ? 1 : 0;
        return (made[k] ??= kitLookMaterial(look, layout !== undefined));
      }
      const key = `tint:${tint}`;
      let plain = this.materials.get(key);
      if (plain === undefined) this.materials.set(key, (plain = cameraRelative(new MeshLambertNodeMaterial({ color: KIT_TINTS[tint % KIT_TINTS.length]! }))));
      return plain;
    }
    // A kit's own layout is keyed by its numbers too, so an edited layout draws its new debug set.
    const sheet = layout === undefined ? '' : layout.draft ? layout.id : `${layout.id}:${crc32(utf8Encode(JSON.stringify(layout))) >>> 0}`;
    const key = layout !== undefined ? `trim:${sheet}` : `kit:${tint}`;
    let m = this.materials.get(key);
    if (m === undefined) {
      let map: THREE.Texture = this.texture;
      if (layout !== undefined) {
        map = this.trimTextures.get(sheet) ?? trimDebugTexture(layout);
        this.trimTextures.set(sheet, map);
      }
      const color = layout !== undefined ? 0xffffff : KIT_TINTS[tint % KIT_TINTS.length]!;
      this.materials.set(key, (m = layout !== undefined ? trimMaterial(map) : cameraRelative(new MeshLambertNodeMaterial({ color, map }))));
    }
    return m;
  }

  /** A trim kit's mesh with its run faces flagged for the world-anchored U (made once a mesh and run axis). */
  trimGeometry(g: THREE.BufferGeometry, layout: TrimLayout, runAxis: 0 | 1 | 2 = 0): THREE.BufferGeometry {
    let byAxis = this.trimmed.get(g);
    if (byAxis === undefined) this.trimmed.set(g, (byAxis = []));
    return (byAxis[runAxis] ??= trimRunGeometry(g, layout, runAxis));
  }

  /** `g` cut flush at the case faces `caseFaces` after its slot rotation `rotation` (voxel `cutFlush`; made once each). */
  flushGeometry(g: THREE.BufferGeometry, rotation: number, caseFaces: number): THREE.BufferGeometry {
    let byKey = this.flushed.get(g);
    if (byKey === undefined) this.flushed.set(g, (byKey = new Map()));
    const key = rotation * 64 + caseFaces;
    let out = byKey.get(key);
    if (out === undefined) {
      out = g.clone();
      const pos = out.getAttribute('position') as THREE.BufferAttribute;
      const xyz = new Float32Array(pos.count * 3);
      for (let v = 0; v < pos.count; v++) xyz.set([pos.getX(v), pos.getY(v), pos.getZ(v)], v * 3);
      cutFlush(xyz, rotation, caseFaces, VOXEL_SIZE_M / 2);
      out.setAttribute('position', new THREE.BufferAttribute(xyz, 3));
      out.computeBoundingSphere();
      byKey.set(key, out);
    }
    return out;
  }

  /** What a world's view draws its pieces with: `table` (its streamer's) and the kit records it was built from. */
  set(table: PieceTable, kits: readonly VoxelKitRecordLike[]): VoxelKitSet {
    return new VoxelKitSet(this, table, kits);
  }

  /** The pieces of a world streamed with the world rules from `kits` and the project's piece `seed` (`worldPieceTable`). */
  world(kits: readonly VoxelKitRecordLike[], seed: number): VoxelKitSet {
    return this.set(worldPieceTable(kits, seed), kits);
  }

  /**
   * Bytes of what this holds: the vertex and index arrays of every loaded, mirrored and trim-flagged mesh,
   * and the textures' texels (with a third more for mips). The GPU holds a copy of each; that copy counts in each
   * world's stream budget (voxel-world-draws.ts).
   */
  /** {@link bytes} summed: what a world's stream budget counts of the kits. */
  gpuBytes(): number {
    const b = this.bytes();
    return b.meshes + b.textures;
  }

  bytes(): { readonly meshes: number; readonly textures: number } {
    const geometries = new Set<THREE.BufferGeometry>();
    for (const s of this.meshes.values()) {
      if (s.state !== 'ready') continue;
      geometries.add(s.geometry);
      for (const m of s.mirrored) if (m !== undefined) geometries.add(m);
    }
    for (const l of this.trimmed.values()) for (const g of l) if (g !== undefined) geometries.add(g);
    for (const l of this.flushed.values()) for (const g of l.values()) geometries.add(g);
    let meshes = 0;
    for (const g of geometries) {
      for (const a of Object.values(g.attributes)) meshes += (a as THREE.BufferAttribute).array.byteLength;
      meshes += g.index?.array.byteLength ?? 0;
    }
    let textures = 0;
    for (const t of [this.texture, ...this.trimTextures.values()]) {
      const img = t.image as { width?: number; height?: number } | null;
      textures += Math.round(((img?.width ?? 0) * (img?.height ?? 0) * 4 * 4) / 3);
    }
    return { meshes, textures };
  }

  /**
   * Meshes loaded and failed, by key (diagnostics, tests): a ready mesh whose material draws a sheet says so, naming
   * the texture asset its base colour was extracted into ("ready, sheet <asset>"; "ready, sheet" for an image kept in
   * the file; a missing asset's stand-in image has no asset).
   */
  states(): Record<string, string> {
    const sheet = (s: Extract<MeshState, { state: 'ready' }>): string => {
      const map = s.look?.map ?? null;
      if (map === null) return '';
      const asset = map.userData[TEXTURE_ASSET_KEY] as string | undefined;
      return asset !== undefined ? `, sheet ${asset}` : ', sheet';
    };
    return Object.fromEntries([...this.meshes].map(([k, s]) => [k, s.state === 'failed' ? `failed: ${s.reason}` : s.state === 'ready' ? `ready${sheet(s)}` : s.state]));
  }

  dispose(): void {
    this.disposed = true;
    for (const s of this.meshes.values()) {
      if (s.state !== 'ready') continue;
      s.geometry.dispose();
      for (const m of s.mirrored) m?.dispose();
    }
    this.meshes.clear();
    for (const m of this.materials.values()) m.dispose();
    this.materials.clear();
    for (const l of this.lookMaterials.values()) for (const m of l) m?.dispose();
    this.lookMaterials.clear();
    for (const g of this.held) g.dispose();
    this.held.length = 0;
    for (const t of this.trimTextures.values()) t.dispose();
    this.trimTextures.clear();
    for (const l of this.trimmed.values()) for (const g of l) g?.dispose();
    this.trimmed.clear();
    for (const l of this.flushed.values()) for (const g of l.values()) g.dispose();
    this.flushed.clear();
    this.texture.dispose();
    this.waiting.clear();
  }
}

/** The damage stage whose pieces a slot holds (2, 3), or 0 for any other slot. */
function damageStageOfSlot(caseId: string): number {
  return caseId === DAMAGE_PIECE_SLOTS[2] ? 2 : caseId === DAMAGE_PIECE_SLOTS[3] ? 3 : 0;
}

/** One table's kit pieces: how an instance's kit-local piece is drawn. */
export class VoxelKitSet {
  private readonly records = new Map<string, VoxelKitRecordLike>();
  private readonly lists: (readonly KitPiece[] | null)[];

  constructor(
    readonly meshes: VoxelKitMeshes,
    readonly table: PieceTable,
    kits: readonly VoxelKitRecordLike[],
  ) {
    for (const k of kits) this.records.set(k.voxelKitId, k);
    const cat = WORLD_RULES.catalogue!;
    this.lists = table.kits.map((k) => {
      const r = this.records.get(k.id);
      return r === undefined ? null : kitPieceList(r, cat).pieces;
    });
  }

  /**
   * The crack textures this table's kits draw with: each kit's own (loaded) one a layer from 1, and each material's
   * layer (0: the engine's, a material without a kit or a kit without its own texture).
   */
  crackLayers(): { readonly layers: readonly Uint8Array[]; readonly materialLayer: (material: number) => number } {
    const layers: Uint8Array[] = [];
    const ofKit = this.table.kits.map((k) => {
      const ref = this.records.get(k.id)?.damage?.crackTexture;
      const bytes = ref === undefined ? null : this.meshes.crack(ref);
      if (bytes === null) return 0;
      layers.push(bytes);
      return layers.length;
    });
    return { layers, materialLayer: (m) => (this.table.materialKit[m] === undefined || this.table.materialKit[m] === NO_KIT ? 0 : ofKit[this.table.materialKit[m]!]!) };
  }

  /** What a kit piece of a cell of `material` is: its kit and slot (case id), and the rotation of its `variant`'s mesh (null: not a kit piece of this table). */
  describe(material: number, piece: number, variant = 0): { readonly kit: string; readonly caseId: string; readonly mesh: number; readonly rotation: number } | null {
    const slot = this.table.materialKit[material] ?? NO_KIT;
    if (slot === NO_KIT) return null;
    const pc = this.lists[slot]?.[piece];
    return pc === undefined ? null : { kit: this.table.kits[slot]!.id, caseId: pc.caseId, mesh: variant, rotation: pc.rotations[variant] ?? 0 };
  }

  /**
   * The draw of a kit piece on a cell of `material` with `variantWord`:
   * null when nothing draws it (no kit, an unknown piece, a mesh that
   * failed), 'pending' while its mesh loads.
   */
  resolve(material: number, piece: number, variantWord: number): VoxelKitDraw | 'pending' | null {
    const slot = this.table.materialKit[material] ?? NO_KIT;
    if (slot === NO_KIT) return null;
    const kit = this.table.kits[slot]!;
    const pc = this.lists[slot]?.[piece];
    if (pc === undefined) return null;
    const variant = variantWord & PIECE_VARIANT_MASK;
    const record = this.records.get(kit.id);
    const entry = record?.slots[pc.caseId]?.meshes[variant];
    if (entry === undefined) return null;
    // The case's mirror (a verge's second side) and the mesh's own (a handed piece) cancel where both apply.
    const mirror = ((variantWord & PIECE_VARIANT_MIRROR) !== 0) !== (entry.mirror === true);
    const rotation = pc.rotations[variant] ?? 0;
    const key = `${slot}:${piece}:${variant}:${mirror ? 1 : 0}`;
    const frame = PIECE_STAGGER_FRAMES[pc.caseId];
    const scatter = damageStageOfSlot(pc.caseId);
    const placed = {
      rotation,
      runAxis: meshRunAxis(pc.caseId, rotation),
      halfRun: pieceHalfRun(pc.caseId),
      caseId: pc.caseId,
      mirror,
      stagger: frame === undefined ? null : { frame, seed: this.table.seed, caseIndex: pc.caseIndex, jitter: kit.jitter },
      ...(scatter === 0 ? {} : { scatterCount: kit.damage.pieces[scatter]!, seed: this.table.seed }),
    };
    const g = this.meshes.mesh(entry.mesh, mirror, mirrorAxisOf(rotation));
    if (g === 'pending' || g === null) return g;
    const layout = record === undefined ? undefined : kitTrimLayout(record);
    const look = this.meshes.material(kit.id, layout, this.meshes.look(entry.mesh));
    if (layout === undefined) return { key, geometry: g, material: look, ...placed };
    return { key, geometry: this.meshes.trimGeometry(g, layout, placed.runAxis), material: look, uPerMetre: trimUPerMetre(layout), ...placed };
  }
}
