/**
 * The editor's icon registry covers every kind the project index lists (the
 * asset kinds, the resource kinds, scenes), folders, visual scripts, every
 * document kind of the editor window and every toolbar action, and each
 * picture it names is a WebP shipped with the editor page.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { ASSET_KINDS, RESOURCE_KIND_TABLE } from '@thirdlight/project-model/limits';

import { actionIcon, ICON_KINDS, kindIcon, TOOL_ACTIONS } from '../packages/editor/src/session/item-icons';
import { PROJECT_KINDS } from '../packages/editor/src/session/project-search';
import { iconKindOfDocument, ITEM_KIND_OF_DOCUMENT } from '../packages/editor/src/session/project-items';

const PUBLIC = resolve(import.meta.dirname, '..', 'packages', 'editor', 'public');

/** The file a registry URL names, and whether it is a WebP (RIFF....WEBP). */
function shipped(url: string): { path: string; webp: boolean } {
  const path = join(PUBLIC, url.replace(/^\.\//, ''));
  if (!existsSync(path)) return { path, webp: false };
  const b = readFileSync(path);
  return { path, webp: b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' };
}

describe('the icon registry', () => {
  it('has a picture for every asset kind, resource kind and scenes, and each is a shipped WebP', () => {
    const kinds = [...ASSET_KINDS, ...RESOURCE_KIND_TABLE.map((k) => k.kind), 'scene', 'folder', 'visual-script'];
    for (const kind of kinds) {
      const url = kindIcon(kind);
      expect(url, kind).toBeDefined();
      expect(shipped(url!), kind).toEqual({ path: expect.any(String), webp: true });
    }
    // The index's kind list is the registry's: a kind added there without a picture fails here.
    for (const kind of PROJECT_KINDS) expect(ICON_KINDS).toContain(kind);
  });

  it('has a picture for every document kind the editor window opens', () => {
    for (const doc of [...Object.keys(ITEM_KIND_OF_DOCUMENT)]) {
      const url = kindIcon(iconKindOfDocument(doc));
      expect(url, doc).toBeDefined();
      expect(shipped(url!).webp, doc).toBe(true);
    }
    expect(iconKindOfDocument('visual-script')).toBe('visual-script');
    expect(iconKindOfDocument('script')).toBe('behavior');
  });

  it('has a shipped picture for every toolbar action', () => {
    for (const a of TOOL_ACTIONS) expect(shipped(actionIcon(a)).webp, a).toBe(true);
  });

  it('knows no picture for a kind it does not list', () => {
    expect(kindIcon('not-a-kind')).toBeUndefined();
  });
});
