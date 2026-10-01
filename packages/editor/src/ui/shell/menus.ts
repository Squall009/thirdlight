/**
 * The editor's menu bar: File, Edit, GameObject (the descriptors' create
 * entries included), Component (the same list as the Inspector's "+ Add
 * component"), Gizmos, Window and Help. Each item says why it is disabled.
 */
import { resetLayout } from '../layout';
import type { Menu, MenuEntry, MenuItem } from '../MenuBar';
import type { ClientUiState } from '../../session/client';
import type { ProjectedEntity } from '../../session/projection';
import { addEntries, createEntries, withOtherScene } from '../../session/descriptor-fields';
import type { DescriptorRegistry } from '@thirdlight/project-model';
import type { SceneHeaderView } from '../Hierarchy';
import { resetWorkspaces } from '../workspace/EditorWindow';
import type { SnapSettings } from '../../session/snapping';
import type { Dispatch, SetStateAction } from 'react';
import type { WorkspaceAction, WorkspaceState } from '../../session/editor-window';
import type { SceneEditing } from './useSceneEditing';
import type { EntityEditing } from './useEntityEditing';
import type { EditorDialogsState } from './useEditorDialogs';
import { BOTTOM_TABS, type BottomTab } from './dock-tabs';
import { resetToolWindows, TOOL_WINDOWS, type ToolWindowId } from '../tools/tool-windows';

export interface EditorMenuInput {
  registry: DescriptorRegistry | null;
  settings: Record<string, unknown> | null;
  sceneHeaders: SceneHeaderView[] | null;
  closedScenes: { sceneId: string; name: string }[];
  entities: ProjectedEntity[];
  selected: ProjectedEntity | null;
  selectedId: string | null;
  /** The components the selection carries (the Component menu's add/remove state). */
  selectedComponents: Set<string>;
  ui: ClientUiState;
  snapping: boolean;
  setSnapping: Dispatch<SetStateAction<boolean>>;
  snapSettings: SnapSettings;
  gizmos: { icons: boolean; lights: boolean; colliders: boolean; gameplay: boolean };
  setGizmos: Dispatch<SetStateAction<{ icons: boolean; lights: boolean; colliders: boolean; gameplay: boolean }>>;
  effectPreview: boolean;
  setEffectPreview: Dispatch<SetStateAction<boolean>>;
  workspace: WorkspaceState;
  workspaceDispatch: Dispatch<WorkspaceAction>;
  setCenterTab: (key: 'scene' | 'game') => void;
  setBottomTab: (tab: BottomTab) => void;
  /** Show the project window searching for something (`t:prefab`: every prefab). */
  showProject: (search: string) => void;
  /** Open the Project Settings window (at the sub-tab last shown). */
  openProjectSettings: () => void;
  /** Open a floating tool window over the Scene view (or bring it to the front). */
  showToolWindow: (id: ToolWindowId) => void;
  /** GameObject → Create prefab from selection. */
  createPrefabFromSelection: () => void;
  /** GameObject → Block layer (a new layer, selected so its tools show). */
  createBlockLayer: () => void;
  resync: () => void;
  scene: SceneEditing;
  entity: EntityEditing;
  dialogs: EditorDialogsState;
}

export function editorMenus(input: EditorMenuInput): Menu[] {
  const { registry, settings, sceneHeaders, closedScenes, entities, selected, selectedId, selectedComponents, ui, snapping, setSnapping, snapSettings } = input;
  const { gizmos, setGizmos, effectPreview, setEffectPreview, workspace, workspaceDispatch, setCenterTab, setBottomTab, showProject, openProjectSettings, showToolWindow, createPrefabFromSelection, createBlockLayer, resync } = input;
  const { clipboardRef, copySelection, createCamera, createEmpty, createEntityAt, createFolder, createLight, del, duplicate, newBox, paste, redo, undo } = input.scene;
  const { addComponentTo, colliderFromModel, colliderFromModel3D, editComponent } = input.entity;
  const { setDialog, setExportState, setSnapDraft } = input.dialogs;
  const noSelection = selectedId === null;
  const selComponents = selectedComponents;
  const v4Reason = 'gameplay components need a v4 project (scenes)';
  const hasCamera = entities.some((e) => e.kind === 'camera');
  // The scene allows one directional and one ambient light.
  const hasDirectional = entities.some((e) => e.light?.type === 'directional');
  const hasAmbient = entities.some((e) => e.light?.type === 'ambient');
  const lightReason = (type: string) => `the scene already has its ${type} light (one per scene)`;
  const need = 'select an entity in the hierarchy first';
  // A folder carries no components.
  const noComponentTarget = noSelection || selected?.kind === 'folder';
  const needObject = noSelection ? need : 'a folder has no components';
  /**
   * The GameObject menu's create entries come from the component
   * descriptors (`create`): top-level items, and one submenu per `menu` name
   * (an existing submenu of that name, such as Light, takes its entries).
   */
  const createMenu = ((): { top: MenuEntry[]; into: Map<string, MenuEntry[]> } => {
    const into = new Map<string, MenuEntry[]>();
    const top: MenuEntry[] = [];
    if (registry === null) return { top, into };
    const scenesAll = [...(sceneHeaders ?? []), ...closedScenes];
    const other = scenesAll.find((sc) => sc.sceneId !== (sceneHeaders?.find((h) => h.active)?.sceneId ?? null))?.sceneId ?? null;
    const own = new Set(['Light']);
    const order: string[] = [];
    for (const entry of createEntries(registry, { dimension: settings?.['physics_dimension'] === 3 ? 3 : 2 })) {
      const needsScene = entry.otherScene.length > 0;
      const reason = sceneHeaders === null ? v4Reason : needsScene && (scenesAll.length < 2 || other === null) ? 'it moves the character to another scene: the project needs a second scene' : null;
      const item: MenuItem = {
        label: entry.label,
        disabled: reason !== null,
        reason: reason ?? '',
        onSelect: () => void createEntityAt(`Create ${entry.label.toLowerCase()}`, needsScene && other !== null ? withOtherScene(entry, other) : entry.args),
      };
      if (entry.menu === null) {
        top.push(item);
        continue;
      }
      if (!into.has(entry.menu)) {
        into.set(entry.menu, []);
        if (!own.has(entry.menu)) order.push(entry.menu);
      }
      into.get(entry.menu)!.push(item);
    }
    for (const m of order) top.push({ label: m, items: into.get(m)! });
    return { top: top.length > 0 ? ['separator', ...top] : top, into };
  })();
  const menus: Menu[] = [
    {
      label: 'File',
      items: [
        { label: 'New project…', onSelect: () => { window.location.search = ''; } },
        { label: 'Open project…', onSelect: () => { window.location.search = ''; } },
        'separator',
        { label: 'Export game…', onSelect: () => { setExportState({ busy: false, result: null, error: null }); setDialog('export'); } },
        'separator',
        { label: 'Project Settings…', onSelect: () => openProjectSettings() },
        { label: 'Reload from disk', onSelect: () => resync() },
      ],
    },
    {
      label: 'Edit',
      items: [
        { label: 'Undo', shortcut: 'Ctrl+Z', disabled: ui.undoDepth === 0, reason: 'nothing to undo', onSelect: () => void undo() },
        { label: 'Redo', shortcut: 'Ctrl+Y', disabled: ui.redoDepth === 0, reason: 'nothing to redo', onSelect: () => void redo() },
        'separator',
        { label: 'Duplicate', shortcut: 'Ctrl+D', disabled: noSelection, reason: need, onSelect: () => void duplicate() },
        { label: 'Copy', shortcut: 'Ctrl+C', disabled: noSelection, reason: need, onSelect: () => void copySelection() },
        { label: 'Paste', shortcut: 'Ctrl+V', disabled: clipboardRef.current === null, reason: 'copy something first', onSelect: () => void paste() },
        { label: 'Delete', shortcut: 'Del', disabled: noSelection, reason: need, onSelect: () => void del() },
        'separator',
        { label: `Snapping: ${snapping ? 'on' : 'off'}`, onSelect: () => setSnapping((v) => !v) },
        { label: 'Snapping settings…', onSelect: () => { setSnapDraft({ translateM: String(snapSettings.translateM), rotateDeg: String(snapSettings.rotateDeg), scale: String(snapSettings.scale), cellTops: snapSettings.cellTops }); setDialog('snapping'); } },
      ],
    },
    {
      label: 'GameObject',
      items: [
        { label: 'Folder', onSelect: () => void createFolder() },
        { label: 'Create empty', onSelect: () => void createEmpty() },
        { label: 'Box', onSelect: () => void newBox() },
        { label: 'Camera', disabled: hasCamera, reason: 'the scene already has its camera (one per scene)', onSelect: () => void createCamera() },
        { label: 'Light', items: [
          { label: 'Directional light', disabled: hasDirectional, reason: lightReason('directional'), onSelect: () => void createLight('directional') },
          { label: 'Ambient light', disabled: hasAmbient, reason: lightReason('ambient'), onSelect: () => void createLight('ambient') },
          { label: 'Point light', onSelect: () => void createLight('point') },
          { label: 'Spot light', onSelect: () => void createLight('spot') },
          { label: 'Hemisphere light', disabled: entities.some((e) => e.light?.type === 'hemisphere'), reason: 'the scene already has a hemisphere light', onSelect: () => void createLight('hemisphere') },
          ...(createMenu.into.get('Light') ?? []),
        ] },
        // The create entries of the component descriptors (a submenu of the same name gains its entries).
        ...createMenu.top,
        'separator',
        // The project window lists them: a model is dragged in or placed from its Inspector, a prefab copy placed from its.
        { label: 'Model from asset…', onSelect: () => showProject('t:model') },
        { label: 'Instance set…', onSelect: () => setDialog('instances') },
        { label: 'Block layer', onSelect: () => createBlockLayer() },
        { label: 'Prefab copy…', onSelect: () => showProject('t:prefab') },
        'separator',
        { label: 'Create prefab from selection', disabled: noSelection, reason: need, onSelect: () => createPrefabFromSelection() },
      ],
    },
    {
      label: 'Component',
      // The same list as the Inspector's "+ Add component" (the descriptors):
      // one item per component, presets as a submenu, and why an item cannot be added.
      items: (() => {
        if (registry === null) return [{ label: 'Loading components…', disabled: true, reason: 'the component descriptions are not loaded yet', onSelect: () => undefined }];
        const entries = addEntries(registry, selComponents, { folder: selected?.kind === 'folder', dimension: settings?.['physics_dimension'] === 3 ? 3 : 2 });
        const out: MenuEntry[] = [];
        let category: string | null = null;
        for (const c of registry.components) {
          const mine = entries.filter((e) => e.component === c.name);
          if (mine.length === 0) continue;
          if (category !== null && category !== c.category) out.push('separator');
          category = c.category;
          const first = mine[0]!;
          const blocked = noComponentTarget ? needObject : first.reason;
          const pickReason = first.pick.length > 0 ? `choose its ${first.pick.map((p) => p.split('/').pop()).join(', ')} in the Inspector (+ Add component)` : null;
          const add = (value: unknown): void => {
            if (selectedId !== null) void addComponentTo(selectedId, c.name, value as Record<string, unknown>);
          };
          if (mine.length > 1) {
            const items: MenuEntry[] = mine.map((e) => ({ label: e.label.slice(c.label.length + 2), onSelect: () => add(e.value) }));
            // A collider from the model's outline.
            if (c.name === 'collider' && selectedId !== null) {
              const id = selectedId;
              // A 3D project makes 3D colliders from the model.
              if (settings?.['physics_dimension'] === 3) items.push({ label: 'Box from model', onSelect: () => void colliderFromModel3D(id, 'box') }, { label: 'Convex hull from model', onSelect: () => void colliderFromModel3D(id, 'convex') }, { label: 'Mesh from model', onSelect: () => void colliderFromModel3D(id, 'mesh') });
              else items.push({ label: 'Box from model', onSelect: () => void colliderFromModel(id, 'box') }, { label: 'Polygon from model outline', onSelect: () => void colliderFromModel(id, 'polygon') });
            }
            out.push({ label: c.label, disabled: blocked !== null, reason: blocked ?? '', items });
          } else {
            out.push({ label: c.label, disabled: blocked !== null || pickReason !== null, reason: blocked ?? pickReason ?? '', onSelect: () => add(first.value) });
          }
        }
        const removable = registry.components.filter((c) => selComponents.has(c.name) && c.name !== 'transform' && c.name !== 'prefab' && c.name !== 'folder');
        out.push('separator');
        out.push({ label: 'Remove', disabled: noSelection || removable.length === 0, reason: noSelection ? need : 'no removable components', items: removable.map((c) => ({ label: c.label, onSelect: () => selectedId !== null && void editComponent(selectedId, c.name, null) })) });
        return out;
      })(),
    },
    {
      label: 'Gizmos',
      items: [
        { label: `Icons: ${gizmos.icons ? 'on' : 'off'}`, onSelect: () => setGizmos((g) => ({ ...g, icons: !g.icons })) },
        { label: `Light ranges: ${gizmos.lights ? 'on' : 'off'}`, onSelect: () => setGizmos((g) => ({ ...g, lights: !g.lights })) },
        { label: `Collider outlines: ${gizmos.colliders ? 'on' : 'off'}`, onSelect: () => setGizmos((g) => ({ ...g, colliders: !g.colliders })) },
        { label: `Gameplay paths and areas: ${gizmos.gameplay ? 'on' : 'off'}`, onSelect: () => setGizmos((g) => ({ ...g, gameplay: !g.gameplay })) },
        { label: `Play selected effects: ${effectPreview ? 'on' : 'off'}`, onSelect: () => setEffectPreview((v) => !v) },
      ],
    },
    {
      label: 'Window',
      items: [
        { label: 'Scene', onSelect: () => setCenterTab('scene') },
        { label: 'Game', onSelect: () => setCenterTab('game') },
        {
          label: 'Editor window',
          disabled: workspace.docs.length === 0,
          reason: 'no item is open (double-click one in the project window)',
          onSelect: () => workspaceDispatch({ type: 'show', on: true }),
        },
        { label: 'Next tab', shortcut: 'Ctrl+Tab', onSelect: () => workspaceDispatch({ type: 'cycle', dir: 1 }) },
        { label: 'Previous tab', shortcut: 'Ctrl+Shift+Tab', onSelect: () => workspaceDispatch({ type: 'cycle', dir: -1 }) },
        { label: workspace.maximized ? 'Restore docks' : 'Maximize centre area', onSelect: () => workspaceDispatch({ type: 'maximize' }) },
        'separator',
        // Scene settings float over the Scene view (it previews them): the editor window steps aside.
        ...TOOL_WINDOWS.map<MenuEntry>((t) => ({ label: t.label, onSelect: () => showToolWindow(t.id) })),
        'separator',
        // A tool window shows in the default view: the editor window steps aside.
        ...BOTTOM_TABS.map<MenuEntry>((t) => ({ label: t.label, onSelect: () => { workspaceDispatch({ type: 'show', on: false }); setBottomTab(t.id); } })),
        'separator',
        { label: 'Full screen', shortcut: 'Shift+F11', onSelect: () => { if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined); else void document.documentElement.requestFullscreen().catch(() => undefined); } },
        { label: 'Reset layout', onSelect: () => { resetLayout(); resetWorkspaces(); resetToolWindows(); window.location.reload(); } },
      ],
    },
    {
      label: 'Help',
      items: [
        { label: 'Keyboard shortcuts', onSelect: () => setDialog('shortcuts') },
        { label: 'About Thirdlight', onSelect: () => setDialog('about') },
      ],
    },
  ];
  return menus;
}

/** The Hierarchy's context menu (right-click a row): what the menu bar does to the selection. */
export function hierarchyContextMenu(scene: Pick<SceneEditing, 'duplicate' | 'copySelection' | 'del'>, createPrefabFromSelection: () => void): MenuEntry[] {
  return [
    { label: 'Create prefab from selection', onSelect: createPrefabFromSelection },
    'separator',
    { label: 'Duplicate', shortcut: 'Ctrl+D', onSelect: () => void scene.duplicate() },
    { label: 'Copy', shortcut: 'Ctrl+C', onSelect: () => void scene.copySelection() },
    { label: 'Delete', shortcut: 'Del', onSelect: () => void scene.del() },
  ];
}
