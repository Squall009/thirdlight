/**
 * The graph editor's keyboard (shortcuts, keyboard wiring between focused ports, arrow moves),
 * the node catalogue's search and keys, and the inline comment and group title edit.
 */
import { useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  compatibleNodeDefs,
  copyItems,
  searchCatalogue,
  snap,
  GRID,
  type GraphNodeDef,
  type GraphPoint,
  type PortEnd,
} from './model';
import type { GraphEditorProps } from './graph-editor-parts';
import type { GraphView } from './useGraphView';
import type { GraphActions } from './useGraphActions';

export function useGraphKeyboard(gv: GraphView, ga: GraphActions, props: GraphEditorProps) {
  const { kind, onToggleBreakpoint } = props;
  const { fixedTypes, portsOfNode, rootRef, sizeRef, dragRef, movedRef, mouseRef, spaceRef, graphRef, selectionRef, setTick, snapOn, setStatus, catalogue, setCatalogue, editing, setEditing, pendingPort, setPendingPort, setSelection, requestDraw } = gv;
  const { edit, moveSet, openCatalogue, frame, copySelection, pasteClip, paste, removeSelection, addGroup, addNodeFromCatalogue, connect } = ga;
  const keyMoveRef = useRef<Map<string, GraphPoint> | null>(null);

  const onKeyDown = (ev: ReactKeyboardEvent<HTMLDivElement>): void => {
    const t = ev.target as HTMLElement;
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return;
    const mod = ev.ctrlKey || ev.metaKey;
    const key = ev.key.toLowerCase();
    const handled = (): void => {
      ev.preventDefault();
      ev.stopPropagation();
    };
    if (mod && key === 'z') return; // project undo/redo (the app handles it)
    if (mod && key === 'y') return;
    if (ev.key === 'Escape') {
      // Nothing to cancel: Esc is the editor window's (back to the Scene).
      if (catalogue === null && pendingPort === null && dragRef.current === null) return;
      handled();
      setCatalogue(null);
      setPendingPort(null);
      dragRef.current = null;
      movedRef.current = new Map();
      requestDraw();
      return;
    }
    if (ev.key === ' ' && !ev.repeat) {
      handled();
      // Space tapped (no drag while held) opens the catalogue; held + drag pans.
      if (t.dataset['port'] !== undefined) return activatePort(t);
      spaceRef.current = { down: true, used: false };
      return;
    }
    if (ev.key === ' ') return handled();
    if (ev.key === 'Enter' && t.dataset['port'] !== undefined) {
      handled();
      return activatePort(t);
    }
    if (mod && key === 'c') {
      handled();
      const clip = copySelection();
      setStatus({ text: clip !== null ? `copied ${clip.nodes.length + clip.groups.length + clip.comments.length} item(s)` : 'nothing to copy', error: false });
      return;
    }
    if (mod && key === 'x') {
      handled();
      if (copySelection() !== null) void removeSelection();
      return;
    }
    if (mod && key === 'v') {
      handled();
      void paste();
      return;
    }
    if (mod && key === 'd') {
      handled();
      const clip = copyItems(kind.kind, graphRef.current, selectionRef.current, fixedTypes);
      if (clip.nodes.length + clip.groups.length + clip.comments.length > 0) void pasteClip(clip, { offset: [GRID * 2, GRID * 2] });
      return;
    }
    if (mod && key === 'a') {
      handled();
      const g = graphRef.current;
      setSelection(new Set([...g.nodes.map((n) => n.id), ...(g.comments ?? []).map((c) => c.id), ...(g.groups ?? []).map((x) => x.id)]));
      return;
    }
    if (mod && key === 'g') {
      handled();
      void addGroup();
      return;
    }
    if (ev.key === 'F9' && onToggleBreakpoint !== undefined) {
      // Toggle breakpoints on the selected nodes.
      handled();
      const ids = graphRef.current.nodes.filter((n) => selectionRef.current.has(n.id)).map((n) => n.id);
      if (ids.length > 0) onToggleBreakpoint(ids);
      else setStatus({ text: 'select a node to put a breakpoint on it', error: false });
      return;
    }
    if (mod) return;
    if (ev.key === 'Delete' || ev.key === 'Backspace') {
      handled();
      void removeSelection();
      return;
    }
    if (key === 'f') {
      handled();
      frame(ev.shiftKey ? null : selectionRef.current);
      return;
    }
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const dir = arrows[ev.key];
    if (dir !== undefined && selectionRef.current.size > 0) {
      handled();
      const step = GRID * (ev.shiftKey ? 5 : 1);
      const base = keyMoveRef.current ?? moveSet(selectionRef.current);
      if (keyMoveRef.current === null) keyMoveRef.current = new Map(base);
      const cur = movedRef.current.size > 0 ? movedRef.current : base;
      const m = new Map<string, GraphPoint>();
      for (const [id, pos] of cur) m.set(id, [snap(pos[0] + dir[0] * step, snapOn), snap(pos[1] + dir[1] * step, snapOn)]);
      movedRef.current = m;
      requestDraw();
      setTick((x) => x + 1);
    }
  };

  const onKeyUp = (ev: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (ev.key === ' ') {
      const s = spaceRef.current;
      spaceRef.current = { down: false, used: false };
      const t = ev.target as HTMLElement;
      if (s.down && !s.used && t.dataset['port'] === undefined && t.tagName !== 'INPUT' && t.tagName !== 'TEXTAREA') {
        const m = mouseRef.current ?? { sx: sizeRef.current.w / 2, sy: sizeRef.current.h / 2 };
        openCatalogue(m.sx, m.sy, null);
      }
      return;
    }
    if (ev.key.startsWith('Arrow') && keyMoveRef.current !== null) {
      // One keyboard move (press → release) is one edit.
      const orig = keyMoveRef.current;
      keyMoveRef.current = null;
      const moves = [...movedRef.current].filter(([id, pos]) => {
        const o = orig.get(id);
        return o !== undefined && (o[0] !== pos[0] || o[1] !== pos[1]);
      });
      if (moves.length > 0) void edit([{ op: 'moveNodes', moves: moves.map(([id, position]) => ({ id, position })) }]);
    }
  };

  const activatePort = (el: HTMLElement): void => {
    const end: PortEnd = { node: el.dataset['node']!, port: el.dataset['port']!, side: el.dataset['side'] as 'in' | 'out' };
    if (pendingPort === null) {
      setPendingPort(end);
      setStatus({ text: `wire from ${end.side === 'out' ? 'output' : 'input'} "${end.port}" — focus a port and press Enter to connect (Esc cancels)`, error: false });
      return;
    }
    const from = pendingPort;
    setPendingPort(null);
    void connect(from, end);
  };

  // ---- the catalogue ----------------------------------------------------------------------

  const catalogueEntries = useMemo(() => {
    if (catalogue === null) return [];
    let only: readonly GraphNodeDef[] | undefined;
    if (catalogue.from !== null) {
      const g = graphRef.current;
      const n = g.nodes.find((x) => x.id === catalogue.from!.node);
      const own = n !== undefined ? portsOfNode(n) : { inputs: [], outputs: [] };
      const port = (catalogue.from.side === 'out' ? own.outputs : own.inputs).find((p) => p.id === catalogue.from!.port);
      only = port !== undefined ? compatibleNodeDefs(kind, port.type, catalogue.from.side).map((x) => x.def) : [];
    }
    return searchCatalogue(kind, catalogue.query, only);
  }, [catalogue, kind, graphRef, portsOfNode]);

  const onCatalogueKey = (ev: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (catalogue === null) return;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      setCatalogue(null);
      rootRef.current?.focus();
    } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      const n = catalogueEntries.length;
      if (n > 0) setCatalogue({ ...catalogue, active: (catalogue.active + (ev.key === 'ArrowDown' ? 1 : n - 1)) % n });
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      const d = catalogueEntries[catalogue.active];
      if (d !== undefined) void addNodeFromCatalogue(d.type);
    }
  };

  // ---- inline text editing ------------------------------------------------------------------

  const commitEditing = (): void => {
    const e = editing;
    setEditing(null);
    if (e === null) return;
    const g = graphRef.current;
    if (e.kind === 'comment') {
      const c = (g.comments ?? []).find((x) => x.id === e.id);
      if (c !== undefined && c.text !== e.text && e.text.length > 0) void edit([{ op: 'setComments', comments: [{ ...c, text: e.text.slice(0, 2000) }] }]);
    } else {
      const gr = (g.groups ?? []).find((x) => x.id === e.id);
      if (gr !== undefined && gr.title !== e.text) void edit([{ op: 'setGroups', groups: [{ ...gr, title: e.text.slice(0, 64) }] }]);
    }
    rootRef.current?.focus();
  };
  return { onKeyDown, onKeyUp, catalogueEntries, onCatalogueKey, commitEditing };
}
export type GraphKeyboard = ReturnType<typeof useGraphKeyboard>;
