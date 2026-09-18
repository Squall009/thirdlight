/**
 * Canonical JSON serialization (export.md §3 "canonical serialization,
 * project-model §12.2 style"): fixed key order (the object's own insertion
 * order — callers build documents in the normative field order), 2-space
 * indent, LF line endings, one trailing newline, no BOM.
 *
 * Used for `snapshot.json` (the runtime snapshot document: wrapper fields in
 * the runtime.md §2 order, then the normalized scene — which is already in
 * the project-model canonical field order) and `meta.json` (export.md §6
 * field order). Pure string processing: no I/O.
 */

/**
 * Serialize `value` canonically. Throws on values that cannot be JSON (the
 * exporter only serializes validated documents — a throw here is an internal
 * defect, caught by the pipeline and reported as a structured error).
 */
export function canonicalJson(value: unknown, indent = 0): string {
  const pad = '  '.repeat(indent);
  const inner = '  '.repeat(indent + 1);
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return jsonString(value);
    case 'number':
      if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number');
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      throw new Error('canonicalJson: bigint is not JSON');
    case 'undefined':
      throw new Error('canonicalJson: undefined is not JSON');
    default:
      break;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map((v) => inner + canonicalJson(v, indent + 1));
    return '[\n' + items.join(',\n') + '\n' + pad + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    const items = keys.map((k) => inner + jsonString(k) + ': ' + canonicalJson((value as Record<string, unknown>)[k], indent + 1));
    return '{\n' + items.join(',\n') + '\n' + pad + '}';
  }
  throw new Error('canonicalJson: unsupported value type ' + typeof value);
}

/** A JSON string literal (escapes per JSON semantics — no raw control chars). */
function jsonString(s: string): string {
  return JSON.stringify(s);
}

/**
 * The full canonical document bytes: 2-space-indented JSON with LF endings
 * and exactly one trailing newline, UTF-8, no BOM.
 */
export function canonicalDocument(value: unknown): Uint8Array {
  const text = canonicalJson(value, 0) + '\n';
  return new TextEncoder().encode(text);
}