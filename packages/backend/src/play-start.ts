/**
 * Resolve a test/debug start of Play (`options.sceneId`, `mode`,
 * `variables`, `save`, `saveSlot` of the play-start request — the editor's
 * "Play from…" and `tl_play_start` send the same body) against the captured
 * project, so the preview only applies what the backend already checked:
 *
 * - a scene is loaded with the start scenes (they hold the camera and the
 *   character), and the character starts at the scene's first player spawn
 *   when it has one;
 * - a project save document (`format: "thirdlight.save"`), or a
 *   save slot 1–99, in a project with a save schema (`content.saveSchema`) —
 *   loaded at the first step (the game migrates an older version); a
 *   document newer than the schema is refused;
 * - variables pass through (the runtime puts them in `ctx.save` at step 0,
 *   and again at every restart);
 * - `threads` (worker | single) passes through;
 * - a mode is checked against `content.modes` when the project defines game
 *   modes, and noted as ignored otherwise.
 *
 * Pure: no I/O.
 */
import { sessionError, type PlayStartOptions, type PlayStartResolved, type SessionError } from '@thirdlight/protocol';

interface SceneLike {
  readonly sceneId: string;
  readonly entities: ReadonlyArray<{ readonly id: string; readonly components?: Record<string, unknown> }>;
}

export interface PlayStartProject {
  /** The captured content block. */
  readonly content: Record<string, unknown>;
  /** A v4 project's scenes (absent: one scene, v3). */
  readonly scenes?: readonly unknown[];
  readonly startScenes?: readonly string[];
  /** The single scene's id (v3). */
  readonly sceneId: string;
}

export type PlayStartResolution = { ok: true; start: PlayStartResolved; notes: string[] } | { ok: false; error: SessionError };

function invalid(path: string, message: string): PlayStartResolution {
  return { ok: false, error: sessionError('field_value', 'validation', message, { path }) };
}

export function resolvePlayStart(options: PlayStartOptions, project: PlayStartProject): PlayStartResolution {
  const out: PlayStartResolved = {};
  const notes: string[] = [];

  if (options.sceneId !== undefined) {
    const sceneId = options.sceneId;
    out.sceneId = sceneId;
    if (project.scenes === undefined) {
      if (sceneId !== project.sceneId) return invalid('/options/sceneId', `this project has one scene ("${project.sceneId}"), not "${sceneId}"`);
    } else {
      const scenes = project.scenes as readonly SceneLike[];
      const scene = scenes.find((s) => s.sceneId === sceneId);
      if (scene === undefined) return invalid('/options/sceneId', `the project has no scene "${sceneId}"`);
      const start = project.startScenes ?? [];
      out.scenes = start.includes(sceneId) ? [...start] : [...start, sceneId];
      // The chosen scene's first spawn.
      const spawn = scene.entities.find((e) => e.components?.['playerSpawn'] !== undefined);
      if (spawn !== undefined) out.spawnId = spawn.id;
    }
  }

  const schema = project.content['saveSchema'] as { version?: number; slots?: number } | undefined;
  if (options.save !== undefined || options.saveSlot !== undefined) {
    // Project saves.
    if (schema === undefined || typeof schema.version !== 'number' || typeof schema.slots !== 'number') return invalid(options.save !== undefined ? '/options/save' : '/options/saveSlot', 'a project save document needs a project save schema (content.saveSchema); this project declares none');
    if (options.save !== undefined) {
      const version = options.save['version'] as number;
      if (version > schema.version) return invalid('/options/save/version', `the save document is version ${version}; the project's save schema is version ${schema.version} (a newer save cannot be loaded)`);
      out.projectSave = options.save;
    } else {
      const slot = Number(options.saveSlot);
      if (!Number.isInteger(slot) || slot < 1 || slot > schema.slots) return invalid('/options/saveSlot', `the project has save slots 1-${schema.slots}`);
      out.projectSaveSlot = slot;
    }
  }

  if (options.variables !== undefined) out.variables = options.variables;
  // A play-test's threading mode passes through (the page applies it over sim_thread).
  if (options.threads !== undefined) out.threads = options.threads;

  if (options.mode !== undefined) {
    const modes = project.content['modes'];
    if (Array.isArray(modes)) {
      const ids = modes.map((m) => (typeof m === 'object' && m !== null ? ((m as { modeId?: unknown; id?: unknown }).modeId ?? (m as { id?: unknown }).id) : undefined)).filter((x): x is string => typeof x === 'string');
      if (!ids.includes(options.mode)) return invalid('/options/mode', `the project has no game mode "${options.mode}"${ids.length > 0 ? ` (modes: ${ids.slice(0, 16).join(', ')})` : ''}`);
      out.mode = options.mode;
    } else {
      notes.push(`mode "${options.mode}" ignored: the project defines no game modes`);
    }
  }
  return { ok: true, start: out, notes };
}
