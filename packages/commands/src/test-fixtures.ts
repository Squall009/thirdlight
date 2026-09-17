/**
 * Test-only fixture access for the commands test suite (NOT part of the
 * package's public surface — not exported from index.ts, imported only by
 * .test.ts files).
 *
 * Fixture files under `fixtures/commands/` are read through the Vite
 * `import.meta.glob` `?raw` transform (eager, raw text) because this
 * package's boundary rules forbid Node builtin imports in package sources
 * (dependencies.md §4.1/§5 check 1; the only exempted test import is
 * vitest). Every fixture file is valid UTF-8 (packet 02 verification),
 * so the raw text round-trips to the exact file bytes via `TextEncoder`.
 *
 * The fixtures are the packet 02 normative examples (commands.md §12):
 * self-contained scenarios with `disk-before`/`disk-after` envelopes and
 * `messages.json` request/result pairs. The scenario `out` payloads of
 * the pure pipeline steps are byte-pinned and are asserted verbatim.
 */

const RAW = import.meta.glob('../../../fixtures/commands/**', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

const PREFIX = '../../../fixtures/commands/';

/** Raw UTF-8 text of `fixtures/commands/<rel>`. */
export function fixtureText(rel: string): string {
  const key = `${PREFIX}${rel}`;
  const v = RAW[key];
  if (typeof v !== 'string') {
    throw new Error(
      `fixture not found: ${rel} (matched ${Object.keys(RAW).length} files; ` +
        `sample keys: ${Object.keys(RAW).slice(0, 3).join(', ')})`,
    );
  }
  return v;
}

/** Exact bytes of `fixtures/commands/<rel>` (UTF-8, BOM-free fixtures). */
export function fixtureBytes(rel: string): Uint8Array {
  return new TextEncoder().encode(fixtureText(rel));
}

/** Constant-time-free plain byte equality (no Buffer dependency). */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}