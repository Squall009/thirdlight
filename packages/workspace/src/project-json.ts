/** The layout every project file is written in. */

/**
 * The project-file layout — objects indented (two spaces), and
 * every array of objects with one element per line (an entity, a material, a
 * retry record: a diff shows one line per changed item). About a third of
 * the fully indented size, so an edit writes (and hashes) far fewer bytes.
 * Any JSON reader reads it; the files stay strict JSON.
 */
export function layoutProjectJson(value: unknown, indent = ''): string {
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every((v) => v !== null && typeof v === 'object')) {
      const inner = `${indent}  `;
      return `[\n${value.map((v) => `${inner}${JSON.stringify(v)}`).join(',\n')}\n${indent}]`;
    }
    return JSON.stringify(value);
  }
  if (value !== null && typeof value === 'object') {
    const inner = `${indent}  `;
    const parts: string[] = [];
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined || typeof v === 'function') continue;
      parts.push(`${inner}${JSON.stringify(k)}: ${layoutProjectJson(v, inner)}`);
    }
    return parts.length === 0 ? '{}' : `{\n${parts.join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

