/**
 * The edit-mode registry.
 *
 * An edit mode is a full-screen editor on the live Scene view: of one object
 * (a terrain, a model's vertex paint, a block layer) or of the scene (its
 * decals). A mode registers here, as a document kind registers in
 * `workspace/kinds.tsx`: which objects it edits (an object's mode) or opens
 * on (a scene's), its rail of modes with their hints, the settings column of
 * each (which declares its docked panels over the view), the Scene view's tools its keys reach, and how the view is set up —
 * the object alone and framed, or the whole scene with only the objects of
 * one component pickable. The shell (`EditModeShell`) — the header, the
 * rail, the lent Scene view, isolation, the status line, the keys, Done and
 * Play — is the same for every mode.
 *
 * Browser-only (React).
 */
import type { ReactNode } from 'react';

import type { KeyHint } from '../../session/edit-keys';
import type { EffectiveEntityFlags } from '../../session/hierarchy';
import type { ProjectedEntity } from '../../session/projection';
import type { BlockModeHost } from '../blocks/block-host';
import type { PaletteHost } from '../palette/MaterialLayers';
import type { DecalAtlas } from '../shell/useDecalAtlas';
import type { DecalTools } from '../shell/useDecalTools';
import type { TerrainTools } from '../shell/useTerrainTools';
import type { VertexPaintTools } from '../shell/useVertexPaintTools';
import { blockMode } from './block-mode';
import { decalMode } from './decal-mode';
import { prefabMode, type PrefabModeHost } from './prefab-mode';
import { terrainMode } from './terrain-mode';
import { vertexPaintMode } from './vertex-paint-mode';
import type { RailItem } from './ToolRail';

/** What edit modes get from the app (as document views get a `WorkspaceHost`). */
export interface EditModeHost {
  /** The terrain tools' wiring: the Scene view's terrain editor and the terrain commands. */
  terrain: Pick<TerrainTools, 'terrainEditor' | 'terrainRun' | 'stageFile'>;
  /** The vertex paint brush's wiring: armed on the edited object, its stale paint. */
  paint: VertexPaintTools;
  /** The decal editor's wiring: its tool, selection, settings and commands. */
  decals: DecalTools;
  /** The decal atlas: the pages Play and the export will use, Rebuild pages, what the Scene view draws from. */
  decalAtlas: DecalAtlas;
  /** The block editor's wiring: the Scene view's block tools, the block content and its commands. */
  blocks: BlockModeHost;
  /** The scene's objects (a scene's mode reads the ones it edits). */
  entities: readonly ProjectedEntity[];
  /** The scene new objects go into (the active one; null: none). */
  scene: { readonly sceneId: string; readonly name: string } | null;
  /** An object's effective flags (locked, inactive). */
  flags: (entityId: string) => EffectiveEntityFlags | undefined;
  /** The project's block layers (a conversion's sources). */
  blockLayers: readonly { entityId: string; name: string }[];
  /** What the layer palette reads and sends (materials, thumbnails, commands). */
  palette: PaletteHost;
  /** The prefab editor's wiring: the prefab opened on its own, the object picked, the Inspector. */
  prefab: PrefabModeHost;
}

/** One mode of an editor's rail. */
export interface EditRailMode extends RailItem {
  /** What to do in it, in one plain sentence (the status line). */
  readonly hint: string;
  /** Its own keys, listed before the shared ones. */
  readonly keys?: readonly KeyHint[];
  /** What a drag and a click do with no tool armed, in one sentence (absent: orbit, and select what the editor edits). */
  readonly navigate?: string;
}

/** What an editor's settings column is drawn from. */
export interface EditModeView {
  readonly entity: ProjectedEntity;
  /** The rail's mode shown. */
  readonly mode: string;
  readonly host: EditModeHost;
}

/** What a scene's mode's column is drawn from. */
export interface SceneModeView {
  /** The rail's mode shown. */
  readonly mode: string;
  readonly host: EditModeHost;
  /** The object it was opened on (a double-click on a decal), selected on entering; null: none. */
  readonly focus: string | null;
}

/** What every edit mode declares. */
interface EditModeBase {
  /** Stable identifier (`[a-z][a-z0-9-]*`). */
  readonly kind: string;
  /** The header's editor name ("Terrain editor"). */
  readonly label: string;
  /** The Inspector's button that opens it ("Edit terrain"). */
  readonly action: string;
  /**
   * Whether a double-click on the object (Hierarchy, Scene view) opens it
   * (absent: yes). An editor every object of a common kind has (vertex paint
   * on any model) is opened from the Inspector only, so a double-click keeps
   * doing what it does for those objects.
   */
  readonly activates?: boolean;
  /** The rail, in order (Shift+1 is the first). */
  readonly rail: readonly EditRailMode[];
  /** The Scene view's tools (`SceneTool` names on the view's tool router) whose keys this mode routes. */
  readonly tools: readonly string[];
}

/** A scene's edit mode (decals): the whole scene is drawn, only the objects with its component are picked. */
export interface SceneEditModeKind extends EditModeBase {
  readonly scope: 'scene';
  /** The objects it opens on (a double-click, the Inspector's button), focused when it opens. */
  applies(e: ProjectedEntity): boolean;
  /** The objects it edits: those that carry this component (the view's isolation). */
  readonly component: string;
  /** The rail mode it opens in on an object (absent: the one last shown): a decal double-clicked opens in Select. */
  readonly focusMode?: string;
  /** The header's icon (an object icon kind). */
  readonly icon: string;
  /** A short fact for the header ("14 decals · 2 materials"). */
  meta?(view: SceneModeView): string;
  /** A note before the header's undo ("Only decals can be picked"). */
  readonly note?: string;
  /** The isolation chip's words over the view. */
  readonly chip: ReactNode;
  /** The settings column of the mode shown. */
  column(view: SceneModeView): ReactNode;
  /** What the editor lays over the Scene view in every mode (its tool armed, chips beside the isolation chip). */
  viewExtra?(view: SceneModeView): ReactNode;
}

/** An object's edit mode (a terrain, a model's vertex paint): it alone is drawn (Context: the rest too, not pickable). */
export interface ObjectEditModeKind extends EditModeBase {
  readonly scope?: 'object';
  /** Whether it edits this object. */
  applies(e: ProjectedEntity): boolean;
  /** A short fact for the header ("4 tiles · 2 × 2 · 256 m each"). */
  meta?(e: ProjectedEntity): string;
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
  /**
   * The object is shown on a stage of its own, not at a place in the scene
   * (a prefab): closing the mode puts the Scene view back where it was.
   */
  readonly ownStage?: boolean;
  /** The settings column of the mode shown. */
  column(view: EditModeView): ReactNode;
  /**
   * Other objects drawn and picked with the edited one (absent: none): what
   * belongs to it, as the rooms drawn on a block layer do.
   */
  companions?(e: ProjectedEntity, entities: readonly ProjectedEntity[]): readonly string[];
  /** What the editor lays over the Scene view in every mode (chips beside the isolation chip, a toast). */
  viewExtra?(view: EditModeView): ReactNode;
  /** Fields the Inspector leaves to the mode, by component (what only the mode edits: a terrain's tiles and rules). */
  readonly inspectorSkips?: Readonly<Record<string, readonly string[]>>;
  /**
   * Other objects that open this editor on the object they belong to, in
   * one of its rail's modes (the rooms drawn on a block layer open the
   * layer's block editor in Rooms & buildings); null: not one of them.
   */
  via?(e: ProjectedEntity, entities: readonly ProjectedEntity[]): EditModeVia | null;
}

/** Where an object that belongs to another opens that one's editor. */
export interface EditModeVia {
  /** The object the editor edits. */
  readonly entityId: string;
  /** The rail's mode it opens in. */
  readonly mode: string;
  /** The Inspector's button ("Edit in block editor"). */
  readonly label: string;
  /** Fields of the object's components the Inspector leaves to that mode. */
  readonly skips?: Readonly<Record<string, readonly string[]>>;
}

export type EditModeKind = ObjectEditModeKind | SceneEditModeKind;

/** Whether a mode edits the scene rather than one object. */
export const isSceneMode = (k: EditModeKind): k is SceneEditModeKind => k.scope === 'scene';

/** Every edit mode, in the order one is chosen for an object that several would edit. */
// The prefab editor first: a prefab's root on its stage is edited as the prefab, whatever else it is.
export const EDIT_MODES: readonly EditModeKind[] = [prefabMode, terrainMode, blockMode, vertexPaintMode, decalMode];

const BY_KIND = new Map(EDIT_MODES.map((k) => [k.kind, k]));

export function editModeKind(kind: string): EditModeKind | undefined {
  return BY_KIND.get(kind);
}

/** The editor an object opens on the object it belongs to (undefined: none). */
export function editModeVia(e: ProjectedEntity | null | undefined, entities: readonly ProjectedEntity[]): (EditModeVia & { kind: string }) | undefined {
  if (e === null || e === undefined) return undefined;
  for (const k of EDIT_MODES) {
    const v = !isSceneMode(k) ? (k.via?.(e, entities) ?? null) : null;
    if (v !== null) return { ...v, kind: k.kind };
  }
  return undefined;
}

/** The edit mode that edits an object (undefined: none); `activated`: the one a double-click opens. */
export function editModeFor(e: ProjectedEntity | null | undefined, activated = false): EditModeKind | undefined {
  return e === null || e === undefined ? undefined : EDIT_MODES.find((k) => k.applies(e) && (!activated || k.activates !== false));
}
