/**
 * A program past the device's texture units, caught before its pipeline is
 * made.
 *
 * A fragment stage samples only so many textures (WebGPU's
 * `maxSampledTexturesPerShaderStage`, 16 on the low tier's GPUs; WebGL 2's
 * `MAX_TEXTURE_IMAGE_UNITS`). The engine keeps its own lit programs within
 * `LIT_TEXTURE_UNITS` under its worst case (`lit-texture-units.test.ts`), but
 * a material with many textures of its own (a graph sampling several maps)
 * can pass the limit where the engine's reads are all on (the surface cache,
 * decals, the screen-space histories, the light path). Past it a WebGPU
 * pipeline fails validation and the object stops drawing with nothing said;
 * a WebGL 2 program fails to link.
 *
 * So the program's sampled textures are counted from its bindings when three
 * asks for its pipeline (three has built the program by then, not the
 * pipeline). Past the limit no pipeline is made and that draw is skipped; the
 * object draws from then on with a plain fallback of its material (its
 * colour, side and transparency: none of its own textures), and the scene's
 * host hears a problem naming the material and the object, once a material
 * ({@link TEXTURE_UNIT_PROBLEM_KEY}; the console when none listens). The
 * fallback is per object and material, so the same material keeps its look on
 * objects whose programs fit (fewer engine reads reach them).
 */
import * as THREE from 'three/webgpu';

/** The fragment stage's bit in a binding's visibility (WebGPU's `GPUShaderStage.FRAGMENT`, three's on both backends). */
const FRAGMENT_STAGE = 2;
/** A scene's `userData` key for who hears of a material past the limit drawn in it (absent: the console). */
export const TEXTURE_UNIT_PROBLEM_KEY = 'tlTextureUnitProblem';

type RenderObjectFn = (object: THREE.Object3D, scene: THREE.Scene, camera: THREE.Camera, geometry: THREE.BufferGeometry, material: THREE.Material, group: unknown, lightsNode: unknown, clippingContext: unknown, passId: unknown) => void;

/** What the guard reads of a three render object. */
interface RenderObjectLike {
  readonly object: THREE.Object3D;
  readonly material: THREE.Material;
  readonly scene: THREE.Scene;
  getBindings(): readonly { readonly bindings: readonly { readonly isSampledTexture?: boolean; readonly visibility: number }[] }[];
  getNodeBuilderState(): { readonly fragmentShader?: string | null };
}

interface PipelinesLike {
  getForRender(renderObject: RenderObjectLike, promises?: unknown): unknown;
}

interface BindingsLike {
  getForRender(renderObject: RenderObjectLike): readonly unknown[];
}

/** What a refused render object's bindings are: none made, none updated. */
const NO_BINDINGS: readonly unknown[] = Object.freeze([]);

interface GuardedRenderer {
  renderObject: RenderObjectFn;
  readonly _pipelines?: PipelinesLike;
  readonly _bindings?: BindingsLike;
  readonly backend: { readonly device?: { readonly limits?: { readonly maxSampledTexturesPerShaderStage?: number } }; readonly gl?: WebGL2RenderingContext };
}

/** A sampler a GLSL fragment shader declares (`uniform highp sampler2DShadow name;`). */
const GLSL_SAMPLER = /\buniform\s+(?:(?:lowp|mediump|highp)\s+)?[iu]?sampler\w*\s+\w+/g;

/**
 * The textures a program's fragment stage samples: its bindings for that
 * stage (WGSL's builder marks each binding's stages); GLSL's builder marks
 * none, so there the samplers its fragment shader declares.
 */
export function fragmentTexturesOf(ro: Pick<RenderObjectLike, 'getBindings' | 'getNodeBuilderState'>): number {
  let n = 0;
  let staged = false;
  for (const g of ro.getBindings()) {
    for (const b of g.bindings) {
      if (b.visibility !== 0) staged = true;
      if (b.isSampledTexture === true && (b.visibility & FRAGMENT_STAGE) !== 0) n += 1;
    }
  }
  if (staged) return n;
  return ro.getNodeBuilderState().fragmentShader?.match(GLSL_SAMPLER)?.length ?? 0;
}

/** One renderer's guard: the limit, the fallbacks made, who hears a problem. */
export class TextureUnitGuard {
  /** A test or a diagnostic run may lower the device's limit (null: the device's). */
  limitOverride: number | null = null;
  /** Materials reported, and each object's fallbacks by the material it was given. */
  private readonly told = new WeakSet<THREE.Material>();
  private readonly fallbacks = new WeakMap<THREE.Object3D, Map<THREE.Material, THREE.Material>>();
  private readonly made = new WeakMap<THREE.Material, THREE.Material>();
  private deviceLimit: number | null = null;
  /** Programs found past the limit (a diagnostic). */
  over = 0;

  constructor(private readonly renderer: GuardedRenderer) {}

  /** The fragment stage's sampled-texture limit. */
  limit(): number {
    if (this.limitOverride !== null) return this.limitOverride;
    if (this.deviceLimit === null) {
      const b = this.renderer.backend;
      const gpu = b.device?.limits?.maxSampledTexturesPerShaderStage;
      const gl = b.gl;
      this.deviceLimit = gpu ?? (gl !== undefined ? (gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) as number) : 16);
    }
    return this.deviceLimit;
  }

  /** The material `object` draws with instead of `material` (itself unless its program was past the limit). */
  materialFor(object: THREE.Object3D, material: THREE.Material): THREE.Material {
    return this.fallbacks.get(object)?.get(material) ?? material;
  }

  /** Whether `ro`'s program may get a pipeline; past the limit, its object's fallback is set and the problem told. */
  admit(ro: RenderObjectLike, given: THREE.Material, scene: THREE.Scene): boolean {
    const used = fragmentTexturesOf(ro);
    const limit = this.limit();
    if (used <= limit) return true;
    this.over += 1;
    this.fallBack(ro.object, given);
    if (!this.told.has(given)) {
      this.told.add(given);
      const message = `Material ${given.name === '' ? '(unnamed)' : given.name} on ${ro.object.name === '' ? 'an object' : ro.object.name} samples ${used} textures in one shader where this GPU allows ${limit}; it draws with a plain fallback there (its own textures left out). Sample fewer textures in the material (combine maps into one texture's channels).`;
      const tell = scene.userData[TEXTURE_UNIT_PROBLEM_KEY] as ((code: string, message: string) => void) | undefined;
      if (tell !== undefined) tell('texture_units', message);
      else console.warn(message);
    }
    return false;
  }

  /** `object` draws `given`'s fallback from now on. */
  fallBack(object: THREE.Object3D, given: THREE.Material): void {
    let byMaterial = this.fallbacks.get(object);
    if (byMaterial === undefined) this.fallbacks.set(object, (byMaterial = new Map()));
    if (!byMaterial.has(given)) byMaterial.set(given, this.fallbackOf(given));
  }

  /** A plain lit material in `m`'s colour, side and transparency (shared by every object `m` falls back on). */
  private fallbackOf(m: THREE.Material): THREE.Material {
    let f = this.made.get(m);
    if (f === undefined) {
      const s = new THREE.MeshStandardNodeMaterial();
      const src = m as THREE.Material & { color?: THREE.Color; roughness?: number; metalness?: number };
      if (src.color !== undefined) s.color.copy(src.color);
      if (src.roughness !== undefined) s.roughness = src.roughness;
      if (src.metalness !== undefined) s.metalness = src.metalness;
      s.side = m.side;
      s.transparent = m.transparent;
      s.opacity = m.opacity;
      s.name = `${m.name} (fallback)`;
      this.made.set(m, (f = s));
    }
    return f;
  }
}

const guards = new WeakMap<object, TextureUnitGuard>();

/** `renderer`'s guard (null: not installed). */
export function textureUnitGuardOf(renderer: object): TextureUnitGuard | null {
  return guards.get(renderer) ?? null;
}

/**
 * Guard `renderer`'s draws (installed last, so it sees each draw's material
 * as the scene gave it): three's pipeline request for a program past the
 * limit makes none, and its object draws with the fallback from then on.
 */
export function installTextureUnitGuard(renderer: GuardedRenderer): TextureUnitGuard {
  const guard = new TextureUnitGuard(renderer);
  guards.set(renderer, guard);
  const base = renderer.renderObject;
  /**
   * The material the scene gave the draw under way (variants are made from it further down). three's precompile asks
   * for bindings and pipelines after the draw calls it collected have returned: there a refused program's object gets
   * its fallback the next time it is drawn (the same render object, refused again).
   */
  let given: THREE.Material | null = null;
  const admitted = new WeakMap<RenderObjectLike, boolean>();
  /** Counted once a render object (three makes a new one when its program changes): asked every draw. */
  const admits = (ro: RenderObjectLike): boolean => {
    let ok = admitted.get(ro);
    if (ok === undefined) admitted.set(ro, (ok = guard.admit(ro, given ?? ro.material, ro.scene)));
    else if (!ok && given !== null) guard.fallBack(ro.object, given);
    return ok;
  };
  let hooked: unknown = null;
  renderer.renderObject = function renderObjectGuarded(this: GuardedRenderer, object, scene, camera, geometry, material, group, lightsNode, clippingContext, passId) {
    // three makes its managers when the renderer starts; hook them the first draw after. Bind groups are made
    // before the pipeline (a WebGPU layout past the limit fails there already): neither is made past it.
    const bindings = this._bindings;
    const pipelines = this._pipelines;
    if (bindings !== undefined && pipelines !== undefined && bindings !== hooked) {
      hooked = bindings;
      const bindingsFor = bindings.getForRender;
      bindings.getForRender = function getBindingsGuarded(this: BindingsLike, ro) {
        return admits(ro) ? bindingsFor.call(this, ro) : NO_BINDINGS;
      };
      const pipelineFor = pipelines.getForRender;
      pipelines.getForRender = function getPipelineGuarded(this: PipelinesLike, ro, promises) {
        return admits(ro) ? pipelineFor.call(this, ro, promises) : null;
      };
    }
    // Every draw comes here: nothing but two assignments unless some program was refused.
    if (scene.overrideMaterial !== null) {
      base.call(this, object, scene, camera, geometry, material, group, lightsNode, clippingContext, passId);
      return;
    }
    const before = given;
    given = material;
    try {
      base.call(this, object, scene, camera, geometry, guard.over > 0 ? guard.materialFor(object, material) : material, group, lightsNode, clippingContext, passId);
    } finally {
      given = before;
    }
  };
  return guard;
}
