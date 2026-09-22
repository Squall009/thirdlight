/**
 * Test-only fixture access for the project-model test suite (NOT part of
 * the package's public surface — not exported from index.ts, imported only
 * by .test.ts files).
 *
 * Fixture files are read through the Vite `import.meta.glob` `?raw`
 * transform (eager, raw text) because this package's boundary rules forbid
 * Node builtin imports in package sources (dependencies.md §4.1/§5 check
 * 1; the only exempted test import is vitest). Every fixture file under
 * `fixtures/project-model/` is valid UTF-8 (packet 01 verification), so
 * `TextEncoder` round-trips the text to the exact file bytes; the raw
 * text is what the strict byte parser is designed to consume.
 */

const RAW = import.meta.glob('../../../fixtures/project-model/**', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

const RAW_M2_MODEL = import.meta.glob('../../../fixtures/m2/model/**', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

const RAW_M3_CONTRACTS = import.meta.glob('../../../fixtures/m3/contracts/**/*.json', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

const PREFIX = '../../../fixtures/project-model/';
const PREFIX_M2_MODEL = '../../../fixtures/m2/model/';
const PREFIX_M3_CONTRACTS = '../../../fixtures/m3/contracts/';

function readGlob(glob: Record<string, string>, prefix: string, rel: string, label: string): string {
  const key = `${prefix}${rel}`;
  const v = glob[key];
  if (typeof v !== 'string') {
    throw new Error(
      `${label} fixture not found: ${rel} (matched ${Object.keys(glob).length} files; ` +
        `sample keys: ${Object.keys(glob).slice(0, 3).join(', ')})`,
    );
  }
  return v;
}

/** Raw UTF-8 text of `fixtures/project-model/<rel>`. */
export function fixtureText(rel: string): string {
  return readGlob(RAW, PREFIX, rel, 'project-model');
}

/**\n * Raw UTF-8 text of `fixtures/m2/model/<rel>` (packet 20 M2 model fixtures).\n */
export function m2ModelFixtureText(rel: string): string {
  return readGlob(RAW_M2_MODEL, PREFIX_M2_MODEL, rel, 'm2/model');
}

/** Exact bytes of `fixtures/m2/model/<rel>`. */
export function m2ModelFixtureBytes(rel: string): Uint8Array {
  return new TextEncoder().encode(m2ModelFixtureText(rel));
}

/** Exact bytes of `fixtures/project-model/<rel>` (UTF-8, BOM-free fixtures). */
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

/** UTF-8 decode helper (fatal: the test inputs are valid UTF-8). */
export function decodeUtf8(b: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(b);
}

/** Raw UTF-8 text of `fixtures/m3/contracts/<rel>` (packet-44 contract fixtures). */
export function m3ContractFixtureText(rel: string): string {
  return readGlob(RAW_M3_CONTRACTS, PREFIX_M3_CONTRACTS, rel, 'm3/contracts');
}

/** Exact bytes of `fixtures/m3/contracts/<rel>` (canonical JSON fixtures). */
export function m3ContractFixtureBytes(rel: string): Uint8Array {
  return new TextEncoder().encode(m3ContractFixtureText(rel));
}

/** Every `fixtures/m3/contracts/**` JSON file, as repository-relative paths. */
export function m3ContractFixtureKeys(): string[] {
  return Object.keys(RAW_M3_CONTRACTS)
    .map((k) => (k.startsWith(PREFIX_M3_CONTRACTS) ? k.slice(PREFIX_M3_CONTRACTS.length) : k))
    .sort();
}