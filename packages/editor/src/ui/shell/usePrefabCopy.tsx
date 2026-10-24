/**
 * The selected object's linked prefab copy, read from the backend (the
 * editor holds assembled objects; the copy's link and overrides are the
 * stored ones), and what the Inspector does with it: the copy header, the
 * marks on overridden fields with their right-click Revert / Apply to
 * prefab, and Unpack. Each action is one command (one undo step).
 *
 * Browser-only (React).
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import type { ProjectedEntity } from '../../session/projection';
import { fieldOverridden, fieldOverridePath, overridesOfPart, variantChain, type PrefabCopyView } from '../../session/prefab-copy';
import type { FieldMarks } from '../field-marks';
import { ContextMenu } from '../ContextMenu';
import { PrefabCopyHeader, type OverrideTarget } from '../PrefabCopyHeader';
import { onPrefabStage } from './usePrefabStage';
import type { ClientRef, SetNotice, UiError } from './commands';

export interface PrefabCopyDeps {
  clientRef: ClientRef;
  selected: ProjectedEntity | null;
  /** The projected objects (a new list after every change: the copy is read again). */
  entities: readonly ProjectedEntity[];
  runTypedCommand: (op: string, args: unknown, onError: (e: UiError) => void) => Promise<boolean>;
  setNotice: SetNotice;
  openPrefab: (prefabId: string) => void;
}

export function usePrefabCopy(d: PrefabCopyDeps): { header: ReactNode; marks: FieldMarks | null; menu: ReactNode } {
  const { clientRef, selected, entities, runTypedCommand, setNotice, openPrefab } = d;
  const [read, setRead] = useState<{ id: string; copy: PrefabCopyView; chain: string[] } | null>(null);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number; path: string } | null>(null);
  const id = selected !== null && selected.prefab !== undefined && !onPrefabStage(selected) ? selected.id : null;

  useEffect(() => {
    const c = clientRef.current;
    if (id === null || c === null) {
      setRead(null);
      return;
    }
    let live = true;
    void (async () => {
      const r = await c.queryEntity(id);
      if (!live) return;
      if (!r.ok || r.prefabCopy === null) return setRead(null);
      // A variant names its base through its root: read each definition of the chain.
      let chain: string[] = [];
      for (let n = 0; n < 64; n++) {
        chain = variantChain(r.prefabCopy.prefabId, (p) => c.prefabs.getDefinition(p));
        const missing = chain.filter((p) => !c.prefabs.hasDefinition(p));
        if (missing.length === 0) break;
        await c.catalog.ensurePrefabs(missing);
        if (!live) return;
        if (missing.every((p) => !c.prefabs.hasDefinition(p))) break;
      }
      setRead({ id, copy: r.prefabCopy, chain });
    })();
    return () => {
      live = false;
    };
    // `entities`: any change may have changed the copy's overrides.
  }, [clientRef, id, entities]);

  const copy = read !== null && read.id === id ? read.copy : null;
  const run = useCallback(
    async (op: string, args: Record<string, unknown>, what: string) => {
      let failure: UiError | null = null;
      const ok = await runTypedCommand(op, args, (e) => (failure = e));
      if (!ok) setNotice(`${what}: ${(failure as UiError | null)?.message ?? 'refused'}`);
    },
    [runTypedCommand, setNotice],
  );
  const revert = useCallback((t: OverrideTarget) => copy !== null && void run('revertPrefabOverrides', { entityId: copy.copyId, ...t }, 'Revert'), [copy, run]);
  const apply = useCallback((t: OverrideTarget) => copy !== null && void run('applyPrefabOverrides', { entityId: copy.copyId, ...t }, 'Apply to prefab'), [copy, run]);

  const marks = useMemo((): FieldMarks | null => {
    if (copy === null) return null;
    const own = overridesOfPart(copy, copy.part);
    if (own.length === 0) return null;
    return {
      overridden: (component, path) => fieldOverridden(own, component, path),
      menu: (component, path, at) => setMenuAt({ ...at, path: fieldOverridePath(component, path) }),
    };
  }, [copy]);
  const closeMenu = useCallback(() => setMenuAt(null), []);

  if (copy === null) return { header: null, marks: null, menu: null };
  const c = clientRef.current;
  const nameOf = (entityId: string | undefined): string => (entityId === undefined ? '?' : (entities.find((e) => e.id === entityId)?.name ?? entityId));
  const header = (
    <PrefabCopyHeader
      copy={copy}
      copyName={nameOf(copy.copyId)}
      chain={(read?.chain ?? [copy.prefabId]).map((p) => c?.prefabs.getDefinition(p)?.displayName ?? p)}
      partName={(key) => nameOf(copy.partIds[key])}
      onRevert={revert}
      onApply={apply}
      onOpen={() => openPrefab(copy.prefabId)}
      onUnpack={() => void run('unpackPrefab', { entityId: copy.copyId }, 'Unpack')}
    />
  );
  const menu =
    menuAt === null ? null : (
      <ContextMenu
        at={menuAt}
        label="override menu"
        onClose={closeMenu}
        items={[
          { label: 'Revert', onSelect: () => revert({ part: copy.part, path: menuAt.path }) },
          { label: 'Apply to prefab', onSelect: () => apply({ part: copy.part, path: menuAt.path }) },
        ]}
      />
    );
  return { header, marks, menu };
}
