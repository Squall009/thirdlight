/**
 * Packet-33 cold-build harness (NOT a vitest test): bundled by
 * `tests/integration/m2-builds/cold-build.test.ts` with the packet-13 deployed
 * backend arrangement (`platform: 'node'`, `packages: 'bundle'`,
 * `external: ['esbuild']`, the `createRequire` banner) and executed in fresh
 * Node processes.
 *
 * Usage: node harness.mjs <container-path> <declaration-json-path>
 *        node harness.mjs sentinel
 *
 * It prints one JSON line with the digests of a real compile. It never
 * evaluates, imports or runs the project source; `sentinel` mode proves that in
 * the deployed arrangement too.
 */
import { readFileSync } from 'node:fs';
import process from 'node:process';

import { M2_PINNED_MODULES, compileBehavior } from '../../packages/behavior-build/src/index';

async function main(): Promise<number> {
  const [arg1, arg2] = process.argv.slice(2);
  if (arg1 === 'sentinel') {
    const sentinel = '__thirdlight_cold_sentinel_executed__';
    (globalThis as Record<string, unknown>)[sentinel] = undefined;
    const container = {
      graphVersion: 1,
      entryPath: 'src/index.ts',
      requiredModules: [],
      ownedTransforms: [],
      files: [
        {
          path: 'src/index.ts',
          text: `globalThis.${sentinel} = true;\nthrow new Error('must not run');\nexport default { step() {} };\n`,
        },
      ],
    };
    const result = await compileBehavior({
      behaviorId: 'behavior-0100',
      declaration: { properties: [{ key: 'speed', label: 'Speed', type: 'number', default: 3.5 }] } as never,
      containerBytes: new TextEncoder().encode(`${JSON.stringify(container, null, 2)}\n`),
      pinnedModules: M2_PINNED_MODULES,
      limits: { timeoutMs: 30_000 },
    });
    const executed = (globalThis as Record<string, unknown>)[sentinel] === true;
    process.stdout.write(`${JSON.stringify({ sentinel: true, ok: result.ok, executed })}\n`);
    return executed || !result.ok ? 3 : 0;
  }
  if (arg1 === undefined || arg2 === undefined) {
    process.stderr.write('usage: harness.mjs <container-path> <declaration-path>\n');
    return 2;
  }
  const containerBytes = new Uint8Array(readFileSync(arg1));
  const declaration = JSON.parse(readFileSync(arg2, 'utf8')) as { properties: readonly unknown[] };
  const start = Date.now();
  const result = await compileBehavior({
    behaviorId: 'behavior-0100',
    declaration: declaration as never,
    containerBytes,
    pinnedModules: M2_PINNED_MODULES,
    limits: { timeoutMs: 30_000 },
  });
  const elapsedMs = Date.now() - start;
  if (!result.ok) {
    process.stdout.write(`${JSON.stringify({ ok: false, code: result.code, reason: result.reason, elapsedMs })}\n`);
    return 1;
  }
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      outputDigest: result.outputDigest,
      manifestDigest: result.manifestDigest,
      recipeDigest: result.recipeDigest,
      outputByteLength: result.outputBytes.length,
      elapsedMs,
    })}\n`,
  );
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    process.stderr.write(`harness crash: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 4;
  },
);
