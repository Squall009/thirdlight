/**
 * The project window and the chosen asset: imports and re-imports (from a
 * file or the project folder, with the media drop's pending context), the
 * chosen asset's summary, preview and options, and what a double-click in
 * the project window (or an Inspector reference's "Open") opens.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ItemOpener } from '../catalog/item-opener';
import { importFailed, initialImportState, publishArgsFromProposal, type AssetImportState, type ImportTarget } from '../../session/asset-browser';
import { useAssetPreview } from '../assets/useAssetPreview';
import { useProjectWindow } from '../project/useProjectWindow';
import { useSelectedAsset } from '../assets/useSelectedAsset';
import { useLoadingNames } from '../useLoadingNames';
import { useAssetFileCheck } from '../useAssetFileCheck';
import { useAssetOptions } from '../useAssetOptions';
import { useAssetImport } from '../useAssetImport';
import type { AnimationRoleKey } from '../../session/media';
import type { ClientRef, ModelsRef, ReportFailure } from './commands';

/** What a double-click in the project window opens, besides an asset's preview. */
export type ProjectWindowOpeners = Omit<Parameters<typeof useProjectWindow>[2], 'previewAsset'>;

export interface AssetsWindowDeps {
  clientRef: ClientRef;
  modelInstancesRef: ModelsRef;
  refreshEntities: () => void;
  reportFailure: ReportFailure;
  checkFiles: ReturnType<typeof useAssetFileCheck>['checkFiles'];
  catalogTick: number;
  /** Brings the Assets tab to the front (an import shows its result there). */
  showAssets: () => void;
  openers: ProjectWindowOpeners;
}

export function useAssetsWindow(deps: AssetsWindowDeps) {
  const { clientRef, modelInstancesRef, refreshEntities, reportFailure, checkFiles, catalogTick, showAssets, openers } = deps;
  const [importState, setImportState] = useState<AssetImportState>(initialImportState);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const pendingProposalRef = useRef<{ proposal: Parameters<typeof publishArgsFromProposal>[0]; target: ImportTarget } | null>(null);
  // The media import context the panel shows between the
  // inspect and the publish — the kind the drop decided, the inspected clip
  // names (a model proposal) and the animated-reimport obligation.
  const mediaPendingRef = useRef<{ kind: 'model' | 'audio' | 'texture' | 'font'; clipNames: string[] | null; referencingEntityIds: string[] } | null>(null);
  const [reimportRoles, setReimportRoles] = useState<Record<AnimationRoleKey, string>>({ idle: '', run: '', airborne: '' });
  const [reimportEntity, setReimportEntity] = useState('');
  const importStateRef = useRef<AssetImportState>(initialImportState);
  const selectedAssetIdRef = useRef<string | null>(null);
  useEffect(() => {
    importStateRef.current = importState;
  }, [importState]);
  useEffect(() => {
    selectedAssetIdRef.current = selectedAssetId;
  }, [selectedAssetId]);
  // An asset an import brings (a new one, or new bytes for one) is chosen and shows in the Inspector.
  const { inspect } = openers;
  const chooseImported = useCallback(
    (id: string | null) => {
      setSelectedAssetId(id);
      if (id !== null) inspect({ kind: 'asset', id });
    },
    [inspect],
  );
  const assetPreview = useAssetPreview({ clientRef, modelInstancesRef, selectedAssetId, onFailure: (e) => setImportState(importFailed(importStateRef.current, e)) });
  const [filePicker, setFilePicker] = useState<'create' | 'reimport' | null>(null);
  const loadProjectFiles = useCallback(
    (dir: string) =>
      clientRef.current !== null
        ? clientRef.current.listProjectFiles(dir)
        : Promise.resolve({ ok: false as const, error: { code: 'session_unavailable', message: 'not connected' } }),
    [clientRef],
  );

  const { importSettings, textureEncoding, reimportWithExtract, uploadFolder, setUploadFolder, importFile, importFromFolder, publish, reimportIssue, cancelImportFlow, discardImportFlow } = useAssetImport({
    clientRef,
    pendingProposalRef,
    mediaPendingRef,
    importStateRef,
    selectedAssetIdRef,
    setImportState,
    setSelectedAssetId: chooseImported,
    reimportRoles,
    setReimportRoles,
    reimportEntity,
    setReimportEntity,
    refreshEntities,
    checkFiles,
    showAssets,
  });
  // The project window: its folder (new items and uploads go there), moves, and what a double-click opens.
  const projectWindow = useProjectWindow(clientRef, setUploadFolder, {
    ...openers,
    previewAsset: (id) => {
      setSelectedAssetId(id);
      void assetPreview.load(id);
    },
  });
  // An Inspector reference's "Open" does what a double-click does (one stable object for the context).
  const openItemRef = useRef(projectWindow.open);
  openItemRef.current = projectWindow.open;
  const itemOpener = useMemo<ItemOpener>(() => ({ open: (item) => openItemRef.current(item) }), []);
  const assetOptions = useAssetOptions(clientRef, reportFailure);
  const loadingNames = useLoadingNames(clientRef);
  // The chosen asset (its summary, and a model's pieces and material names, loaded when it is chosen).
  const selectedAsset = useSelectedAsset(clientRef, modelInstancesRef, selectedAssetId, catalogTick);
  const assetSourceMaterials = selectedAsset.sourceMaterials;

  return {
    importState, selectedAssetId, setSelectedAssetId, selectedAssetIdRef, mediaPendingRef, reimportRoles, setReimportRoles, reimportEntity, setReimportEntity, assetPreview,
    filePicker, setFilePicker, loadProjectFiles, importSettings, textureEncoding, reimportWithExtract, uploadFolder, setUploadFolder, importFile, importFromFolder, publish,
    reimportIssue, cancelImportFlow, discardImportFlow, projectWindow, itemOpener, assetOptions, loadingNames, selectedAsset, assetSourceMaterials,
  };
}

export type AssetsWindow = ReturnType<typeof useAssetsWindow>;
