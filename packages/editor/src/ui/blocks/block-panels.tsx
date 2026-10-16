/**
 * The block editor's panels that more than one of its modes declares: the
 * layer's lock (bottom left, collapsed) and the block type editor (right
 * edge). A panel shared by modes has one id, so it keeps one place across
 * them (`EditPanels`); the brush's panels are every editor's
 * (`editmode/brush-panels.tsx`).
 *
 * Browser-only (React).
 */
import { Toggle } from '../editmode/controls';
import type { EditPanel } from '../editmode/docks';
import type { EditModeView } from '../editmode/modes';
import type { BlockSetup } from './block-column';
import { BlockTypeEditor } from './BlockTypeEditor';

/** The layer's lock (its Hierarchy flag), so a finished layer is not changed by a stray stroke; open while locked, so the lock shows. */
export function layerPanel(s: BlockSetup): EditPanel {
  return {
    id: 'layer',
    title: 'Layer',
    dock: 'bl',
    collapsed: !s.locked,
    badge: s.locked ? 'locked' : 'unlocked',
    render: () => (
      <div className="tl-dpanel__pad">
        <Toggle label="Locked (nothing can be edited)" aria="lock layer" on={s.locked} onChange={(on) => s.blocks.setFlag(s.entity.id, 'locked', on)} hint="The object's Locked flag, as in the Hierarchy." />
      </div>
    ),
  };
}

/** The block type the palette picked (or a click in Navigate opened), edited in plain controls. */
export function blockTypePanel(view: EditModeView, s: BlockSetup, shown = true): EditPanel {
  const id = s.state.typeOpen ?? s.state.brush.block;
  const t = id === null ? undefined : s.typeOf.get(id);
  return { id: 'block-type', title: 'Block type', dock: 'r', shown, ...(t !== undefined ? { badge: t.name } : {}), render: () => <BlockTypeEditor {...view} /> };
}

/** Outside Build, the block type editor shows while a click in Navigate has a block selected (its type opened). */
export const openedTypeShown = (s: BlockSetup): boolean => s.state.selection !== null && s.state.typeOpen !== null;
