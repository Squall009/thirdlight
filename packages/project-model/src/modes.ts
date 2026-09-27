/**
 * Phase 23.10: game modes (`content.modes[]`) and behavior groups
 * (`content.behaviorGroups[]`), v4.
 *
 * A game mode is a named state of the running game that decides, in one
 * transition and without a scene load: which input maps are active, which
 * virtual camera is live, which UI documents are shown, which behavior
 * groups tick (the rest pause), whether the engine pause is allowed, the
 * time scale and whether physics steps. Genre-neutral examples: explore and
 * tactical, on foot and in a vehicle, build and play, a photo mode, a title
 * screen. The first mode in the list is the one a run starts in (a Play
 * start option can name another).
 *
 * A behavior group is a name an entity carries (the `behaviorGroup` component);
 * a mode lists the groups that tick while it is active (absent: every group)
 * and what ungrouped behaviors do. The engine has no built-in group or mode
 * names (owner rule: generic only).
 *
 * Modes are simulation state: the runtime switches them at a step boundary
 * (a script's `ctx.modes.switch`), or before the scripts of a step (a UI
 * button's mode action, which rides on the input frame), so replays and the
 * simulation worker switch at the same step. Pure data rules.
 */
import type { ModelErrorV2 } from './errors';
import { INPUT_MAPS } from './input';

export type ModeBlend = 'cut' | 'linear' | 'eased';
export const MODE_BLENDS: readonly ModeBlend[] = ['cut', 'linear', 'eased'];
export type ModePhysics = 'run' | 'hold';
export const MODE_PHYSICS: readonly ModePhysics[] = ['run', 'hold'];
export type ModeUngrouped = 'tick' | 'pause';
export const MODE_UNGROUPED: readonly ModeUngrouped[] = ['tick', 'pause'];

/**
 * How a switch looks: the camera blend into the mode's camera and an
 * optional overlay document (a fade panel: its own show/hide tweens are the
 * fade) shown for `fadeTime` seconds from the switch.
 */
export interface ModeTransition {
  /** The camera blend (absent: the incoming camera's own blend). */
  blend?: ModeBlend;
  /** Seconds of the camera blend (0–30; absent: the camera's own). */
  blendTime?: number;
  /** A UI document shown for `fadeTime` seconds from the switch (its show/hide tweens make the fade). */
  fade?: string;
  /** Seconds the fade document stays (0.05–10; default 0.5). */
  fadeTime?: number;
}

export interface GameMode {
  /** Stable id (scripts and UI actions name it). */
  modeId: string;
  /** Shown in the editor and the Play toolbar. */
  name: string;
  /** The input maps active in the mode (absent: every map). */
  inputMaps?: string[];
  /** A virtual camera entity that is live while the mode is (over priorities; absent: the priority rule). */
  camera?: string;
  /** UI documents shown while the mode is active (hidden when it ends). */
  ui?: string[];
  /** The behavior groups that tick (absent: every group; the others pause). */
  groups?: string[];
  /** Behaviors without a group: tick (default) or pause. */
  ungrouped?: ModeUngrouped;
  /** The engine pause may be used (default true). */
  pause?: boolean;
  /** A UI document drawn while the game is paused in this mode (absent: the engine's pause panel). */
  pauseScreen?: string;
  /** Simulation speed (0.1–4; default 1): fewer or more fixed steps per second, each step unchanged. */
  timeScale?: number;
  /** Physics, the character controller, movers and triggers step (run, default) or stand still (hold). */
  physics?: ModePhysics;
  /** How entering this mode looks (a script's switch may pass its own). */
  enter?: ModeTransition;
}

/** Engine limits (documented; they protect the runtime and keep a whole list inside one 64 KiB command). */
export const MODE_LIMITS = Object.freeze({
  modes: 16,
  inputMaps: 8,
  ui: 16,
  groups: 32,
  behaviorGroups: 32,
  nameLength: 64,
  timeScaleMin: 0.1,
  timeScaleMax: 4,
  blendTimeMax: 30,
  fadeTimeMin: 0.05,
  fadeTimeMax: 10,
});

/** Defaults, with their genre-neutral reasons. */
export const MODE_DEFAULTS = Object.freeze({
  /** Every group ticks unless a mode says otherwise: a project without groups behaves as before. */
  ungrouped: 'tick' as ModeUngrouped,
  /** The pause is a player's right in most modes; a cutscene or title mode turns it off. */
  pause: true,
  /** Real time. */
  timeScale: 1,
  physics: 'run' as ModePhysics,
  /** Half a second: long enough to read as a fade, short enough not to stall input. */
  fadeTime: 0.5,
});

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** A behavior group or an input map name: a letter or _, then up to 31 letters, digits or _. */
export const MODE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function err(errors: ModelErrorV2[], code: string, path: string, message: string, found?: unknown, expected?: string): void {
  errors.push({ code, path, message, ...(found !== undefined ? { found } : {}), ...(expected !== undefined ? { expected } : {}) } as ModelErrorV2);
}
const isNum = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const validName = (s: string): boolean => s.length >= 1 && s.length <= MODE_LIMITS.nameLength && !/[\u0000-\u001f\u007f]/.test(s);

const MODE_KEYS = ['modeId', 'name', 'inputMaps', 'camera', 'ui', 'groups', 'ungrouped', 'pause', 'pauseScreen', 'timeScale', 'physics', 'enter'];
const TRANSITION_KEYS = ['blend', 'blendTime', 'fade', 'fadeTime'];

function idList(errors: ModelErrorV2[], v: unknown, path: string, max: number, re: RegExp, what: string): void {
  if (v === undefined) return;
  if (!Array.isArray(v) || v.length > max) return err(errors, 'field_value', path, `${what}: a list of at most ${max}`, Array.isArray(v) ? v.length : v, `at most ${max}`);
  const seen = new Set<string>();
  v.forEach((x, i) => {
    if (typeof x !== 'string' || !re.test(x)) err(errors, 'field_value', `${path}/${i}`, `${what}: not a valid name`, x, re === ID_RE ? 'an id' : 'an identifier');
    else if (seen.has(x)) err(errors, 'field_value', `${path}/${i}`, `${what}: listed twice`, x, 'unique names');
    else seen.add(x);
  });
}

/** One transition (see `ModeTransition`). */
export function validateModeTransition(v: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(v)) return err(errors, 'field_type', path, 'a transition is { blend?, blendTime?, fade?, fadeTime? }', v, 'object');
  for (const k of Object.keys(v)) if (!TRANSITION_KEYS.includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown field "${k}"`, k, TRANSITION_KEYS.join(', '));
  if (v['blend'] !== undefined && !(MODE_BLENDS as readonly unknown[]).includes(v['blend'])) err(errors, 'field_value', `${path}/blend`, 'blend is cut, linear or eased', v['blend'], MODE_BLENDS.join(' | '));
  if (v['blendTime'] !== undefined && !isNum(v['blendTime'], 0, MODE_LIMITS.blendTimeMax)) err(errors, 'field_value', `${path}/blendTime`, `blendTime is 0–${MODE_LIMITS.blendTimeMax} s`, v['blendTime'], `0..${MODE_LIMITS.blendTimeMax}`);
  if (v['fade'] !== undefined && (typeof v['fade'] !== 'string' || !ID_RE.test(v['fade']))) err(errors, 'field_value', `${path}/fade`, 'fade names a UI document', v['fade'], 'a uiDocumentId');
  if (v['fadeTime'] !== undefined && !isNum(v['fadeTime'], MODE_LIMITS.fadeTimeMin, MODE_LIMITS.fadeTimeMax)) err(errors, 'field_value', `${path}/fadeTime`, `fadeTime is ${MODE_LIMITS.fadeTimeMin}–${MODE_LIMITS.fadeTimeMax} s`, v['fadeTime'], `${MODE_LIMITS.fadeTimeMin}..${MODE_LIMITS.fadeTimeMax}`);
}

/** One mode's shape (references to documents, maps, groups and cameras are checked with the project: `validateModeReferences`). */
export function validateMode(v: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(v)) return err(errors, 'field_type', path, 'a game mode is { modeId, name, … }', v, 'object');
  for (const k of Object.keys(v)) if (!MODE_KEYS.includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown field "${k}"`, k, MODE_KEYS.join(', '));
  if (typeof v['modeId'] !== 'string' || !ID_RE.test(v['modeId'])) err(errors, 'field_value', `${path}/modeId`, 'modeId is an id (lowercase letters, digits, _ or -)', v['modeId'], 'an id');
  if (typeof v['name'] !== 'string' || !validName(v['name'])) err(errors, 'field_value', `${path}/name`, `name is 1–${MODE_LIMITS.nameLength} characters without control characters`, v['name'], 'a name');
  idList(errors, v['inputMaps'], `${path}/inputMaps`, MODE_LIMITS.inputMaps, MODE_NAME_RE, 'inputMaps');
  if (v['camera'] !== undefined && (typeof v['camera'] !== 'string' || !ID_RE.test(v['camera']))) err(errors, 'field_value', `${path}/camera`, 'camera names a virtual camera object', v['camera'], 'an entity id');
  idList(errors, v['ui'], `${path}/ui`, MODE_LIMITS.ui, ID_RE, 'ui');
  idList(errors, v['groups'], `${path}/groups`, MODE_LIMITS.groups, MODE_NAME_RE, 'groups');
  if (v['ungrouped'] !== undefined && !(MODE_UNGROUPED as readonly unknown[]).includes(v['ungrouped'])) err(errors, 'field_value', `${path}/ungrouped`, 'ungrouped is tick or pause', v['ungrouped'], 'tick | pause');
  if (v['pause'] !== undefined && typeof v['pause'] !== 'boolean') err(errors, 'field_type', `${path}/pause`, 'pause is true or false', v['pause'], 'boolean');
  if (v['pauseScreen'] !== undefined && (typeof v['pauseScreen'] !== 'string' || !ID_RE.test(v['pauseScreen']))) err(errors, 'field_value', `${path}/pauseScreen`, 'pauseScreen names a UI document', v['pauseScreen'], 'a uiDocumentId');
  if (v['timeScale'] !== undefined && !isNum(v['timeScale'], MODE_LIMITS.timeScaleMin, MODE_LIMITS.timeScaleMax)) err(errors, 'field_value', `${path}/timeScale`, `timeScale is ${MODE_LIMITS.timeScaleMin}–${MODE_LIMITS.timeScaleMax}`, v['timeScale'], `${MODE_LIMITS.timeScaleMin}..${MODE_LIMITS.timeScaleMax}`);
  if (v['physics'] !== undefined && !(MODE_PHYSICS as readonly unknown[]).includes(v['physics'])) err(errors, 'field_value', `${path}/physics`, 'physics is run or hold', v['physics'], 'run | hold');
  if (v['enter'] !== undefined) validateModeTransition(v['enter'], `${path}/enter`, errors);
}

/** The whole list (shape, unique ids, the limit). */
export function validateModes(v: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!Array.isArray(v)) return err(errors, 'field_type', path, 'modes is a list', v, 'array');
  if (v.length > MODE_LIMITS.modes) err(errors, 'limits_exceeded', path, `a project has at most ${MODE_LIMITS.modes} game modes`, v.length, `at most ${MODE_LIMITS.modes}`);
  const seen = new Set<string>();
  v.forEach((m, i) => {
    validateMode(m, `${path}/${i}`, errors);
    const id = isPlainObject(m) ? m['modeId'] : undefined;
    if (typeof id === 'string') {
      if (seen.has(id)) err(errors, 'id_duplicate', `${path}/${i}/modeId`, 'modeId is already used by an earlier mode', id, 'a unique modeId');
      seen.add(id);
    }
  });
}

/** `content.behaviorGroups`: the group names behaviors may carry (unique identifiers). */
export function validateBehaviorGroups(v: unknown, path: string, errors: ModelErrorV2[]): void {
  idList(errors, v, path, MODE_LIMITS.behaviorGroups, MODE_NAME_RE, 'behaviorGroups');
}

/**
 * The project-level references of the modes: UI documents (shown, pause
 * screen, fade), input maps (the engine's gameplay/ui and the project's
 * `input.maps`), behavior groups. The camera names a scene object and is
 * checked when the game runs (a missing one is warned once in the play log).
 */
export function validateModeReferences(content: Record<string, unknown>, errors: ModelErrorV2[]): void {
  const modes = content['modes'];
  if (!Array.isArray(modes)) return;
  const docIds = new Set((Array.isArray(content['uiDocuments']) ? (content['uiDocuments'] as unknown[]) : []).filter(isPlainObject).map((d) => d['uiDocumentId']));
  const input = content['input'];
  const maps = new Set<string>([...INPUT_MAPS, ...((isPlainObject(input) && Array.isArray(input['maps']) ? input['maps'] : []) as string[])]);
  const groups = new Set((Array.isArray(content['behaviorGroups']) ? content['behaviorGroups'] : []) as string[]);
  const doc = (id: unknown, path: string): void => {
    if (typeof id === 'string' && !docIds.has(id)) err(errors, 'reference_missing', path, `no UI document "${id}" in this project`, id, 'a uiDocumentId');
  };
  modes.forEach((m, i) => {
    if (!isPlainObject(m)) return;
    const at = `/modes/${i}`;
    if (Array.isArray(m['ui'])) m['ui'].forEach((id, j) => doc(id, `${at}/ui/${j}`));
    doc(m['pauseScreen'], `${at}/pauseScreen`);
    if (isPlainObject(m['enter'])) doc(m['enter']['fade'], `${at}/enter/fade`);
    if (Array.isArray(m['inputMaps'])) {
      m['inputMaps'].forEach((name, j) => {
        if (typeof name === 'string' && !maps.has(name)) err(errors, 'reference_missing', `${at}/inputMaps/${j}`, `no input map "${name}" (gameplay, ui or one of input.maps)`, name, [...maps].join(' | '));
      });
    }
    if (Array.isArray(m['groups'])) {
      m['groups'].forEach((name, j) => {
        if (typeof name === 'string' && !groups.has(name)) err(errors, 'reference_missing', `${at}/groups/${j}`, `no behavior group "${name}" (content.behaviorGroups)`, name, 'a behavior group');
      });
    }
  });
}

/**
 * The `behaviorGroup` component: the group the entity's behavior belongs to
 * (a mode lists the groups that tick).
 */
export interface BehaviorGroupComponent {
  group: string;
}

/** The component's shape (whether the group exists is the project composition's check: `behaviorGroupErrors`). */
export function validateBehaviorGroupComponent(v: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(v)) return err(errors, 'field_type', path, 'behaviorGroup is { group }', v, 'object');
  for (const k of Object.keys(v)) if (k !== 'group') err(errors, 'field_unexpected', `${path}/${k}`, `unknown field "${k}"`, k, 'group');
  if (typeof v['group'] !== 'string' || !MODE_NAME_RE.test(v['group'])) err(errors, 'field_value', `${path}/group`, 'group is a behavior group name (a letter or _, then up to 31 letters, digits or _)', v['group'], 'a behavior group');
}

export function canonicalBehaviorGroup(c: BehaviorGroupComponent): BehaviorGroupComponent {
  return { group: c.group };
}

/**
 * An entity's `behaviorGroup` must name one of the project's behavior groups
 * (the project composition checks it on scene and prefab entities).
 */
export function behaviorGroupErrors(comps: Record<string, unknown>, path: string, groups: readonly string[], errors: ModelErrorV2[]): void {
  const b = comps['behaviorGroup'];
  if (!isPlainObject(b)) return;
  const g = b['group'];
  if (typeof g === 'string' && !groups.includes(g)) err(errors, 'reference_missing', `${path}/components/behaviorGroup/group`, `no behavior group "${g}" in this project`, g, groups.length > 0 ? groups.join(' | ') : 'a behavior group (content.behaviorGroups)');
}

/** The canonical transition (field by field, fixed order). */
function canonicalTransition(t: ModeTransition): ModeTransition {
  return {
    ...(t.blend !== undefined ? { blend: t.blend } : {}),
    ...(t.blendTime !== undefined ? { blendTime: t.blendTime } : {}),
    ...(t.fade !== undefined ? { fade: t.fade } : {}),
    ...(t.fadeTime !== undefined ? { fadeTime: t.fadeTime } : {}),
  };
}

/** One canonical mode (field by field, fixed order; absent fields stay absent). */
export function canonicalMode(m: GameMode): GameMode {
  return {
    modeId: m.modeId,
    name: m.name,
    ...(m.inputMaps !== undefined ? { inputMaps: [...m.inputMaps] } : {}),
    ...(m.camera !== undefined ? { camera: m.camera } : {}),
    ...(m.ui !== undefined ? { ui: [...m.ui] } : {}),
    ...(m.groups !== undefined ? { groups: [...m.groups] } : {}),
    ...(m.ungrouped !== undefined ? { ungrouped: m.ungrouped } : {}),
    ...(m.pause !== undefined ? { pause: m.pause } : {}),
    ...(m.pauseScreen !== undefined ? { pauseScreen: m.pauseScreen } : {}),
    ...(m.timeScale !== undefined ? { timeScale: m.timeScale } : {}),
    ...(m.physics !== undefined ? { physics: m.physics } : {}),
    ...(m.enter !== undefined ? { enter: canonicalTransition(m.enter) } : {}),
  };
}

/** The canonical list: order kept (the first mode is the start mode). */
export function canonicalModes(list: readonly GameMode[]): GameMode[] {
  return list.map(canonicalMode);
}

/**
 * What the simulation knows of the modes: the canonical list and, for the
 * input masking, each action's map (the project's input, else the engine
 * default for its dimension). Undefined without modes (a project without
 * modes gets no snapshot field: its snapshot, digests and replays are as
 * before).
 */
export interface RuntimeModes {
  modes: GameMode[];
  /** Action name → its input map. */
  actionMaps: Record<string, string>;
}

export function modesForRuntime(modes: readonly GameMode[] | undefined, input: { actions: readonly { name: string; map: string }[] } | undefined): RuntimeModes | undefined {
  if (modes === undefined || modes.length === 0) return undefined;
  const actionMaps: Record<string, string> = {};
  for (const a of input?.actions ?? []) actionMaps[a.name] = a.map;
  return { modes: canonicalModes(modes), actionMaps };
}
