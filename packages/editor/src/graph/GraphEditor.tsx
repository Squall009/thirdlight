/**
 * The generic node-graph editor.
 *
 * A self-contained component: give it a graph kind (catalogue, port types,
 * rules), the owner (which document's graph it is), the graph value, and an
 * `onEdit` that sends ONE `graphEdit` command with a list of ops. Every
 * gesture is one call (a drag of many nodes is one `moveNodes` on release;
 * a paste is one add + connect), so every gesture is one undo step and MCP
 * and other clients see the same graph. The component never changes the
 * graph itself: it shows the value it is given (plus the in-flight drag),
 * so a remote edit appears as soon as the host passes the new value.
 *
 * Gestures: pan (middle-drag or Space+drag), zoom to the cursor (wheel), fit
 * (F: the selection, Shift+F: everything), minimap (click/drag to move the
 * view), grid snapping (toggle), box select (drag on empty space; Shift
 * adds, Ctrl toggles), multi-drag, a group drags what is inside it,
 * copy/cut/paste (Ctrl+C/X/V, also between editors of the same kind),
 * duplicate (Ctrl+D), delete (Delete), select all (Ctrl+A), group
 * (Ctrl+G), alignment (toolbar), search-to-add (right click or Space: a
 * filterable catalogue with categories), drag from a port to empty space
 * (the catalogue filtered to nodes that can take the wire), double-click a
 * wire to add a reroute point (double-click the point to remove it),
 * double-click a node's title to collapse it, a comment or a group title to
 * edit it. Keyboard: nodes and ports are focusable; arrows move the
 * selection by a grid step (Shift: five); Enter on a port starts a wire,
 * Enter on another port connects it.
 */
import type { JSX } from 'react';

import type { GraphEditorProps } from './graph-editor-parts';
import { renderGraphEditor } from './GraphEditorView';
import { useGraphActions } from './useGraphActions';
import { useGraphKeyboard } from './useGraphKeyboard';
import { useGraphPointer } from './useGraphPointer';
import { useGraphView } from './useGraphView';

export type { GraphEditorProps, GraphOwnerRef } from './graph-editor-parts';

/** The view state, then the edits, the pointer and the keyboard over it (hooks in this order), then the elements. */
export function GraphEditor(props: GraphEditorProps): JSX.Element {
  const gv = useGraphView(props);
  const ga = useGraphActions(gv, props);
  const gp = useGraphPointer(gv, ga, props);
  const gk = useGraphKeyboard(gv, ga, props);
  return renderGraphEditor(gv, ga, gp, gk, props);
}
