/**
 * The Assets tab: the project window (folders, tiles, search), imports and
 * re-imports, and the chosen item's side panel (preview, options, placing).
 */
import type { JSX } from 'react';
import { assetPlacementAvailable } from '../../session/placement';
import { TileThumbnails } from '../../viewport/thumbnails';
import type { MaterialDef } from '@thirdlight/project-model';
import { AssetBrowser } from '../AssetBrowser';
import { ModelAssetOptions } from '../ModelAssetOptions';
import { AssetFolders } from '../AssetFolders';
import type { ClientRef } from './commands';
import type { AnimatorTools } from './useAnimatorTools';
import type { AssetsWindow } from './useAssetsWindow';
import type { AssetActions } from './useAssetActions';

export interface AssetsTabProps {
  clientRef: ClientRef;
  assets: AssetsWindow;
  actions: AssetActions;
  /** Imports from the project folder are offered (the file check can list it). */
  folderImport: boolean;
  materials: MaterialDef[];
  animator: Pick<AnimatorTools, 'missingBones' | 'setAssetClipsFor'>;
  uiDocumentCount: number;
  createUiDocument: (name: string) => Promise<void>;
  tileThumbnails: TileThumbnails | null;
}

export function AssetsTab(props: AssetsTabProps): JSX.Element {
  const { clientRef, materials, tileThumbnails, createUiDocument } = props;
  const { missingBones, setAssetClipsFor } = props.animator;
  const { importState, selectedAssetId, setSelectedAssetId, mediaPendingRef, reimportRoles, setReimportRoles, reimportEntity, setReimportEntity, assetPreview, setFilePicker, loadProjectFiles } = props.assets;
  const { importSettings, textureEncoding, reimportWithExtract, uploadFolder, setUploadFolder, importFile, publish, cancelImportFlow, discardImportFlow, projectWindow, assetOptions, loadingNames, selectedAsset, assetSourceMaterials } = props.assets;
  const { assetDeleteError, setAssetDeleteError, placementError, placement, placeAsset, deleteAsset, refreshAssets } = props.actions;
  return (
    <AssetBrowser
      onNewUiDocument={() => void createUiDocument(`UI document ${props.uiDocumentCount + 1}`)}
      importState={importState}
      selectedAssetId={selectedAssetId}
      placementAvailable={placement !== null && assetPlacementAvailable()}
      placementMessage={placementError?.message ?? null}
      preview={assetPreview.view}
      onRefresh={() => void refreshAssets()}
      onSelect={(id) => {
        setSelectedAssetId(id);
        setAssetDeleteError(null);
      }}
      onImport={(f) => void importFile(f, 'create')}
      importSettings={importSettings}
      onPackTexture={async (req) => {
        const c = clientRef.current;
        if (c === null) return 'not connected';
        const res = await c.packTexture(req);
        if (!res.ok) return res.error.message;
        await c.fullResync();
        setSelectedAssetId(res.assetId);
        return null;
      }}
      onReimport={(f) => void importFile(f, 'reimport')}
      folderImport={props.folderImport}
      onImportFromFolder={() => setFilePicker('create')}
      onReimportFromFolder={() => setFilePicker('reimport')}
      onPublish={() => void publish()}
      onCancel={() => void cancelImportFlow()}
      onDiscard={() => void discardImportFlow()}
      onPreview={(id) => void assetPreview.load(id)}
      previewCanvasRef={assetPreview.canvasRef}
      onPreviewPlay={assetPreview.play}
      onPreviewPause={assetPreview.pause}
      onPreviewScrub={assetPreview.scrub}
      onPlace={() => void placeAsset()}
      roleMapping={mediaPendingRef.current !== null && mediaPendingRef.current.referencingEntityIds.length > 0 ? { clipNames: mediaPendingRef.current.clipNames ?? [], referencingEntityIds: mediaPendingRef.current.referencingEntityIds } : null}
      roleEntity={reimportEntity}
      roleDraft={reimportRoles}
      onRoleEntityChange={setReimportEntity}
      onRoleDraftChange={setReimportRoles}
      thumbnails={tileThumbnails}
      pieces={selectedAsset.pieces}
      assetOptions={assetOptions}
      onDelete={(id) => void deleteAsset(id)}
      deleteError={assetDeleteError}
      importExtra={
        <AssetFolders
          clientRef={clientRef}
          uploadFolder={uploadFolder}
          onUploadFolder={setUploadFolder}
          newFolder={projectWindow.folder ?? ''}
          ktx2={textureEncoding === 'none' ? undefined : textureEncoding}
          load={loadProjectFiles}
          onImported={() => void refreshAssets()}
        />
      }
      loading={loadingNames}
      folder={projectWindow.folder}
      onFolder={projectWindow.setFolder}
      onOpenItem={projectWindow.open}
      projectCommands={projectWindow.commands}
      sideExtra={
        selectedAssetId !== null && selectedAsset.summary?.kind === 'model' ? (
          <ModelAssetOptions asset={selectedAsset.summary} materials={materials} sourceMaterials={assetSourceMaterials} missingBones={missingBones} onClipsFor={(rig) => void setAssetClipsFor(selectedAssetId, rig)} onMaterials={(mapping) => void assetOptions.setAssetMaterials(selectedAssetId, mapping)} onReimportExtract={(path, extract) => void reimportWithExtract(selectedAssetId, path, extract)} />
        ) : null
      }
    />
  );
}
