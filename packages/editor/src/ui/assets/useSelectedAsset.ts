/**
 * The asset chosen in the Assets tab: its summary (read by id), and for a
 * model file what only loading it tells — its pieces (a file of several
 * expands into piece tiles) and its material names (the default materials
 * editor). A model is loaded when it is selected, never to draw its tile.
 *
 * Browser-only (React).
 */
import { useEffect, useState, type RefObject } from 'react';

import type { AssetView } from '../../session/content-projection';
import type { SessionClient } from '../../session/client';
import type { ModelInstances } from '../../viewport/model-instances';

export interface SelectedAsset {
  readonly summary: AssetView | null;
  /** The selected model's pieces (null: not a model, or not loaded yet). */
  readonly pieces: { assetId: string; list: readonly { name: string }[] } | null;
  /** The selected model file's own material names. */
  readonly sourceMaterials: string[];
}

export function useSelectedAsset(clientRef: RefObject<SessionClient | null>, modelsRef: RefObject<ModelInstances | null>, assetId: string | null, catalogTick: number): SelectedAsset {
  const [pieces, setPieces] = useState<SelectedAsset['pieces']>(null);
  const [sourceMaterials, setSourceMaterials] = useState<string[]>([]);
  const c = clientRef.current;
  const summary = assetId !== null ? (c?.content.getAsset(assetId) ?? null) : null;
  // Read its summary when it is chosen (a tile on screen has read it already; an id from elsewhere may not).
  useEffect(() => {
    if (assetId !== null) void clientRef.current?.catalog.ensureAssets([assetId]);
  }, [assetId, catalogTick, clientRef]);
  const kind = summary?.kind ?? null;
  const version = summary?.currentVersion ?? null;
  useEffect(() => {
    const models = modelsRef.current;
    if (assetId === null || kind !== 'model' || models === null) {
      setPieces(null);
      setSourceMaterials([]);
      return;
    }
    let live = true;
    void models.prepared(assetId).then((r) => {
      if (!live) return;
      setPieces(r === null ? null : { assetId, list: r.pieces().map((pc) => ({ name: pc.name })) });
      setSourceMaterials(r === null ? [] : r.materialNames(null));
    });
    return () => {
      live = false;
    };
  }, [assetId, kind, version, modelsRef]);
  return { summary, pieces, sourceMaterials };
}
