/**
 * A digest of the committed simulation state after one step —
 * every entity's transform (exact float bits), the counters, the hidden
 * entities, the look overrides, the animator poses, the scene set's revision
 * and spawned entities and the resolved camera and the project UI state. Two runs
 * with the same inputs produce the same digest at every step: the check that
 * the simulation worker computes exactly what the page computes.
 */
import type { Runtime } from '@thirdlight/runtime';

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);

/** 32-bit FNV-1a, two lanes (different offsets) for a 64-bit digest. */
class Fnv {
  private a = 0x811c9dc5;
  private b = 0x050c5d1f;
  word(w: number): void {
    for (let s = 0; s < 32; s += 8) {
      const byte = (w >>> s) & 0xff;
      this.a = Math.imul(this.a ^ byte, 0x01000193) >>> 0;
      this.b = Math.imul(this.b ^ byte, 0x01000193) >>> 0;
    }
  }
  text(s: string): void {
    for (let i = 0; i < s.length; i += 1) this.word(s.charCodeAt(i));
    this.word(0xffffffff);
  }
  num(v: number): void {
    f64[0] = v;
    this.word(u32[0]!);
    this.word(u32[1]!);
  }
  hex(): string {
    return this.a.toString(16).padStart(8, '0') + this.b.toString(16).padStart(8, '0');
  }
}

/** The digest of the runtime's committed state now (call it right after a step). */
export function stepDigest(rt: Runtime): string {
  const h = new Fnv();
  const d = rt.getDiagnostics();
  h.num(d.ok ? d.diagnostics.stepIndex : -1);
  // The committed transforms (interpolated ones hold the last frame's timing).
  const visit = rt.forEachCommitted !== undefined ? rt.forEachCommitted.bind(rt) : rt.forEachInterpolated?.bind(rt);
  visit?.((id, p, r, s) => {
    h.text(id);
    for (let k = 0; k < 3; k += 1) h.num(p[k]!);
    for (let k = 0; k < 4; k += 1) h.num(r[k]!);
    for (let k = 0; k < 3; k += 1) h.num(s[k]!);
  });
  const c = rt.gameCounters?.();
  if (c !== undefined) h.text(JSON.stringify(c));
  const hidden = rt.hiddenEntities?.();
  if (hidden !== undefined) h.text([...hidden].sort().join(','));
  // The fields scripts wrote through ctx.entity (only while any is, so every other digest is unchanged).
  const fields = rt.entityFieldsState?.() ?? null;
  if (fields !== null) h.text(fields);
  // The look overrides (only while any is set, so every other digest is unchanged).
  const looks = rt.entityLooks?.();
  if (looks !== undefined && looks.size > 0) h.text(JSON.stringify([...looks].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
  const poses = (rt as { animatorPoses?: () => ReadonlyMap<string, unknown> }).animatorPoses?.();
  if (poses !== undefined) for (const [id, p] of poses) h.text(`${id}=${JSON.stringify(p)}`);
  const set = rt.sceneSet?.();
  if (set !== undefined) {
    h.num(set.revision);
    h.text(set.spawned.map((e) => e.id).join(','));
  }
  // The resolved camera (only a game with a virtual camera has one, so every other digest is unchanged).
  const cam = rt.cameraView?.() ?? null;
  if (cam !== null) {
    h.text(cam.live ?? '');
    h.text(cam.blend === null ? '' : `${cam.blend.from ?? ''}|${cam.blend.style}`);
    if (cam.blend !== null) h.num(cam.blend.progress);
    for (let k = 0; k < 3; k += 1) h.num(cam.position[k]!);
    for (let k = 0; k < 4; k += 1) h.num(cam.rotation[k]!);
    h.num(cam.fovY);
    h.num(cam.near);
    h.num(cam.far);
    h.num(cam.letterbox);
    h.num(cam.shake);
  }
  // The audio intent log (only once scripts used audio, so every other digest is unchanged).
  const audio = rt.audioState?.() ?? null;
  if (audio !== null) h.text(JSON.stringify(audio));
  // The material parameters scripts set (only while any is set, so every other digest is unchanged).
  const mat = rt.materialState?.() ?? null;
  if (mat !== null) h.text(mat);
  // The environment preset blend (only once a script changed the environment, so every other digest is unchanged).
  const env = rt.environmentState?.() ?? null;
  if (env !== null) h.text(env);
  // The project saves state (document, play time, settings, slot list, outcomes; only with a save schema and once used).
  const saves = rt.savesState?.() ?? null;
  if (saves !== null) h.text(saves);
  // The dialogue runner (only once a conversation or a dialogue call happened, so every other digest is unchanged).
  const dlg = rt.dialogueState?.() ?? null;
  if (dlg !== null) h.text(dlg);
  // The timelines (only once one played, so every other digest is unchanged).
  const tl = rt.timelineState?.() ?? null;
  if (tl !== null) h.text(tl);
  // The project UI's view model and shown documents (only once a script or a frame used it).
  const ui = rt.uiView?.();
  if (ui !== undefined && (Object.keys(ui.model).length > 0 || ui.shown.length > 0)) {
    h.text(JSON.stringify(ui.model));
    h.text(JSON.stringify(ui.shown));
  }
  // The game mode (only a project with modes has one, so every other digest is unchanged).
  const mode = rt.modeView?.() ?? null;
  if (mode !== null) h.text(`${mode.current}|${mode.previous}|${mode.since}|${mode.pending}`);
  return h.hex();
}

/**
 * The digest of the world as this run has made it — for
 * comparing a run with its replay (a restart and the same input). Unlike
 * `stepDigest` it counts steps from the run's start (a restart's boundary),
 * names spawned copies by their number in this run (ids are never reused in
 * a play, so a replay's copies have higher ids) and hashes which scenes are
 * loaded instead of the scene set's revision (it grows across restarts). It
 * covers every object's transform, the counters, the hidden and switched-off
 * objects, the fields scripts wrote, the looks, the animator poses, the
 * loaded scenes and spawned copies, the resolved camera, the UI's view model
 * and shown documents, the material values, the environment blend and the
 * game mode (the committed transforms; the interpolated ones hold the
 * last frame's timing). It leaves out the logs of when things happened (sounds,
 * timelines, dialogue, saves, a mode's switch step), which hold absolute
 * step numbers; ids inside values scripts wrote are hashed as they are.
 */
export function runDigest(rt: Runtime): { readonly stepIndex: number; readonly runStep: number; readonly digest: string } {
  const h = new Fnv();
  const d = rt.getDiagnostics();
  const stepIndex = d.ok ? d.diagnostics.stepIndex : 0;
  const start = rt.runStart?.() ?? { step: 0, spawnBase: 0 };
  const runStep = stepIndex - start.step;
  const rel = (id: string): string => {
    if (!id.startsWith('spawn-')) return id;
    const n = Number(id.slice(6));
    return Number.isInteger(n) && n > start.spawnBase ? `spawn-run-${n - start.spawnBase}` : id;
  };
  const byId = <T>(entries: Iterable<[string, T]>): [string, T][] => [...entries].map(([k, v]) => [rel(k), v] as [string, T]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  h.num(runStep);
  const transforms: [string, number[]][] = [];
  // The committed transforms — interpolated ones depend on the last frame's timing.
  const visit = rt.forEachCommitted !== undefined ? rt.forEachCommitted.bind(rt) : rt.forEachInterpolated?.bind(rt);
  visit?.((id, p, r, sc) => {
    transforms.push([rel(id), [p[0]!, p[1]!, p[2]!, r[0]!, r[1]!, r[2]!, r[3]!, sc[0]!, sc[1]!, sc[2]!]]);
  });
  transforms.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [id, v] of transforms) {
    h.text(id);
    for (const n of v) h.num(n);
  }
  const c = rt.gameCounters?.();
  if (c !== undefined) h.text(JSON.stringify(c));
  const hidden = rt.hiddenEntities?.();
  if (hidden !== undefined) h.text([...hidden].map(rel).sort().join(','));
  const fields = rt.entityFieldsState?.() ?? null;
  if (fields !== null) h.text(fields);
  const looks = rt.entityLooks?.();
  if (looks !== undefined && looks.size > 0) h.text(JSON.stringify(byId(looks)));
  const poses = (rt as { animatorPoses?: () => ReadonlyMap<string, unknown> }).animatorPoses?.();
  if (poses !== undefined) for (const [id, p] of byId(poses)) h.text(`${id}=${JSON.stringify(p)}`);
  const set = rt.sceneSet?.();
  if (set !== undefined) {
    const status = set.status as Readonly<Record<string, string>>;
    h.text(Object.keys(status).sort().map((k) => `${k}=${status[k]}`).join(','));
    h.text(set.spawned.map((e) => rel(e.id)).join(','));
  }
  const cam = rt.cameraView?.() ?? null;
  if (cam !== null) {
    h.text(cam.live ?? '');
    for (let k = 0; k < 3; k += 1) h.num(cam.position[k]!);
    for (let k = 0; k < 4; k += 1) h.num(cam.rotation[k]!);
    h.num(cam.fovY);
  }
  const mat = rt.materialState?.() ?? null;
  if (mat !== null) h.text(mat);
  const env = rt.environmentState?.() ?? null;
  if (env !== null) h.text(env);
  const ui = rt.uiView?.();
  if (ui !== undefined && (Object.keys(ui.model).length > 0 || ui.shown.length > 0)) {
    h.text(JSON.stringify(ui.model));
    h.text(JSON.stringify(ui.shown));
  }
  const mode = rt.modeView?.() ?? null;
  if (mode !== null) h.text(mode.current);
  return { stepIndex, runStep, digest: h.hex() };
}
