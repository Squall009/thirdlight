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
      const rebuilt = buildEnvelopeBytes(dirName, res.scene, res.records);
      expect(Array.from(rebuilt)).toEqual(Array.from(bytes));
    });
  }

  it('is deterministic (two rebuilds are equal)', () => {
    const bytes = new Uint8Array(readFileSync(join(VALID_DIR, 'demo-0001-rev5.json')));
    const res = validateEnvelope(bytes, 'demo-0001');
    if (res.ok !== true) throw new Error('fixture must load');
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
  'storage-version-unsupported.json': 'storage_version_unsupported',
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