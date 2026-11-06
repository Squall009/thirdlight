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
 */
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
const KIT_DIR = join(REPO, 'tools', 'voxel-bench', 'kits');
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

const dir = join(DATA_ROOT, 'projects', PROJECT, ...FOLDER.split('/'));
mkdirSync(dir, { recursive: true });
for (const id of KITS) copyFileSync(join(KIT_DIR, `voxel-kit-${id}.glb`), join(dir, `voxel-kit-${id}.glb`));
const imported = await command('importAssets', { folder: FOLDER }, true);
if (imported.ok !== true && imported.error?.code !== 'no_change') throw new Error(`importAssets: ${JSON.stringify(imported.error)}`);
// Files already imported and since regenerated: "check files" imports them again as a new version.
const checked = await fetch(`${ORIGIN}/api/v1/projects/${PROJECT}/content/files/check`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: '{}' });
if (!checked.ok) throw new Error(`check files: ${checked.status} ${await checked.text()}`);
const listed = await command('queryAssets', { limit: 100 }, false);
if (listed.ok !== true) throw new Error(`queryAssets: ${JSON.stringify(listed.error)}`);
const assets = listed['assets'] as Array<{ assetId: string; sourcePath?: string }>;
const before = ((await (await fetch(`${ORIGIN}/api/v1/projects/${PROJECT}/problems`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()) as { problems: unknown[] }).problems.length;
for (const id of KITS) {
  const glb = readFileSync(join(KIT_DIR, `voxel-kit-${id}.glb`));
  const digest = createHash('sha256').update(glb).digest('hex');
  const asset = assets.find((a) => a.sourcePath === `${FOLDER}/voxel-kit-${id}.glb`);
  if (asset === undefined) throw new Error(`voxel-kit-${id}.glb was not imported`);
  const record = (await (await fetch(`${ORIGIN}/api/v1/projects/${PROJECT}/content/assets/${asset.assetId}`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()) as { versions?: { sourceDigest?: string }[] };
  if (!(record.versions ?? []).some((v) => v.sourceDigest === digest)) throw new Error(`${asset.assetId} has no version of these bytes (${digest})`);
  // The record names the asset by the id the file was committed with; the project's import may name it otherwise.
  const text = readFileSync(join(KIT_DIR, `${id}.voxelkit.json`), 'utf8').replaceAll(`"voxel-kit-${id}"`, JSON.stringify(asset.assetId));
  const kit = JSON.parse(text) as { slots: Record<string, unknown> };
  if (!text.includes(digest)) throw new Error(`${id}.voxelkit.json does not name voxel-kit-${id}.glb's digest ${digest}: run the generator again`);
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
