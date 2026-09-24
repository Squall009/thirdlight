/**
 * Phase 9.6: the browser lightmap baker ("Bake preview").
 *
 * Every static mesh with UV1 is drawn in lightmap space (its UV1, moved into
 * its atlas rectangle, becomes the screen position) with a white Lambert
 * material, lit and shadowed from its real world position. Each sample adds
 * one jittered set of the baked lights into a float atlas:
 * - directional / point / spot lights: shadowed, their position or direction
 *   jittered a little (soft shadows);
 * - ambient / hemisphere lights: one shadowed directional light from a
 *   direction spread over the sphere per sample (sky occlusion), scaled so an
 *   open surface gets exactly the ambient light it would get in realtime.
 * The average is converted to what three's `lightMap` needs to reproduce the
 * same shading (measured once per bake, so the realtime and baked looks
 * match), divided by `range`, sRGB-encoded and dilated into the padding.
 * No bounce light: that is the Blender bake's job.
 *
 * Browser-only (WebGL2 with float render targets).
 */
import * as THREE from 'three';

export interface BakeMeshInput {
  /** The mesh's geometry (needs `uv1`); positions in the mesh's own space. */
  readonly geometry: THREE.BufferGeometry;
  /** Mesh space → world. */
  readonly matrixWorld: THREE.Matrix4;
}

export interface BakeTargetInput {
  readonly entityId: string;
  readonly atlas: number;
  /** UV1 → atlas UV (`uv * [sx, sy] + [ox, oy]`). */
  readonly scaleOffset: readonly [number, number, number, number];
  readonly meshes: readonly BakeMeshInput[];
}

export interface BakeLightInput {
  readonly type: 'directional' | 'ambient' | 'hemisphere' | 'point' | 'spot';
  readonly color: string;
  readonly intensity: number;
  /** World position (point/spot). */
  readonly position?: readonly [number, number, number];
  /** The direction the light shines in (directional/spot). */
  readonly direction?: readonly [number, number, number];
  readonly range?: number;
  readonly decay?: number;
  /** Cone angle in degrees (spot). */
  readonly angle?: number;
  readonly penumbra?: number;
  readonly groundColor?: string;
}

export interface BrowserBakeInput {
  readonly atlases: readonly { readonly width: number; readonly height: number }[];
  readonly targets: readonly BakeTargetInput[];
  /** Static meshes without UV1: they cast shadows but get no lightmap. */
  readonly occluders: readonly BakeMeshInput[];
  readonly lights: readonly BakeLightInput[];
  readonly samples: number;
  /** Irradiance at texel value 1.0 (the bake record's `range`). */
  readonly range: number;
  /** Texels to dilate into around every lightmap. */
  readonly padding: number;
  /** Sun softness: the jitter cone of directional lights (radians). */
  readonly softness?: number;
  readonly onProgress?: (done: number, total: number) => void;
  readonly signal?: AbortSignal;
}

export interface BakedAtlas {
  width: number;
  height: number;
  /** RGBA8, row 0 = v 0 (load with `flipY = false`), alpha 255. */
  pixels: Uint8ClampedArray;
}

export type BrowserBakeResult = { ok: true; atlases: BakedAtlas[]; millis: number } | { ok: false; code: 'bake_cancelled' | 'bake_unsupported' | 'bake_failed'; message: string };

/** Camera layer of atlas 0's lightmap pass (atlas a uses ATLAS_LAYER0 + a; at most 16 atlases). */
const ATLAS_LAYER0 = 8;

const UV_VERTEX = /* glsl */ `
#include <fog_vertex>
gl_Position = vec4( ( uv1 * tlLmScale + tlLmOffset ) * 2.0 - 1.0, 0.0, 1.0 );`;

/** A white Lambert material that renders a mesh into its lightmap rectangle. */
function bakeMaterial(scaleOffset: readonly number[]): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  m.blending = THREE.AdditiveBlending;
  m.depthTest = false;
  m.depthWrite = false;
  const scale = new THREE.Vector2(scaleOffset[0], scaleOffset[1]);
  const offset = new THREE.Vector2(scaleOffset[2], scaleOffset[3]);
  m.onBeforeCompile = (shader) => {
    shader.uniforms['tlLmScale'] = { value: scale };
    shader.uniforms['tlLmOffset'] = { value: offset };
    shader.vertexShader = `uniform vec2 tlLmScale;\nuniform vec2 tlLmOffset;\n#ifndef USE_UV1\nattribute vec2 uv1;\n#endif\n${shader.vertexShader.replace('#include <fog_vertex>', UV_VERTEX)}`;
    // In lightmap space the triangle's winding says nothing about which side
    // faces the light: always use the geometry's own normal.
    shader.fragmentShader = shader.fragmentShader.replace(/gl_FrontFacing \? 1\.0 : - 1\.0/g, '1.0');
  };
  m.customProgramCacheKey = () => 'tl-lightmap-bake';
  return m;
}

const tick = (): Promise<void> => new Promise((r) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => r()) : setTimeout(r, 0)));

/** Points spread evenly over the sphere (Fibonacci), rotated per bake. */
function sphereDirection(i: number, n: number, twist: number): THREE.Vector3 {
  const y = 1 - (2 * (i + 0.5)) / n;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const phi = i * Math.PI * (3 - Math.sqrt(5)) + twist;
  return new THREE.Vector3(Math.cos(phi) * r, y, Math.sin(phi) * r);
}

/** A small deterministic generator (the same bake gives the same result). */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    s ^= s >>> 12;
    return (s >>> 0) / 4294967296;
  };
}

function readFloatTarget(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget): Float32Array {
  const { width, height } = target;
  const out = new Float32Array(width * height * 4);
  if (target.texture.type === THREE.FloatType) {
    renderer.readRenderTargetPixels(target, 0, 0, width, height, out);
    return out;
  }
  const half = new Uint16Array(width * height * 4);
  renderer.readRenderTargetPixels(target, 0, 0, width, height, half);
  for (let i = 0; i < half.length; i++) out[i] = THREE.DataUtils.fromHalfFloat(half[i]!);
  return out;
}

/** Fill uncovered texels from covered neighbours, `passes` texels out. */
function dilate(rgb: Float32Array, covered: Uint8Array, w: number, h: number, passes: number): void {
  for (let pass = 0; pass < passes; pass++) {
    const next = covered.slice();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (covered[i]) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            const j = yy * w + xx;
            if (!covered[j]) continue;
            r += rgb[j * 3]!;
            g += rgb[j * 3 + 1]!;
            b += rgb[j * 3 + 2]!;
            n++;
          }
        }
        if (n > 0) {
          rgb[i * 3] = r / n;
          rgb[i * 3 + 1] = g / n;
          rgb[i * 3 + 2] = b / n;
          next[i] = 1;
        }
      }
    }
    covered.set(next);
  }
}

const srgb = (v: number): number => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

export async function bakeLightmapsInBrowser(input: BrowserBakeInput): Promise<BrowserBakeResult> {
  const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (typeof document === 'undefined') return { ok: false, code: 'bake_unsupported', message: 'baking needs a browser' };
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 4;
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, preserveDrawingBuffer: false });
  } catch (e) {
    return { ok: false, code: 'bake_unsupported', message: `no WebGL for baking: ${(e as Error).message}` };
  }
  const disposables: { dispose(): void }[] = [];
  try {
    const gl = renderer.getContext();
    const floatOk = gl instanceof WebGL2RenderingContext && gl.getExtension('EXT_color_buffer_float') !== null;
    const type = floatOk ? THREE.FloatType : THREE.HalfFloatType;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.autoClear = false;
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    camera.position.set(0, 0, 5);
    camera.updateMatrixWorld();

    const makeTarget = (w: number, h: number): THREE.WebGLRenderTarget => {
      const t = new THREE.WebGLRenderTarget(w, h, { type, format: THREE.RGBAFormat, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false });
      disposables.push(t);
      return t;
    };

    // ---- calibration: ambient 1 vs an overhead light 1 vs a lightmap texel 1 ----
    const calib = new THREE.Scene();
    const plane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    plane.setAttribute('uv1', plane.getAttribute('uv')!.clone());
    disposables.push(plane);
    const calibMat = bakeMaterial([1, 1, 0, 0]);
    disposables.push(calibMat);
    const calibMesh = new THREE.Mesh(plane, calibMat);
    calibMesh.frustumCulled = false;
    calibMesh.layers.set(ATLAS_LAYER0);
    calib.add(calibMesh);
    const calibTarget = makeTarget(4, 4);
    const measure = (light: THREE.Object3D | null, lightMapValue: number | null): number => {
      if (light !== null) {
        light.layers.enableAll(); // lights count only when they share a layer with the camera
        calib.add(light);
      }
      camera.layers.set(ATLAS_LAYER0);
      let lm: THREE.DataTexture | null = null;
      if (lightMapValue !== null) {
        lm = new THREE.DataTexture(new Float32Array([lightMapValue, lightMapValue, lightMapValue, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
        lm.channel = 1;
        lm.needsUpdate = true;
        calibMat.lightMap = lm;
        calibMat.lightMapIntensity = 1;
        calibMat.needsUpdate = true;
      }
      renderer.setRenderTarget(calibTarget);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(calib, camera);
      renderer.setRenderTarget(null);
      const px = readFloatTarget(renderer, calibTarget);
      if (light !== null) calib.remove(light);
      if (lm !== null) {
        calibMat.lightMap = null;
        calibMat.needsUpdate = true;
        lm.dispose();
      }
      return px[5 * 4]!; // a texel in the middle, red channel
    };
    const ambientOut = measure(new THREE.AmbientLight(0xffffff, 1), null);
    const sunLight = new THREE.DirectionalLight(0xffffff, 1);
    sunLight.position.set(0, 10, 0);
    const directOut = measure(sunLight, null);
    const lightMapOut = measure(null, 1);
    if (!(directOut > 0) || !(lightMapOut > 0)) return { ok: false, code: 'bake_failed', message: 'the bake calibration rendered nothing (WebGL float targets?)' };
    /** An open surface's ambient light, as sphere-sampled directional light: k = 4 · ambient / direct. */
    const ambientToDirect = (4 * ambientOut) / directOut;

    // ---- the bake scene ------------------------------------------------------------
    const scene = new THREE.Scene();
    const bounds = new THREE.Box3();
    /** Layer 0: every static mesh (the shadow cameras see it); layer ATLAS_LAYER0 + a: the lightmap pass of atlas a. */
    const addMesh = (m: BakeMeshInput, material: THREE.Material, atlas: number | null): THREE.Mesh => {
      const mesh = new THREE.Mesh(m.geometry, material);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(m.matrixWorld);
      mesh.matrixWorld.copy(m.matrixWorld);
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = atlas !== null;
      if (atlas !== null) mesh.layers.enable(ATLAS_LAYER0 + atlas);
      scene.add(mesh);
      m.geometry.computeBoundingBox();
      if (m.geometry.boundingBox !== null) bounds.union(m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld));
      return mesh;
    };
    for (const t of input.targets) {
      const material = bakeMaterial(t.scaleOffset);
      disposables.push(material);
      for (const m of t.meshes) addMesh(m, material, t.atlas);
    }
    const occluderMaterial = new THREE.MeshBasicMaterial();
    disposables.push(occluderMaterial);
    for (const m of input.occluders) addMesh(m, occluderMaterial, null);
    if (bounds.isEmpty()) bounds.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    const center = bounds.getCenter(new THREE.Vector3());
    const radius = Math.max(0.5, bounds.getSize(new THREE.Vector3()).length() / 2);

    /** A shadowed directional light covering the whole bake. */
    const directional = (): THREE.DirectionalLight => {
      const d = new THREE.DirectionalLight();
      d.castShadow = true;
      d.shadow.mapSize.set(2048, 2048);
      const cam = d.shadow.camera;
      cam.left = -radius;
      cam.right = radius;
      cam.top = radius;
      cam.bottom = -radius;
      cam.near = 0.01;
      cam.far = radius * 4;
      d.shadow.bias = -0.0005;
      d.shadow.normalBias = Math.max(0.01, (radius * 2) / 2048);
      d.target.position.copy(center);
      d.layers.enableAll();
      scene.add(d, d.target);
      return d;
    };
    const aim = (d: THREE.DirectionalLight, towards: THREE.Vector3): void => {
      // `towards`: the direction the light travels.
      d.position.copy(center).addScaledVector(towards, -radius * 2);
      d.target.position.copy(center);
      d.updateMatrixWorld();
      d.target.updateMatrixWorld();
    };

    type Live = { input: BakeLightInput; object: THREE.Light };
    const live: Live[] = [];
    const sky: { input: BakeLightInput; object: THREE.DirectionalLight }[] = [];
    for (const l of input.lights) {
      const colour = new THREE.Color(l.color);
      if (l.type === 'directional') {
        const d = directional();
        d.color.copy(colour);
        d.intensity = l.intensity;
        live.push({ input: l, object: d });
      } else if (l.type === 'point') {
        const p = new THREE.PointLight(colour, l.intensity, l.range ?? 0, l.decay ?? 2);
        p.castShadow = true;
        p.shadow.mapSize.set(1024, 1024);
        p.shadow.bias = -0.001;
        p.layers.enableAll();
        scene.add(p);
        live.push({ input: l, object: p });
      } else if (l.type === 'spot') {
        const s = new THREE.SpotLight(colour, l.intensity, l.range ?? 0, THREE.MathUtils.degToRad(l.angle ?? 30), l.penumbra ?? 0.2, l.decay ?? 2);
        s.castShadow = true;
        s.shadow.mapSize.set(1024, 1024);
        s.shadow.bias = -0.001;
        s.layers.enableAll();
        scene.add(s, s.target);
        live.push({ input: l, object: s });
      } else {
        const d = directional();
        sky.push({ input: l, object: d });
      }
    }

    const accum = input.atlases.map((a) => makeTarget(a.width, a.height));
    for (const t of accum) {
      renderer.setRenderTarget(t);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
    }
    renderer.setRenderTarget(null);

    const rnd = random(0x7117);
    const twist = rnd() * Math.PI * 2;
    const samples = Math.max(1, Math.floor(input.samples));
    const softness = input.softness ?? 0.03;
    const jitter = new THREE.Vector3();
    for (let s = 0; s < samples; s++) {
      if (input.signal?.aborted === true) return { ok: false, code: 'bake_cancelled', message: 'the bake was cancelled' };
      for (const { input: l, object } of live) {
        jitter.set(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1);
        if (l.type === 'directional') {
          const dir = new THREE.Vector3(...(l.direction ?? [0, -1, 0])).normalize().addScaledVector(jitter, softness).normalize();
          aim(object as THREE.DirectionalLight, dir);
        } else {
          const p = l.position ?? [0, 0, 0];
          object.position.set(p[0], p[1], p[2]).addScaledVector(jitter, 0.05);
          if (l.type === 'spot') {
            const d = new THREE.Vector3(...(l.direction ?? [0, -1, 0])).normalize();
            (object as THREE.SpotLight).target.position.copy(object.position).add(d);
            (object as THREE.SpotLight).target.updateMatrixWorld();
          }
          object.updateMatrixWorld();
        }
      }
      for (const { input: l, object } of sky) {
        // The direction light arrives FROM; the light travels the other way.
        const from = sphereDirection(s, samples, twist);
        const colour = l.type === 'hemisphere' ? new THREE.Color(from.y >= 0 ? l.color : (l.groundColor ?? '#444444')) : new THREE.Color(l.color);
        object.color.copy(colour);
        object.intensity = l.intensity * ambientToDirect;
        aim(object, from.clone().negate());
      }
      for (let a = 0; a < accum.length; a++) {
        camera.layers.set(ATLAS_LAYER0 + a);
        renderer.setRenderTarget(accum[a]!);
        renderer.render(scene, camera);
      }
      renderer.setRenderTarget(null);
      input.onProgress?.(s + 1, samples);
      if (s % 4 === 3) await tick();
    }

    // ---- read back, convert, dilate, encode ---------------------------------------
    const toLightMap = 1 / (samples * lightMapOut * Math.max(1e-6, input.range));
    const atlases: BakedAtlas[] = [];
    for (let a = 0; a < accum.length; a++) {
      const { width: w, height: h } = input.atlases[a]!;
      const raw = readFloatTarget(renderer, accum[a]!);
      const rgb = new Float32Array(w * h * 3);
      const covered = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) {
        if (raw[i * 4 + 3]! <= 0) continue;
        covered[i] = 1;
        rgb[i * 3] = raw[i * 4]! * toLightMap;
        rgb[i * 3 + 1] = raw[i * 4 + 1]! * toLightMap;
        rgb[i * 3 + 2] = raw[i * 4 + 2]! * toLightMap;
      }
      dilate(rgb, covered, w, h, Math.max(1, input.padding + 1));
      const pixels = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        pixels[i * 4] = Math.round(srgb(Math.min(1, Math.max(0, rgb[i * 3]!))) * 255);
        pixels[i * 4 + 1] = Math.round(srgb(Math.min(1, Math.max(0, rgb[i * 3 + 1]!))) * 255);
        pixels[i * 4 + 2] = Math.round(srgb(Math.min(1, Math.max(0, rgb[i * 3 + 2]!))) * 255);
        pixels[i * 4 + 3] = 255;
      }
      atlases.push({ width: w, height: h, pixels });
    }
    const ended = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return { ok: true, atlases, millis: Math.round(ended - started) };
  } catch (e) {
    return { ok: false, code: 'bake_failed', message: (e as Error).message };
  } finally {
    for (const d of disposables) d.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
  }
}
