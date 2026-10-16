/**
 * The decal atlas as the editor reads it: the decal pages Play and the
 * export will use (the backend plans them from the project as its build
 * does: `GET …/content/decal-pages`), and, once composed (`POST`), each
 * decal material's place on them, which the Scene view then draws from, as
 * Play does.
 *
 * The composed arrays reach the view's texture loader as keys of their own
 * (`decalpages:<array id>`, never an asset id: ids hold no ':'), fetched from
 * the backend (`GET …/content/decal-pages/arrays/:id`).
 *
 * Pure (no DOM, no React).
 */
import type { DecalPageRef, DecalPageReport, MaterialDef } from '@thirdlight/project-model';

/** The backend's answer (backend `DecalAtlasView`). */
export interface DecalAtlasView {
  readonly report: DecalPageReport;
  /** What the pages are made of (a change: the composed pages are out of date). */
  readonly signature: string;
  /** The composed pages' places when they are of these very pages (null: not composed, or out of date). */
  readonly composed: DecalAtlasComposed | null;
}

export interface DecalAtlasComposed {
  readonly signature: string;
  readonly refs: Readonly<Record<string, DecalPageRef>>;
  readonly ms: number;
  readonly stats: { readonly asStored: number; readonly composed: number; readonly cached: number } | null;
  /** The pages at a preview size, while the pages themselves are composed. */
  readonly preview?: true;
}

const PREFIX = 'decalpages:';

/** The page arrays a composition's places name (each once). */
export function decalPageArrayIds(refs: Readonly<Record<string, DecalPageRef>>): string[] {
  const ids = new Set<string>();
  for (const r of Object.values(refs)) for (const set of ['albedo', 'normal', 'orm'] as const) if (r[set] !== undefined) ids.add(r[set].texture);
  return [...ids];
}

/** The view's texture key of a composed page array. */
export function decalPageTextureKey(arrayId: string): string {
  return PREFIX + arrayId;
}

/** A composed page array's id from its texture key (null: another key). */
export function parseDecalPageTextureKey(key: string): string | null {
  return key.startsWith(PREFIX) ? key.slice(PREFIX.length) : null;
}

/**
 * The materials as the Scene view draws them with composed pages: each decal
 * material with a place gets it (`decalPage`, arrays as texture keys), as a
 * build hands it to the runtime; the rest as they are. Null refs: unchanged.
 */
export function withDecalPageRefs<M extends MaterialDef>(materials: readonly M[], refs: Readonly<Record<string, DecalPageRef>> | null): readonly M[] {
  if (refs === null) return materials;
  return materials.map((m) => {
    const ref = refs[m.materialId];
    if (ref === undefined || m.shader !== 'decal') return m;
    const page: DecalPageRef = { rect: ref.rect, mip: ref.mip };
    for (const set of ['albedo', 'normal', 'orm'] as const) {
      const l = ref[set];
      if (l !== undefined) page[set] = { texture: decalPageTextureKey(l.texture), layer: l.layer };
    }
    return { ...m, decalPage: page };
  });
}

/** Bytes as the drawer shows them (MB of 10^6, as tools report GPU memory). */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} B`;
}

/** A share 0–1 as a whole percent. */
export const formatShare = (share: number): string => `${Math.round(share * 100)} %`;

/** What the drawer's warning says about the images that set the pages' size (null: none do). */
export function offenderText(report: DecalPageReport, nameOf: (materialId: string) => string): { title: string; detail: string } | null {
  const o = report.offender;
  if (o === null) return null;
  const names = o.materials.map(nameOf);
  const who = names.length <= 2 ? names.join(' and ') : `${names[0]} and ${names.length - 1} more`;
  const pages = (n: number, size: number): string => `${n} page${n === 1 ? '' : 's'} of ${size}²`;
  const saved = report.gpuBytes - o.gpuBytesHalved;
  const gain = o.sizeHalved < o.size ? `${pages(o.pagesHalved, o.sizeHalved)} instead of ${pages(report.pages.length, o.size)}${saved > 0 ? `, ${formatBytes(saved)} less` : ''}` : 'no smaller pages (other images need this size too)';
  return {
    title: `${who} (${o.source[0]} × ${o.source[1]}) ${names.length === 1 ? 'sets' : 'set'} every page to ${o.size}².`,
    detail: `Shrink to ${o.halved[0]} × ${o.halved[1]}: ${gain}.`,
  };
}

/** The decal materials whose image is the rectangle at page pixel (x, y) of page `page` (none: empty there). */
export function materialsAt(report: DecalPageReport, page: number, x: number, y: number): readonly string[] {
  const p = report.pages.find((q) => q.page === page);
  const r = p?.rects.find((q) => x >= q.rect[0] && y >= q.rect[1] && x < q.rect[0] + q.rect[2] && y < q.rect[1] + q.rect[3]);
  return r?.materials ?? [];
}
