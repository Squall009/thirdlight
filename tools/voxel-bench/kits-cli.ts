/**
 * The placeholder kits (`kits/`: log and stone, made by
 * `kits/make_placeholder_kits.py` in Blender) into a project on a running
 * backend (`node tools/voxel-bench/run.mjs kits …`), through the one
 * command path: each GLB put in the project's `assets/kits` folder and
 * imported as every model is (`importAssets`; a file changed since its
 * import is imported again by the editor's "check files"), each kit record set with the
 * imported asset's id (`setVoxelKit`), then the kit check's rows the
 * backend logged as problems printed. Engine-owned test data only (staging).
 *
 *   --origin URL        the backend (default http://127.0.0.1:4180, staging)
 *   --token-file FILE   its owner token (default ~/thirdlight-staging-p45/owner-token)
 *   --data-root DIR     its data root (default ~/thirdlight-staging-p45): the project's folder is under it
 *   --project ID        (default voxel-slice)   --kits log,stone
 *   --sheets SIZE       each kit's GLB with a placeholder sheet at SIZE² as its one material (kit-sheets.ts: the
 *                       kit's layout, log in timber, stone and sample in stone), imported as a new model
 *                       `voxel-kit-<id>-sheet.glb` so the import extracts its images into KTX2 textures; the record
 *                       names that model's version
 *   --crack SIZE        a placeholder 4 × 4 m crack map at SIZE² (`assets/kits/voxel-kit-crack.png`) as every
 *                       kit's own (`damage.crackTexture`)
 *   --from DIR          the kits' GLB and record from DIR (an export with its sheet inside), imported as sheet models
 *   --sheets-out DIR    only write the first kit's sheet at --sheets SIZE as DIR/albedo.png, normal.png, orm.png
 *                       (what the Blender export's `--sheet DIR` puts on a kit's material) and stop
 */
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { kitTrimLayout } from '@thirdlight/project-model';

import { glbWithKitMaterial, kitSheetPngs, placeholderCrackPng } from './kit-sheets';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback;
}

const REPO = process.env['TL_VOXEL_BENCH_REPO'] ?? process.cwd();
const ORIGIN = arg('origin', 'http://127.0.0.1:4180');
const TOKEN = readFileSync(arg('token-file', join(homedir(), 'thirdlight-staging-p45', 'owner-token')), 'utf8').trim();
const DATA_ROOT = arg('data-root', join(homedir(), 'thirdlight-staging-p45'));
const PROJECT = arg('project', 'voxel-slice');
const KITS = arg('kits', 'log,stone').split(',');
// `--from DIR`: a kit exported with its sheet inside (the Blender export's `--sheet`), imported as a sheet model.
const FROM = arg('from', '');
const KIT_DIR = FROM !== '' ? FROM : join(REPO, 'tools', 'voxel-bench', 'kits');
const FOLDER = 'assets/kits';

type Answer = Record<string, unknown> & { ok?: boolean; error?: { code: string; message?: string } };

async function command(op: string, args: Record<string, unknown>, write: boolean): Promise<Answer> {
  const body: Record<string, unknown> = { op, projectId: PROJECT, args };
  if (write) {
    const project = await command('queryProject', {}, false);
    body['expectedRevision'] = project['revision'];
    body['requestId'] = `req-${randomBytes(16).toString('hex')}`;
  }
  const r = await fetch(`${ORIGIN}/api/v1/projects/${PROJECT}/commands`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return (await r.json()) as Answer;
}

const SHEETS = Number(arg('sheets', '0'));
const CRACK = Number(arg('crack', '0'));
const SHEET_SET = { log: 'timber', stone: 'stone', sample: 'stone' } as const;
const SHEETS_OUT = arg('sheets-out', '');
if (SHEETS_OUT !== '') {
  const id = KITS[0]!;
  const layout = kitTrimLayout(JSON.parse(readFileSync(join(KIT_DIR, `${id}.voxelkit.json`), 'utf8')) as { voxelKitId: string });
  if (layout === undefined || SHEETS === 0) throw new Error('--sheets-out needs a kit with a layout and --sheets SIZE');
  const pngs = kitSheetPngs(layout, SHEETS, SHEET_SET[id as keyof typeof SHEET_SET] ?? 'stone');
  mkdirSync(SHEETS_OUT, { recursive: true });
  for (const [k, b] of Object.entries(pngs)) writeFileSync(join(SHEETS_OUT, `${k}.png`), b);
  console.log(`[kits] ${id}'s sheet at ${SHEETS}² into ${SHEETS_OUT}: ${Object.entries(pngs).map(([k, b]) => `${k} ${(b.length / 1e6).toFixed(2)} MB`).join(', ')}`);
  process.exit(0);
}
const dir = join(DATA_ROOT, 'projects', PROJECT, ...FOLDER.split('/'));
mkdirSync(dir, { recursive: true });
/** The file a kit's GLB is imported from (its sheet version a model of its own). */
const SHEETED = SHEETS > 0 || FROM !== '';
const fileOf = (id: string): string => (SHEETED ? `voxel-kit-${id}-sheet.glb` : `voxel-kit-${id}.glb`);
for (const id of KITS) {
  if (SHEETS === 0) {
    copyFileSync(join(KIT_DIR, `voxel-kit-${id}.glb`), join(dir, fileOf(id)));
    continue;
  }
  const record = JSON.parse(readFileSync(join(KIT_DIR, `${id}.voxelkit.json`), 'utf8')) as { voxelKitId: string; trimLayout?: string; sheetLayout?: never };
  const layout = kitTrimLayout(record);
  if (layout === undefined) throw new Error(`${id}: no trim layout to lay a sheet on`);
  const t0 = performance.now();
  const pngs = kitSheetPngs(layout, SHEETS, SHEET_SET[id as keyof typeof SHEET_SET] ?? 'stone');
  const glb = glbWithKitMaterial(readFileSync(join(KIT_DIR, `voxel-kit-${id}.glb`)), `${id}-sheet`, pngs);
  writeFileSync(join(dir, fileOf(id)), glb);
  console.log(`[kits] ${id}: sheet on ${layout.id} at ${SHEETS}² (${((SHEETS * layout.pxPerMetre) / layout.size).toFixed(0)} px/m): albedo ${(pngs.albedo.length / 1e6).toFixed(2)} MB, normal ${(pngs.normal.length / 1e6).toFixed(2)} MB, ORM ${(pngs.orm.length / 1e6).toFixed(2)} MB PNG; GLB ${(glb.length / 1e6).toFixed(2)} MB (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
}
if (CRACK > 0) {
  const png = placeholderCrackPng(CRACK);
  writeFileSync(join(dir, 'voxel-kit-crack.png'), png);
  console.log(`[kits] crack map ${CRACK}² (${CRACK / 4} px/m on a 4 m tile): PNG ${(png.length / 1e6).toFixed(2)} MB`);
}
const imported = await command('importAssets', { folder: FOLDER }, true);
if (imported.ok !== true && imported.error?.code !== 'no_change') throw new Error(`importAssets: ${JSON.stringify(imported.error)}`);
// Files already imported and since regenerated: "check files" imports them again as a new version.
const checked = await fetch(`${ORIGIN}/api/v1/projects/${PROJECT}/content/files/check`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: '{}' });
if (!checked.ok) throw new Error(`check files: ${checked.status} ${await checked.text()}`);
const listed = await command('queryAssets', { limit: 100 }, false);
if (listed.ok !== true) throw new Error(`queryAssets: ${JSON.stringify(listed.error)}`);
const assets = listed['assets'] as Array<{ assetId: string; sourcePath?: string; textures?: Record<string, string> }>;
const crackAsset = CRACK > 0 ? assets.find((a) => a.sourcePath === `${FOLDER}/voxel-kit-crack.png` || a.assetId === 'voxel-kit-crack') : undefined;
if (CRACK > 0 && crackAsset === undefined) throw new Error('voxel-kit-crack.png was not imported');
const currentDigest = async (assetId: string): Promise<string> => {
  const r = (await (await fetch(`${ORIGIN}/api/v1/projects/${PROJECT}/content/assets/${assetId}`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()) as { asset?: { currentVersion?: number }; versions?: { version: number; sourceDigest: string }[] };
  return r.versions!.find((v) => v.version === r.asset!.currentVersion)!.sourceDigest;
};
const before = ((await (await fetch(`${ORIGIN}/api/v1/projects/${PROJECT}/problems`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()) as { problems: unknown[] }).problems.length;
for (const id of KITS) {
  const glb = readFileSync(join(KIT_DIR, `voxel-kit-${id}.glb`));
  const digest = createHash('sha256').update(glb).digest('hex');
  // A model whose images were extracted lists no source path of its own file: its id is the file's stem.
  const asset = assets.find((a) => a.sourcePath === `${FOLDER}/${fileOf(id)}`) ?? assets.find((a) => a.assetId === fileOf(id).replace(/\.glb$/, ''));
  if (asset === undefined) throw new Error(`${fileOf(id)} was not imported`);
  const record = (await (await fetch(`${ORIGIN}/api/v1/projects/${PROJECT}/content/assets/${asset.assetId}`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()) as { versions?: { sourceDigest?: string }[] };
  if (!SHEETED && !(record.versions ?? []).some((v) => v.sourceDigest === digest)) throw new Error(`${asset.assetId} has no version of these bytes (${digest})`);
  // The record names the asset by the id the file was committed with; the project's import may name it otherwise. A
  // sheet GLB is stored with its images extracted: the record names that stored version's digest.
  let text = readFileSync(join(KIT_DIR, `${id}.voxelkit.json`), 'utf8').replaceAll(`"voxel-kit-${id}"`, JSON.stringify(asset.assetId));
  if (!text.includes(digest)) throw new Error(`${id}.voxelkit.json does not name voxel-kit-${id}.glb's digest ${digest}: run the generator again`);
  if (SHEETED) text = text.replaceAll(digest, await currentDigest(asset.assetId));
  const kit = JSON.parse(text) as { slots: Record<string, unknown>; damage?: Record<string, unknown> };
  if (crackAsset !== undefined) kit.damage = { ...(kit.damage ?? {}), crackTexture: { assetId: crackAsset.assetId, digest: await currentDigest(crackAsset.assetId) } };
  if (SHEETED) console.log(`[kits] ${id}: extracted images ${JSON.stringify(asset.textures ?? {})}`);
  const set = await command('setVoxelKit', { kit }, true);
  if (set.ok !== true && set.error?.code !== 'no_change') throw new Error(`setVoxelKit ${id}: ${JSON.stringify(set.error)}`);
  console.log(`[kits] ${id}: asset ${asset.assetId} (${glb.length} B, sha256 ${digest.slice(0, 12)}…), ${Object.keys(kit.slots).length} slots, setVoxelKit ${set.ok === true ? 'ok' : set.error?.code}`);
}
// The backend checks kits after a kit or asset change (debounced): give it a moment, then print its rows.
await new Promise((ok) => setTimeout(ok, 1500));
const problems = ((await (await fetch(`${ORIGIN}/api/v1/projects/${PROJECT}/problems`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()) as { problems: Array<{ code: string; message: string }> }).problems;
const rows = problems.slice(before).filter((p) => p.code === 'voxel_kit_check');
console.log(`[kits] kit check rows logged as problems (warn/err): ${rows.length}`);
for (const p of rows) console.log(`  ${p.message}`);
