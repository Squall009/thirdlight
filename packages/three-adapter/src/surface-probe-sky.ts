/**
 * The sky as the live probes see it (`surface-probe-wgsl.ts`'s `sky`): the
 * light from every direction where a probe ray meets nothing, as four RGB
 * first-order SH coefficients of radiance. It is what a probe bake sees
 * there: the scene's environment map (turned as the scene turns it, times
 * its intensity) or else its background colour, plus the ambient and
 * hemisphere lights the probes hold (baked or mixed: inside the probes'
 * tiles the probe lighting draws them in their place).
 *
 * The environment is projected on the GPU (`SKY_SAMPLES` directions of the
 * map, four pixels read back), again only when what it is made of changed.
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';

import type { N } from './effects-tsl';
import { isProbeHeld } from './probe-lighting';
import { SH_E0, SH_E1, SH_Y0, SH_Y1 } from './surface-probes';

const TSL: N = TSLTyped;
const { Fn, Loop, float, int, pmremTexture, screenCoordinate, select, uniform, vec3, vec4 } = TSL;

/** Directions the environment is projected over (an equal-area Fibonacci sphere). */
const SKY_SAMPLES = 512;
/** How rough a lookup of the environment is (smooths a small bright sun in the map without moving its light). */
const SKY_ROUGHNESS = 0.25;
/** How often (ms) what the sky is made of is looked at again. */
const SKY_CHECK_MS = 500;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

interface SkyRenderer {
  getRenderTarget(): THREE.RenderTarget | null;
  setRenderTarget(t: THREE.RenderTarget | null): void;
  readRenderTargetPixelsAsync(t: THREE.RenderTarget, x: number, y: number, w: number, h: number): Promise<ArrayBufferView>;
}

export class SkyProbe {
  /** Radiance SH: band 0, then the y, z and x terms, RGB each. */
  readonly coefficients = new Float32Array(12);
  /** Bumped when the coefficients changed. */
  version = 0;
  private key = '';
  private checkedAt = -Infinity;
  private busy = false;
  private target: THREE.RenderTarget | null = null;
  private quad: THREE.QuadMesh | null = null;
  private env: THREE.Texture | null = null;
  private readonly intensity: N = uniform(1);
  private readonly turn: N = uniform(0);

  /** Look at the scene's sky (cheap unless it changed). */
  update(renderer: unknown, scene: THREE.Scene, now = performance.now()): void {
    if (this.busy || now - this.checkedAt < SKY_CHECK_MS) return;
    this.checkedAt = now;
    const held: { kind: 'ambient' | 'hemisphere'; sky: THREE.Color; ground: THREE.Color }[] = [];
    for (const o of scene.children) {
      const l = o as THREE.Light & { isAmbientLight?: boolean; isHemisphereLight?: boolean; groundColor?: THREE.Color };
      if (!l.visible || !isProbeHeld(l)) continue;
      if (l.isAmbientLight === true) held.push({ kind: 'ambient', sky: l.color.clone().multiplyScalar(l.intensity), ground: new THREE.Color(0) });
      else if (l.isHemisphereLight === true) held.push({ kind: 'hemisphere', sky: l.color.clone().multiplyScalar(l.intensity), ground: (l.groundColor ?? new THREE.Color(0)).clone().multiplyScalar(l.intensity) });
    }
    const env = scene.environment;
    const bg = (scene.background as THREE.Color | null)?.isColor === true ? (scene.background as THREE.Color) : null;
    const key = JSON.stringify([env?.uuid ?? null, env?.version ?? 0, scene.environmentIntensity, scene.environmentRotation.y, bg?.getHex() ?? null, held.map((h) => [h.kind, h.sky.toArray(), h.ground.toArray()])]);
    if (key === this.key) return;
    this.key = key;
    const c = new Float32Array(12);
    for (const h of held) {
      // Irradiance as three gives it: an ambient light's colour × intensity everywhere; a hemisphere light's (sky + ground) / 2 + (sky − ground) / 2 · n.y.
      const mean = h.kind === 'ambient' ? h.sky : h.sky.clone().add(h.ground).multiplyScalar(0.5);
      const slope = h.kind === 'ambient' ? new THREE.Color(0) : h.sky.clone().sub(h.ground).multiplyScalar(0.5);
      [mean.r, mean.g, mean.b].forEach((v, k) => (c[k]! += v / SH_E0));
      [slope.r, slope.g, slope.b].forEach((v, k) => (c[3 + k]! += v / SH_E1));
    }
    if (env === null) {
      if (bg !== null) [bg.r, bg.g, bg.b].forEach((v, k) => (c[k]! += v * SH_Y0 * 4 * Math.PI));
      this.publish(c);
      return;
    }
    this.busy = true;
    this.project(renderer as SkyRenderer, env, scene.environmentIntensity, scene.environmentRotation.y).then(
      (e) => {
        this.busy = false;
        for (let k = 0; k < 12; k += 1) c[k]! += e[k]!;
        this.publish(c);
      },
      () => {
        this.busy = false;
        this.publish(c);
      },
    );
  }

  private publish(c: Float32Array): void {
    this.coefficients.set(c);
    this.version += 1;
  }

  /** The environment's radiance SH, on the GPU: pixel k is coefficient k. */
  private async project(renderer: SkyRenderer, env: THREE.Texture, intensity: number, turn: number): Promise<Float32Array> {
    if (this.quad === null || this.env !== env) {
      this.env = env;
      (this.quad?.material as THREE.Material | undefined)?.dispose();
      const material = new THREE.NodeMaterial();
      material.outputNode = Fn(() => {
        const coef = int(screenCoordinate.x).toVar();
        const sum = vec3(0).toVar();
        Loop(SKY_SAMPLES, ({ i }: { i: N }) => {
          const fi = float(i);
          const y = float(1).sub(fi.mul(2).add(1).div(SKY_SAMPLES));
          const r = y.mul(y).oneMinus().max(0).sqrt();
          const phi = fi.mul(GOLDEN_ANGLE);
          const d = vec3(r.mul(phi.cos()), y, r.mul(phi.sin()));
          // The map as the scene shows it turned (Ry(θ)ᵀ·d).
          const cs = this.turn.cos();
          const sn = this.turn.sin();
          const look = vec3(d.x.mul(cs).sub(d.z.mul(sn)), d.y, d.x.mul(sn).add(d.z.mul(cs)));
          const L = pmremTexture(env, look, float(SKY_ROUGHNESS)).rgb.mul(this.intensity);
          const basis = select(coef.equal(0), float(SH_Y0), select(coef.equal(1), d.y.mul(SH_Y1), select(coef.equal(2), d.z.mul(SH_Y1), d.x.mul(SH_Y1))));
          sum.addAssign(L.mul(basis));
        });
        return vec4(sum.mul((4 * Math.PI) / SKY_SAMPLES), 1);
      })();
      material.depthTest = false;
      material.depthWrite = false;
      this.quad = new THREE.QuadMesh(material);
      this.target ??= new THREE.RenderTarget(4, 1, { type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, generateMipmaps: false });
    }
    this.intensity.value = intensity;
    this.turn.value = turn;
    const was = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    this.quad.render(renderer as unknown as THREE.Renderer);
    renderer.setRenderTarget(was);
    const px = (await renderer.readRenderTargetPixelsAsync(this.target!, 0, 0, 4, 1)) as Float32Array;
    const out = new Float32Array(12);
    for (let k = 0; k < 4; k += 1) for (let q = 0; q < 3; q += 1) out[k * 3 + q] = px[k * 4 + q]!;
    return out;
  }

  dispose(): void {
    (this.quad?.material as THREE.Material | undefined)?.dispose();
    this.target?.dispose();
    this.quad = null;
    this.target = null;
  }
}
