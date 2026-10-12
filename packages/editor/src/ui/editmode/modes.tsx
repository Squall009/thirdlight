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
import type { TerrainTools } from '../shell/useTerrainTools';
import { terrainMode } from './terrain-mode';
import type { RailItem } from './ToolRail';

/** What edit modes get from the app (as document views get a `WorkspaceHost`). */
export interface EditModeHost {
  /** The terrain tools' wiring: the Scene view's terrain editor and the terrain commands. */
  terrain: Pick<TerrainTools, 'terrainEditor' | 'terrainRun' | 'stageFile'>;
  /** An object's effective flags (locked, inactive). */
  flags: (entityId: string) => EffectiveEntityFlags | undefined;
  /** The project's block layers (a conversion's sources). */
  blockLayers: readonly { entityId: string; name: string }[];
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
  /** A short fact for the header ("4 tiles · 2 × 2 · 256 m each"). */
  meta?(e: ProjectedEntity): string;
  /** The rail, in order (Shift+1 is the first). */
  readonly rail: readonly EditRailMode[];
  /** The Scene view's tools (`SceneTool` names on the view's tool router) whose keys this mode routes. */
  readonly tools: readonly string[];
  /** The object's box in its own frame for Home (absent: the meshes it draws). */
  bounds?(e: ProjectedEntity): { min: readonly number[]; max: readonly number[] } | null;
  /** The settings column of the mode shown. */
  column(view: EditModeView): ReactNode;
}

/** Every edit mode, in the order one is chosen for an object that several would edit. */
export const EDIT_MODES: readonly EditModeKind[] = [terrainMode];

const BY_KIND = new Map(EDIT_MODES.map((k) => [k.kind, k]));

export function editModeKind(kind: string): EditModeKind | undefined {
  return BY_KIND.get(kind);
}

/** The edit mode that edits an object (undefined: none). */
export function editModeFor(e: ProjectedEntity | null | undefined): EditModeKind | undefined {
  return e === null || e === undefined ? undefined : EDIT_MODES.find((k) => k.applies(e));
}
