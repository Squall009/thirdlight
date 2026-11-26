/**
 * The plain look of liquid near the eye: a chunk's liquid part (the voxel
 * derive's quads of liquid faces against open space, derived-liquid.ts)
 * drawn as one more mesh of the chunk's draw, flat in its material's
 * colour and opaque. No waves, no transparency, no refraction or foam.
 *
 * - **Colour.** The material record's colour times its wall texture set's
 *   mean (the set's coarsest mip), read from the surface's material table
 *   in the vertex stage exactly as the far field reads it
 *   (`VoxelSurface.farColour`, no wetness): a record's change reaches the
 *   water with no mesh change.
 * - **Light.** A lit program like any surface: the sun and its shadow maps,
 *   lamps, and the light volume's read (it reads as a `surface`), so water
 *   in a cave is as dark as the cave and water at night takes a lamp's light.
 * - **Shadows.** It receives them and casts none: water stands over its bed
 *   and against open space, so its own shadow would fall on a bed nobody
 *   sees through opaque water; casting none also keeps a liquid-only edit
 *   out of the cached static shadow maps (nothing to redraw).
 * - **Cost.** One draw a chunk that shows liquid, its program built when
 *   the first liquid face arrives: a world with no liquid compiles nothing.
 */
import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import * as TSLTyped from 'three/tsl';
import { LIQUID_STEPS_PER_CELL, VOXEL_SIZE_M, type LiquidPart } from '@thirdlight/voxel';
import { cameraRelative } from './camera-relative';
import { disposeObjectTree } from './dispose';
import { markOccludee } from './occludees';
import type { N } from './effects-tsl';
import { VOLUME_READ_KIND_KEY } from './voxel-light-volume-layout';
import { geometryBytes, mediumQuadGeometry } from './voxel-medium-geometry';
import type { VoxelSurface } from './voxel-surface';

const TSL: N = TSLTyped;
const { attribute, float, varying, vec4 } = TSL;

/** The liquid geometry's attribute holding each vertex's material id. */
export const VOXEL_LIQUID_MATERIAL_ATTRIBUTE = 'voxelLiquidMaterial';

/** `mesh.userData[VOXEL_LIQUID_KEY]`: a chunk's liquid mesh (counted apart from its surface). */
export const VOXEL_LIQUID_KEY = '__tlVoxelLiquid';

/** How rough the plain water is: a soft sheen in the sun, no mirror (no reflection is drawn). */
export const LIQUID_ROUGHNESS = 0.35;

/**
 * A chunk's liquid quads as a float geometry (null: none): four vertices a
 * quad, positions in metres from the chunk's corner, the face's outward
 * normal, the quad's material; two triangles a quad wound to face out.
 */
export function liquidGeometry(part: LiquidPart | null | undefined): THREE.BufferGeometry | null {
  return mediumQuadGeometry(part, VOXEL_SIZE_M / LIQUID_STEPS_PER_CELL, VOXEL_LIQUID_MATERIAL_ATTRIBUTE);
}

/** The plain liquid program of a view (one for all its chunks), made with the first liquid face. */
export class VoxelLiquidLook {
  private made: THREE.Material | null = null;

  constructor(private readonly surface: VoxelSurface) {}

  /** Whether its program was made (a world that showed no liquid never makes it). */
  get built(): boolean {
    return this.made !== null;
  }

  get material(): THREE.Material {
    if (this.made !== null) return this.made;
    const m = cameraRelative(new MeshStandardNodeMaterial());
    m.name = 'voxel liquid';
    m.metalness = 0;
    m.roughness = LIQUID_ROUGHNESS;
    // Lit as a voxel surface by the light volume (its read and its indoor share), not as a prop.
    m.userData[VOLUME_READ_KIND_KEY] = 'surface';
    const material = attribute(VOXEL_LIQUID_MATERIAL_ATTRIBUTE, 'float');
    m.colorNode = vec4(varying(this.surface.farColour(material, float(0))), 1);
    this.made = m;
    return m;
  }

  dispose(): void {
    this.made?.dispose();
    this.made = null;
  }
}

/** A chunk's liquid mesh (null: no liquid face): lit, receiving shadows where the view draws them, casting none. */
export function liquidMesh(part: LiquidPart | null | undefined, look: VoxelLiquidLook, shadows: boolean): THREE.Mesh | null {
  const geo = liquidGeometry(part);
  if (geo === null) return null;
  const mesh = new THREE.Mesh(geo, look.material);
  mesh.name = 'voxel liquid';
  mesh.matrixAutoUpdate = false;
  mesh.castShadow = false;
  mesh.receiveShadow = shadows;
  mesh.userData[VOXEL_LIQUID_KEY] = true;
  return mesh;
}

/** What a view's chunk draw holds of its liquid: its group, its liquid mesh and its bytes. */
export interface LiquidHolder {
  readonly group: THREE.Group;
  liquid: THREE.Mesh | null;
  bytes: number;
}

/**
 * A view's liquid meshes: made for its chunks' draws, replaced alone when only a chunk's liquid part changes, and
 * counted. `find` gives a drawn level-0 chunk's draw.
 */
export class VoxelLiquidDraws {
  /** Triangles of the liquid meshes drawn, and the liquid meshes replaced alone. */
  triangles = 0;
  sets = 0;
  /** The plain liquid program, made with the first liquid face. */
  readonly look: VoxelLiquidLook;

  constructor(
    surface: VoxelSurface,
    private readonly shadows: boolean,
    private readonly drawn: boolean,
    private readonly find: (cx: number, cy: number, cz: number) => LiquidHolder | undefined,
  ) {
    this.look = new VoxelLiquidLook(surface);
  }

  /** A chunk's liquid mesh (null: no liquid face, or liquid not drawn), culled whole like its surface; counted once {@link shown}. */
  mesh(part: LiquidPart | null | undefined): THREE.Mesh | null {
    const mesh = this.drawn ? liquidMesh(part, this.look, this.shadows) : null;
    if (mesh !== null) markOccludee(mesh, 'single');
    return mesh;
  }

  /** A liquid mesh began to be drawn. */
  shown(mesh: THREE.Mesh | null): void {
    if (mesh !== null) this.triangles += (mesh.geometry.index?.count ?? 0) / 3;
  }

  /** A liquid mesh is no longer drawn: its geometry goes (its render objects with it when `whole`, else its draw's tree takes them). */
  gone(mesh: THREE.Mesh, whole: boolean): void {
    this.triangles -= (mesh.geometry.index?.count ?? 0) / 3;
    mesh.geometry.dispose();
    if (whole) disposeObjectTree(mesh);
  }

  /**
   * Gives a drawn chunk its new liquid faces (only its liquid part changed: a change only between air and liquid, or
   * of a liquid's fill or material); its surfaces, pieces and grid stay, and no static shadow is drawn again (liquid
   * casts none). Returns its bytes now (0: not drawn).
   */
  set(cx: number, cy: number, cz: number, part: LiquidPart | null | undefined): number {
    const m = this.find(cx, cy, cz);
    if (m === undefined) return 0;
    this.sets++;
    const old = m.liquid;
    if (old !== null) {
      m.group.remove(old);
      m.bytes -= geometryBytes(old.geometry);
      this.gone(old, true);
    }
    m.liquid = this.mesh(part);
    if (m.liquid !== null) {
      m.group.add(m.liquid);
      m.bytes += geometryBytes(m.liquid.geometry);
      this.shown(m.liquid);
    }
    return m.bytes;
  }

  dispose(): void {
    this.look.dispose();
  }
}
