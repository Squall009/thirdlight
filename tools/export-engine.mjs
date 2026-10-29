/**
 * Freezes the engine an export bundles from: copies the sources of every
 * package an export may link (the exporter's `exportEnginePackages()`) into
 * `dist/export-engine/`, with the layout esbuild resolves the live tree by, so
 * exports bundle from the build Play serves and never from the working tree.
 *
 *   node tools/export-engine.mjs            (also run by tools/build.mjs)
 *
 * Copied: each package's package.json, tsconfig.json and src/ (tests left
 * out), and the shared tsconfig base. `node_modules/@thirdlight/<name>` links
 * each package to its copy; a package's own node_modules (a pinned dependency
 * installed beside it) is linked to the installed one. Everything else
 * (three, Rapier) resolves from the installation's node_modules above.
 * The copy is written beside the old one and swapped in at the end, so an
 * export running meanwhile reads a whole engine.
 */
import esbuild from 'esbuild';
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The exporter's own answers (folder, package list), read from its source so the list lives in one place. */
async function exporterFacts(root) {
  const r = await esbuild.build({
    entryPoints: [join(root, 'packages/exporter/src/export-engine.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    logLevel: 'silent',
  });
  const code = r.outputFiles[0].text;
  const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  return { dir: mod.EXPORT_ENGINE_DIR, packages: mod.exportEnginePackages() };
}

const isTest = (name) => /\.test\.[cm]?[jt]sx?$/.test(name);

function link(target, at) {
  mkdirSync(dirname(at), { recursive: true });
  symlinkSync(relative(dirname(at), target), at);
}

/**
 * Write the frozen engine of the sources under `root` into `<outRoot>/<dir>`
 * (`outRoot` defaults to `root`; a test freezes into a scratch engine root).
 * Returns the frozen folder and the number of source files copied.
 */
export async function freezeExportEngine(root = ROOT, outRoot = root) {
  const { dir, packages } = await exporterFacts(root);
  const out = join(outRoot, dir);
  const staging = `${out}.${process.pid}.tmp`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  cpSync(join(root, 'tsconfig.base.json'), join(staging, 'tsconfig.base.json'));
  for (const name of packages) {
    const from = join(root, 'packages', name);
    const to = join(staging, 'packages', name);
    for (const f of ['package.json', 'tsconfig.json']) if (existsSync(join(from, f))) cpSync(join(from, f), join(to, f));
    cpSync(join(from, 'src'), join(to, 'src'), { recursive: true, filter: (src) => !isTest(src) });
    if (existsSync(join(from, 'node_modules'))) link(join(from, 'node_modules'), join(to, 'node_modules'));
    link(to, join(staging, 'node_modules', '@thirdlight', name));
  }
  const files = readdirSync(join(staging, 'packages'), { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).length;
  // Swap: an export that started on the old copy has read its sources by the time esbuild returns.
  const old = `${out}.${process.pid}.old`;
  if (existsSync(out)) renameSync(out, old);
  renameSync(staging, out);
  rmSync(old, { recursive: true, force: true });
  return { dir: out, packages, files };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = await freezeExportEngine();
  console.log(`export-engine: ${r.packages.length} packages, ${r.files} files -> ${relative(ROOT, r.dir)}`);
}
