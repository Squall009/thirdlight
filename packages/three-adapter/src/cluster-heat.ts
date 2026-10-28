/**
 * The light clusters' heat map (a lighting debug view: the editor's View
 * menu, or `?clusterView=1` on a page): every lit pixel drawn in the colour
 * of how many lights its cell lists, from blue (one) through green and
 * yellow to red (64 and more), black where none is listed; dimmer where
 * the listed lights' spheres do not reach the pixel (what the light loop
 * would test and skip). Unlit materials, the sky and emissive light draw as
 * they do; a build that takes no local light (mode `none`) draws black.
 *
 * It reaches every lit material the way the light loop will: a light in
 * the scene (`ClusterHeatLight`, not a three.js light kind) whose node three
 * builds into every lit program; the scene's lights node builds it last
 * (`probe-lighting.ts`), so it replaces the lit result. It reads the packed
 * lists through `cluster-gpu.ts` alone: the cell from the pixel's place and
 * depth, the header, then a loop over the list reading each record — the
 * light loop's reads, so the view also proves them on the GPU it runs on.
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';

import { clusterCell, clusterIndexAt, clusterLightTexel, clusterList, clusterNodes, type ClusterGpu, type ClusterNodes } from './cluster-gpu';
import type { N } from './effects-tsl';
import { buildsLocalLights } from './local-lights';

const TSL: N = TSLTyped;
const { If, Loop, NodeUpdateType, abs, clamp, float, int, log2, max, positionView, screenUV, vec2, vec3 } = TSL;

/** Listed lights at which the colour reaches red (a power of two). */
const HEAT_FULL = 64;
/** How bright a listed light that does not reach the pixel leaves it (a share). */
const HEAT_UNREACHED = 0.3;

/** The heat map's light: its node reads the lists `gpu` holds. */
export class ClusterHeatLight extends THREE.Light {
  readonly isClusterHeat = true;

  constructor(public gpu: ClusterGpu) {
    super(0xffffff, 1);
    this.name = 'light clusters view';
    this.matrixAutoUpdate = false;
    this.matrixWorldAutoUpdate = false;
    // As the probe light: three binds an unchanged object's textures again (WebGL 2) only when a light's data
    // changes, and a shadow map's size is that data; the textures' revision stands in for it. It casts nothing.
    this.castShadow = true;
    (this as unknown as { shadow: { mapSize: { width: number; height: number } } }).shadow = { mapSize: { width: 0, height: 0 } };
  }

  /** Make every lit object take the current textures again (after they were made again, or the renderer changed). */
  rebind(): void {
    (this as unknown as { shadow: { mapSize: { width: number } } }).shadow.mapSize.width = this.gpu.revision;
  }
}

/** The jet ramp from 0 (blue) to 1 (red). */
function ramp(t: N): N {
  const four = t.mul(4);
  return clamp(vec3(float(1.5).sub(abs(four.sub(3))), float(1.5).sub(abs(four.sub(2))), float(1.5).sub(abs(four.sub(1)))), vec3(0), vec3(1));
}

class ClusterHeatNode extends (THREE.Node as unknown as new () => { updateType: string; [k: string]: unknown }) {
  static get type(): string {
    return 'ClusterHeatNode';
  }
  readonly isClusterHeatNode = true;
  private readonly t: ClusterNodes;

  constructor(readonly light: ClusterHeatLight) {
    super();
    this.t = clusterNodes(light.gpu);
    this.updateType = NodeUpdateType.RENDER;
  }

  update(): void {
    this.t.sync(this.light.gpu);
  }

  setup(builder: N): void {
    const ctx = builder.context;
    const listed = int(0).toVar('tlClusterListed');
    const reached = int(0).toVar('tlClusterReached');
    if (buildsLocalLights(builder)) {
      const t = this.t;
      // The tiles are numbered y up from the bottom of the render; the screen's share runs from the top.
      const cell = clusterCell(t, vec2(screenUV.x, screenUV.y.oneMinus()), positionView.z.negate()).toVar('tlClusterCell');
      If(cell.greaterThanEqual(0), () => {
        const { at, count } = clusterList(t, cell);
        listed.assign(count);
        Loop(count, ({ i }: { i: N }) => {
          const rec = clusterLightTexel(t, clusterIndexAt(t, at.add(i)), 0);
          If(positionView.sub(rec.xyz).length().lessThanEqual(rec.w), () => {
            reached.addAssign(1);
          });
        });
      });
    }
    const n = float(listed);
    const tone = clamp(log2(max(n, float(1))).add(1).div(Math.log2(HEAT_FULL) + 1), float(0), float(1));
    const lit = float(HEAT_UNREACHED).add(float(1 - HEAT_UNREACHED).mul(float(reached).div(max(n, float(1)))));
    const heat = ramp(tone).mul(lit).mul(n.greaterThan(0).select(float(1), float(0)));
    // The heat in place of every light's: nothing direct, nothing indirect.
    ctx.reflectedLight.directDiffuse.assign(heat);
    ctx.reflectedLight.directSpecular.assign(vec3(0));
    ctx.irradiance.assign(vec3(0));
    ctx.iblIrradiance.assign(vec3(0));
    ctx.radiance.assign(vec3(0));
  }
}

/** Whether a light node is the heat map's (the lights node builds it last). */
export function isClusterHeatNode(n: unknown): boolean {
  return (n as { isClusterHeatNode?: boolean } | null)?.isClusterHeatNode === true;
}

/** Teach a renderer the heat map's light. */
export function registerClusterHeat(renderer: { library: { addLight(node: unknown, light: unknown): void } }): void {
  renderer.library.addLight(ClusterHeatNode, ClusterHeatLight);
}
