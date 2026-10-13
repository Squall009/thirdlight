/**
 * The kit editor's state and actions, shared by the kit's document tab and
 * the Inspector beside it: which kit is in front, what is picked in it (a
 * slot and one of its variants, or a block type), the backend's check of it
 * against the trim sheet spec, and the edits — each one undo step: one
 * `setKit`, a dropped GLB published and put in its slot, a trim sheet
 * swapped with the presets and block types that wore the old one, a fix.
 *
 * The check is asked again shortly after the kit (or anything its pieces
 * read) changes; the sheet's pixels are read when a kit is first opened and
 * on Check all (the backend keeps what it read, so later checks reuse it).
 *
 * Browser-only (React).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { KitCheckReport, KitDef } from '@thirdlight/project-model';

import { activeDoc, type WorkspaceState } from '../../session/editor-window';
import { kitSheetSwap } from '../../session/kit-edits';
import { mergeDocumentEdit } from '../../session/own-commands';
import { publishBakeTexture } from '../../viewport/bake-run';
import { refusal, type ClientRef } from '../shell/commands';

/** What the kit editor has picked: a slot (and which of its variants), or one of its block types. */
export type KitPick = { kind: 'slot'; slot: string; index: number } | { kind: 'blockType'; id: string };

/** How long after a change the check is asked again (ms): a burst of edits asks once. */
const RECHECK_MS = 150;

export interface KitEditor {
  /** The kit of the tab in front of the editor window (null: no kit tab in front). */
  kitId: string | null;
  kit: KitDef | null;
  pick: KitPick | null;
  setPick: (pick: KitPick | null) => void;
  report: KitCheckReport | null;
  /** A check is running (the pixels are being read when `pixels`). */
  checking: { pixels: boolean } | null;
  checkAll: () => void;
  /** Store the kit as `next` (one `setKit`); resolves with a refusal or null. */
  save: (next: KitDef) => Promise<string | null>;
  /**
   * The kit's trim sheet swapped for `to`: the kit, and its presets and block types that wore the old sheet
   * (`kitSheetSwap`), in one undo step.
   */
  swapSheet: (kit: KitDef, to: string) => Promise<void>;
  /** Run an action whose commands are one undo step (a dropped GLB published, then put in its slot). */
  grouped: <T>(action: () => Promise<T>) => Promise<T>;
  /** Publish a dropped GLB as a model asset; its id, or why not. */
  importModel: (file: File) => Promise<string | { message: string }>;
  /** Map a model's source material to a material (one `setAssetOptions`, the rest of its map kept). */
  mapMaterial: (assetId: string, source: string, materialId: string) => Promise<void>;
  /** What is being done ("Importing door.glb…"), shown in the toolbar. */
  busy: string | null;
  error: string | null;
}

export function useKitEditor(clientRef: ClientRef, workspace: WorkspaceState, kits: readonly KitDef[], revision: number): KitEditor {
  const doc = activeDoc(workspace);
  const kitId = doc !== null && doc.kind === 'kit' ? doc.id : null;
  const kit = kitId === null ? null : (kits.find((k) => k.kitId === kitId) ?? null);
  const [picks, setPicks] = useState<Readonly<Record<string, KitPick | null>>>({});
  const [report, setReport] = useState<KitCheckReport | null>(null);
  const [checking, setChecking] = useState<{ pixels: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Kits whose sheet pixels were read in this session. */
  const pixelsRead = useRef(new Set<string>());
  const seq = useRef(0);

  const run = useCallback(
    async (id: string, pixels: boolean) => {
      const c = clientRef.current;
      if (c === null) return;
      const n = ++seq.current;
      setChecking({ pixels });
      const r = await c.kitCheck(id, pixels);
      if (n !== seq.current) return;
      setChecking(null);
      if (r.ok) {
        setReport(r);
        if (pixels) pixelsRead.current.add(id);
      } else setError(`Check: ${r.error.message}`);
    },
    [clientRef],
  );

  // A kit coming to the front is checked (its pixels the first time); a change to it or the project re-checks it.
  useEffect(() => {
    if (kitId === null || kit === null) {
      setReport(null);
      return undefined;
    }
    const t = window.setTimeout(() => void run(kitId, !pixelsRead.current.has(kitId)), RECHECK_MS);
    return () => window.clearTimeout(t);
  }, [kitId, kit, revision, run]);
  // A report of another kit is not shown while this one is read.
  useEffect(() => setReport((r) => (r !== null && r.kitId !== kitId ? null : r)), [kitId]);

  const checkAll = useCallback(() => {
    if (kitId !== null) void run(kitId, true);
  }, [kitId, run]);

  const save = useCallback(
    async (next: KitDef): Promise<string | null> => {
      const c = clientRef.current;
      if (c === null) return 'not connected';
      const base = kits.find((k) => k.kitId === next.kitId) ?? null;
      // Re-applied onto the kit as it is when sent, so a quick second edit keeps the first.
      const build = (): { kit: KitDef } => ({ kit: mergeDocumentEdit(base, next, c.getKits().find((k) => k.kitId === next.kitId) ?? null) ?? next });
      const err = refusal(await c.command('setKit', build, c.projection.revision));
      setError(err);
      return err;
    },
    [clientRef, kits],
  );

  const importModel = useCallback(
    async (file: File): Promise<string | { message: string }> => {
      const c = clientRef.current;
      if (c === null) return { message: 'not connected' };
      if (!/\.glb$/i.test(file.name)) return { message: `${file.name}: a kit piece is a GLB file (export glTF binary from the modelling tool).` };
      setBusy(`Importing ${file.name}…`);
      try {
        const id = await publishBakeTexture(c, new Uint8Array(await file.arrayBuffer()), file.name.replace(/\.[^.]+$/, ''), undefined, file.name, 'model');
        if (typeof id !== 'string') setError(id.message);
        return id;
      } finally {
        setBusy(null);
      }
    },
    [clientRef],
  );

  const mapMaterial = useCallback(
    async (assetId: string, source: string, materialId: string) => {
      const c = clientRef.current;
      if (c === null) return;
      await c.catalog.ensureAssets([assetId]);
      const current = (c.content.getAsset(assetId) as { materials?: Record<string, string> } | undefined)?.materials ?? {};
      setError(refusal(await c.command('setAssetOptions', { assetId, materials: { ...current, [source]: materialId } }, c.projection.revision)));
    },
    [clientRef],
  );

  const grouped = useCallback(<T,>(action: () => Promise<T>): Promise<T> => (clientRef.current !== null ? clientRef.current.grouped(action) : action()), [clientRef]);

  const swapSheet = useCallback(
    async (target: KitDef, to: string) => {
      const c = clientRef.current;
      if (c === null) return;
      const from = target.trimMaterial;
      const parts = from === undefined ? { presets: [], blockTypes: [] } : kitSheetSwap(target, from, to, c.getGraphs(), c.getBlockTypes());
      await c.grouped(async () => {
        if ((await save({ ...target, trimMaterial: to })) !== null) return;
        for (const g of parts.presets) {
          const err = refusal(await c.command('graphEdit', { owner: { kind: 'graph', id: g.graphId }, ops: g.ops }, c.projection.revision));
          if (err !== null) return setError(err);
        }
        for (const block of parts.blockTypes) {
          const err = refusal(await c.command('setBlockType', { block }, c.projection.revision));
          if (err !== null) return setError(err);
        }
      });
    },
    [clientRef, save],
  );

  const pick = kitId === null ? null : (picks[kitId] ?? null);
  const setPick = useCallback((p: KitPick | null) => {
    if (kitId !== null) setPicks((m) => ({ ...m, [kitId]: p }));
  }, [kitId]);

  return { kitId, kit, pick, setPick, report: report !== null && report.kitId === kitId ? report : null, checking, checkAll, save, swapSheet, grouped, importModel, mapMaterial, busy, error };
}
