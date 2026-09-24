/**
 * Envelope canonicalization + strict load validation (workspace.md §4).
 *
 * The valid fixtures are byte-for-byte references: rebuilding the envelope
 * from its parsed+normalized scene and records must reproduce the exact
 * fixture bytes. The invalid fixtures pin one load-failure reason each.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildEnvelopeBytes, validateEnvelope } from '../src/envelope';
import { FIXTURES } from './helpers';

const VALID_DIR = join(FIXTURES, 'envelope', 'valid');
const INVALID_DIR = join(FIXTURES, 'envelope', 'invalid');

function envelopeProjectIdOf(name: string): string {
  const raw = JSON.parse(readFileSync(join(VALID_DIR, name), 'utf8')) as { projectId: string };
  return raw['projectId'];
}

describe('envelope canonical bytes (workspace.md §4.4)', () => {
  for (const name of readdirSync(VALID_DIR).sort()) {
    if (!name.endsWith('.json') || name.includes('manifest')) continue;
    it(`rebuilds ${name} byte-identically`, () => {
      const bytes = new Uint8Array(readFileSync(join(VALID_DIR, name)));
      const dirName = envelopeProjectIdOf(name);
      const res = validateEnvelope(bytes, dirName);
      expect(res.ok, `fixture ${name} should load: ${JSON.stringify(res).slice(0, 400)}`).toBe(true);
      if (res.ok !== true) return;
      // The M1 fixture tree is storageVersion 1 by construction (the v2
      // envelopes live in fixtures/m2/contracts/envelope).
      if (res.storageVersion !== 1) throw new Error(`M1 fixture ${name} must be storageVersion 1`);
      const rebuilt = buildEnvelopeBytes(dirName, res.scene, res.records);
      expect(Array.from(rebuilt)).toEqual(Array.from(bytes));
    });
  }

  it('is deterministic (two rebuilds are equal)', () => {
    const bytes = new Uint8Array(readFileSync(join(VALID_DIR, 'demo-0001-rev5.json')));
    const res = validateEnvelope(bytes, 'demo-0001');
    if (res.ok !== true || res.storageVersion !== 1) throw new Error('fixture must load as v1');
    const a = buildEnvelopeBytes('demo-0001', res.scene, res.records);
    const b = buildEnvelopeBytes('demo-0001', res.scene, res.records);
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});

const INVALID_REASONS: Record<string, string> = {
  'duplicate-key.json': 'duplicate_key',
  'embedded-scene-invalid.json': 'scene_invalid',
  'project-mismatch.json': 'envelope_project_mismatch',
  'retry-records-non-ascending.json': 'retry_records_invalid',
  // M2 (workspace.md §4.3 step 3/6a): storageVersion 2 is now KNOWN, so this
  // M1-era fixture (storageVersion 2, scene schemaVersion 1, no content) is
  // no longer `storage_version_unsupported` — it enters the v2 branch and its
  // missing `content` key fails the step-6a key-set check (`envelope_invalid`
  // with `field_missing`). The fixture bytes are unchanged; the M2 semantics
  // for an UNKNOWN version are pinned in the packet-23 tests
  // (`storageVersion: 3` ⇒ `storage_version_unsupported`).
  'storage-version-unsupported.json': 'envelope_invalid',
  'type-missing.json': 'envelope_invalid',
};

describe('envelope strict load failures (§4.3)', () => {
  for (const [name, reason] of Object.entries(INVALID_REASONS)) {
    it(`${name} ⇒ ${reason}`, () => {
      const bytes = new Uint8Array(readFileSync(join(INVALID_DIR, name)));
      const res = validateEnvelope(bytes, 'demo-0001');
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.reason).toBe(reason);
      expect(res.count).toBeGreaterThanOrEqual(1);
      expect(res.errors[0].code).toBeTypeOf('string');
      expect(res.errors[0].path).toBeTypeOf('string');
      expect(res.errors[0].message).toBeTypeOf('string');
    });
  }
});