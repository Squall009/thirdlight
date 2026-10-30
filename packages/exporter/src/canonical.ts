/**
 * Canonical document bytes (export.md): fixed key order (the object's own
 * insertion order — callers build documents in the normative field order),
 * 2-space indent, LF line endings, one trailing newline, no BOM.
 *
 * Used for `snapshot.json` (the runtime snapshot document: wrapper fields in
 * the runtime.md order, then the normalized scene — which is already in
 * the project-model canonical field order) and `meta.json` (export.md field
 * order). Pure string processing: no I/O.
 */
import { indentedJsonText } from '@thirdlight/shared';

/**
 * The full canonical document bytes: 2-space-indented JSON with LF endings
 * and exactly one trailing newline, UTF-8, no BOM. Throws on values that
 * cannot be JSON (the exporter only serializes validated documents — a throw
 * here is an internal defect, reported as a structured error).
 */
export function canonicalDocument(value: unknown): Uint8Array {
  return new TextEncoder().encode(indentedJsonText(value, 0) + '\n');
}
