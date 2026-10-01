/**
 * The Assets tab's actions on the chosen asset: place it where the camera
 * looks, drop a model (or one piece) into the scene or the hierarchy, delete
 * it, and read the index again.
 */
import { useCallback, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { planAssetPlacement, planModelDrop, type AssetDragPayload, type PieceFacts } from '../../session/placement';
import { refusal, type ClientRef, type ModelsRef, type ReportFailure, type UiError, type ViewportRef } from './commands';

export interface AssetActionsDeps {
  clientRef: ClientRef;
  viewportRef: ViewportRef;
  modelInstancesRef: ModelsRef;
  selectedAssetId: string | null;
  selectedAssetIdRef: MutableRefObject<string | null>;
  setSelectedAssetId: Dispatch<SetStateAction<string | null>>;
  setSelectedId: (id: string | null) => void;
  runTypedCommand: (op: string, args: unknown, onError: (e: UiError) => void, withDetail?: boolean) => Promise<boolean>;
  reportFailure: ReportFailure;
}

export function useAssetActions(deps: AssetActionsDeps) {
  const { clientRef, viewportRef, modelInstancesRef, selectedAssetId, selectedAssetIdRef, setSelectedAssetId, setSelectedId, runTypedCommand, reportFailure } = deps;
  // Why the last asset delete was refused.
  const [assetDeleteError, setAssetDeleteError] = useState<string | null>(null);
  const [placementError, setPlacementError] = useState<UiError | null>(null);
  const placement = selectedAssetId !== null ? planAssetPlacement(selectedAssetId) : null;

  const placeAsset = useCallback(async () => {
    const c = clientRef.current;
    const assetId = selectedAssetIdRef.current;
    if (!c || !assetId) return;
    // Named after the asset and placed where the camera is looking.
    const displayName = c.content.getAsset(assetId)?.displayName;
    const focus = viewportRef.current?.focusPoint() ?? [0, 0, 0];
    const command = planAssetPlacement(assetId, {
      ...(displayName !== undefined ? { name: displayName.slice(0, 128) } : {}),
      transform: { position: focus.map((v) => Math.round(v * 4) / 4) },
    });
    setPlacementError(null);
    await runTypedCommand('createEntity', command.args, setPlacementError);
  }, [clientRef, runTypedCommand, selectedAssetIdRef, viewportRef]);

  /**
   * Drop a model (or one piece) from the asset tiles: one createEntity — a
   * piece, a whole single-piece file, or a folder holding every piece of a
   * multi-piece file laid out in a row. `_COL` nodes become 2D colliders.
   */
  const dropAsset = useCallback(
    async (payload: AssetDragPayload, position: [number, number, number], parentId: string | null) => {
      const c = clientRef.current;
      const models = modelInstancesRef.current;
      if (!c || !models) return;
      const asset = c.content.getAsset(payload.assetId);
      if (asset === undefined || asset.kind !== 'model') return;
      setSelectedAssetId(payload.assetId);
      const resource = await models.prepared(payload.assetId);
      if (resource === null) {
        setPlacementError({ code: 'asset_unavailable', message: `${asset.displayName} could not be loaded` });
        return;
      }
      const box = (piece: string | null): PieceFacts['bounds'] => {
        const b = resource.bounds(piece);
        return b.isEmpty() ? null : { min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] };
      };
      // In a 3D project a `_COL` node becomes a triangle-mesh collider (exact static geometry),
      // or a convex hull when it is too big for a mesh; the 2D plane keeps its outline polygon.
      const threeD = (clientRef.current?.getSettings() ?? {})['physics_dimension'] === 3;
      const collider3D = (piece: string | null): PieceFacts['collider'] => {
        for (const kind of ['mesh', 'convex'] as const) {
          const made = resource.collider3D(piece, kind);
          if (made.ok && made.source === 'collision') return { shape: made.shape };
          if (made.ok) return null;
        }
        return null;
      };
      const pieces: PieceFacts[] = resource.pieces().map((pc) => ({ name: pc.name, bounds: box(pc.name), collider: pc.hasCollider ? (threeD ? collider3D(pc.name) : resource.collider2D(pc.name)) : null, skinned: pc.skinned }));
      const { args } = planModelDrop({
        assetId: payload.assetId,
        displayName: asset.displayName,
        ...(payload.piece !== undefined ? { piece: payload.piece } : {}),
        pieces,
        wholeCollider: pieces.length === 1 ? (threeD ? collider3D(null) : resource.collider2D(null)) : null,
        position,
        parentId,
      });
      setPlacementError(null);
      const res = await c.command('createEntity', args, c.projection.revision);
      if (res.ok && res.createdId !== undefined) setSelectedId(res.createdId);
      else if (!res.ok) setPlacementError({ code: (res.response as { code?: string }).code ?? 'command_failed', message: (res.response as { message?: string }).message ?? 'the model could not be placed' });
      reportFailure(`Place ${asset.displayName}`, res);
    },
    [clientRef, modelInstancesRef, reportFailure, setSelectedAssetId, setSelectedId],
  );

  // Delete an asset (the backend refuses while anything uses it; one undo restores).
  const deleteAsset = useCallback(async (assetId: string) => {
    const c = clientRef.current;
    if (!c) return;
    const res = await c.command('deleteAsset', { assetId }, c.projection.revision);
    const err = refusal(res);
    setAssetDeleteError(err);
    if (err === null) setSelectedAssetId((cur) => (cur === assetId ? null : cur));
  }, [clientRef, setSelectedAssetId]);
  /** Read the index again (lists and pickers read their pages again). */
  const refreshAssets = useCallback(() => {
    clientRef.current?.catalog.invalidate();
  }, [clientRef]);

  return { assetDeleteError, setAssetDeleteError, placementError, placement, placeAsset, dropAsset, deleteAsset, refreshAssets };
}

export type AssetActions = ReturnType<typeof useAssetActions>;
