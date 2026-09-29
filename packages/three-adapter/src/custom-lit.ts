/**
 * Phase 23.15: the Custom-lit surface of a material graph — a node material
 * whose colour the graph computes from the lights, drawn through three's
 * normal lighting pipeline so fog, tone mapping and the post stack apply.
 *
 * three.js (r186) lights a node material in `LightsNode.setup`: the material's
 * lighting model gets `start` (every light node builds; an analytic light
 * calls `direct` with its direction, its colour already carrying its shadow
 * and falloff; ambient, hemisphere and probe lights add to the context's
 * `irradiance`, the environment to `iblIrradiance`), `indirect`, then
 * `finish`, all inside one stack whose result is the outgoing light. The
 * model here (`GraphLightingModel`) only gathers: every term goes into a
 * shader variable (`LIT`), and in `finish` — after every light has been
 * gathered — the graph's colour (which reads those variables through the
 * Lighting input nodes) becomes the outgoing light. Nothing the graph
 * computes runs before the lights, so the inputs are always filled; the
 * material's own emissive (selection tint, a look override) is still added by
 * three after the lighting.
 *
 * Terms (all on the diffuse scale, irradiance ÷ π, so colour × term is what
 * a Lambert surface of that colour reflects — the PBR output's diffuse):
 *
 * - direct: Σ over analytic lights (directional, point, spot) of
 *   colour × intensity × max(N·L, 0) × shadow × falloff;
 * - ambient: ambient + hemisphere + light probes; environment: the scene's
 *   image-based light (three's `EnvironmentNode`); lightmap: a baked
 *   lightmap (phase 9.6, `lightMap × lightMapIntensity`) — added to the
 *   total, never to `ambient`;
 * - total = direct + ambient + environment + lightmap; luminance(total);
 * - main light: the brightest shadow-casting directional light, else the
 *   first directional one (light id order), chosen per render from the
 *   lights' current colour × intensity (a uniform index, so an intensity
 *   change never recompiles); its direction (world, towards the light),
 *   colour, signed N·L and shadow term (1 when it casts none or the object
 *   receives none).
 *
 * With no light at all (or lighting off) the graph still draws, with every
 * term 0 (shadow 1). Rect-area lights are not gathered (the engine has none).
 */
import * as THREE from 'three';
import * as TSL from 'three/tsl';
import { EnvironmentNode, LightingModel, LightingNode, NodeMaterial, type NodeBuilder } from 'three/webgpu';

// TSL's typings do not follow values whose width is known only at run time.
type N = any;
const T: N = TSL;

const INV_PI = 1 / Math.PI;

/** The gathered lighting terms (shader variables shared by every custom-lit build; view-space main direction). */
export const LIT = {
  mainDirView: T.property('vec3', 'tlLitMainDir') as N,
  mainColor: T.property('vec3', 'tlLitMainColor') as N,
  mainNdotL: T.property('float', 'tlLitMainNdotL') as N,
  shadow: T.property('float', 'tlLitShadow') as N,
  direct: T.property('vec3', 'tlLitDirect') as N,
  ambient: T.property('vec3', 'tlLitAmbient') as N,
  environment: T.property('vec3', 'tlLitEnvironment') as N,
  lightmap: T.property('vec3', 'tlLitLightmap') as N,
  total: T.property('vec3', 'tlLitTotal') as N,
  luminance: T.property('float', 'tlLitLuminance') as N,
};

/** The main light's direction in world space (towards the light; up when there is none). */
export function litMainDirectionWorld(): N {
  const world = LIT.mainDirView.transformDirection(T.cameraWorldMatrix);
  return T.select(T.length(LIT.mainDirView).greaterThan(0), T.normalize(world), T.vec3(0, 1, 0));
}

/** Every term back to "no light" (the start of a gather, or a surface drawn without lights). */
function resetTerms(): void {
  LIT.mainDirView.assign(T.vec3(0));
  LIT.mainColor.assign(T.vec3(0));
  LIT.mainNdotL.assign(T.float(0));
  LIT.shadow.assign(T.float(1));
  LIT.direct.assign(T.vec3(0));
  LIT.ambient.assign(T.vec3(0));
  LIT.environment.assign(T.vec3(0));
  LIT.lightmap.assign(T.vec3(0));
  LIT.total.assign(T.vec3(0));
  LIT.luminance.assign(T.float(0));
}

function totals(): void {
  LIT.total.assign(LIT.direct.add(LIT.ambient).add(LIT.environment).add(LIT.lightmap));
  LIT.luminance.assign(T.luminance(LIT.total));
}

/** Brightness a light is ranked by for "main" (its colour's luminance × intensity). */
function brightness(l: THREE.DirectionalLight): number {
  return (0.2126 * l.color.r + 0.7152 * l.color.g + 0.0722 * l.color.b) * l.intensity;
}

/**
 * The main light among directional lights (light id order): the brightest
 * one casting shadows, else the first; -1 when there is none. Ties keep the
 * earlier light.
 */
export function mainLightIndex(lights: readonly THREE.DirectionalLight[]): number {
  let best = -1;
  for (let i = 0; i < lights.length; i++) {
    const l = lights[i]!;
    if (l.castShadow !== true) continue;
    if (best < 0 || brightness(l) > brightness(lights[best]!)) best = i;
  }
  return best >= 0 ? best : lights.length > 0 ? 0 : -1;
}

interface LightNodeLike {
  readonly isAnalyticLightNode?: boolean;
  readonly light?: THREE.Light;
  readonly colorNode?: N;
  readonly baseColorNode?: N | null;
  readonly shadowNode?: N | null;
}
interface BuilderLike {
  readonly lightsNode: { getLightNodes(builder: NodeBuilder): LightNodeLike[] };
  readonly object: THREE.Object3D;
  readonly renderer: { readonly shadowMap: { readonly enabled: boolean } };
  readonly context: { irradiance: N; iblIrradiance: N; outgoingLight: N };
  readonly material: { lightMap?: THREE.Texture | null };
  isOpaque(): boolean;
}

/** The lighting model of a custom-lit surface: gathers every term, then puts the graph's colour out. */
class GraphLightingModel extends LightingModel {
  private directionals: THREE.DirectionalLight[] = [];
  private mainIndex: N = null;

  constructor(private readonly material: MeshCustomLitNodeMaterial) {
    super();
  }

  override start(builder: NodeBuilder): void {
    const b = builder as unknown as BuilderLike;
    resetTerms();
    // EnvironmentNode also samples a reflection by roughness (unused here): a defined value.
    T.roughness.assign(T.float(1));
    this.directionals = b.lightsNode
      .getLightNodes(builder)
      .filter((n) => n.isAnalyticLightNode === true && (n.light as THREE.DirectionalLight | undefined)?.isDirectionalLight === true)
      .map((n) => n.light as THREE.DirectionalLight);
    const lights = this.directionals;
    // One index per build (its light list is the build's): picked each render from the lights' current values.
    this.mainIndex = T.uniform(mainLightIndex(lights))
      .setGroup(T.renderGroup)
      .onRenderUpdate(() => mainLightIndex(lights));
    super.start(builder);
  }

  override direct(input: { lightDirection: N; lightColor: N; lightNode?: unknown }, builder: NodeBuilder): void {
    const b = builder as unknown as BuilderLike;
    const nl = T.normalView.dot(input.lightDirection);
    LIT.direct.addAssign(nl.clamp().mul(input.lightColor).mul(INV_PI));
    const node = input.lightNode as LightNodeLike | undefined;
    const i = node?.light !== undefined ? this.directionals.indexOf(node.light as THREE.DirectionalLight) : -1;
    if (i < 0 || node === undefined) return;
    const w = T.select(this.mainIndex.equal(T.float(i)), T.float(1), T.float(0));
    // The light's own colour (without its shadow, which `lightColor` carries when the object receives it).
    const colour = node.baseColorNode ?? node.colorNode;
    const shadowed = node.light!.castShadow === true && b.object.receiveShadow === true && b.renderer.shadowMap.enabled === true && node.shadowNode !== null && node.shadowNode !== undefined;
    const shadow = shadowed ? T.float(node.shadowNode) : T.float(1);
    LIT.mainDirView.addAssign(input.lightDirection.mul(w));
    LIT.mainColor.addAssign(T.vec3(colour).mul(INV_PI).mul(w));
    LIT.mainNdotL.addAssign(nl.mul(w));
    LIT.shadow.assign(T.mix(LIT.shadow, shadow, w));
  }

  override indirect(builder: NodeBuilder): void {
    const b = builder as unknown as BuilderLike;
    LIT.ambient.assign(b.context.irradiance.mul(INV_PI));
    LIT.environment.assign(b.context.iblIrradiance.mul(INV_PI));
  }

  override finish(builder: NodeBuilder): void {
    const b = builder as unknown as BuilderLike;
    totals();
    this.material.applyLitAlpha(b);
    b.context.outgoingLight.assign(this.material.surfaceColor());
  }
}

/** A baked lightmap's light into the lightmap term (three's standard material adds it to the ambient irradiance). */
class LitLightMapNode extends LightingNode {
  static get type(): string {
    return 'LitLightMapNode';
  }
  override setup(): null {
    LIT.lightmap.addAssign(T.materialLightMap.mul(INV_PI));
    return null;
  }
}

/**
 * The node material of a Custom-lit output. The graph's slots are node
 * properties (so three's program cache key tells two graphs apart):
 * `litColorNode` (required), `litEmissiveNode`, and `litOpacityNode` /
 * `litAlphaTestNode` when the alpha reads lighting inputs (else the plain
 * `opacityNode` / `alphaTestNode` apply before the lights, as usual).
 */
export class MeshCustomLitNodeMaterial extends NodeMaterial {
  static override get type(): string {
    return 'MeshCustomLitNodeMaterial';
  }
  readonly isMeshCustomLitNodeMaterial = true;
  litColorNode: N = null;
  litEmissiveNode: N = null;
  litOpacityNode: N = null;
  litAlphaTestNode: N = null;
  /** The per-object looks (selection tint, a look override) write these; three adds them after the lights. */
  emissive = new THREE.Color(0x000000);
  emissiveIntensity = 1;
  /** Phase 9.6: a baked lightmap (UV1) goes into the lightmap term. */
  lightMap: THREE.Texture | null = null;
  lightMapIntensity = 1;

  constructor() {
    super();
    this.lights = true;
  }

  /** The colour the surface puts out (graph colour + graph emissive). */
  surfaceColor(): N {
    const c = this.litColorNode !== null ? T.vec3(this.litColorNode) : T.vec3(1);
    return this.litEmissiveNode !== null ? c.add(T.vec3(this.litEmissiveNode)) : c;
  }

  /** Alpha that reads lighting inputs: clipped and applied once the lights are gathered. */
  applyLitAlpha(builder: { isOpaque(): boolean }): void {
    if (this.litOpacityNode === null && this.litAlphaTestNode === null) return;
    const a = this.litOpacityNode !== null ? T.float(this.litOpacityNode) : T.float(1);
    if (this.litAlphaTestNode !== null) T.Discard(a.lessThanEqual(T.float(this.litAlphaTestNode)));
    if (!builder.isOpaque()) T.diffuseColor.a.assign(T.diffuseColor.a.mul(a));
  }

  override setupLightingModel(): LightingModel {
    return new GraphLightingModel(this);
  }

  /** No light reaches the surface (none in the scene, or lighting off): the graph draws with every term at "no light". */
  override setupOutgoingLight(): N {
    return T.Fn((builder: NodeBuilder) => {
      resetTerms();
      totals();
      this.applyLitAlpha(builder as unknown as BuilderLike);
      return this.surfaceColor();
    })();
  }

  override setupLightMap(builder: NodeBuilder): N {
    return (builder as unknown as BuilderLike).material.lightMap ? new LitLightMapNode() : null;
  }

  /** The material's environment, else the scene's (as three's standard material). */
  override setupEnvironment(builder: NodeBuilder): N {
    let env = super.setupEnvironment(builder) as N;
    const sceneEnv = (builder as unknown as { environmentNode?: N }).environmentNode;
    if (env === null && sceneEnv) env = sceneEnv;
    return env ? new EnvironmentNode(env) : null;
  }

  override copy(source: MeshCustomLitNodeMaterial): this {
    // NodeMaterial.copy copies INTO object values it already holds: the slots are taken by reference instead.
    this.litColorNode = null;
    this.litEmissiveNode = null;
    this.litOpacityNode = null;
    this.litAlphaTestNode = null;
    this.lightMap = null;
    super.copy(source);
    this.litColorNode = source.litColorNode;
    this.litEmissiveNode = source.litEmissiveNode;
    this.litOpacityNode = source.litOpacityNode;
    this.litAlphaTestNode = source.litAlphaTestNode;
    this.emissive.copy(source.emissive);
    this.emissiveIntensity = source.emissiveIntensity;
    this.lightMap = source.lightMap;
    this.lightMapIntensity = source.lightMapIntensity;
    return this;
  }
}
