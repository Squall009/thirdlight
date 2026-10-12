/**
 * A texture set by its names: material libraries and texture tools ship one
 * surface as several files named alike ("rock_albedo", "rock_normal",
 * "rock_orm"), so when a layer is given its colour texture the palette looks
 * for the other maps by the same stem and fills their slots too.
 *
 * A name is split at `_`, `-`, `.`, spaces and camel-case humps; its last
 * word (or two, "base color") names the map it holds. The stem is what comes
 * before. Matching is on the stem and the role, never on a guess at a
 * similar stem.
 *
 * Pure.
 */

/** The maps a layered material's layer takes (the template's three arrays). */
export type TextureRole = 'albedo' | 'normals' | 'orm';

/** The words that name each map, as texture tools write them (lower case, separators gone). */
const ROLE_WORDS: Readonly<Record<TextureRole, readonly string[]>> = Object.freeze({
  albedo: ['albedo', 'basecolor', 'basecolour', 'base', 'color', 'colour', 'col', 'diffuse', 'diff', 'albedoheight', 'albedoh'],
  normals: ['normal', 'normals', 'normalgl', 'nrm', 'nor', 'norm', 'norgl', 'n'],
  orm: ['orm', 'arm', 'occlusionroughnessmetallic', 'occlusionroughnessmetalness', 'packed', 'mask', 'rma'],
});

/** A name's words in lower case (camel humps split; a file extension dropped). */
function words(name: string): string[] {
  const bare = name.replace(/\.(png|jpe?g|webp|ktx2|tga|exr|hdr|tiff?|bmp)$/i, '');
  return bare
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_.\-]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w !== '');
}

/** A name split into its stem and the map it names (null: its last words name no map). */
export function textureRoleOf(name: string): { stem: string; role: TextureRole } | null {
  const w = words(name);
  if (w.length < 2) return null;
  // "base color", "normal gl": two words naming one map.
  for (const take of [2, 1]) {
    if (w.length <= take) continue;
    const tail = w.slice(-take).join('');
    for (const role of ['albedo', 'normals', 'orm'] as const) {
      if (ROLE_WORDS[role].includes(tail)) return { stem: w.slice(0, -take).join(' '), role };
    }
  }
  return null;
}

/** The texture of another map of the same set: the first named with the albedo's stem and that role. */
export function matchingTexture(albedoName: string, role: Exclude<TextureRole, 'albedo'>, candidates: readonly { id: string; name: string }[]): string | null {
  const a = textureRoleOf(albedoName);
  if (a === null || a.role !== 'albedo') return null;
  for (const c of candidates) {
    const r = textureRoleOf(c.name);
    if (r !== null && r.role === role && r.stem === a.stem) return c.id;
  }
  return null;
}

/** The text to search the project for a set's other maps (the albedo's stem; null: its name names no colour map). */
export function textureSetQuery(albedoName: string): string | null {
  const a = textureRoleOf(albedoName);
  return a !== null && a.role === 'albedo' ? a.stem : null;
}
