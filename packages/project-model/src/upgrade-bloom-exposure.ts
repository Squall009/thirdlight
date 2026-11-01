/**
 * The schema 8 step that keeps a look's bloom where it was when bloom moved
 * after exposure.
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
 * The default strength fell at the same time (`BLOOM_DEFAULTS.strength`), so
 * a look with bloom on that left its strength out gets the old default
 * written, and glows as strongly as it did.
 *
 * A quality level's threshold override applies to every look: it is scaled
 * by the looks' exposure where every look with bloom on has the same one,
 * and left (with a note) where they differ. A level's absent strength is the
 * look's, which this step writes.
 *
 * Pure: works on the raw documents before they are validated; a project whose
 * looks have no bloom on is returned as it was.
 */
import { BLOOM_DEFAULTS, BLOOM_LIMITS } from './materials';
import { isPlainObject } from './validate';

type Obj = Record<string, unknown>;

/** Thresholds are written to this many decimals (the field's step is 0.05). */
const DECIMALS = 4;

/** The default strength before bloom moved after exposure: written where a look with bloom on left it out. */
const STRENGTH_BEFORE = 0.6;

/** What changed in one look's bloom. */
interface Change {
  readonly scaled: boolean;
  readonly clamped: boolean;
  readonly strength: boolean;
}

/** A threshold times an exposure, to the field's bound. */
function scaledThreshold(was: number, exposure: number): { threshold: number; clamped: boolean } {
  const scaled = Number((was * exposure).toFixed(DECIMALS));
  const threshold = Math.min(BLOOM_LIMITS.threshold, scaled);
  return { threshold, clamped: threshold < scaled };
}

/** A look's exposure (1 where it leaves it out or it is not a number). */
function exposureOf(post: Obj): number {
  const e = post['exposure'];
  return typeof e === 'number' && Number.isFinite(e) ? e : 1;
}

/** The post settings with the threshold scaled by the exposure and the old default strength written (null: nothing to change). */
function upgradedPost(post: unknown): { post: Obj; change: Change } | null {
  if (!isPlainObject(post) || !isPlainObject(post['bloom'])) return null;
  const bloom = post['bloom'];
  const exposure = exposureOf(post);
  const scale = exposure !== 1;
  const strength = bloom['enabled'] === true && bloom['strength'] === undefined;
  if (!scale && !strength) return null;
  const out: Obj = { ...bloom };
  let clamped = false;
  if (scale) {
    const r = scaledThreshold(typeof bloom['threshold'] === 'number' ? bloom['threshold'] : BLOOM_DEFAULTS.threshold, exposure);
    out['threshold'] = r.threshold;
    clamped = r.clamped;
  }
  if (strength) out['strength'] = STRENGTH_BEFORE;
  return { post: { ...post, bloom: out }, change: { scaled: scale, clamped, strength } };
}

/** An environment-like object (a scene's look, a preset) with its post upgraded (null: unchanged). */
function upgradedLook(look: unknown): { look: Obj; change: Change } | null {
  if (!isPlainObject(look)) return null;
  const r = upgradedPost(look['post']);
  return r === null ? null : { look: { ...look, post: r.post }, change: r.change };
}

/** The exposure of a look whose bloom is on (null: none on). */
function bloomExposure(look: unknown): number | null {
  if (!isPlainObject(look) || !isPlainObject(look['post'])) return null;
  const post = look['post'];
  return isPlainObject(post['bloom']) && post['bloom']['enabled'] === true ? exposureOf(post) : null;
}

/**
 * The quality levels with their bloom threshold overrides scaled by `exposure` (null: no level overrides the
 * threshold); `ids`: the levels that override it.
 */
function upgradedLevels(levels: unknown, exposure: number | null): { levels: unknown[]; ids: string[]; clamped: boolean } | null {
  if (!Array.isArray(levels)) return null;
  const ids: string[] = [];
  let clamped = false;
  const out = levels.map((level) => {
    if (!isPlainObject(level) || !isPlainObject(level['post']) || !isPlainObject(level['post']['bloom'])) return level;
    const bloom = level['post']['bloom'];
    if (typeof bloom['threshold'] !== 'number') return level;
    ids.push(String(level['id'] ?? '?'));
    if (exposure === null) return level;
    const r = scaledThreshold(bloom['threshold'], exposure);
    clamped ||= r.clamped;
    return { ...level, post: { ...level['post'], bloom: { ...bloom, threshold: r.threshold } } };
  });
  return ids.length === 0 ? null : { levels: out, ids, clamped };
}

/** Scale bloom thresholds by their look's exposure and keep the old default strength (see the file comment). */
export function upgradeBloomExposure(contentIn: unknown, scenesIn: readonly unknown[]): { content: unknown; scenes: unknown[]; changed: boolean; notes: string[] } {
  const notes: string[] = [];
  let changed = false;
  let scaledAny = false;
  const capped = ` (capped at ${BLOOM_LIMITS.threshold})`;
  const note = (where: string, c: Change): void => {
    changed = true;
    scaledAny ||= c.scaled;
    if (c.scaled) notes.push(`${where}: the bloom threshold is now compared after exposure; it was scaled by the look's exposure so the same brightness glows${c.clamped ? capped : ''}`);
    if (c.strength) notes.push(`${where}: bloom's default strength is now ${BLOOM_DEFAULTS.strength}; the look's strength was written as ${STRENGTH_BEFORE}, the old default, so it glows as before`);
  };
  const exposures = new Set<number>();
  const scenes = scenesIn.map((scene) => {
    if (!isPlainObject(scene)) return scene;
    const e = bloomExposure(scene['environment']);
    if (e !== null) exposures.add(e);
    const r = upgradedLook(scene['environment']);
    if (r === null) return scene;
    note(`scene ${String(scene['sceneId'] ?? '?')}`, r.change);
    return { ...scene, environment: r.look };
  });
  let content = contentIn;
  if (isPlainObject(contentIn) && isPlainObject(contentIn['environment'])) {
    let env: Obj = contentIn['environment'];
    if (Array.isArray(env['presets'])) {
      let presetsChanged = false;
      const presets = (env['presets'] as unknown[]).map((p) => {
        const e = bloomExposure(p);
        if (e !== null) exposures.add(e);
        const r = upgradedLook(p);
        if (r === null) return p;
        presetsChanged = true;
        note(`environment preset ${String((p as Obj)['presetId'] ?? '?')}`, r.change);
        return r.look;
      });
      if (presetsChanged) env = { ...env, presets };
    }
    // A level's threshold override is compared after the exposure of whichever look it draws: one exposure scales it.
    const one = exposures.size === 1 ? [...exposures][0]! : null;
    const levels = exposures.size === 0 || one === 1 ? null : upgradedLevels(env['qualityLevels'], one);
    if (levels !== null) {
      if (one !== null) {
        changed = true;
        env = { ...env, qualityLevels: levels.levels };
        notes.push(`quality levels ${levels.ids.join(', ')}: the bloom threshold override was scaled by the looks' exposure (${one}) so the same brightness glows${levels.clamped ? capped : ''}`);
      } else {
        notes.push(`quality levels ${levels.ids.join(', ')}: the bloom threshold override is now compared after exposure and was left as it was, as the looks with bloom have different exposures (${[...exposures].sort((a, b) => a - b).join(', ')}); check where bloom starts at each`);
      }
    }
    if (env !== contentIn['environment']) content = { ...contentIn, environment: env };
  }
  if (scaledAny) notes.push('a preset that sets only the exposure, over a scene look with bloom, now also moves where that bloom starts');
  return { content, scenes: changed ? scenes : [...scenesIn], changed, notes };
}
