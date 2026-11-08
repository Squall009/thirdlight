/**
 * Voxel kits checked into the project's Problems (project-model
 * `voxel-kit-check`): each kit against the world rules' case catalogue and
 * its meshes' files, its warn and err rows as lines of the problems log
 * (the editor's Problems, MCP's tl_diagnostics). Rows of one rule that
 * repeat per case or role (a required case without a piece, a role
 * without a fallback piece) are one line, so a sparse kit names what it
 * lacks without flooding the log.
 *
 * Checked when the project loads and shortly after a change that can change
 * the answer (a kit, an import or a removed asset); a line is logged when
 * it appears or changes. A mesh's facts are kept by its file version and
 * node for as long as a kit names it.
 */
import { imageDimensions } from '@thirdlight/asset-pipeline';
import type { VoxelKit, VoxelKitMesh } from '@thirdlight/project-model';
import { namedVoxelIds, voxelKitMeshFacts, voxelKitMeshKey, worldVoxelKitCheck, type VoxelKitCheckReport, type VoxelKitCheckRow, type VoxelKitMeshFacts } from '@thirdlight/project-model/voxel-kit-check';
import type { WorkspaceService } from '@thirdlight/workspace';

/** The change types that can change a voxel kit's answer. */
const RELEVANT = new Set(['setVoxelKit', 'deleteVoxelKit', 'publishAsset', 'removeAsset', 'importAssets', 'importResources', 'setAssetOptions']);
const MIMES = new Set<string>(['image/png', 'image/jpeg', 'image/webp', 'image/ktx2']);
/** The problems log code of a voxel kit's check lines. */
export const VOXEL_KIT_CHECK_CODE = 'voxel_kit_check';

type CapturedAsset = { assetId: string; kind?: string; currentVersion: number; versions: { version: number; sourceDigest: string }[] };

const currentDigest = (a: CapturedAsset): { current?: string } => {
  const d = a.versions.find((v) => v.version === a.currentVersion)?.sourceDigest;
  return d === undefined ? {} : { current: d };
};

const imageSize = (bytes: Uint8Array, mime: string): [number, number] | null => {
  if (!MIMES.has(mime)) return null;
  const d = imageDimensions(bytes, mime as Parameters<typeof imageDimensions>[1]);
  return d === null ? null : [d.width, d.height];
};

/** A report's warn and err rows as log lines: one a rule (the part of its id before `:`). */
export function voxelKitProblemLines(r: VoxelKitCheckReport): string[] {
  const groups = new Map<string, VoxelKitCheckRow[]>();
  for (const row of r.rows) {
    if (row.state !== 'err' && row.state !== 'warn') continue;
    const rule = row.id.startsWith('trim:') ? row.id : row.id.split(':')[0]!;
    groups.set(rule, [...(groups.get(rule) ?? []), row]);
  }
  return [...groups].map(([rule, rows]) => {
    const state = rows.some((x) => x.state === 'err') ? 'error' : 'warning';
    const what = rows.length === 1 ? `${rows[0]!.title}: ${rows[0]!.detail}` : `${rows.length} ${rule} rows: ${rows.map((x) => x.title).join('; ')}`;
    return `Voxel kit "${r.name}" (${r.voxelKitId}) ${state}${rows[0]!.draft === true ? ' (draft trim layout)' : ''}: ${what}`;
  });
}

export interface VoxelKitProblemChecker {
  /** Check every kit now (logging lines that appeared or changed); null: the project cannot be read. */
  check(projectId: string): VoxelKitCheckReport[] | null;
  loaded(projectId: string): void;
  changed(projectId: string, change: unknown): void;
}

export function createVoxelKitProblemChecker(deps: {
  service: Pick<WorkspaceService, 'readCapturedV3' | 'readBlob'>;
  recordProblem: (projectId: string, code: string, message: string) => void;
  logStartup: (line: string) => void;
  closed: () => boolean;
}): VoxelKitProblemChecker {
  const last = new Map<string, Set<string>>();
  const facts = new Map<string, Map<string, VoxelKitMeshFacts | null>>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const check = (projectId: string): VoxelKitCheckReport[] | null => {
    const captured = deps.service.readCapturedV3(projectId);
    if (!captured.ok) return null;
    const content = captured.read.content as unknown as { voxelKits?: VoxelKit[]; assets?: CapturedAsset[]; materials?: unknown[] };
    const assets = new Map((content.assets ?? []).map((a) => [a.assetId, a]));
    const view = new Map([...assets].map(([id, a]) => [id, { kind: a.kind ?? 'model', digests: a.versions.map((v) => v.sourceDigest), ...currentDigest(a) }]));
    const kept = facts.get(projectId) ?? new Map<string, VoxelKitMeshFacts | null>();
    const used = new Map<string, VoxelKitMeshFacts | null>();
    const factsOf = (m: VoxelKitMesh): VoxelKitMeshFacts | null => {
      const a = assets.get(m.assetId);
      if (a === undefined || (a.kind ?? 'model') !== 'model') return null;
      // The version the piece was made from; else the one a build ships (the current).
      const version = a.versions.find((v) => v.sourceDigest === m.digest)?.version ?? a.currentVersion;
      const key = `${voxelKitMeshKey(m)}|${version}`;
      if (used.has(key)) return used.get(key)!;
      let f = kept.get(key);
      if (f === undefined) {
        const read = deps.service.readBlob(projectId, { assetId: m.assetId, version });
        f = read.ok ? voxelKitMeshFacts(read.bytes, m.node, imageSize) : { unreadable: read.error.message, found: false, triangles: 0, bounds: null, positions: new Float32Array(0), uv: null, textures: { count: 0, bytes: 0, sizes: [] }, textureSets: [] };
      }
      used.set(key, f);
      return f;
    };
    const named = namedVoxelIds(content.materials ?? []);
    const reports = (content.voxelKits ?? []).map((k) => worldVoxelKitCheck(k, view, factsOf, named));
    facts.set(projectId, used);
    const before = last.get(projectId);
    const now = new Set<string>();
    for (const r of reports) {
      for (const line of voxelKitProblemLines(r)) {
        now.add(line);
        if (before?.has(line) !== true) deps.recordProblem(projectId, VOXEL_KIT_CHECK_CODE, line);
      }
    }
    last.set(projectId, now);
    return reports;
  };
  const safeCheck = (projectId: string): void => {
    try {
      check(projectId);
    } catch (e) {
      deps.logStartup(`voxel kit check of ${projectId} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  return {
    check,
    loaded(projectId) {
      if (!last.has(projectId)) safeCheck(projectId);
    },
    changed(projectId, change) {
      const type = (change as { type?: unknown } | null)?.type;
      if (typeof type !== 'string' || !RELEVANT.has(type) || deps.closed() || timers.has(projectId)) return;
      const t = setTimeout(() => {
        timers.delete(projectId);
        if (!deps.closed()) safeCheck(projectId);
      }, 25);
      (t as { unref?: () => void }).unref?.();
      timers.set(projectId, t);
    },
  };
}
