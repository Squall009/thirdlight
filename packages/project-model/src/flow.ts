/**
 * Phase 9.10: the game flow (`content.flow`, v4 projects).
 *
 * An ordered list of levels — each a set of scenes played together and the
 * spawn the player starts at, with optional music — plus lives, an optional
 * title screen, the HUD layout, the menu look, menu texts and default
 * volumes. Without a flow block a game plays as before: one level (the start
 * scenes), unlimited lives, no title screen.
 *
 * The references (scenes, spawns, music and logo assets) are checked against
 * the scenes and the asset catalog by the v4 project validator.
 */
import type { ModelErrorV2 } from './errors';

export interface FlowLevel {
  /** Stable id (saves remember levels by it). */
  id: string;
  name: string;
  /** The scenes loaded for this level (each must hold or share the player and camera). */
  scenes: string[];
  /** The player spawn the level starts at. */
  spawnId: string;
  /** A music asset that loops while the level plays. */
  music?: string;
}

export const HUD_PRESETS = ['classic', 'minimal', 'corners'] as const;
export const UI_FONTS = ['sans', 'serif', 'mono', 'rounded'] as const;

export interface GameFlow {
  levels: FlowLevel[];
  /** Lives per game; absent: unlimited (a death only respawns). */
  lives?: { start: number; max: number };
  /** A title screen before the first level (absent: the game starts on a key press). */
  title?: { subtitle?: string; music?: string };
  hud?: { preset: (typeof HUD_PRESETS)[number]; timer?: boolean };
  ui?: { font: (typeof UI_FONTS)[number]; accent: string; panel: string; text: string; logo?: string };
  texts?: { levelComplete?: string; gameOver?: string; credits?: string };
  /** Default volumes (0–1) before the player changes them in Settings. */
  volumes?: { music: number; sfx: number };
  /** Phase 14.3: score rules (absent: no score is shown or kept). */
  score?: FlowScore;
}

/**
 * Phase 14.3: how a level's score is made. `points` gives points per unit of
 * a run counter — the counter names are the project's own (pickups count
 * into `coins`, `gems`, `keys`, `lives` or a custom counter; stomped enemies
 * into `defeated`). `timeBonus` adds `perSecond` points for every second the
 * level took under `targetSeconds` (rounded down; none over the target).
 */
export interface FlowScore {
  points?: Record<string, number>;
  timeBonus?: { targetSeconds: number; perSecond: number };
}

export const MAX_SCORE_COUNTERS = 32;
/** Points per counter unit (negative: a penalty). */
export const MAX_SCORE_POINTS = 1_000_000;

export const MAX_FLOW_LEVELS = 32;
export const MAX_LEVEL_SCENES = 16;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function err(errors: ModelErrorV2[], code: string, path: string, message: string, found?: unknown): void {
  errors.push({ code, path, message, ...(found !== undefined ? { found } : {}) } as ModelErrorV2);
}
function only(v: Record<string, unknown>, allowed: readonly string[], path: string, errors: ModelErrorV2[]): void {
  for (const k of Object.keys(v)) if (!allowed.includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown field "${k}" (allowed: ${allowed.join(', ')})`, k);
}
const text = (v: unknown, max: number): boolean => typeof v === 'string' && v.length <= max;
const int = (v: unknown, lo: number, hi: number): boolean => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
const unit = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

/** The shape of a flow block (references are checked by the project validator). */
export function validateFlow(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isObj(value)) return err(errors, 'field_type', path, 'flow is an object', value);
  only(value, ['levels', 'lives', 'title', 'hud', 'ui', 'texts', 'volumes', 'score'], path, errors);
  const levels = value['levels'];
  if (!Array.isArray(levels) || levels.length < 1 || levels.length > MAX_FLOW_LEVELS) {
    err(errors, 'field_value', `${path}/levels`, `levels is a list of 1–${MAX_FLOW_LEVELS} levels`, Array.isArray(levels) ? levels.length : levels);
  } else {
    const ids = new Set<string>();
    levels.forEach((l, i) => {
      const p = `${path}/levels/${i}`;
      if (!isObj(l)) return err(errors, 'field_type', p, 'a level is an object', l);
      only(l, ['id', 'name', 'scenes', 'spawnId', 'music'], p, errors);
      if (typeof l['id'] !== 'string' || !ID_RE.test(l['id'])) err(errors, 'field_value', `${p}/id`, 'a level id is 1–64 letters, digits, _ or -', l['id']);
      else if (ids.has(l['id'])) err(errors, 'id_duplicate', `${p}/id`, 'level ids are unique', l['id']);
      else ids.add(l['id']);
      if (!text(l['name'], 64) || (l['name'] as string).trim() === '') err(errors, 'field_value', `${p}/name`, 'a level name is 1–64 characters', l['name']);
      const scenes = l['scenes'];
      if (!Array.isArray(scenes) || scenes.length < 1 || scenes.length > MAX_LEVEL_SCENES || !scenes.every((s) => typeof s === 'string' && s.length > 0 && s.length <= 128) || new Set(scenes).size !== scenes.length) {
        err(errors, 'field_value', `${p}/scenes`, `a level loads 1–${MAX_LEVEL_SCENES} distinct scenes`, scenes);
      }
      if (typeof l['spawnId'] !== 'string' || l['spawnId'].length === 0 || l['spawnId'].length > 128) err(errors, 'field_value', `${p}/spawnId`, 'a level names its player spawn', l['spawnId']);
      if (l['music'] !== undefined && (typeof l['music'] !== 'string' || l['music'].length === 0)) err(errors, 'field_value', `${p}/music`, 'music names a music asset', l['music']);
    });
  }
  const lives = value['lives'];
  if (lives !== undefined) {
    if (!isObj(lives)) err(errors, 'field_type', `${path}/lives`, 'lives is { start, max }', lives);
    else {
      only(lives, ['start', 'max'], `${path}/lives`, errors);
      if (!int(lives['start'], 1, 99)) err(errors, 'field_value', `${path}/lives/start`, 'lives start at 1–99', lives['start']);
      if (!int(lives['max'], 1, 99) || (int(lives['start'], 1, 99) && (lives['max'] as number) < (lives['start'] as number))) err(errors, 'field_value', `${path}/lives/max`, 'max lives is 1–99 and at least the start', lives['max']);
    }
  }
  const title = value['title'];
  if (title !== undefined) {
    if (!isObj(title)) err(errors, 'field_type', `${path}/title`, 'title is { subtitle?, music? }', title);
    else {
      only(title, ['subtitle', 'music'], `${path}/title`, errors);
      if (title['subtitle'] !== undefined && !text(title['subtitle'], 160)) err(errors, 'field_value', `${path}/title/subtitle`, 'the subtitle is at most 160 characters', title['subtitle']);
      if (title['music'] !== undefined && (typeof title['music'] !== 'string' || title['music'].length === 0)) err(errors, 'field_value', `${path}/title/music`, 'music names a music asset', title['music']);
    }
  }
  const hud = value['hud'];
  if (hud !== undefined) {
    if (!isObj(hud)) err(errors, 'field_type', `${path}/hud`, 'hud is { preset, timer? }', hud);
    else {
      only(hud, ['preset', 'timer'], `${path}/hud`, errors);
      if (!(HUD_PRESETS as readonly unknown[]).includes(hud['preset'])) err(errors, 'field_value', `${path}/hud/preset`, `the HUD preset is ${HUD_PRESETS.join(', ')}`, hud['preset']);
      if (hud['timer'] !== undefined && typeof hud['timer'] !== 'boolean') err(errors, 'field_type', `${path}/hud/timer`, 'timer is true or false', hud['timer']);
    }
  }
  const ui = value['ui'];
  if (ui !== undefined) {
    if (!isObj(ui)) err(errors, 'field_type', `${path}/ui`, 'ui is { font, accent, panel, text, logo? }', ui);
    else {
      only(ui, ['font', 'accent', 'panel', 'text', 'logo'], `${path}/ui`, errors);
      if (!(UI_FONTS as readonly unknown[]).includes(ui['font'])) err(errors, 'field_value', `${path}/ui/font`, `the font is ${UI_FONTS.join(', ')}`, ui['font']);
      for (const k of ['accent', 'panel', 'text'] as const) if (typeof ui[k] !== 'string' || !COLOR_RE.test(ui[k] as string)) err(errors, 'field_value', `${path}/ui/${k}`, `${k} is a #rrggbb colour`, ui[k]);
      if (ui['logo'] !== undefined && (typeof ui['logo'] !== 'string' || ui['logo'].length === 0)) err(errors, 'field_value', `${path}/ui/logo`, 'logo names a texture asset', ui['logo']);
    }
  }
  const texts = value['texts'];
  if (texts !== undefined) {
    if (!isObj(texts)) err(errors, 'field_type', `${path}/texts`, 'texts is { levelComplete?, gameOver?, credits? }', texts);
    else {
      only(texts, ['levelComplete', 'gameOver', 'credits'], `${path}/texts`, errors);
      for (const k of ['levelComplete', 'gameOver'] as const) if (texts[k] !== undefined && !text(texts[k], 64)) err(errors, 'field_value', `${path}/texts/${k}`, `${k} is at most 64 characters`, texts[k]);
      if (texts['credits'] !== undefined && !text(texts['credits'], 2000)) err(errors, 'field_value', `${path}/texts/credits`, 'credits are at most 2000 characters', texts['credits']);
    }
  }
  const volumes = value['volumes'];
  if (volumes !== undefined) {
    if (!isObj(volumes)) err(errors, 'field_type', `${path}/volumes`, 'volumes is { music, sfx }', volumes);
    else {
      only(volumes, ['music', 'sfx'], `${path}/volumes`, errors);
      if (!unit(volumes['music'])) err(errors, 'field_value', `${path}/volumes/music`, 'the music volume is 0–1', volumes['music']);
      if (!unit(volumes['sfx'])) err(errors, 'field_value', `${path}/volumes/sfx`, 'the sound volume is 0–1', volumes['sfx']);
    }
  }
  const score = value['score'];
  if (score !== undefined) validateScore(score, `${path}/score`, errors);
}

const COUNTER_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;

function validateScore(score: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isObj(score)) return err(errors, 'field_type', path, 'score is { points?: { counter: points }, timeBonus?: { targetSeconds, perSecond } }', score);
  only(score, ['points', 'timeBonus'], path, errors);
  const points = score['points'];
  if (points !== undefined) {
    if (!isObj(points)) err(errors, 'field_type', `${path}/points`, 'points is { counterName: points per unit }', points);
    else {
      const names = Object.keys(points);
      if (names.length > MAX_SCORE_COUNTERS) err(errors, 'field_value', `${path}/points`, `score at most ${MAX_SCORE_COUNTERS} counters`, names.length);
      for (const k of names) {
        const at = `${path}/points/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`;
        if (!COUNTER_RE.test(k)) err(errors, 'field_value', at, 'a counter name is 1–32 letters, digits or _ (not starting with a digit)', k);
        else if (!int(points[k], -MAX_SCORE_POINTS, MAX_SCORE_POINTS)) err(errors, 'field_value', at, `points per unit are a whole number from -${MAX_SCORE_POINTS} to ${MAX_SCORE_POINTS}`, points[k]);
      }
    }
  }
  const bonus = score['timeBonus'];
  if (bonus !== undefined) {
    if (!isObj(bonus)) err(errors, 'field_type', `${path}/timeBonus`, 'timeBonus is { targetSeconds, perSecond }', bonus);
    else {
      only(bonus, ['targetSeconds', 'perSecond'], `${path}/timeBonus`, errors);
      const t = bonus['targetSeconds'];
      if (typeof t !== 'number' || !Number.isFinite(t) || t < 1 || t > 36_000) err(errors, 'field_value', `${path}/timeBonus/targetSeconds`, 'the target time is 1–36000 seconds', t);
      const ps = bonus['perSecond'];
      if (typeof ps !== 'number' || !Number.isFinite(ps) || ps < 0 || ps > 100_000) err(errors, 'field_value', `${path}/timeBonus/perSecond`, 'the time bonus is 0–100000 points per second', ps);
    }
  }
}

/** Every asset the flow names (music, the logo), for capture and export. */
export function flowAssetRefs(flow: GameFlow): { music: string[]; textures: string[] } {
  const music = new Set<string>();
  for (const l of flow.levels) if (l.music !== undefined) music.add(l.music);
  if (flow.title?.music !== undefined) music.add(flow.title.music);
  return { music: [...music], textures: flow.ui?.logo !== undefined ? [flow.ui.logo] : [] };
}

export function canonicalFlow(f: GameFlow): GameFlow {
  return {
    levels: f.levels.map((l) => ({ id: l.id, name: l.name, scenes: [...l.scenes], spawnId: l.spawnId, ...(l.music !== undefined ? { music: l.music } : {}) })),
    ...(f.lives !== undefined ? { lives: { start: f.lives.start, max: f.lives.max } } : {}),
    ...(f.title !== undefined ? { title: { ...(f.title.subtitle !== undefined ? { subtitle: f.title.subtitle } : {}), ...(f.title.music !== undefined ? { music: f.title.music } : {}) } } : {}),
    ...(f.hud !== undefined ? { hud: { preset: f.hud.preset, ...(f.hud.timer !== undefined ? { timer: f.hud.timer } : {}) } } : {}),
    ...(f.ui !== undefined ? { ui: { font: f.ui.font, accent: f.ui.accent, panel: f.ui.panel, text: f.ui.text, ...(f.ui.logo !== undefined ? { logo: f.ui.logo } : {}) } } : {}),
    ...(f.texts !== undefined
      ? { texts: { ...(f.texts.levelComplete !== undefined ? { levelComplete: f.texts.levelComplete } : {}), ...(f.texts.gameOver !== undefined ? { gameOver: f.texts.gameOver } : {}), ...(f.texts.credits !== undefined ? { credits: f.texts.credits } : {}) } }
      : {}),
    ...(f.volumes !== undefined ? { volumes: { music: f.volumes.music, sfx: f.volumes.sfx } } : {}),
    ...(f.score !== undefined ? { score: canonicalScore(f.score) } : {}),
  };
}

/** Score rules with the counters in name order (a stable document whatever order they were typed in). */
function canonicalScore(s: FlowScore): FlowScore {
  return {
    ...(s.points !== undefined ? { points: Object.fromEntries(Object.keys(s.points).sort().map((k) => [k, s.points![k]!])) } : {}),
    ...(s.timeBonus !== undefined ? { timeBonus: { targetSeconds: s.timeBonus.targetSeconds, perSecond: s.timeBonus.perSecond } } : {}),
  };
}
