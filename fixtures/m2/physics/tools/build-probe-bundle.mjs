/**
 * Packet 31 — browser-bundle probe: build an entry that imports the adapter
 * with the **export.md §5.3 pinned esbuild option set** and record the exact
 * byte count and digest.
 *
 * The production preview/export bundle entries are owned by packets 35/36; this
 * probe only proves that the adapter (and therefore the approved
 * `@dimforge/rapier2d-compat@0.20.0` distribution) is bundleable under the
 * pinned flags — `bundle`, `platform: browser`, `format: iife`,
 * `treeShaking: false`, `sourcemap: false`, `minify: false`, every other
 * option at its 0.28.2 default. The output is written outside the repository
 * (default `/tmp/tl31-bundle/`): only the measured size/digest is recorded.
 *
 * Browser execution, CSP interaction and static packaging remain UNVERIFIED in
 * this container (no browser) — the packet-37 procedure covers them.
 *
 * Usage (repository root):
 *   node fixtures/m2/physics/tools/build-probe-bundle.mjs [outDir]
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import esbuild from 'esbuild';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const OUT_DIR = process.argv[2] ?? '/tmp/tl31-bundle';

const ENTRY_SOURCE = `import { createPhysicsPort, PHYSICS_IMPLEMENTATION, RAPIER_PIN } from '@thirdlight/physics-rapier';

export const probe = {
  pin: RAPIER_PIN,
  implementation: PHYSICS_IMPLEMENTATION,
  create: () => createPhysicsPort({
    character: { x: 0, y: 0.9 },
    statics: [{ entityId: 'floor-0001', shape: { type: 'box', hx: 8, hy: 0.3 }, position: { x: 0, y: -0.3 }, rotationZ: 0 }],
    solver: { hz: 120, gravityY: -19.62 },
    controller: { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: 0.7853981633974483, minSlopeSlideRad: 0.5235987755982988, autostep: false },
  }),
};
`;

mkdirSync(OUT_DIR, { recursive: true });
// The generated entry lives inside the repository so Node-style resolution
// finds the workspace `node_modules` (the pinned option set adds no custom
// resolution options); it is disposable build input under the gitignored
// `dist/`.
const entryDir = join(REPO, 'dist', 'tl31-probe');
mkdirSync(entryDir, { recursive: true });
const entry = join(entryDir, 'probe-entry.ts');
writeFileSync(entry, ENTRY_SOURCE);
const outfile = join(OUT_DIR, 'probe-iife.js');

let result;
try {
  result = await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'browser',
    format: 'iife',
    treeShaking: false,
    sourcemap: false,
    minify: false,
    metafile: true,
  });
} finally {
  rmSync(entryDir, { recursive: true, force: true });
}

const bytes = statSync(outfile).size;
const digest = createHash('sha256').update(readFileSync(outfile)).digest('hex');
const modules = Object.keys(result.metafile.outputs[Object.keys(result.metafile.outputs)[0]].inputs);
const report = {
  packet: 31,
  entry: 'fixtures/m2/physics/tools/build-probe-bundle.mjs (generated probe entry)',
  options: {
    bundle: true,
    platform: 'browser',
    format: 'iife',
    treeShaking: false,
    sourcemap: false,
    minify: false,
    note: 'exact export.md §5.3 pinned set; every other option at the 0.28.2 default',
  },
  esbuild: esbuild.version,
  bytes,
  sha256: digest,
  importsRapier: modules.some((m) => m.includes('@dimforge/rapier2d-compat')),
  importsAdapter: modules.some((m) => m.includes('physics-rapier')),
  outfile,
  browserExecution: 'UNVERIFIED (no browser in this container; packet-37 procedure)',
};
console.log(JSON.stringify(report, null, 2));
if (!report.importsRapier || !report.importsAdapter) {
  console.error('build-probe-bundle: FAIL — the adapter/Rapier modules are not in the bundle graph');
  process.exit(1);
}
