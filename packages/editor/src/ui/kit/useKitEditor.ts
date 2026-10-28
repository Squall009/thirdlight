/**
 * The kit editor's state and actions, shared by the kit's document tab and
 * the Inspector beside it: which kit is in front, what is picked in it (a
 * slot and one of its variants, or a block type), the backend's check of it
 * against the trim sheet spec, and the edits — each one undo step: one
 * `setKit`, a dropped GLB published and put in its slot, a trim sheet
 * swapped with the presets and block types that wore the old one, a fix.
 * The multi-command ones send through their `grouped` scope, so an edit made
 * elsewhere while they run (a slow upload) is not undone with them.
 *
 * The check is asked again shortly after the kit (or anything its pieces
 * read) changes; the sheet's pixels are read when a kit is first opened and
 * on Check all (the backend keeps what it read, so later checks reuse it).
 *
 * Browser-only (React).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { BlockType, KitCheckReport, KitDef } from '@thirdlight/project-model';

import { activeDoc, type WorkspaceState } from '../../session/editor-window';
import type { CommandResult, SessionClient } from '../../session/client';
import { kitPieceAssets, kitSheetSwap, repointBlockType, repointMapping, repointPreset, withoutShared, type SharedKitPart } from '../../session/kit-edits';
import { mergeDocumentEdit } from '../../session/own-commands';
import { publishFileAsset } from '../../session/publish-file';
import { refusal, type ClientRef } from '../shell/commands';

/** What the kit editor has picked: a slot (and which of its variants), or one of its block types. */
export type KitPick = { kind: 'slot'; slot: string; index: number } | { kind: 'blockType'; id: string };

/** How long after a change the check is asked again (ms): a burst of edits asks once. */
const RECHECK_MS = 150;

/** The kit edits a user action sends (through the client, or a grouped action's scope). */
export interface KitEdits {
  /** Store the kit as `next` (one `setKit`); resolves with a refusal or null. */
  save: (next: KitDef) => Promise<string | null>;
  /** Publish a dropped GLB as a model asset; its id, or why not. */
  importModel: (file: File) => Promise<string | { message: string }>;
}

/** What a sheet swap does with parts other kits list too: move them for every kit, or leave them. */
export type SharedSwapChoice = 'all' | 'skip';

export interface KitEditor extends KitEdits {
  /** The kit of the tab in front of the editor window (null: no kit tab in front). */
  kitId: string | null;
  kit: KitDef | null;
  pick: KitPick | null;
  setPick: (pick: KitPick | null) => void;
  report: KitCheckReport | null;
  /** A check is running (the pixels are being read when `pixels`). */
  checking: { pixels: boolean } | null;
  checkAll: () => void;
  /**
   * The kit's trim sheet swapped for `to`: the kit, and its presets, block types and piece models that wore the old sheet
   * (`kitSheetSwap`), in one undo step. When some of those parts are other kits' too and `shared` is not given, nothing
   * is sent and the shared parts are returned for the user to choose; else null. A refusal part way takes back what
   * already ran and says why.
   */
  swapSheet: (kit: KitDef, to: string, shared?: SharedSwapChoice) => Promise<SharedKitPart[] | null>;
  /** Run an action whose edits (sent through `edits`) are one undo step (a dropped GLB published, then put in its slot). */
  grouped: <T>(action: (edits: KitEdits) => Promise<T>) => Promise<T>;
  /** Map a model's source material to a material (one `setAssetOptions`, the rest of its map kept). */
  mapMaterial: (assetId: string, source: string, materialId: string) => Promise<void>;
  /** What is being done ("Importing door.glb…"), shown in the toolbar. */
  busy: string | null;
  error: string | null;
  /** Asks the kit document to show the picked part's panels (the Inspector's link); counts up on each ask. */
  reveal: number;
  revealPanels: () => void;
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
  const [reveal, setReveal] = useState(0);
  const revealPanels = useCallback(() => setReveal((n) => n + 1), []);

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

  const saveVia = useCallback(
    async (c: SessionClient | null, next: KitDef): Promise<string | null> => {
      if (c === null) return 'not connected';
      const base = kits.find((k) => k.kitId === next.kitId) ?? null;
      // Re-applied onto the kit as it is when sent, so a quick second edit keeps the first.
      const build = (): { kit: KitDef } => ({ kit: mergeDocumentEdit(base, next, c.getKits().find((k) => k.kitId === next.kitId) ?? null) ?? next });
      const err = refusal(await c.command('setKit', build, c.projection.revision));
      setError(err);
      return err;
    },
    [kits],
  );
  const save = useCallback((next: KitDef) => saveVia(clientRef.current, next), [clientRef, saveVia]);

  const importVia = useCallback(async (c: SessionClient | null, file: File): Promise<string | { message: string }> => {
    if (c === null) return { message: 'not connected' };
    if (!/\.glb$/i.test(file.name)) return { message: `${file.name}: a kit piece is a GLB file (export glTF binary from the modelling tool).` };
    setBusy(`Importing ${file.name}…`);
    try {
      const id = await publishFileAsset(c, new Uint8Array(await file.arrayBuffer()), file.name.replace(/\.[^.]+$/, ''), file.name, 'model');
      if (typeof id !== 'string') setError(id.message);
      return id;
    } finally {
      setBusy(null);
    }
  }, []);
  const importModel = useCallback((file: File) => importVia(clientRef.current, file), [clientRef, importVia]);

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

  const grouped = useCallback(
    <T,>(action: (edits: KitEdits) => Promise<T>): Promise<T> => {
      const c = clientRef.current;
      const editsOf = (via: SessionClient | null): KitEdits => ({ save: (next) => saveVia(via, next), importModel: (file) => importVia(via, file) });
      return c !== null ? c.grouped((g) => action(editsOf(g))) : action(editsOf(null));
    },
    [clientRef, saveVia, importVia],
  );

  const swapSheet = useCallback(
    async (target: KitDef, to: string, shared?: SharedSwapChoice): Promise<SharedKitPart[] | null> => {
      const c = clientRef.current;
      if (c === null) return null;
      const from = target.trimMaterial;
      if (from === undefined || from === to) {
        await save({ ...target, trimMaterial: to });
        return null;
      }
      if (!c.getMaterials().some((m) => m.materialId === to)) {
        setError(`The trim sheet ${to} is not in the project.`);
        return null;
      }
      // The pieces' material mappings are read from their summaries, which are loaded on demand.
      await c.catalog.ensureAssets(kitPieceAssets(target));
      const mappingOf = (id: string): Readonly<Record<string, string>> | undefined => (c.content.getAsset(id) as { materials?: Record<string, string> } | undefined)?.materials;
      const plan = kitSheetSwap(target, from, to, c.getGraphs(), c.getBlockTypes(), mappingOf, c.getKits());
      if (plan.shared.length > 0 && shared === undefined) return plan.shared;
      const parts = shared === 'skip' ? withoutShared(plan) : plan;
      // Each part as a step that re-points it from one sheet to the other, built from the project as it is when sent
      // (an edit made since the plan is kept); run backwards, a step takes itself back.
      type Step = (g: SessionClient, a: string, b: string) => Promise<CommandResult>;
      const kitStep: Step = (g, _a, b) => g.command('setKit', () => ({ kit: { ...(g.getKits().find((k) => k.kitId === target.kitId) ?? target), trimMaterial: b } }), g.projection.revision);
      const steps: Step[] = [
        kitStep,
        ...parts.presets.map(({ graphId }): Step => (g, a, b) =>
          g.command('graphEdit', () => {
            const graph = g.getGraphs().find((x) => x.graphId === graphId);
            const head = graph?.graph.nodes.find((x) => x.type === 'preset');
            // A head that no longer names the sheet is sent as it is (nothing changes).
            return { owner: { kind: 'graph', id: graphId }, ops: repointPreset(graph, a, b) ?? (head !== undefined ? [{ op: 'setNodeData', id: head.id, data: head.data ?? {} }] : []) };
          }, g.projection.revision),
        ),
        ...parts.blockTypes.map(({ blockId }): Step => (g, a, b) => {
          const now = (): BlockType | undefined => g.getBlockTypes().find((t) => t.blockId === blockId);
          return g.command('setBlockType', () => ({ block: repointBlockType(now(), a, b) ?? now() }), g.projection.revision);
        }),
        ...parts.assets.map(({ assetId }): Step => (g, a, b) => g.command('setAssetOptions', () => ({ assetId, materials: repointMapping(mappingOf(assetId), a, b) ?? mappingOf(assetId) ?? {} }), g.projection.revision)),
      ];
      // A part that no longer wore the sheet when its step was sent is left as it is.
      const failed = (r: CommandResult): string | null => (!r.ok && (r.response as { code?: string }).code === 'no_change' ? null : refusal(r));
      setBusy('Swapping the trim sheet…');
      try {
        await c.grouped(async (g) => {
          let done = 0;
          let err: string | null = null;
          for (const step of steps) {
            err = failed(await step(g, from, to));
            if (err !== null) break;
            done++;
          }
          if (err === null) return setError(null);
          // All or nothing: what already ran goes back to the old sheet (in the same undo step, which then changes nothing).
          const undoErrors: string[] = [];
          for (let i = done - 1; i >= 0; i--) {
            const back = failed(await steps[i]!(g, to, from));
            if (back !== null) undoErrors.push(back);
          }
          setError(`The trim sheet was not swapped: ${err}${undoErrors.length > 0 ? ` (and taking back what had changed was refused too: ${undoErrors.join('; ')})` : ''}`);
        });
      } finally {
        setBusy(null);
      }
      return null;
    },
    [clientRef, save],
  );

  const pick = kitId === null ? null : (picks[kitId] ?? null);
  const setPick = useCallback((p: KitPick | null) => {
    if (kitId !== null) setPicks((m) => ({ ...m, [kitId]: p }));
  }, [kitId]);

  return { kitId, kit, pick, setPick, report: report !== null && report.kitId === kitId ? report : null, checking, checkAll, save, swapSheet, grouped, importModel, mapMaterial, busy, error, reveal, revealPanels };
}
