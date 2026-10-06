/**
 * The Project tab: the project window (folders, tiles, search, the Create
 * menu), imports and re-imports. The chosen item shows in the Inspector.
 */
import type { JSX } from 'react';
import { TileThumbnails } from '../../viewport/thumbnails';
import { AssetBrowser } from '../AssetBrowser';
import { AssetFolders } from '../AssetFolders';
import type { ClientRef } from './commands';
import type { ProjectItem } from '../../session/project-items';
import type { ItemActions } from '../project/useItemActions';
import type { AssetsWindow } from './useAssetsWindow';
import type { AssetActions } from './useAssetActions';

export interface AssetsTabProps {
  clientRef: ClientRef;
  assets: AssetsWindow;
  actions: AssetActions;
  /** Imports from the project folder are offered (the file check can list it). */
  folderImport: boolean;
  tileThumbnails: TileThumbnails | null;
  /** The chosen item shows in the Inspector. */
  inspect: (item: ProjectItem) => void;
  /** The Create menu, deletes. */
  items: ItemActions;
  /** A search the project window is asked to show. */
  search: { text: string; n: number } | null;
}

export function AssetsTab(props: AssetsTabProps): JSX.Element {
  const { clientRef, tileThumbnails } = props;
  const { importState, selectedAssetId, setSelectedAssetId, mediaPendingRef, reimportRoles, setReimportRoles, reimportEntity, setReimportEntity, setFilePicker, loadProjectFiles } = props.assets;
  const { importSettings, textureEncoding, uploadFolder, setUploadFolder, importFile, publish, cancelImportFlow, discardImportFlow, projectWindow, loadingNames, selectedAsset } = props.assets;
  const { setAssetDeleteError, refreshAssets } = props.actions;
  return (
    <AssetBrowser
      importState={importState}
      selectedAssetId={selectedAssetId}
      onRefresh={() => void refreshAssets()}
      onSelect={(id) => {
        setSelectedAssetId(id);
        setAssetDeleteError(null);
      }}
      onInspect={props.inspect}
      search={props.search}
      actions={props.items}
      onImport={(f) => void importFile(f, 'create')}
      importSettings={importSettings}
      onPackTexture={async (req) => {
        const c = clientRef.current;
        if (c === null) return { error: 'not connected' };
        const res = await c.packTexture(req);
        if (!res.ok) return { error: res.error.message };
        await c.fullResync();
        setSelectedAssetId(res.assetId);
        return { reencoded: res.reencoded, joined: res.joined };
      }}
      onReimport={(f) => void importFile(f, 'reimport')}
      folderImport={props.folderImport}
      onImportFromFolder={() => setFilePicker('create')}
      onReimportFromFolder={() => setFilePicker('reimport')}
      onPublish={() => void publish()}
      onCancel={() => void cancelImportFlow()}
      onDiscard={() => void discardImportFlow()}
      roleMapping={mediaPendingRef.current !== null && mediaPendingRef.current.referencingEntityIds.length > 0 ? { clipNames: mediaPendingRef.current.clipNames ?? [], referencingEntityIds: mediaPendingRef.current.referencingEntityIds } : null}
      roleEntity={reimportEntity}
      roleDraft={reimportRoles}
      onRoleEntityChange={setReimportEntity}
      onRoleDraftChange={setReimportRoles}
      thumbnails={tileThumbnails}
      pieces={selectedAsset.pieces}
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
    />
  );
}
