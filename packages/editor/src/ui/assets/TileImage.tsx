/**
 * An asset's picture on a tile: its thumbnail from the import cache, read
 * while the tile is on screen (the kind's icon until then, or when there is
 * none). Drawing it never reads the asset's own bytes (viewport/thumbnails.ts).
 *
 * Browser-only (React).
 */
import { useEffect, useState, type JSX } from 'react';

import type { AssetView } from '../../session/content-projection';
import type { TileRef, TileThumbnails } from '../../viewport/thumbnails';
import { kindIcon } from '../../session/item-icons';

/** The picture URL of an asset version (and piece) while the caller is on screen (null: none yet). */
export function useTileUrl(summary: AssetView | undefined, piece: string | null, thumbnails: TileThumbnails | null): string | null {
  return useTile(summary, piece, thumbnails).url;
}

/** The picture URL and whether it is still being read or made. */
function useTile(summary: AssetView | undefined, piece: string | null, thumbnails: TileThumbnails | null): { url: string | null; pending: boolean } {
  const [url, setUrl] = useState<string | null>(null);
  const [done, setDone] = useState('');
  const v = summary?.versions?.find((x) => x.version === summary.currentVersion);
  const ref: TileRef | null = summary !== undefined && v !== undefined ? { assetId: summary.assetId, kind: summary.kind, version: summary.currentVersion, digest: v.sourceDigest, piece } : null;
  const key = ref === null ? '' : `${ref.digest}|${ref.piece ?? ''}`;
  useEffect(() => {
    setUrl(null);
    if (ref === null || thumbnails === null) return;
    let live = true;
    void thumbnails.url(ref).then((u) => {
      if (!live) return;
      setUrl(u);
      setDone(key);
    });
    const release = thumbnails.hold(ref);
    return () => {
      live = false;
      release();
    };
    // The key stands for the asset version and piece the picture shows.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `ref` is rebuilt each draw; `key` names what it points at
  }, [key, thumbnails]);
  return { url, pending: summary === undefined || (ref !== null && thumbnails !== null && done !== key) };
}

export function TileImage(p: { summary: AssetView | undefined; kind: string; piece: string | null; thumbnails: TileThumbnails | null }): JSX.Element {
  const { url, pending } = useTile(p.summary, p.piece, p.thumbnails);
  const icon = kindIcon(p.kind) ?? kindIcon('model')!;
  // `data-thumb`: pending while the picture is read or made (tests wait for the tiles in view to settle).
  return <img className={url !== null ? 'tl-tile__img tl-tile__img--thumb' : 'tl-tile__img'} src={url ?? icon} alt="" draggable={false} data-thumb={pending ? 'pending' : url !== null ? 'ready' : 'none'} />;
}
