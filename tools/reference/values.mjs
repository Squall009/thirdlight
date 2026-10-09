/**
 * The engine's own values (the descriptor registry, the graph catalogues,
 * the op list, the limits) for the reference generator, read by importing
 * the packages' public entry points — never by copying a number.
 *
 * The packages are TypeScript sources, so they are bundled once with the
 * pinned esbuild into a scratch module under node_modules/.cache (third-party
 * imports stay external and resolve from the workspace) and imported from
 * there.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import esbuild from 'esbuild';

/** The packages whose public exports the reference reads (limits are gathered from these). */
export const VALUE_PACKAGES = ['project-model', 'commands', 'runtime', 'protocol', 'behavior-build', 'asset-pipeline', 'game-host'];

/**
 * Single modules read beside the packages' entry points (not searched for
 * limits): the workspace's scene routing names the argument it reads before
 * the validator.
 */
export const VALUE_MODULES = { 'workspace/scene-routing': 'workspaceSceneRouting' };

const ident = (pkg) => pkg.replace(/-(.)/g, (_, c) => c.toUpperCase());

/** Package name → its module namespace. */
export async function loadValues(root) {
  const dir = join(root, 'node_modules', '.cache', 'gen-reference');
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `values-${process.pid}.mjs`);
  const contents = [
    ...VALUE_PACKAGES.map((p) => `export * as ${ident(p)} from '@thirdlight/${p}';`),
    ...Object.entries(VALUE_MODULES).map(([spec, name]) => `export * as ${name} from '@thirdlight/${spec}';`),
  ].join('\n');
  await esbuild.build({
    stdin: { contents, resolveDir: root, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: out,
    logLevel: 'error',
    plugins: [
      {
        name: 'workspace-only',
        setup(build) {
          build.onResolve({ filter: /^[^./]/ }, (args) => (args.path.startsWith('@thirdlight/') ? undefined : { external: true }));
        },
      },
    ],
  });
  try {
    const mod = await import(pathToFileURL(out).href);
    return Object.fromEntries([...VALUE_PACKAGES.map((p) => [p, mod[ident(p)]]), ...Object.entries(VALUE_MODULES).map(([spec, name]) => [spec, mod[name]])]);
  } finally {
    rmSync(out, { force: true });
  }
}
