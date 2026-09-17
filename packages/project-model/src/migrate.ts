/**
 * Migration entry points — project-model.md §12.4.
 *
 * M1 ships NO migrations. `migrate*(doc, target)` is an identity operation
 * when the document's `schemaVersion` equals `target` (and both equal 1);
 * any other pair returns the structured `no_migration_path` result
 * (from-version, to-version, action). A document that fails migration is
 * retained byte-for-byte by the caller — no destructive rewrite, ever
 * (§12.4 rule 3, charter §6).
 *
 * Migration is a pure version operation on parsed documents: it performs
 * no field-level validation (that is `validate*`'s job) and never mutates
 * the input.
 */

import type { ModelError, ModelResult } from './errors';
import type { Manifest, Scene } from './types';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fromVersion(doc: unknown): number | null {
  return isPlainObject(doc) && typeof doc['schemaVersion'] === 'number'
    ? (doc['schemaVersion'] as number)
    : null;
}

function migrate(doc: unknown, target: number): ModelResult<unknown> {
  const from = fromVersion(doc);
  if (from === 1 && target === 1) {
    // Identity operation: the document is returned unchanged.
    return { ok: true, normalized: doc };
  }
  const fromDesc = from === null ? 'a document without a recognized schemaVersion' : `schema version ${from}`;
  const error: ModelError = {
    code: 'no_migration_path',
    path: '/schemaVersion',
    message: `no migration path from ${fromDesc} to version ${target} (M1 ships no migrations)`,
    found: from,
    expected: `schemaVersion ${target}`,
    hint: 'open the document in an engine that knows its format, or convert it manually; the original document is retained',
  };
  return { ok: false, errors: [error] };
}

/** §12.4: manifest migration entry point (M1: identity at 1 → 1 only). */
export function migrateManifest(doc: unknown, target: number): ModelResult<Manifest> {
  return migrate(doc, target) as ModelResult<Manifest>;
}

/** §12.4: scene migration entry point (M1: identity at 1 → 1 only). */
export function migrateScene(doc: unknown, target: number): ModelResult<Scene> {
  return migrate(doc, target) as ModelResult<Scene>;
}