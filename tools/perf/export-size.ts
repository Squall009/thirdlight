/**
 * What an exported game downloads: the engine's code files of an export (the page bundle, the workers,
 * the physics backend and its WASM, the decoders) raw, gzip and brotli, for a minimal 2D game, a minimal
 * 3D game, the village class and any project folder given. Content (models, textures, audio) is reported
 * as one total: it is the game's, not the engine's.
 *
 *   node tools/perf/run.mjs export-size [--no-village] [--project <folder>]… [--keep]
 *
 * A folder is registered as is (the backend writes into what it registers: pass a copy).
 */
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

import { PERF_ROOT, startPerfBackend, type PerfBackend } from './backend';
import { buildVillage } from './village';

interface FileSize {
  path: string;
  raw: number;
  gzip: number;
  brotli: number;
}

export interface ExportSize {
  name: string;
  exportMs: number;
  /** The engine's code files (js/, decoders/), largest first. */
  code: FileSize[];
  codeTotal: Omit<FileSize, 'path'>;
  /** Everything else in the export (manifest, scenes, assets), raw bytes. */
  contentRaw: number;
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

/** Sizes of one export directory. */
export function exportSize(name: string, dir: string, exportMs: number): ExportSize {
  const code: FileSize[] = [];
  let contentRaw = 0;
  for (const file of filesUnder(dir)) {
    const rel = relative(dir, file).replace(/\\/g, '/');
    const bytes = readFileSync(file);
    // Source maps are never downloaded by a player (only by open developer tools).
    if (rel.endsWith('.map')) continue;
    if (!rel.startsWith('js/') && !rel.startsWith('decoders/')) {
      contentRaw += bytes.length;
      continue;
    }
    code.push({
      path: rel,
      raw: bytes.length,
      gzip: gzipSync(bytes, { level: 9 }).length,
      brotli: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length } }).length,
    });
  }
  code.sort((a, b) => b.raw - a.raw);
  const sum = (k: 'raw' | 'gzip' | 'brotli'): number => code.reduce((n, f) => n + f[k], 0);
  return { name, exportMs, code, codeTotal: { raw: sum('raw'), gzip: sum('gzip'), brotli: sum('brotli') }, contentRaw };
}

const kb = (n: number): string => `${(n / 1024).toFixed(0)} KiB`;

export function exportSizeLines(s: ExportSize): string[] {
  return [
    `${s.name}: code ${kb(s.codeTotal.raw)} raw / ${kb(s.codeTotal.gzip)} gzip / ${kb(s.codeTotal.brotli)} brotli, content ${kb(s.contentRaw)}, export ${s.exportMs} ms`,
    ...s.code.map((f) => `  ${f.path}: ${kb(f.raw)} / ${kb(f.gzip)} / ${kb(f.brotli)}`),
  ];
}

async function exportOf(be: PerfBackend, projectId: string): Promise<{ dir: string; ms: number }> {
  const t = performance.now();
  console.log(`export-size: exporting ${projectId}`);
  const res = await be.post(`/api/v1/admin/projects/${projectId}/export`, {});
  if (res.status !== 200) throw new Error(`export of ${projectId} failed: ${JSON.stringify(res.json).slice(0, 400)}`);
  return { dir: join(be.exportRoot, String(res.json['outputDir'])), ms: Math.round(performance.now() - t) };
}

export async function runExportSizeCli(argv: readonly string[]): Promise<void> {
  const folders: string[] = [];
  argv.forEach((a, i) => {
    if (a === '--project' && argv[i + 1] !== undefined) folders.push(resolve(argv[i + 1]!));
  });
  const runDir = join(PERF_ROOT, 'runs', `export-size-${Date.now()}`);
  const be = await startPerfBackend(join(runDir, 'data'), join(runDir, 'exports'));
  // Measured once the backend is done: compressing takes seconds, longer than an idle connection is kept.
  const exported: { name: string; dir: string; ms: number }[] = [];
  try {
    // The smallest game with physics: a floor and a player with the character controller, on the 2D plane and in 3D.
    for (const [projectId, dimension] of [['min2d', 2], ['min3d', 3]] as const) {
      const created = await be.post('/api/v1/admin/projects', { projectId, name: projectId });
      if (created.status !== 201 && created.status !== 200) throw new Error(`project create failed: ${JSON.stringify(created.json)}`);
      const p = be.project(projectId);
      if (dimension === 3) await p.command('setSettings', { settings: { physics_dimension: 3 } });
      const shape = dimension === 3 ? { type: 'box', hx: 5, hy: 0.5, hz: 5 } : { type: 'box', hx: 5, hy: 0.5 };
      await p.command('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'box', name: 'Floor', transform: { position: [0, -0.5, 0] }, box: { size: [10, 1, 10] }, components: { collider: { shape } } });
      const player = String((await p.command('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Player', transform: { position: [0, 3, 0] } }))['createdId']);
      await p.command('setComponent', { entityId: player, component: 'controller', value: {} });
      exported.push({ name: `minimal ${dimension}D`, ...(await exportOf(be, projectId)) });
    }
    if (!argv.includes('--no-village')) {
      await buildVillage(be, 'village');
      exported.push({ name: 'village class', ...(await exportOf(be, 'village')) });
    }
    for (const folder of folders) {
      const reg = await be.post('/api/v1/admin/projects/register', { folder });
      if (typeof reg.json['projectId'] !== 'string') throw new Error(`register failed: ${JSON.stringify(reg.json).slice(0, 400)}`);
      exported.push({ name: folder.split('/').pop()!, ...(await exportOf(be, reg.json['projectId'])) });
    }
  } finally {
    await be.stop();
  }
  const results = exported.map((e) => exportSize(e.name, e.dir, e.ms));
  for (const r of results) for (const line of exportSizeLines(r)) console.log(line);
  if (!argv.includes('--keep')) rmSync(runDir, { recursive: true, force: true });
  console.log(JSON.stringify(results.map((r) => ({ name: r.name, ...r.codeTotal, contentRaw: r.contentRaw, exportMs: r.exportMs }))));
}
