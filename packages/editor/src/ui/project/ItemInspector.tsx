/**
 * The Inspector of an item chosen in the project window (Unity's Inspector
 * shows the Project window's last choice until something else is selected):
 * an asset's (AssetInspector), a material's values, a prefab's copy
 * placement, and for every other resource and scene its kind, file, name,
 * address and labels, with Open (its editor) and Delete.
 *
 * Display and intent only: every change is a command through the session.
 *
 * Browser-only (React).
 */
import { useEffect, useState, type JSX } from 'react';
import type { MaterialDef } from '@thirdlight/project-model';

import type { IndexEntryView } from '../../session/catalog';
import type { PrefabSummaryView } from '../../session/prefab-projection';
import { documentOfItem, isAssetKind, type ProjectItem } from '../../session/project-items';
import { AssetInspector, type AssetInspectorProps } from '../assets/AssetInspector';
import { useCatalog } from '../catalog/catalog-context';
import { LoadableFields } from '../LoadableFields';
import { MaterialItemInspector } from '../material/MaterialInspector';
import type { TrimCheck } from '../material/TrimSheetTable';
import { PrefabInspector, type PrefabInspectorProps } from '../PrefabInspector';
import type { LoadingNameActions } from '../useLoadingNames';
import type { ItemActions } from './useItemActions';

export interface ItemInspectorProps {
  item: ProjectItem;
  actions: ItemActions;
  /** What a double-click does (its editor, a scene in the Scene view). */
  open: (item: ProjectItem) => void;
  /** Show another item (a new material instance). */
  inspect: (item: ProjectItem) => void;
  /** Open a document in the editor window (a material just converted to a graph). */
  openDocument: (kind: string, id: string) => void;
  loading?: LoadingNameActions;
  asset: Omit<AssetInspectorProps, 'assetId' | 'loading' | 'onDelete' | 'deleteError'>;
  materials: { list: readonly MaterialDef[]; save: (material: MaterialDef, base: MaterialDef | null) => void; error: string | null; checkTrim?: TrimCheck };
  prefab: Omit<PrefabInspectorProps, 'prefabId' | 'definition' | 'onDelete' | 'deleteError'> & { definitions: readonly PrefabSummaryView[] };
}

/** An index entry by kind and id, read again whenever the index changed (names, files, labels change with commands). */
function useEntry(item: ProjectItem): IndexEntryView | null | undefined {
  const { catalog, version } = useCatalog();
  const [entry, setEntry] = useState<IndexEntryView | null | undefined>(undefined);
  const { kind, id } = item;
  useEffect(() => {
    if (catalog === null) return;
    let live = true;
    void catalog.entries([id], [kind]).then(
      (list) => live && setEntry(list.find((e) => e.kind === kind && e.id === id) ?? null),
      () => live && setEntry(null),
    );
    return () => {
      live = false;
    };
  }, [catalog, version, kind, id]);
  return entry !== undefined && entry !== null && (entry.kind !== kind || entry.id !== id) ? undefined : entry;
}

/** Kinds whose double-click opens something (an editor, the Scene view, the Environment window). */
const opens = (item: ProjectItem): boolean => documentOfItem(item) !== null || item.kind === 'scene' || item.kind === 'envpreset';

export function ItemInspector(p: ItemInspectorProps): JSX.Element {
  const { item, actions } = p;
  const deleteError = actions.deleteError !== null && actions.deleteError.item.kind === item.kind && actions.deleteError.item.id === item.id ? actions.deleteError.message : null;
  // `asset`: an asset whose kind is not known yet (one an import just brought).
  if (item.kind === 'asset' || isAssetKind(item.kind)) {
    return <AssetInspector assetId={item.id} {...(p.loading !== undefined ? { loading: p.loading } : {})} {...p.asset} onDelete={() => void actions.remove(item)} deleteError={deleteError} />;
  }
  return <ResourceInspector {...p} deleteError={deleteError} />;
}

function ResourceInspector(p: ItemInspectorProps & { deleteError: string | null }): JSX.Element {
  const { item, actions } = p;
  const e = useEntry(item);
  const [renameError, setRenameError] = useState<string | null>(null);
  if (e === undefined) return <div className="tl-inspector__empty">Reading {item.kind} {item.id}…</div>;
  if (e === null) return <div className="tl-inspector__empty">{item.kind} {item.id} is no longer in the project (deleted, or undone).</div>;
  return (
    <div className="tl-panel tl-inspector tl-item-inspector" aria-label={`${e.kind} inspector`} data-item={`${e.kind}:${e.id}`}>
      <div className="tl-panel__title" title={e.id}>
        Inspector — {e.name}
      </div>
      <div className="tl-assets__preview" data-testid="item-side" data-item={`${e.kind}:${e.id}`}>
        <div className="tl-assets__preview-head" title={e.id}>
          {e.kind} · {e.name}
        </div>
        {e.path !== null && (
          <div className="tl-assets__source" title="Its file in the game folder">
            file: {e.path}
          </div>
        )}
        {actions.canRename(e.kind) && e.kind !== 'material' && (
          <label className="tl-field">
            <span className="tl-field__label">name</span>
            <input
              key={`${e.kind}:${e.id}:${e.name}`}
              className="tl-input"
              aria-label={`${e.kind} name`}
              defaultValue={e.name}
              maxLength={64}
              onBlur={(ev) => {
                const name = ev.target.value.trim();
                if (name !== '' && name !== e.name) void actions.rename(item, name).then(setRenameError);
              }}
              onKeyDown={(ev) => ev.key === 'Enter' && (ev.target as HTMLInputElement).blur()}
            />
          </label>
        )}
        {renameError !== null && (
          <div className="tl-assets__error" role="alert">
            {renameError}
          </div>
        )}
        {p.loading !== undefined && e.kind !== 'scene' && <LoadableFields item={{ kind: e.kind, id: e.id }} address={e.address ?? null} labels={e.labels} actions={p.loading} />}
        {(opens(item) || actions.canDelete(e.kind)) && e.kind !== 'prefab' && (
          <div className="tl-assets__row">
            {opens(item) && (
              <button className="tl-btn tl-btn--small" onClick={() => p.open(item)} title="Open its editor (or double-click it in the project window)">
                open
              </button>
            )}
            {actions.canDelete(e.kind) && e.kind !== 'material' && (
              <button className="tl-btn tl-btn--small" aria-label={`delete ${e.kind} ${e.name}`} onClick={() => void actions.remove(item)} title="Remove it from the project (refused while anything still uses it; one undo brings it back)">
                delete
              </button>
            )}
          </div>
        )}
        {p.deleteError !== null && e.kind !== 'prefab' && (
          <div className="tl-assets__error" role="alert" data-testid="item-delete-error" title={p.deleteError}>
            {p.deleteError}
          </div>
        )}
      </div>
      {e.kind === 'material' && (
        <MaterialItemInspector
          materialId={e.id}
          materials={p.materials.list}
          onSave={(m) => p.materials.save(m, p.materials.list.find((x) => x.materialId === m.materialId) ?? null)}
          onDelete={() => void actions.remove(item)}
          onOpen={(id) => p.openDocument('material', id)}
          onShow={(id) => p.inspect({ kind: 'material', id })}
          {...(p.materials.checkTrim !== undefined ? { onCheckTrim: p.materials.checkTrim } : {})}
        />
      )}
      {e.kind === 'material' && p.materials.error !== null && (
        <div className="tl-assets__error" role="alert">
          {p.materials.error}
        </div>
      )}
      {e.kind === 'prefab' && (
        <PrefabInspector
          prefabId={e.id}
          definition={p.prefab.definitions.find((d) => d.prefabId === e.id) ?? null}
          targets={p.prefab.targets}
          copyError={p.prefab.copyError}
          overrideCount={p.prefab.overrideCount}
          onPlaceCopy={p.prefab.onPlaceCopy}
          onOverrideCommit={p.prefab.onOverrideCommit}
          onDelete={() => void actions.remove(item)}
          deleteError={p.deleteError}
        />
      )}
    </div>
  );
}
