/**
 * Phase 24.4j: the game shell (`content.shell`, v4) — the menus around a game
 * and its HUD, as project UI documents, for a game that plays as a scene (no
 * game session, no flow).
 *
 * - `screens`: the UI documents drawn for the shell's screens — a title
 *   before play, the pause screen (absent: the engine's pause panel), a
 *   settings screen, a controls (rebinding) screen and the save and load
 *   screens (project saves, `content.saveSchema`). A document's buttons use
 *   the engine UI actions: new game, continue, resume, back, open a screen,
 *   save or load a slot, set a volume, rebind an action, next scene.
 * - `hud`: UI documents shown while the game plays (hidden behind the menus).
 *   Their bindings read the scripts' view model (`ctx.ui.set`) and the host
 *   values under `$flow`: named counters (`$flow.counters.<name>`), objects'
 *   health (`$flow.health.<objectId>.current|max`) and the input prompts
 *   generated from the project's input actions (`$flow.prompts`).
 * - `scenes`: the game's scenes in order, each with the player spawn it
 *   starts at. New game begins a fresh run at the first; the `nextScene`
 *   action moves on to the next one (loading it, unloading the previous
 *   listed scene unless it is a start scene).
 * - `pause`: whether the pause input opens the pause screen (absent: true).
 * - `status`: a small debug line with the shell's screen, the listed scene
 *   and the input prompts (absent: off).
 *
 * The shell never changes what the simulation does by itself: new game,
 * next scene and restart ride on the input frame as UI events (so replays
 * hold); pausing stops the steps as the engine pause does.
 */
import type { ModelErrorV2 } from './errors';

/** The shell's screens a project draws with its own UI documents. */
export const SHELL_SCREENS = ['title', 'pause', 'settings', 'controls', 'save', 'load'] as const;
export type ShellScreen = (typeof SHELL_SCREENS)[number];

/** Engine limits: HUD documents shown together; listed scenes. */
export const SHELL_LIMITS = Object.freeze({ hud: 8, scenes: 32 });

export interface ShellScene {
  /** A scene of the project. */
  scene: string;
  /** The player spawn the character starts at (a playerSpawn object in that scene; absent: it stays where it is). */
  spawn?: string;
}

export interface GameShell {
  screens?: Partial<Record<ShellScreen, string>>;
  hud?: string[];
  scenes?: ShellScene[];
  pause?: boolean;
  status?: boolean;
}

export const SHELL_FIELDS = ['screens', 'hud', 'scenes', 'pause', 'status'] as const;

const DOC_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function err(errors: ModelErrorV2[], code: string, path: string, message: string, found?: unknown, expected?: string): void {
  errors.push({ code, path, message, ...(found !== undefined ? { found } : {}), ...(expected !== undefined ? { expected } : {}) } as ModelErrorV2);
}

/** The shape of a shell block (the documents, scenes and spawns it names are checked against the project). */
export function validateShell(v: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(v)) return err(errors, 'field_type', path, 'shell is an object { screens?, hud?, scenes?, pause?, status? }', v, 'object');
  for (const k of Object.keys(v)) if (!(SHELL_FIELDS as readonly string[]).includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown shell field "${k}"`, k, SHELL_FIELDS.join(', '));
  const screens = v['screens'];
  if (screens !== undefined) {
    if (!isPlainObject(screens)) err(errors, 'field_type', `${path}/screens`, 'screens maps shell screens to UI documents', screens, 'object');
    else {
      for (const [k, id] of Object.entries(screens)) {
        if (!(SHELL_SCREENS as readonly string[]).includes(k)) err(errors, 'field_unexpected', `${path}/screens/${k}`, `unknown shell screen "${k}"`, k, SHELL_SCREENS.join(', '));
        else if (typeof id !== 'string' || !DOC_RE.test(id)) err(errors, 'field_value', `${path}/screens/${k}`, 'a shell screen names a UI document', id, 'a uiDocumentId');
      }
    }
  }
  const hud = v['hud'];
  if (hud !== undefined) {
    if (!Array.isArray(hud) || hud.length > SHELL_LIMITS.hud) err(errors, 'field_value', `${path}/hud`, `hud is a list of at most ${SHELL_LIMITS.hud} UI documents`, hud, 'an array');
    else {
      hud.forEach((id, i) => {
        if (typeof id !== 'string' || !DOC_RE.test(id)) err(errors, 'field_value', `${path}/hud/${i}`, 'a HUD entry names a UI document', id, 'a uiDocumentId');
      });
      if (new Set(hud).size !== hud.length) err(errors, 'field_value', `${path}/hud`, 'a HUD document is listed once', hud);
    }
  }
  const scenes = v['scenes'];
  if (scenes !== undefined) {
    if (!Array.isArray(scenes) || scenes.length < 1 || scenes.length > SHELL_LIMITS.scenes) err(errors, 'field_value', `${path}/scenes`, `scenes is a list of 1–${SHELL_LIMITS.scenes} entries`, Array.isArray(scenes) ? scenes.length : scenes, 'an array');
    else {
      scenes.forEach((s, i) => {
        const p = `${path}/scenes/${i}`;
        if (!isPlainObject(s)) return err(errors, 'field_type', p, 'a listed scene is { scene, spawn? }', s, 'object');
        for (const k of Object.keys(s)) if (k !== 'scene' && k !== 'spawn') err(errors, 'field_unexpected', `${p}/${k}`, `unknown field "${k}"`, k, 'scene, spawn');
        if (typeof s['scene'] !== 'string' || s['scene'].length === 0 || s['scene'].length > 128) err(errors, 'field_value', `${p}/scene`, 'a listed scene names a scene', s['scene'], 'a sceneId');
        if (s['spawn'] !== undefined && (typeof s['spawn'] !== 'string' || s['spawn'].length === 0 || s['spawn'].length > 128)) err(errors, 'field_value', `${p}/spawn`, 'spawn names a player spawn object', s['spawn'], 'an entity id');
      });
    }
  }
  for (const k of ['pause', 'status'] as const) if (v[k] !== undefined && typeof v[k] !== 'boolean') err(errors, 'field_type', `${path}/${k}`, `${k} is true or false`, v[k], 'boolean');
}

/** The UI documents the shell names exist; the shell drives a game without the game session and flow. */
export function validateShellReferences(content: Record<string, unknown>, errors: ModelErrorV2[]): void {
  const shell = content['shell'];
  if (!isPlainObject(shell)) return;
  if (content['flow'] !== undefined) err(errors, 'field_unexpected', '/shell', 'a project has the shell or the flow, not both (the flow drives a game with the game session)', 'shell');
  if (content['game'] !== undefined && content['game'] !== null) err(errors, 'field_unexpected', '/shell', 'the shell drives a game that plays as a scene; this project has the game session (content.game)', 'shell');
  const docIds = new Set((Array.isArray(content['uiDocuments']) ? (content['uiDocuments'] as unknown[]) : []).filter(isPlainObject).map((d) => d['uiDocumentId']));
  const doc = (id: unknown, path: string): void => {
    if (typeof id === 'string' && !docIds.has(id)) err(errors, 'reference_missing', path, `no UI document "${id}" in this project`, id, 'a uiDocumentId');
  };
  if (isPlainObject(shell['screens'])) for (const [k, id] of Object.entries(shell['screens'])) doc(id, `/shell/screens/${k}`);
  if (Array.isArray(shell['hud'])) shell['hud'].forEach((id, i) => doc(id, `/shell/hud/${i}`));
}

export function canonicalShell(s: GameShell): GameShell {
  return {
    ...(s.screens !== undefined ? { screens: Object.fromEntries(SHELL_SCREENS.filter((k) => s.screens![k] !== undefined).map((k) => [k, s.screens![k]!])) } : {}),
    ...(s.hud !== undefined ? { hud: [...s.hud] } : {}),
    ...(s.scenes !== undefined ? { scenes: s.scenes.map((x) => ({ scene: x.scene, ...(x.spawn !== undefined ? { spawn: x.spawn } : {}) })) } : {}),
    ...(s.pause !== undefined ? { pause: s.pause } : {}),
    ...(s.status !== undefined ? { status: s.status } : {}),
  };
}
