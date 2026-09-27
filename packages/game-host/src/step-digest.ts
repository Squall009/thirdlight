/**
 * Phase 22.0: a digest of the committed simulation state after one step —
 * the committed game view, every entity's transform (exact float bits), the
 * counters, the hidden and fading entities, the animator poses, the scene
 * set's revision and spawned entities, the run's save state and (phase 23.4)
 * the resolved camera and (phase 23.9a) the project UI state. Two runs
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
  const view = rt.peekGameView !== undefined ? rt.peekGameView() : (() => {
    const v = rt.getGameView();
    return v.ok ? v.view : null;
  })();
  h.text(view === null ? 'null' : JSON.stringify(view));
  rt.forEachInterpolated?.((id, p, r, s) => {
    h.text(id);
    for (let k = 0; k < 3; k += 1) h.num(p[k]!);
    for (let k = 0; k < 4; k += 1) h.num(r[k]!);
    for (let k = 0; k < 3; k += 1) h.num(s[k]!);
  });
  const c = rt.gameCounters?.();
  if (c !== undefined) h.text(JSON.stringify(c));
  const hidden = rt.hiddenEntities?.();
  if (hidden !== undefined) h.text([...hidden].sort().join(','));
  const fade = rt.entityOpacity?.();
  if (fade !== undefined) for (const [id, o] of fade) {
    h.text(id);
    h.num(o);
  }
  const poses = (rt as { animatorPoses?: () => ReadonlyMap<string, unknown> }).animatorPoses?.();
  if (poses !== undefined) for (const [id, p] of poses) h.text(`${id}=${JSON.stringify(p)}`);
  const set = rt.sceneSet?.();
  if (set !== undefined) {
    h.num(set.revision);
    h.text(set.spawned.map((e) => e.id).join(','));
  }
  const save = rt.runState?.();
  if (save !== undefined) h.text(JSON.stringify(save));
  // Phase 23.4: the resolved camera (only a game with a virtual camera has one, so every other digest is unchanged).
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
  // Phase 23.13: the audio intent log (only once scripts used audio, so every other digest is unchanged).
  const audio = rt.audioState?.() ?? null;
  if (audio !== null) h.text(JSON.stringify(audio));
  // Phase 23.12: the material parameters scripts set (only while any is set, so every other digest is unchanged).
  const mat = rt.materialState?.() ?? null;
  if (mat !== null) h.text(mat);
  // Phase 23.19: the project saves state (document, play time, settings, slot list, outcomes; only with a save schema and once used).
  const saves = rt.savesState?.() ?? null;
  if (saves !== null) h.text(saves);
  // Phase 23.17: the timelines (only once one played, so every other digest is unchanged).
  const tl = rt.timelineState?.() ?? null;
  if (tl !== null) h.text(tl);
  // Phase 23.9a: the project UI's view model and shown documents (only once a script or a frame used it).
  const ui = rt.uiView?.();
  if (ui !== undefined && (Object.keys(ui.model).length > 0 || ui.shown.length > 0)) {
    h.text(JSON.stringify(ui.model));
    h.text(JSON.stringify(ui.shown));
  }
  // Phase 23.10: the game mode (only a project with modes has one, so every other digest is unchanged).
  const mode = rt.modeView?.() ?? null;
  if (mode !== null) h.text(`${mode.current}|${mode.previous}|${mode.since}|${mode.pending}`);
  return h.hex();
}
