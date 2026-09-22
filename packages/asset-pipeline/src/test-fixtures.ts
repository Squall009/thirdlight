/**
 * Test-only fixture access for the asset-pipeline suite (NOT part of the
 * package's public surface — not exported from index.ts, imported only by
 * `*.test.ts` files).
 *
 * `packages/asset-pipeline` is a pure leaf: no Node built-ins, no I/O
 * (dependencies.md §4.1/§4.3), enforced for test files too (the only exempted
 * test import is the approved runner `vitest`). The committed GLB fixtures are
 * therefore read as base64 text through the Vite `import.meta.glob(..., {
 * query: '?raw' })` transform and decoded here; `expected.json` records the
 * SHA-256 of the committed `.glb` file, and the fixture-index test asserts
 * that the decoded bytes hash to exactly that digest — so the tests run on the
 * real committed bytes, not on a rebuilt approximation.
 */

const RAW = import.meta.glob('../../../fixtures/m2/assets/*.json', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

const PREFIX = '../../../fixtures/m2/assets/';

function read(rel: string): string {
  const value = RAW[`${PREFIX}${rel}`];
  if (typeof value !== 'string') {
    throw new Error(
      `fixture index not found: ${rel} (matched ${Object.keys(RAW).length} file(s): ${Object.keys(RAW).join(', ')})`,
    );
  }
  return value;
}

export interface FixtureEntry {
  readonly file: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly purpose: string;
  readonly status: 'ok' | 'rejected';
  readonly codes: readonly string[];
  readonly limits: readonly string[];
  readonly paths: readonly string[];
  readonly metrics?: Record<string, number>;
  readonly recipeDigest: string;
  readonly metadataDigest: string;
}

export interface ExpectedIndex {
  readonly indexVersion: number;
  readonly job: {
    readonly proposalId: string;
    readonly stageId: string;
    readonly expiresAt: string;
    readonly suggestedDisplayName: string;
  };
  readonly entries: readonly FixtureEntry[];
}

/** The fixture index (canonical JSON, LF, one trailing newline). */
export function expectedIndex(): ExpectedIndex {
  return JSON.parse(read('expected.json')) as ExpectedIndex;
}

/** base64 sidecars of the committed `*.glb` fixtures (generated, not hand-edited). */
export function fixtureBase64(): Record<string, string> {
  const parsed = JSON.parse(read('bytes.base64.json')) as { files: Record<string, string> };
  return parsed.files;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Pure base64 decode (no `atob`, no Node built-ins; exact for the sidecars). */
export function base64ToBytes(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let offset = 0;
  for (const ch of clean) {
    const value = ALPHABET.indexOf(ch);
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[offset] = (buffer >> bits) & 0xff;
      offset += 1;
    }
  }
  return out.subarray(0, offset);
}

/** Exact bytes of one committed `fixtures/m2/assets/<name>` GLB fixture. */
export function fixtureBytes(name: string): Uint8Array {
  const files = fixtureBase64();
  const text = files[name];
  if (typeof text !== 'string') throw new Error(`fixture not found in bytes.base64.json: ${name}`);
  return base64ToBytes(text);
}

/** Raw text of one committed fixture-support file under `fixtures/m2/assets/`. */
export function fixtureText(rel: string): string {
  return read(rel);
}
