/**
 * The project problems log (the editor's Problems tab and MCP read it) and the
 * checks that fill it: what the project's open reported, its materials'
 * graphs, missing files, scripts naming unloadable assets, kits, block
 * layers, vertex paint, height slots, occluders and held model images. Each
 * check runs when an editor loads the project and again after a change that
 * can matter to it.
 */
import type { WorkspaceService } from '@thirdlight/workspace';

import { audioPlaybackProblems } from './audio-gaps';
import type { AssetFileCheck } from './asset-files';
import { createBlockProblemChecker } from './block-problems';
import { createPrefabProblemChecker } from './prefab-problems';
import { createMigrated2DProblemChecker } from './migrated-2d-problems';
import { createHeightAlphaProblems, type HeightAlphaChecks } from './height-alpha';
import { createHeldImagesChecker } from './held-images';
import { createKitChecker } from './kit-check';
import { createKitProblemChecker } from './kit-problems';
import { createMaterialProblemChecker, materialProblemLine, type MaterialRow } from './material-problems';
import { createMissingFiles } from './missing-files';
import { createOccluderProblemChecker } from './occluder-problems';
import { createPaintProblemChecker } from './paint-problems';
import { createScriptNameChecker } from './script-name-problems';
import type { TextureEncoder } from './texture-encode';

/** One recorded problem: bounded, log-safe (no secrets, no host paths). */
export interface Problem {
  seq: number;
  at: string;
  source: 'command' | 'import' | 'compile' | 'play' | 'export' | 'workspace';
  code: string;
  message: string;
}

export type RecordProblem = (projectId: string, source: Problem['source'], code: string, message: string) => void;

/** The newest problems a project keeps; older ones fall off the log. */
const PROBLEMS_PER_PROJECT = 200;

export interface ProblemLog {
  readonly record: RecordProblem;
  /** The project's problems, oldest first. */
  list(projectId: string): readonly Problem[];
}

/** The bounded per-project log; each new problem also goes to the project's connected editor. */
export function createProblemLog(deps: { nowMs: () => number; sendToProject: (projectId: string, frame: Record<string, unknown>) => void }): ProblemLog {
  const problems = new Map<string, Problem[]>();
  let problemSeq = 0;
  const record: RecordProblem = (projectId, source, code, message) => {
    problemSeq += 1;
    const entry: Problem = { seq: problemSeq, at: new Date(deps.nowMs()).toISOString(), source, code, message: message.slice(0, 256) };
    const list = problems.get(projectId) ?? [];
    list.push(entry);
    if (list.length > PROBLEMS_PER_PROJECT) list.splice(0, list.length - PROBLEMS_PER_PROJECT);
    problems.set(projectId, list);
    // The Problems query returns it anyway when the editor misses this.
    deps.sendToProject(projectId, { type: 'problems.added', problem: entry });
  };
  return { record, list: (projectId) => problems.get(projectId) ?? [] };
}

export interface ProjectChecksDeps {
  readonly service: WorkspaceService;
  readonly recordProblem: RecordProblem;
  readonly logStartup: (message: string) => void;
  readonly closed: () => boolean;
  readonly textureEncoder: TextureEncoder;
  readonly heightChecks: HeightAlphaChecks;
  readonly assetFiles: AssetFileCheck;
}

/**
 * Whether a change can change a material's compile: the materials
 * themselves, a standalone graph (a material function), or the texture
 * assets a graph samples. A scene edit or any other content edit cannot,
 * and the check reads the whole project.
 */
const changeReachesMaterials = (change: unknown): boolean => {
  const type = (change as { type?: unknown } | null)?.type;
  return (
    type === 'setMaterial' ||
    type === 'setMaterials' ||
    type === 'setGraph' ||
    type === 'graphEdit' ||
    type === 'publishAsset' ||
    type === 'removeAsset' ||
    type === 'importAssets' ||
    type === 'importResources' ||
    type === 'setAssetOptions'
  );
};
/** Whether a change adds, removes, moves or re-imports an asset record (what the missing-file walk reads). */
const changesAssetRecords = (change: unknown): boolean => {
  const type = (change as { type?: unknown } | null)?.type;
  return type === 'publishAsset' || type === 'removeAsset' || type === 'importAssets' || type === 'importResources' || type === 'setAssetOptions';
};

export function createProjectChecks(deps: ProjectChecksDeps) {
  const { service, recordProblem, logStartup, closed } = deps;
  const as = (source: Problem['source']) => (projectId: string, code: string, message: string): void => recordProblem(projectId, source, code, message);

  // The missing asset files (read at the first problems query and after each file check or asset change).
  const missingFiles = createMissingFiles({ service, recordProblem: as('workspace'), logStartup, closed });
  // Scripts that name an asset that is not loadable (checked on load and after a change that can matter).
  const scriptNames = createScriptNameChecker({ service, recordProblem: as('compile'), logStartup, closed });
  // Kits against the trim sheet spec (the kit editor's checks); their pieces' errors join the kit Problems.
  const kitChecker = createKitChecker({ service, encoder: deps.textureEncoder });
  const kitProblems = createKitProblemChecker({ service, recordProblem: as('workspace'), logStartup, closed, pieceErrors: kitChecker.pieceErrors });
  // Block layers' floating blocks, empty regions and unreachable places (checked on load and after block edits settle).
  const blockProblems = createBlockProblemChecker({ service, recordProblem: as('workspace'), logStartup, closed });
  // Linked prefab copies assembly could not make as stored (checked on load and after changes to copies or prefabs).
  const prefabProblems = createPrefabProblemChecker({ service, recordProblem: as('workspace'), logStartup, closed });
  // What the upgrade of a former 2D project converted, until each item is saved again (checked on load and after changes while any is open).
  const migrated2D = createMigrated2DProblemChecker({ service, recordProblem: as('workspace'), logStartup, closed });
  // Vertex paint a reimport left without its mesh (checked on load and after changes that can matter).
  const paintProblems = createPaintProblemChecker({ service, recordProblem: as('workspace'), logStartup, closed });
  // Textures in a layered surface's height slots without height in A (checked on load and after material and texture changes).
  const heightProblems = createHeightAlphaProblems({ service, checks: deps.heightChecks, recordProblem: as('import'), logStartup, closed });
  // Models' `_OCC` stand-ins that are ignored, being outside their piece (checked on load and after imports).
  const occluderProblems = createOccluderProblemChecker({ service, recordProblem: as('import'), logStartup, closed });
  // Models still holding images when the project extracts every model's: extracted where their files are, the rest listed.
  const heldImages = createHeldImagesChecker({ service, extract: deps.assetFiles.extractModels, recordProblem: as('import'), logStartup, closed });

  // Graph materials' problems (checked on load and after every change).
  const materialChecker = createMaterialProblemChecker();
  const materialCheckTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Check a project's materials now; problems that appeared or changed go to the problems log. Null: the project cannot be read. */
  const checkMaterials = (projectId: string): MaterialRow[] | null => {
    if (closed()) return null;
    const t = materialCheckTimers.get(projectId);
    if (t !== undefined) {
      clearTimeout(t);
      materialCheckTimers.delete(projectId);
    }
    const captured = service.readCapturedV3(projectId);
    if (!captured.ok) return null;
    const { rows, changed } = materialChecker.update(projectId, captured.read.content);
    for (const r of changed) recordProblem(projectId, 'compile', 'material_graph_problems', materialProblemLine(r));
    return rows;
  };
  const checkMaterialsLogged = (projectId: string): void => {
    try {
      checkMaterials(projectId);
    } catch (e) {
      logStartup(`material check of ${projectId} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  /** After a change: check soon (coalesced; off the request's path). */
  const scheduleMaterialCheck = (projectId: string): void => {
    if (closed() || materialCheckTimers.has(projectId)) return;
    const t = setTimeout(() => {
      materialCheckTimers.delete(projectId);
      checkMaterialsLogged(projectId);
    }, 25);
    (t as { unref?: () => void }).unref?.();
    materialCheckTimers.set(projectId, t);
  };

  return {
    missingFiles,
    kitChecker,
    heightProblems,
    /** The project's material rows: the last check, else a check now (the load). */
    materialRows: (projectId: string): MaterialRow[] | null => (materialCheckTimers.has(projectId) ? null : materialChecker.last(projectId)) ?? checkMaterials(projectId),
    /** The project was read for an editor or the Problems query: the checks that run on load run (each once). */
    loaded(projectId: string): void {
      // What the open's format upgrade did (files written, older versions kept, the report's name) goes to the log once.
      for (const note of service.takeUpgradeNotes(projectId)) recordProblem(projectId, 'workspace', 'project_upgraded', note);
      for (const p of service.takeOpenProblems(projectId)) recordProblem(projectId, 'workspace', p.code, p.message);
      scriptNames.loaded(projectId);
      kitProblems.loaded(projectId);
      heldImages.loaded(projectId);
      blockProblems.loaded(projectId);
      prefabProblems.loaded(projectId);
      migrated2D.loaded(projectId);
      paintProblems.loaded(projectId);
      heightProblems.loaded(projectId);
      occluderProblems.loaded(projectId);
    },
    /** An editor loading the project: its materials are checked (once; after that, after each change). */
    loadedByEditor(projectId: string): void {
      if (materialChecker.last(projectId) === null) checkMaterialsLogged(projectId);
    },
    /** An applied change: the checks it can matter to run again. */
    changed(projectId: string, change: unknown): void {
      // Materials are checked again after a change that can change what they compile to.
      if (changeReachesMaterials(change)) {
        scheduleMaterialCheck(projectId);
        // Only an asset-record change can change which files are missing (the walk stats every asset, which
        // on a big project costs a noticeable main-thread pause per burst of graph edits); a material or
        // graph edit can only change what uses the files already listed.
        if (changesAssetRecords(change)) missingFiles.schedule(projectId);
        else missingFiles.scheduleUses(projectId);
      }
      scriptNames.changed(projectId, change);
      kitProblems.changed(projectId, change);
      heldImages.changed(projectId, change);
      blockProblems.changed(projectId, change);
      prefabProblems.changed(projectId, change);
      migrated2D.changed(projectId);
      paintProblems.changed(projectId, change);
      heightProblems.changed(projectId, change);
      occluderProblems.changed(projectId, change);
      for (const line of audioPlaybackProblems(change)) recordProblem(projectId, 'import', 'audio_browser_support', line);
    },
    /** No material check after close (it would open the project again). */
    dispose(): void {
      for (const t of materialCheckTimers.values()) clearTimeout(t);
      materialCheckTimers.clear();
    },
  };
}

export type ProjectChecks = ReturnType<typeof createProjectChecks>;
