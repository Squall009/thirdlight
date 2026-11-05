/**
 * The meshes a voxel world's kit pieces draw with, as a chunk view asks for
 * them: an instance's piece is kit-local (piece-table.ts), so its mesh is
 * found from the cell's material (read from the chunk's shader data), the
 * material's kit in the world's piece table, the kit's own piece list
 * (`kitPieceList`: case and run section) and the instance's variant word
 * (variant, and the mirror of its case transform).
 *
 * - **A game kit's pieces** are its authored GLBs (a mesh per variant and
 *   level; at low detail the high mesh where no low one is authored). Their
 *   bytes come from the host (a build's content files, the backend for the
 *   editor) and are parsed by the page's GLB loader port: never fetched by
 *   URL here. A mesh still loading draws nothing until it is there (the view
 *   builds the waiting chunks' pieces again); one that failed draws nothing.
 * - **The default kit's pieces** (default-kit.ts) are generated in the voxel
 *   package and made into geometries here once.
 * - **An alias** (a case drawn by another case's mesh) resolves to that
 *   case's mesh with its cube rotation, which the view applies in the
 *   instance matrix before the case's turns: one mesh, one set of GPU
 *   buffers, for every side it serves.
 *
 * Every mesh is in metres for a level-0 cell, centred on the cell, in its
 * case's orientation (exposed face +z, run along x, up +y). A mirrored case
 * draws a mirrored copy of the mesh (the case's x negated, triangles turned
 * so their fronts stay fronts; through an alias, the mesh axis its rotation
 * carries onto the case's x), so instance matrices never mirror (an alias's
 * rotation has determinant +1). Pieces draw with
 * a stand-in material a kit and a labelled debug UV texture (one cell of UV
 * space: a 1/16-cell checker, a tick and a number every quarter, U and V
 * marked), placed camera-relative in 64 bits like the voxel surface.
 *
 * Meshes stay loaded until this is disposed: kits are a few dozen meshes, and a
 * world whose table changes keeps drawing its untouched chunks with the
 * meshes they were built with until they are derived again.
 */
import * as THREE from 'three';
import { MeshLambertNodeMaterial } from 'three/webgpu';
import { TRIM_LAYOUTS, voxelKitMeshKey, type TrimLayout } from '@thirdlight/project-model';
import {
  DEFAULT_KIT_ID,
  DEFAULT_KIT_UNITS,
  defaultKitSource,
  KIT_PIECE_BASE,
  kitPieceList,
  mirrorAxisOf,
  NO_KIT,
  PIECE_VARIANT_MASK,
  PIECE_STAGGER_FRAMES,
  PIECE_VARIANT_MIRROR,
  pieceHalfRun,
  pieceRunAxis,
  VOXEL_SIZE_M,
  WORLD_RULES,
  worldPieceTable,
  defaultKitMesh,
  type KitMeshData,
  type KitPiece,
  type PieceAlias,
  type PieceStaggerFrame,
  type PieceTable,
} from '@thirdlight/voxel';
import { cameraRelative } from './camera-relative';
import { underHelperNode } from './pieces';
import { mergeLayout, mergeWorldGeometry } from './static-merge';
import type { GlbLoaderPort } from './visual';
import { drawGlyphs, trimDebugTexture } from './voxel-trim-debug-texture';
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
  readonly cases: Readonly<Record<string, { readonly sections?: Readonly<Record<string, { readonly variants: readonly { readonly high: VoxelKitMeshRef; readonly low?: VoxelKitMeshRef; readonly weight?: number }[] }>>; readonly alias?: PieceAlias }>>;
}

/** What draws one kit piece: its mesh and material, and a key equal for draws that can share an instanced mesh. */
export interface VoxelKitDraw {
  readonly key: string;
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.Material;
  /** A trim kit's piece (voxel-trim-u.ts): sheet U a metre, the draw gives each instance its world-anchored U offset. */
  readonly uPerMetre?: number;
  /** The cube rotation (cube-rotations.ts) the mesh is turned by first: an alias's, 0 for a case's own mesh. */
  readonly rotation: number;
  /** The axis the mesh runs along in its own space (0 x, 1 y): where a trim piece's U grows. */
  readonly runAxis: 0 | 1;
  /** The drawn case's stagger frame (null: not staggered) and what its hash reads: the kit's seed and the case's index. */
  readonly stagger: { readonly frame: PieceStaggerFrame; readonly seed: number; readonly caseIndex: number } | null;
  /** How the drawn case's piece covers half its run on an instance flagged `half` (voxel `pieceHalfRun`). */
  readonly halfRun: 'x' | 'diagonal' | null;
}

/** A GLB's bytes as the host has them (its version and source digest), or null: not part of this build or project. */
export type VoxelKitBytes = (ref: VoxelKitMeshRef) => Promise<{ readonly bytes: Uint8Array; readonly version: number } | null>;

/** Every mesh a kit names (each once). */
export function voxelKitMeshRefs(kits: readonly VoxelKitRecordLike[]): VoxelKitMeshRef[] {
  const out = new Map<string, VoxelKitMeshRef>();
  for (const k of kits) for (const c of Object.values(k.cases)) for (const s of Object.values(c.sections ?? {})) for (const v of s.variants) for (const m of v.low === undefined ? [v.high] : [v.high, v.low]) out.set(voxelKitMeshKey(m), m);
  return [...out.values()];
}

/** Side of the debug UV texture in texels (one cell of UV space; a 1/16-cell checker is 16 texels). */
export const KIT_DEBUG_TEXTURE_SIDE = 256;

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
  const check = n / DEFAULT_KIT_UNITS;
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

/** A generated default piece's mesh (default-kit.ts) as a geometry. */
export function defaultKitGeometry(d: KitMeshData): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(d.positions.slice(), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(d.normals.slice(), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(d.uvs.slice(), 2));
  g.setIndex(new THREE.BufferAttribute(d.indices.slice(), 1));
  return g;
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

/** Stand-in tints a kit (by its seed), so neighbouring kits read apart: wood, stone, plaster, slate tones. */
const KIT_TINTS = [0xc8a070, 0xb8b4ac, 0xe0d4bc, 0x9098a4, 0xb07850, 0xd0c090];
const DEFAULT_KIT_TINT = 0xd8d0c4;

/** A ready mesh keeps its mirrored copies by the axis mirrored. */
type MeshState = { state: 'loading' } | { state: 'ready'; geometry: THREE.BufferGeometry; mirrored: (THREE.BufferGeometry | undefined)[] } | { state: 'failed'; reason: string };

/**
 * The page's kit meshes: every GLB mesh the kits name, parsed once, the
 * default kit's built ones, mirrored copies, the debug texture and the
 * stand-in materials. Shared by every world's view on the page.
 */
export class VoxelKitMeshes {
  readonly texture = voxelKitDebugTexture();
  private readonly meshes = new Map<string, MeshState>();
  private readonly defaults = new Map<string, THREE.BufferGeometry>();
  private readonly materials = new Map<string, THREE.Material>();
  private readonly trimTextures = new Map<string, THREE.Texture>();
  /** Trim pieces' run-flagged copies, by the mesh they were made from. */
  private readonly trimmed = new Map<THREE.BufferGeometry, THREE.BufferGeometry[]>();
  private readonly waiting = new Set<() => void>();
  private disposed = false;

  /** Calls `f` whenever meshes finished loading (views build the pieces that waited for them); returns its removal. */
  onLoaded(f: () => void): () => void {
    this.waiting.add(f);
    return () => void this.waiting.delete(f);
  }

  /** Loads every mesh of `kits` not loaded yet: bytes from `read`, parsed by `loader`. Resolves when all have loaded or failed. */
  async load(kits: readonly VoxelKitRecordLike[], read: VoxelKitBytes, loader: GlbLoaderPort): Promise<{ readonly loaded: number; readonly failed: readonly string[] }> {
    const todo = voxelKitMeshRefs(kits).filter((m) => !this.meshes.has(voxelKitMeshKey(m)));
    for (const m of todo) this.meshes.set(voxelKitMeshKey(m), { state: 'loading' });
    const failed: string[] = [];
    await Promise.all(
      todo.map(async (m) => {
        const key = voxelKitMeshKey(m);
        let next: MeshState;
        try {
          const got = await read(m);
          if (got === null) next = { state: 'failed', reason: 'not in this build' };
          else {
            const glb = await loader.load(got.bytes, { signal: new AbortController().signal, descriptor: { assetId: m.assetId, version: got.version, sourceDigest: m.digest, sourceByteLength: got.bytes.byteLength } });
            const g = glbGeometry(glb.root, m.node);
            glb.dispose();
            next = g === null ? { state: 'failed', reason: m.node !== undefined ? `no mesh node "${m.node}"` : 'no mesh' } : { state: 'ready', geometry: g, mirrored: [] };
          }
        } catch (e) {
          next = { state: 'failed', reason: e instanceof Error ? e.message : String(e) };
        }
        if (this.disposed) {
          if (next.state === 'ready') next.geometry.dispose();
          return;
        }
        this.meshes.set(key, next);
        if (next.state === 'failed') failed.push(`${key}: ${next.reason}`);
      }),
    );
    if (todo.length > 0 && !this.disposed) for (const f of [...this.waiting]) f();
    return { loaded: todo.length - failed.length, failed };
  }

  /** Adds a parsed mesh directly (a host that parsed it itself, tests). */
  add(ref: VoxelKitMeshRef, geometry: THREE.BufferGeometry): void {
    const key = voxelKitMeshKey(ref);
    const was = this.meshes.get(key);
    if (was?.state === 'ready') {
      was.geometry.dispose();
      for (const m of was.mirrored) m?.dispose();
    }
    this.meshes.set(key, { state: 'ready', geometry, mirrored: [] });
    for (const f of [...this.waiting]) f();
  }

  /** A loaded mesh (mirrored across `axis` on request); 'pending' while it loads or before it was asked for; null when it failed. */
  mesh(ref: VoxelKitMeshRef, mirror: boolean, axis = 0): THREE.BufferGeometry | 'pending' | null {
    const s = this.meshes.get(voxelKitMeshKey(ref));
    if (s === undefined || s.state === 'loading') return 'pending';
    if (s.state === 'failed') return null;
    if (!mirror) return s.geometry;
    return (s.mirrored[axis] ??= mirrored(s.geometry, axis));
  }

  /** The default kit's own mesh of a case (null: an alias or no piece), mirrored across `axis` on request (the verge rising toward −x). */
  defaultMesh(caseId: string, low: boolean, mirror = false, axis = 0): THREE.BufferGeometry | null {
    const key = `${caseId}:${low ? 1 : 0}:${mirror ? 1 + axis : 0}`;
    let g = this.defaults.get(key);
    if (g === undefined) {
      const d = defaultKitMesh(caseId, low);
      if (d === null) return null;
      g = mirror ? mirrored(this.defaultMesh(caseId, low)!, axis) : defaultKitGeometry(d);
      this.defaults.set(key, g);
    }
    return g;
  }

  /**
   * The stand-in material of a kit (by its seed; the default kit's own tint). A kit following a known trim layout
   * draws untinted with that layout's debug set, so its regions read by their own hues.
   */
  material(seed: number, isDefault: boolean, trimLayout?: string): THREE.Material {
    const layout = trimLayout === undefined || isDefault ? undefined : TRIM_LAYOUTS.get(trimLayout);
    const key = isDefault ? 'default' : layout !== undefined ? `trim:${layout.id}` : `kit:${seed >>> 0}`;
    let m = this.materials.get(key);
    if (m === undefined) {
      let map: THREE.Texture = this.texture;
      if (layout !== undefined) {
        map = this.trimTextures.get(layout.id) ?? trimDebugTexture(layout);
        this.trimTextures.set(layout.id, map);
      }
      const color = isDefault ? DEFAULT_KIT_TINT : layout !== undefined ? 0xffffff : KIT_TINTS[(seed >>> 0) % KIT_TINTS.length]!;
      this.materials.set(key, (m = layout !== undefined ? trimMaterial(map) : cameraRelative(new MeshLambertNodeMaterial({ color, map }))));
    }
    return m;
  }

  /** A trim kit's mesh with its run faces flagged for the world-anchored U (made once a mesh and run axis). */
  trimGeometry(g: THREE.BufferGeometry, layout: TrimLayout, runAxis: 0 | 1 = 0): THREE.BufferGeometry {
    let byAxis = this.trimmed.get(g);
    if (byAxis === undefined) this.trimmed.set(g, (byAxis = []));
    return (byAxis[runAxis] ??= trimRunGeometry(g, layout, runAxis));
  }

  /** What a world's view draws its pieces with: `table` (its streamer's) and the kit records it was built from. */
  set(table: PieceTable, kits: readonly VoxelKitRecordLike[]): VoxelKitSet {
    return new VoxelKitSet(this, table, kits);
  }

  /** The pieces of a world streamed with the world rules from `kits` (`worldPieceTable`: the default kit for every other material). */
  world(kits: readonly VoxelKitRecordLike[]): VoxelKitSet {
    return this.set(worldPieceTable(kits), kits);
  }

  /**
   * Bytes of what this holds: the vertex and index arrays of every loaded, default, mirrored and trim-flagged mesh,
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
    for (const g of this.defaults.values()) geometries.add(g);
    for (const l of this.trimmed.values()) for (const g of l) if (g !== undefined) geometries.add(g);
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

  /** Meshes loaded and failed, by key (diagnostics, tests). */
  states(): Record<string, string> {
    return Object.fromEntries([...this.meshes].map(([k, s]) => [k, s.state === 'failed' ? `failed: ${s.reason}` : s.state]));
  }

  dispose(): void {
    this.disposed = true;
    for (const s of this.meshes.values()) {
      if (s.state !== 'ready') continue;
      s.geometry.dispose();
      for (const m of s.mirrored) m?.dispose();
    }
    this.meshes.clear();
    for (const g of this.defaults.values()) g.dispose();
    this.defaults.clear();
    for (const m of this.materials.values()) m.dispose();
    this.materials.clear();
    for (const t of this.trimTextures.values()) t.dispose();
    this.trimTextures.clear();
    for (const l of this.trimmed.values()) for (const g of l) g?.dispose();
    this.trimmed.clear();
    this.texture.dispose();
    this.waiting.clear();
  }
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
      if (k.id === DEFAULT_KIT_ID) return kitPieceList(defaultKitSource(cat), cat).pieces;
      const r = this.records.get(k.id);
      return r === undefined ? null : kitPieceList(r, cat).pieces;
    });
  }

  /** What a kit piece of a cell of `material` is: its kit, case and run section, and the case whose mesh draws it (an alias's) turned by `rotation` (null: not a kit piece of this table). */
  describe(material: number, piece: number): { readonly kit: string; readonly caseId: string; readonly section: string; readonly meshCaseId: string; readonly rotation: number } | null {
    const slot = this.table.materialKit[material] ?? NO_KIT;
    if (slot === NO_KIT) return null;
    const pc = this.lists[slot]?.[piece - KIT_PIECE_BASE];
    return pc === undefined ? null : { kit: this.table.kits[slot]!.id, caseId: pc.caseId, section: pc.sectionId, meshCaseId: pc.meshCaseId, rotation: pc.rotation };
  }

  /**
   * The draw of a kit piece (`piece` ≥ `KIT_PIECE_BASE`) on a cell of
   * `material` with `variantWord`: null when nothing draws it (no kit, an
   * unknown piece, a mesh that failed), 'pending' while its mesh loads.
   */
  resolve(material: number, piece: number, variantWord: number, low: boolean): VoxelKitDraw | 'pending' | null {
    const slot = this.table.materialKit[material] ?? NO_KIT;
    if (slot === NO_KIT) return null;
    const kit = this.table.kits[slot]!;
    const pc = this.lists[slot]?.[piece - KIT_PIECE_BASE];
    if (pc === undefined) return null;
    const mirror = (variantWord & PIECE_VARIANT_MIRROR) !== 0;
    const variant = variantWord & PIECE_VARIANT_MASK;
    const key = `${slot}:${piece}:${variant}:${low ? 1 : 0}:${mirror ? 1 : 0}`;
    const frame = PIECE_STAGGER_FRAMES[pc.caseId];
    const placed = { rotation: pc.rotation, runAxis: pieceRunAxis(pc.meshCaseId), halfRun: pieceHalfRun(pc.caseId), stagger: frame === undefined ? null : { frame, seed: kit.seed, caseIndex: pc.caseIndex } };
    if (kit.id === DEFAULT_KIT_ID) {
      const g = this.meshes.defaultMesh(pc.meshCaseId, low, mirror, mirrorAxisOf(pc.rotation));
      return g === null ? null : { key, geometry: g, material: this.meshes.material(kit.seed, true), ...placed };
    }
    const v = this.records.get(kit.id)?.cases[pc.meshCaseId]?.sections?.[pc.sectionId]?.variants[variant];
    if (v === undefined) return null;
    const g = this.meshes.mesh(low ? (v.low ?? v.high) : v.high, mirror, mirrorAxisOf(pc.rotation));
    if (g === 'pending' || g === null) return g;
    const trimLayout = this.records.get(kit.id)?.trimLayout;
    const look = this.meshes.material(kit.seed, false, trimLayout);
    const layout = trimLayout === undefined ? undefined : TRIM_LAYOUTS.get(trimLayout);
    if (layout === undefined) return { key, geometry: g, material: look, ...placed };
    return { key, geometry: this.meshes.trimGeometry(g, layout, placed.runAxis), material: look, uPerMetre: trimUPerMetre(layout), ...placed };
  }
}
