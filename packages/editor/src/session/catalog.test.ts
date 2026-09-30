/**
 * The catalog reads what the editor needs by id: the ids asked for in one
 * task go out together, a page at a time; an id being read is not asked for
 * twice; an id that names nothing is remembered until the index changes; and
 * the index version goes up for any change but an edit of scene objects.
 */
import type { AssetSummary } from '@thirdlight/commands';
import { ASSET_QUERY_PAGE_MAX } from '@thirdlight/project-model/limits';
import { describe, expect, it } from 'vitest';

import { Catalog } from './catalog';
import { ContentProjection } from './content-projection';
import { PrefabProjection } from './prefab-projection';

const summary = (id: string): AssetSummary => ({ assetId: id, kind: 'model', displayName: id, currentVersion: 1, versionCount: 1, versions: [{ version: 1, sourceDigest: 'a'.repeat(64), sourceByteLength: 1 }] });

function catalogOver(known: ReadonlySet<string>): { catalog: Catalog; calls: { op: string; args: Record<string, unknown> }[]; content: ContentProjection } {
  const calls: { op: string; args: Record<string, unknown> }[] = [];
  const content = new ContentProjection();
  const catalog = new Catalog(
    async (op, args) => {
      calls.push({ op, args });
      if (op === 'queryAssets') {
        const ids = args['ids'] as string[];
        return { ok: true, assets: ids.filter((id) => known.has(id)).map(summary), missing: ids.filter((id) => !known.has(id)) };
      }
      if (op === 'queryIndex') return { ok: true, total: 1, entries: [{ kind: 'model', id: 'first', path: null, name: 'First', labels: [] }] };
      return { ok: false };
    },
    { assets: content, prefabs: new PrefabProjection(), resources: { has: () => false, put: () => undefined } },
  );
  return { catalog, calls, content };
}

describe('the catalog', () => {
  it('reads the ids asked for in one task together, a page at a time, each once', async () => {
    const ids = Array.from({ length: ASSET_QUERY_PAGE_MAX + 10 }, (_, i) => `a${i}`);
    const { catalog, calls, content } = catalogOver(new Set(ids));
    let arrivals = 0;
    catalog.subscribe(() => (arrivals += 1));
    const first = catalog.ensureAssets(ids.slice(0, 100));
    const second = catalog.ensureAssets(ids.slice(50));
    await Promise.all([first, second]);
    expect(calls.map((c) => (c.args['ids'] as string[]).length)).toEqual([ASSET_QUERY_PAGE_MAX, 10]);
    expect(content.has('a0') && content.has(`a${ASSET_QUERY_PAGE_MAX + 9}`)).toBe(true);
    expect(arrivals).toBe(1);
    // Held already: nothing is read again.
    await catalog.ensureAssets(['a1', 'a2']);
    expect(calls).toHaveLength(2);
  });

  it('remembers an id that names nothing until the index changes', async () => {
    const { catalog, calls } = catalogOver(new Set());
    await catalog.ensureAssets(['gone']);
    expect(catalog.assetAbsent('gone')).toBe(true);
    await catalog.ensureAssets(['gone']);
    expect(calls).toHaveLength(1);
    // An edit of scene objects leaves the index as it was; a content change does not.
    const v = catalog.version;
    catalog.changed('setTransform');
    expect(catalog.version).toBe(v);
    catalog.changed('publishAsset');
    expect(catalog.version).toBe(v + 1);
    expect(catalog.assetAbsent('gone')).toBe(false);
  });

  it('answers the first entry of some kinds once it has read it', async () => {
    const { catalog } = catalogOver(new Set());
    expect(catalog.firstOf(['model'])).toBeUndefined();
    await new Promise((r) => setTimeout(r, 0));
    expect(catalog.firstOf(['model'])).toBe('first');
  });
});
