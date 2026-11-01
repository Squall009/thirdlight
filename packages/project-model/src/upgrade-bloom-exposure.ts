/**
 * The schema 8 step that keeps a look's bloom threshold where it was when
 * the threshold moved after exposure.
 *
 * Bloom's threshold used to be compared with the scene's colour before
 * exposure; it is now compared with the exposed colour, so a later exposure
 * change (or adaptation) calms the glow with the picture. In a look whose own
 * exposure is 1 nothing moves. In a look with another exposure the same
 * brightness now sits at threshold × exposure, so that is written in its
 * place (the default threshold, where the look left it out). Each scene's
 * look and each environment preset is upgraded on its own: a preset that
 * changes only the exposure over a scene's bloom is not (the note says so).
 *
 * Pure: works on the raw documents before they are validated; a project whose
 * looks have no bloom with an exposure other than 1 is returned as it was.
 */
import { BLOOM_DEFAULTS, BLOOM_LIMITS } from './materials';
import { isPlainObject } from './validate';

type Obj = Record<string, unknown>;

/** Thresholds are written to this many decimals (the field's step is 0.05). */
const DECIMALS = 4;

/** The post settings with the threshold scaled by the exposure (null: nothing to change); `clamped`: past the field's bound. */
function upgradedPost(post: unknown): { post: Obj; clamped: boolean } | null {
  if (!isPlainObject(post) || !isPlainObject(post['bloom'])) return null;
  const exposure = post['exposure'];
  if (typeof exposure !== 'number' || !Number.isFinite(exposure) || exposure === 1) return null;
  const bloom = post['bloom'];
  const was = typeof bloom['threshold'] === 'number' ? bloom['threshold'] : BLOOM_DEFAULTS.threshold;
  const scaled = Number((was * exposure).toFixed(DECIMALS));
  const threshold = Math.min(BLOOM_LIMITS.threshold, scaled);
  return { post: { ...post, bloom: { ...bloom, threshold } }, clamped: threshold < scaled };
}

/** An environment-like object (a scene's look, a preset) with its post upgraded (null: unchanged). */
function upgradedLook(look: unknown): { look: Obj; clamped: boolean } | null {
  if (!isPlainObject(look)) return null;
  const r = upgradedPost(look['post']);
  return r === null ? null : { look: { ...look, post: r.post }, clamped: r.clamped };
}

/** Scale bloom thresholds by their look's exposure (see the file comment). */
export function upgradeBloomExposure(contentIn: unknown, scenesIn: readonly unknown[]): { content: unknown; scenes: unknown[]; changed: boolean; notes: string[] } {
  const notes: string[] = [];
  let changed = false;
  const note = (where: string, clamped: boolean): void => {
    changed = true;
    notes.push(`${where}: the bloom threshold is now compared after exposure; it was scaled by the look's exposure so the same brightness glows${clamped ? ` (capped at ${BLOOM_LIMITS.threshold})` : ''}`);
  };
  const scenes = scenesIn.map((scene) => {
    if (!isPlainObject(scene)) return scene;
    const r = upgradedLook(scene['environment']);
    if (r === null) return scene;
    note(`scene ${String(scene['sceneId'] ?? '?')}`, r.clamped);
    return { ...scene, environment: r.look };
  });
  let content = contentIn;
  if (isPlainObject(contentIn) && isPlainObject(contentIn['environment']) && Array.isArray(contentIn['environment']['presets'])) {
    const env = contentIn['environment'];
    let presetsChanged = false;
    const presets = (env['presets'] as unknown[]).map((p) => {
      const r = upgradedLook(p);
      if (r === null) return p;
      presetsChanged = true;
      note(`environment preset ${String((p as Obj)['presetId'] ?? '?')}`, r.clamped);
      return r.look;
    });
    if (presetsChanged) content = { ...contentIn, environment: { ...env, presets } };
  }
  if (changed) notes.push('a preset that sets only the exposure, over a scene look with bloom, now also moves where that bloom starts');
  return { content, scenes: changed ? scenes : [...scenesIn], changed, notes };
}
