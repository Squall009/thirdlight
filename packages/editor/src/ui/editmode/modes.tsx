/**
 * The edit-mode registry.
 *
 * An edit mode is a full-screen editor for one object on the live Scene view
 * (a terrain; later a mesh's vertex paint, decals, a block layer). An object
 * type registers its mode here, as a document kind registers in
 * `workspace/kinds.tsx`: which objects it edits, its rail of modes with
 * their hints, the settings column of each, the Scene view's tools its keys
 * reach, and how the object is framed. The shell (`EditModeShell`) — the
 * header, the rail, the lent Scene view, isolation, the status line, the
 * keys, Done and Play — is the same for every mode.
 *
 * Browser-only (React).
 */
import type { ReactNode } from 'react';

import type { KeyHint } from '../../session/edit-keys';
import type { EffectiveEntityFlags } from '../../session/hierarchy';
import type { ProjectedEntity } from '../../session/projection';
import type { PaletteHost } from '../palette/MaterialLayers';
import type { TerrainTools } from '../shell/useTerrainTools';
import type { VertexPaintTools } from '../shell/useVertexPaintTools';
import { terrainMode } from './terrain-mode';
import { vertexPaintMode } from './vertex-paint-mode';
import type { RailItem } from './ToolRail';

/** What edit modes get from the app (as document views get a `WorkspaceHost`). */
export interface EditModeHost {
  /** The terrain tools' wiring: the Scene view's terrain editor and the terrain commands. */
  terrain: Pick<TerrainTools, 'terrainEditor' | 'terrainRun' | 'stageFile'>;
  /** The vertex paint brush's wiring: armed on the edited object, its stale paint. */
  paint: VertexPaintTools;
  /** An object's effective flags (locked, inactive). */
  flags: (entityId: string) => EffectiveEntityFlags | undefined;
  /** The project's block layers (a conversion's sources). */
  blockLayers: readonly { entityId: string; name: string }[];
  /** What the layer palette reads and sends (materials, thumbnails, commands). */
  palette: PaletteHost;
}

/** One mode of an editor's rail. */
export interface EditRailMode extends RailItem {
  /** What to do in it, in one plain sentence (the status line). */
  readonly hint: string;
  /** Its own keys, listed before the shared ones. */
  readonly keys?: readonly KeyHint[];
}

/** What an editor's settings column is drawn from. */
export interface EditModeView {
  readonly entity: ProjectedEntity;
  /** The rail's mode shown. */
  readonly mode: string;
  readonly host: EditModeHost;
}

export interface EditModeKind {
  /** Stable identifier (`[a-z][a-z0-9-]*`). */
  readonly kind: string;
  /** The header's editor name ("Terrain editor"). */
  readonly label: string;
  /** The Inspector's button that opens it ("Edit terrain"). */
  readonly action: string;
  /** Whether it edits this object. */
  applies(e: ProjectedEntity): boolean;
  /**
   * Whether a double-click on the object (Hierarchy, Scene view) opens it
   * (absent: yes). An editor every object of a common kind has (vertex paint
   * on any model) is opened from the Inspector only, so a double-click keeps
   * doing what it does for those objects.
   */
  readonly activates?: boolean;
  /** A short fact for the header ("4 tiles · 2 × 2 · 256 m each"). */
  meta?(e: ProjectedEntity): string;
  /** The rail, in order (Shift+1 is the first). */
  readonly rail: readonly EditRailMode[];
  /** The Scene view's tools (`SceneTool` names on the view's tool router) whose keys this mode routes. */
  readonly tools: readonly string[];
  /** The object's box in its own frame for Home (absent: the meshes it draws). */
  bounds?(e: ProjectedEntity): { min: readonly number[]; max: readonly number[] } | null;
  /**
   * The part of the object the view looks at on entering, in its own frame
   * (absent or null: the whole object, as Home): a big object framed whole is
   * seen from too far to work on.
   */
  workArea?(e: ProjectedEntity): { min: readonly number[]; max: readonly number[] } | null;
  /**
   * Frame the object on entering unless the view already shows it, even when
   * it was not just made (absent: an existing object keeps the view, which
   * may be aimed at it on purpose). For small objects shown alone, which the
   * view would otherwise often miss.
   */
  readonly framesOnEnter?: boolean;
  /** The settings column of the mode shown. */
  column(view: EditModeView): ReactNode;
  /** What the editor lays over the Scene view in every mode (chips beside the isolation chip, a toast). */
  viewExtra?(view: EditModeView): ReactNode;
  /** Fields the Inspector leaves to the mode, by component (what only the mode edits: a terrain's tiles and rules). */
  readonly inspectorSkips?: Readonly<Record<string, readonly string[]>>;
}

/** Every edit mode, in the order one is chosen for an object that several would edit. */
export const EDIT_MODES: readonly EditModeKind[] = [terrainMode, vertexPaintMode];

const BY_KIND = new Map(EDIT_MODES.map((k) => [k.kind, k]));

export function editModeKind(kind: string): EditModeKind | undefined {
  return BY_KIND.get(kind);
}

/** The edit mode that edits an object (undefined: none); `activated`: the one a double-click opens. */
export function editModeFor(e: ProjectedEntity | null | undefined, activated = false): EditModeKind | undefined {
  return e === null || e === undefined ? undefined : EDIT_MODES.find((k) => k.applies(e) && (!activated || k.activates !== false));
}
