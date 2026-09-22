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
// ---- packet 21: M2 command fixtures (fixtures/m2/**) ------------------------------

const M2_RAW = import.meta.glob('../../../fixtures/m2/**', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

const M2_PREFIX = '../../../fixtures/m2/';

/** Raw UTF-8 text of `fixtures/m2/<rel>`. */
export function m2FixtureText(rel: string): string {
  const key = `${M2_PREFIX}${rel}`;
  const v = M2_RAW[key];
  if (typeof v !== 'string') {
    throw new Error(
      `fixture not found: ${rel} (matched ${Object.keys(M2_RAW).length} files)`,
    );
  }
  return v;
}

/** Parsed JSON value of `fixtures/m2/<rel>`. */
export function m2FixtureJson<T = unknown>(rel: string): T {
  return JSON.parse(m2FixtureText(rel)) as T;
}

// ---- packet 45: M3 v3 contract fixtures (fixtures/m3/contracts/**) ---------------

const M3_CONTRACT_RAW = import.meta.glob('../../../fixtures/m3/contracts/**', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

const M3_CONTRACT_PREFIX = '../../../fixtures/m3/contracts/';

/** Raw UTF-8 text of `fixtures/m3/contracts/<rel>`. */
export function m3ContractText(rel: string): string {
  const key = `${M3_CONTRACT_PREFIX}${rel}`;
  const v = M3_CONTRACT_RAW[key];
  if (typeof v !== 'string') {
    throw new Error(`fixture not found: ${rel} (matched ${Object.keys(M3_CONTRACT_RAW).length} files)`);
  }
  return v;
}

/** Parsed JSON value of `fixtures/m3/contracts/<rel>`. */
export function m3ContractJson<T = unknown>(rel: string): T {
  return JSON.parse(m3ContractText(rel)) as T;
}
