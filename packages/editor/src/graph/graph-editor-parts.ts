/**
 * What the graph editor's parts share: its props, the gesture and hit-test shapes, the clipboard
 * of each graph kind and the layout constants.
 */
import {
  commentRect,
  groupRect,
  nodeRect as nodeRectBase,
  type GraphClipboard,
  type GraphContext,
  type GraphData,
  type GraphKindDef,
  type GraphOp,
  type GraphPoint,
  type GraphProblem,
  type GraphValue,
  type PortEnd,
  type PortsOf,
  type Rect,
  type View,
} from './model';

export interface GraphOwnerRef {
  kind: string;
  id: string;
}

export interface GraphEditorProps {
  kind: GraphKindDef;
  owner: GraphOwnerRef;
  graph: GraphData;
  /** Send one graphEdit (one undo step); resolves to null or the refusal message. */
  onEdit: (ops: GraphOp[]) => Promise<string | null>;
  /** The selected item ids changed (the host shows them in the Inspector). */
  onSelection?: (ids: readonly string[]) => void;
  /** Select and frame an item (a Problems jump); a new `nonce` repeats it. */
  focus?: { id: string; nonce: number } | null;
  /** A short label drawn on a wire (edge id → text, e.g. "×2"). */
  edgeLabels?: ReadonlyMap<string, string>;
  /** Nodes drawn highlighted (e.g. the live preview's current state). */
  highlighted?: ReadonlySet<string>;
  /** The host's field values for a node added from the catalogue (absent = the field defaults). */
  newNodeData?: (type: string) => Record<string, GraphValue> | undefined;
  /** A node's body was double-clicked (e.g. open a blend tree's own graph). */
  onOpenNode?: (id: string) => void;
  /**
   * What data-dependent ports read outside the graph — the
   * standalone graphs a sub-graph call names and external declarations
   * (e.g. a material's parameters). Absent = none.
   */
  portContext?: GraphContext;
  /**
   * Problems found outside the kind's rules (e.g. a visual
   * script's compile errors, by node): shown like the kind's own — a badge on
   * the node, the toolbar count, the node's hover text.
   */
  extraProblems?: readonly GraphProblem[];
  /** Nodes with a breakpoint (a red dot); with `onToggleBreakpoint`, F9 and the toolbar toggle them on the selection. */
  breakpoints?: ReadonlySet<string>;
  onToggleBreakpoint?: (nodeIds: readonly string[]) => void;
  /** The node a paused debugger stands on (outlined, with a ▶). */
  current?: string | null;
  /** A short text shown while the pointer is over a wire (e.g. the value it carried in Play); null = none. */
  edgeTip?: (edgeId: string) => string | null;
  /** Something was dropped on the graph (drag and drop from outside, e.g. a variable); `at` in graph units, `screen` the client (window) point. */
  onDropItem?: (data: DataTransfer, at: GraphPoint, screen: { x: number; y: number }) => void;
  /** Short tags shown under a node (node id → texts, e.g. what a material's output reads); absent or empty: none. */
  nodeNotes?: ReadonlyMap<string, readonly string[]>;
}

/** Copy/paste between editors of the same graph kind (document tabs of one kind). */
export const CLIPBOARDS = new Map<string, GraphClipboard>();

export const GROUP_COLORS = ['#4c6ef5', '#2f9e44', '#e8590c', '#ae3ec9', '#1098ad', '#f59f00'];
/** Above this many nodes in view, only selected nodes get DOM elements (the canvas still draws all). */
export const MAX_DOM_NODES = 400;
export const MINIMAP = { w: 200, h: 130 };

export type Hit =
  | { type: 'port'; end: PortEnd }
  | { type: 'reroute'; edge: string; index: number }
  | { type: 'node'; id: string; header: boolean; toggle: boolean }
  | { type: 'comment'; id: string }
  | { type: 'group'; id: string }
  | { type: 'edge'; id: string }
  | { type: 'empty' };

export type Drag =
  | { mode: 'pan'; sx: number; sy: number; view: View; moved: boolean }
  | { mode: 'move'; start: GraphPoint; items: Map<string, GraphPoint>; moved: boolean }
  | { mode: 'box'; start: GraphPoint; now: GraphPoint; additive: boolean; toggle: boolean }
  | { mode: 'wire'; from: PortEnd; at: GraphPoint; target: PortEnd | null; ok: boolean | null }
  | { mode: 'reroute'; edge: string; index: number; start: GraphPoint; orig: GraphPoint; moved: boolean }
  | { mode: 'minimap' };

export interface Catalogue {
  sx: number;
  sy: number;
  at: GraphPoint;
  from: PortEnd | null;
  query: string;
  active: number;
}

export function allRects(kind: GraphKindDef, g: GraphData, portsOf: PortsOf, only?: ReadonlySet<string>): Rect[] {
  const keep = (id: string): boolean => only === undefined || only.has(id);
  return [
    ...g.nodes.filter((n) => keep(n.id)).map((n) => nodeRectBase(kind, n, n.position, portsOf)),
    ...(g.comments ?? []).filter((c) => keep(c.id)).map((c) => commentRect(c)),
    ...(g.groups ?? []).filter((x) => keep(x.id)).map((x) => groupRect(x)),
  ];
}
