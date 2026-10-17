/**
 * The occlusion oracle: how much of what the view draws no pixel shows.
 *
 * The view's scene is drawn once more, from the view's camera with its
 * per-camera counts (what `view-cull.ts` and the rooms leave the view), into
 * a target of ids: each drawable, each instance copy and each member of a
 * merged static cell writes its own id. The ids with a pixel left are what is
 * seen; the rest is drawn work that occlusion culling could skip at best
 * (occlusion-oracle-count.ts counts it). Opaque items are drawn with their
 * own materials' vertex stages and discards (wind, cut-outs, skinning), so
 * the depth they leave is the frame's (models' `_OCC` stand-ins included,
 * which write depth and no id); transparent items are drawn in a
 * second picture over the opaque depth, since they hide nothing (written
 * whole, so where two overlap only the front one's id is left there).
 *
 * A measuring tool (the perf harness reads it from the scene), never part of
 * a frame: it changes the materials' outputs for its two renders and puts
 * them back, so the programs are built again afterwards.
 */
import * as THREE from 'three';
import { attribute, float, Fn, floor, instanceIndex, mod, uniform, vec4 } from 'three/tsl';
import type { NodeBuilder, WebGPURenderer } from 'three/webgpu';

import { countOracle, hiddenEntries, memberTriangles, ORACLE_ID_LIMIT, type OracleCount, type OracleEntry, type OracleKind } from './occlusion-oracle-count';
import type { OcclusionPath } from '@thirdlight/runtime';

import { OCCLUSION_SWITCH_KEY, type OcclusionSwitch } from './occlusion';
import { drawCapacityOf, drawTrianglesOf } from './occludees';
import { isOccluderStandin } from './occluders';
import { mergedMembersOf } from './static-merge';
import { HIDDEN_BY_OCCLUSION, hideFromView } from './view-hidden';

/** `scene.userData[OCCLUSION_ORACLE_KEY]`: `(renderer, camera, options?) => Promise<OracleResult>` on a scene the adapter draws. */
export const OCCLUSION_ORACLE_KEY = 'tlOcclusionOracle';

/** The vertex attribute a merged mesh carries during the oracle: each vertex's member number. */
const MEMBER_ATTRIBUTE = 'tlOracleMember';

export interface OracleResult extends OracleCount {
  width: number;
  height: number;
  /** Drawables left out, by why: `points`, `lines`, `sprites` (not meshes), `ids` (past the id range). */
  skipped: Record<string, number>;
  ms: number;
  /** The occlusion culling path the view was drawn with (what it counts is what that path left drawn). */
  occlusion: OcclusionPath;
  /** With `hideHidden`: the draws now hidden from the view (every item of theirs hidden). */
  hiddenNow?: number;
}

export interface OracleOptions {
  /**
   * Afterwards, hide from the view every draw none of whose items was seen (shadows keep them): the frame as an
   * ideal culling of whole draws would draw it, for as long as the view stays where it is. A measurement's last
   * step; nothing puts them back. Occlusion culling is pinned off first, so the ideal culling stands alone.
   */
  readonly hideHidden?: boolean;
}

/** Items drawn by the view's render of `mesh` (read right after its own `onBeforeRender` chose them). */
function drawnCount(mesh: THREE.Mesh, merged: boolean): number {
  if (merged) return mesh.geometry.drawRange.count;
  if ((mesh as THREE.InstancedMesh).isInstancedMesh === true) return (mesh as THREE.InstancedMesh).count;
  const g = mesh.geometry as THREE.InstancedBufferGeometry;
  return g.isInstancedBufferGeometry === true ? (Number.isFinite(g.instanceCount) ? g.instanceCount : 1) : 1;
}

type IdMaterial = THREE.Material & { isNodeMaterial?: boolean; outputNode: unknown; fragmentNode: unknown; colorWrite: boolean };

/** Draw `scene` from `camera` into id targets and count what is seen (see the module comment). */
export async function runOcclusionOracle(renderer: WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera, options: OracleOptions = {}): Promise<OracleResult> {
  const t0 = performance.now();
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const width = Math.max(1, Math.floor(size.x));
  const height = Math.max(1, Math.floor(size.y));

  // What the view could draw now: meshes on the camera's layers, shown from the root.
  const meshes: THREE.Mesh[] = [];
  const hide: THREE.Object3D[] = [];
  const skipped: Record<string, number> = {};
  const skip = (o: THREE.Object3D, why: string): void => {
    hide.push(o);
    skipped[why] = (skipped[why] ?? 0) + 1;
  };
  scene.traverseVisible((o) => {
    if (!o.layers.test(camera.layers)) return;
    const m = o as THREE.Mesh;
    if (m.isMesh !== true) {
      if ((o as THREE.Points).isPoints === true) skip(o, 'points');
      else if ((o as THREE.Line).isLine === true) skip(o, 'lines');
      else if ((o as THREE.Sprite).isSprite === true) skip(o, 'sprites');
      return;
    }
    meshes.push(m);
  });

  // Ids: a block per drawable, as many as it could draw.
  const bases = new WeakMap<THREE.Object3D, number>();
  const plan: { mesh: THREE.Mesh; base: number; members: { vStart: number; vCount: number }[] | null; transparent: boolean; drawn: number }[] = [];
  let next = 1;
  for (const mesh of meshes) {
    const members = mergedMembersOf(mesh);
    const cap = drawCapacityOf(mesh, members);
    if (next + cap >= ORACLE_ID_LIMIT) {
      skip(mesh, 'ids');
      continue;
    }
    bases.set(mesh, next);
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    plan.push({ mesh, base: next, members, transparent: mats.some((x) => x.transparent), drawn: 0 });
    next += cap;
  }

  // The id: the drawable's base, plus its copy (instanced draws) or its member (merged cells; else 0).
  const base = uniform(0).onObjectUpdate(({ object }) => bases.get(object as THREE.Object3D) ?? 0);
  const member = Fn((builder: NodeBuilder) => ((builder as unknown as { hasGeometryAttribute(name: string): boolean }).hasGeometryAttribute(MEMBER_ATTRIBUTE) ? attribute(MEMBER_ATTRIBUTE, 'float').round() : float(0)));
  const id = (base as unknown as ReturnType<typeof float>).add(float(instanceIndex)).add(member() as unknown as ReturnType<typeof float>);
  const idColor = vec4(mod(id, 256).div(255), mod(floor(id.div(256)), 256).div(255), floor(id.div(65536)).div(255), 1);

  // Saved to put back: materials' outputs, hooks, member attributes, hidden objects, the scene's background.
  const materials = new Map<IdMaterial, { outputNode: unknown; fragmentNode: unknown; blending: THREE.Blending; colorWrite: boolean; plain: boolean }>();
  const hooks = new Map<THREE.Mesh, THREE.Object3D['onBeforeRender']>();
  const memberGeometries: THREE.BufferGeometry[] = [];
  const shown = hide.map((o) => o.visible);
  const background = scene.background;
  const prevTarget = renderer.getRenderTarget();
  // One colour output: a scene pass's outputs (normals, ids of its own) must not be bound to the id target.
  const prevMrt = renderer.getMRT();
  const prevClear = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  const target = new THREE.RenderTarget(width, height, { type: THREE.UnsignedByteType, depthBuffer: true, samples: 0 });
  const pictures: Uint8Array[] = [];
  try {
    for (const o of hide) o.visible = false;
    scene.background = null;
    for (const p of plan) {
      const mats = (Array.isArray(p.mesh.material) ? p.mesh.material : [p.mesh.material]) as IdMaterial[];
      for (const m of mats) {
        if (materials.has(m)) continue;
        // A plain material is turned into a node material at each build with its own properties copied, these too.
        materials.set(m, { outputNode: m.outputNode, fragmentNode: m.fragmentNode, blending: m.blending, colorWrite: m.colorWrite, plain: m.isNodeMaterial !== true });
        m.outputNode = idColor;
        m.fragmentNode = null;
        // Ids are written whole: a transparent item blended over what is behind would mix two ids.
        m.blending = THREE.NoBlending;
        m.needsUpdate = true;
      }
      if (p.members !== null) {
        const g = p.mesh.geometry;
        const ids = new Float32Array(g.getAttribute('position').count);
        p.members.forEach((s, k) => ids.fill(k, s.vStart, s.vStart + s.vCount));
        g.setAttribute(MEMBER_ATTRIBUTE, new THREE.BufferAttribute(ids, 1));
        memberGeometries.push(g);
      }
      const own = p.mesh.onBeforeRender;
      hooks.set(p.mesh, own);
      p.mesh.onBeforeRender = function (this: THREE.Mesh, r, s, c, g, m, grp) {
        own.call(this, r, s, c, g, m, grp);
        if (c !== camera) return;
        p.drawn = Math.max(p.drawn, drawnCount(this, p.members !== null));
      };
    }
    renderer.setClearColor(0x000000, 0);
    renderer.setMRT(null);
    const picture = async (transparent: boolean): Promise<Uint8Array> => {
      for (const p of plan) {
        const mats = (Array.isArray(p.mesh.material) ? p.mesh.material : [p.mesh.material]) as IdMaterial[];
        if (transparent) for (const m of mats) m.colorWrite = m.transparent;
        else p.mesh.visible = !p.transparent;
      }
      renderer.setRenderTarget(target);
      renderer.clear();
      renderer.render(scene, camera);
      const px = (await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height)) as Uint8Array;
      return new Uint8Array(px.buffer, px.byteOffset, px.byteLength).slice();
    };
    // The opaque items alone, then the transparent ones over the opaque depth (written, not coloured).
    pictures.push(await picture(false));
    for (const p of plan) p.mesh.visible = true;
    const opaqueDrawn = new Map(plan.map((p) => [p, p.drawn]));
    pictures.push(await picture(true));
    for (const p of plan) if (!p.transparent) p.drawn = opaqueDrawn.get(p)!;
  } finally {
    for (const [m, s] of materials) {
      if (s.plain) {
        delete (m as Partial<IdMaterial>).outputNode;
        delete (m as Partial<IdMaterial>).fragmentNode;
      } else {
        m.outputNode = s.outputNode;
        m.fragmentNode = s.fragmentNode;
      }
      m.blending = s.blending;
      m.colorWrite = s.colorWrite;
      m.needsUpdate = true;
    }
    for (const [mesh, own] of hooks) mesh.onBeforeRender = own;
    for (const g of memberGeometries) g.deleteAttribute(MEMBER_ATTRIBUTE);
    for (const p of plan) p.mesh.visible = true;
    hide.forEach((o, i) => (o.visible = shown[i]!));
    scene.background = background;
    renderer.setRenderTarget(prevTarget);
    renderer.setMRT(prevMrt);
    renderer.setClearColor(prevClear, prevAlpha);
    target.dispose();
  }

  const entries: OracleEntry[] = [];
  const meshOf = new Map<OracleEntry, THREE.Mesh>();
  for (const p of plan) {
    // A stand-in writes depth and no id (its material writes no colour): it hides, it is not drawn work.
    if (p.drawn <= 0 || isOccluderStandin(p.mesh)) continue;
    const g = p.mesh.geometry;
    const draws = Array.isArray(p.mesh.material) ? Math.max(1, g.groups.length) : 1;
    let kind: OracleKind = p.transparent ? 'transparent' : p.members !== null ? 'merged' : 'single';
    let triangles: number | Float64Array = drawTrianglesOf(g);
    let count = p.drawn;
    if (p.members !== null && g.index !== null) {
      // A merged draw's view part is a leading index range; its members are counted by their triangles in it.
      const vStarts = p.members.map((s) => s.vStart);
      triangles = memberTriangles(g.index.array, Math.max(0, g.drawRange.start), p.drawn, vStarts);
      count = p.members.length;
    } else if (count > 1 || (g as THREE.InstancedBufferGeometry).isInstancedBufferGeometry === true || (p.mesh as THREE.InstancedMesh).isInstancedMesh === true) {
      if (!p.transparent) kind = 'instanced';
    }
    const entry: OracleEntry = { kind, base: p.base, count, triangles, draws };
    entries.push(entry);
    meshOf.set(entry, p.mesh);
  }
  const counted = countOracle(entries, pictures);
  const culling = scene.userData[OCCLUSION_SWITCH_KEY] as OcclusionSwitch | undefined;
  const out: OracleResult = { ...counted, width, height, skipped, ms: Math.round(performance.now() - t0), occlusion: culling?.path() ?? 'off' };
  if (options.hideHidden === true) {
    culling?.pin('off');
    let n = 0;
    for (const e of hiddenEntries(entries, pictures)) if (hideFromView(meshOf.get(e)!, HIDDEN_BY_OCCLUSION, true)) n += 1;
    out.hiddenNow = n;
  }
  return out;
}
