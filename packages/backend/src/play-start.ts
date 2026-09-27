/**
 * Phase 23.8: resolve a test/debug start of Play (`options.sceneId`, `mode`,
 * `variables`, `save`, `saveSlot` of the play-start request — the editor's
 * "Play from…" and `tl_play_start` send the same body) against the captured
 * project, so the preview only applies what the backend already checked:
 *
 * - a scene in a game with levels (`content.flow`) starts the first level
 *   that loads it (the title is skipped); a scene no level loads is refused;
 * - a scene in a game without levels is loaded with the start scenes (they
 *   hold the camera and the player), and the player starts at the scene's
 *   first player spawn when it has one (else the game's own);
 * - a save (a document, or a Play save slot) continues a game with levels —
 *   the save format is the flow's; a document's level must exist;
 * - variables pass through (the runtime puts them in `ctx.save` at step 0);
 * - a mode is checked against `content.modes` when the project defines game
 *   modes, and noted as ignored otherwise (modes arrive with phase 23.10).
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
  const flow = project.content['flow'] as { levels?: ReadonlyArray<{ id: string; scenes: readonly string[] }> } | undefined;
  const levels = Array.isArray(flow?.levels) ? flow!.levels : [];
  const hasGame = project.content['game'] !== null && project.content['game'] !== undefined;

  if (options.sceneId !== undefined) {
    const sceneId = options.sceneId;
    out.sceneId = sceneId;
    if (project.scenes === undefined) {
      if (sceneId !== project.sceneId) return invalid('/options/sceneId', `this project has one scene ("${project.sceneId}"), not "${sceneId}"`);
    } else {
      const scenes = project.scenes as readonly SceneLike[];
      const scene = scenes.find((s) => s.sceneId === sceneId);
      if (scene === undefined) return invalid('/options/sceneId', `the project has no scene "${sceneId}"`);
      if (levels.length > 0) {
        const level = levels.find((l) => l.scenes.includes(sceneId));
        if (level === undefined) return invalid('/options/sceneId', `no level of the game flow loads scene "${sceneId}" (start at a level's scene)`);
        out.levelId = level.id;
      } else {
        const start = project.startScenes ?? [];
        out.scenes = start.includes(sceneId) ? [...start] : [...start, sceneId];
        if (hasGame) {
          const spawn = scene.entities.find((e) => e.components?.['playerSpawn'] !== undefined);
          if (spawn !== undefined) out.spawnId = spawn.id;
        }
      }
    }
  }

  if (options.save !== undefined || options.saveSlot !== undefined) {
    if (levels.length === 0) return invalid(options.save !== undefined ? '/options/save' : '/options/saveSlot', 'a save continues a game with levels (a game flow); this project has none');
    if (options.save !== undefined) {
      const levelId = options.save['levelId'];
      if (!levels.some((l) => l.id === levelId)) return invalid('/options/save/levelId', `the save is for level "${String(levelId).slice(0, 64)}", which the game flow does not have`);
      out.save = options.save;
    } else out.saveSlot = options.saveSlot!;
  }

  if (options.variables !== undefined) out.variables = options.variables;

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
