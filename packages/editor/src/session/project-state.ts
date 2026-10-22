/**
 * The editor's copy of the project content (everything but the scenes'
 * entities, the asset summaries and the prefabs, which have projections of
 * their own): read whole with each full state, then advanced from the same
 * applied change records the scene projection uses, so an edit made elsewhere
 * (MCP, another tab) shows without a reload.
 *
 * It is the base of the session client: the panels read the content through
 * the client's `get…` methods, and the transport above it fills and advances
 * the copy. It sends nothing itself.
 */

import { applyGraphOpsLocal } from '../graph/model';
import type { BlockChunk, BlockLayerComponent, BlockRegion, BlockStamp, BlockType, CellField, KitDef, SaveSchema } from '@thirdlight/project-model';
import type { DialogueDocument, DialogueSettings, DialogueSpeaker } from '@thirdlight/project-model';
import type { AnimatorController, DescriptorRegistry, GraphDocument, GraphKindDef, EnvironmentConfig, SceneEnvironment, InputConfig, LightingBake, MaterialDef, EffectDef, ScriptLibrary, UiDocument, UiTheme, TimelineAsset, GameMode, EventCue, GameShell, LoadableEntry } from '@thirdlight/project-model';
import type { ChangeData } from '@thirdlight/commands';

/** One block layer as the editor holds it (queryBlocks). */
export interface BlockLayerView {
  component: BlockLayerComponent;
  chunks: Map<string, BlockChunk>;
  regions: BlockRegion[];
}

/** A keyed list with one record replaced or removed (null), kept in id order. */
function replaced<T>(list: readonly T[], idOf: (x: T) => string, id: string, next: T | null): T[] {
  const rest = list.filter((x) => idOf(x) !== id);
  return next === null ? rest : [...rest, structuredClone(next)].sort((a, b) => (idOf(a) < idOf(b) ? -1 : 1));
}

export class SessionProjectState {
  /** Whether the last full state read the project content (`queryGameConfig`). */
  protected contentLoaded = false;
  /**
   * The last-known `content.settings` map: `null` (unknown) until a full
   * state or an applied `setSettings` change (whose `next` is the full map)
   * carries it. The settings panel seeds from the registry defaults in the
   * unknown case and submits only the touched keys (partial semantics
   * preserve the rest).
   */
  private settings: Record<string, unknown> | null = null;
  /** The project tag registry (from `queryGameConfig`, then `setTags` changes). */
  private tags: { bit: number; name: string }[] = [];
  /** The project materials and the environment (from queryGameConfig, then changes). */
  protected materials: MaterialDef[] = [];
  private environment: EnvironmentConfig | null = null;
  /** Each scene's look (scenes without one are not listed). */
  protected sceneLooks = new Map<string, SceneEnvironment>();
  /** Each scene's bake (from queryGameConfig, then setLighting changes). */
  private lighting: Record<string, LightingBake> = {};
  /** The animator controllers. */
  protected animators: AnimatorController[] = [];
  /** The standalone graph documents and the registered graph kinds (from queryGameConfig, then changes). */
  private graphs: GraphDocument[] = [];
  private graphKinds: Record<string, GraphKindDef> = {};
  /** The visual effects (from queryGameConfig, then setEffect / graphEdit changes). */
  private effects: EffectDef[] = [];
  /** The shared script libraries (from queryGameConfig, then setScriptLibrary changes). */
  private scriptLibraries: ScriptLibrary[] = [];
  /** Block types, the cell metadata schema and stamps (from queryGameConfig, then changes). */
  private blockTypes: BlockType[] = [];
  private cellFields: CellField[] = [];
  private blockStamps: BlockStamp[] = [];
  /** The kits (from queryGameConfig, then setKit changes). */
  private kits: KitDef[] = [];
  /** Every block layer's cells (queryBlocks; the chunks a change names are read again). */
  protected blockLayers = new Map<string, BlockLayerView>();
  /** Bumped whenever a layer's cells or the layer list change (the Scene view re-meshes). */
  protected blockRevision = 0;
  /** The project UI documents and themes (from queryGameConfig, then setUi changes). */
  private uiDocuments: UiDocument[] = [];
  private uiThemes: UiTheme[] = [];
  /**
   * The conversations read so far (by id, from the index: a project may hold
   * thousands of lines), the speaker registry and the dialogue settings (from
   * queryGameConfig), then setDialogue / graphEdit changes.
   */
  protected dialogues: DialogueDocument[] = [];
  private speakers: DialogueSpeaker[] = [];
  private dialogueSettings: DialogueSettings | null = null;
  /** The timelines (from queryGameConfig, then setTimeline changes). */
  private timelines: TimelineAsset[] = [];
  /** The project's input actions (null = the defaults). */
  private input: InputConfig | null = null;
  /** The project's named collision layers (from `queryGameConfig`, then `setCollisionLayers` changes). */
  private collisionLayers: string[] = [];
  /** The light layer names by number (from `queryGameConfig`, then `setLightLayers` changes). */
  private lightLayers: string[] = [];
  /** The game modes and behavior groups (from `queryGameConfig`, then setModes / setBehaviorGroups changes). */
  private modes: GameMode[] = [];
  private behaviorGroups: string[] = [];
  /** The event → cue table (from `queryGameConfig`, then `setEventCues` changes). */
  private eventCues: EventCue[] = [];
  /** The resources' addresses and labels (an asset's are on its summary). */
  private loadable: LoadableEntry[] = [];
  /** The game shell (from `queryGameConfig`, then `setShell` changes; null: none). */
  private shell: GameShell | null = null;
  /** The project save schema (from `queryGameConfig`, then `setSaveSchema` changes). */
  private saveSchema: SaveSchema | null = null;
  private inputDefaults: InputConfig = { actions: [] };
  /**
   * The component and content descriptor registry (the editor
   * may import project-model types only, so it arrives with the first
   * `queryGameConfig`; it is static, fetched once).
   */
  protected descriptors: DescriptorRegistry | null = null;

  /**
   * Take the content a full state's `queryGameConfig` carried. The
   * conversations are dropped (they are read by id when they are opened or
   * played); the caller reads the open ones again.
   */
  protected hydrateContent(g: Record<string, unknown>): void {
    const descriptors = (g as { descriptors?: DescriptorRegistry }).descriptors;
    if (descriptors !== undefined) this.descriptors = descriptors;
    this.contentLoaded = true;
    const tags = (g as { tags?: { bit: number; name: string }[] }).tags;
    this.tags = Array.isArray(tags) ? tags.map((t) => ({ bit: t.bit, name: t.name })) : [];
    const mats = (g as { materials?: MaterialDef[] }).materials;
    this.materials = Array.isArray(mats) ? structuredClone(mats) : [];
    const env = (g as { environment?: EnvironmentConfig | null }).environment;
    this.environment = env !== undefined && env !== null ? structuredClone(env) : null;
    const lighting = (g as { lighting?: Record<string, LightingBake> | null }).lighting;
    this.lighting = lighting !== undefined && lighting !== null ? structuredClone(lighting) : {};
    const animators = (g as { animators?: AnimatorController[] | null }).animators;
    this.animators = Array.isArray(animators) ? structuredClone(animators) : [];
    const input = (g as { input?: InputConfig | null }).input;
    this.input = input !== undefined && input !== null ? structuredClone(input) : null;
    const layers = (g as { collisionLayers?: string[] }).collisionLayers;
    this.collisionLayers = Array.isArray(layers) ? [...layers] : [];
    const lightLayers = (g as { lightLayers?: string[] }).lightLayers;
    this.lightLayers = Array.isArray(lightLayers) ? [...lightLayers] : [];
    const modes = (g as { modes?: GameMode[] }).modes;
    this.modes = Array.isArray(modes) ? structuredClone(modes) : [];
    const groups = (g as { behaviorGroups?: string[] }).behaviorGroups;
    this.behaviorGroups = Array.isArray(groups) ? [...groups] : [];
    const cues = (g as { eventCues?: EventCue[] }).eventCues;
    this.eventCues = Array.isArray(cues) ? structuredClone(cues) : [];
    const loadable = (g as { loadable?: LoadableEntry[] }).loadable;
    this.loadable = Array.isArray(loadable) ? structuredClone(loadable) : [];
    const shell = (g as { shell?: GameShell | null }).shell;
    this.shell = shell !== undefined && shell !== null ? structuredClone(shell) : null;
    const saveSchema = (g as { saveSchema?: SaveSchema | null }).saveSchema;
    this.saveSchema = saveSchema !== undefined && saveSchema !== null ? structuredClone(saveSchema) : null;
    const defaults = (g as { inputDefaults?: InputConfig }).inputDefaults;
    if (defaults !== undefined) this.inputDefaults = structuredClone(defaults);
    // The settings map travels with the content (null before: only changes carried it).
    const settings = (g as { settings?: Record<string, unknown> }).settings;
    if (settings !== undefined && settings !== null && typeof settings === 'object') this.settings = { ...settings };
    const graphs = (g as { graphs?: GraphDocument[] }).graphs;
    this.graphs = Array.isArray(graphs) ? structuredClone(graphs) : [];
    const effects = (g as { effects?: EffectDef[] }).effects;
    this.effects = Array.isArray(effects) ? structuredClone(effects) : [];
    const libraries = (g as { scriptLibraries?: ScriptLibrary[] }).scriptLibraries;
    this.scriptLibraries = Array.isArray(libraries) ? structuredClone(libraries) : [];
    // Block types, cell fields and stamps.
    const blockTypes = (g as { blockTypes?: BlockType[] }).blockTypes;
    this.blockTypes = Array.isArray(blockTypes) ? structuredClone(blockTypes) : [];
    const cellFields = (g as { cellFields?: CellField[] }).cellFields;
    this.cellFields = Array.isArray(cellFields) ? structuredClone(cellFields) : [];
    const blockStamps = (g as { blockStamps?: BlockStamp[] }).blockStamps;
    this.blockStamps = Array.isArray(blockStamps) ? structuredClone(blockStamps) : [];
    const kits = (g as { kits?: KitDef[] }).kits;
    this.kits = Array.isArray(kits) ? structuredClone(kits) : [];
    const uiDocs = (g as { uiDocuments?: UiDocument[] }).uiDocuments;
    this.uiDocuments = Array.isArray(uiDocs) ? structuredClone(uiDocs) : [];
    const uiThemes = (g as { uiThemes?: UiTheme[] }).uiThemes;
    this.uiThemes = Array.isArray(uiThemes) ? structuredClone(uiThemes) : [];
    this.dialogues = [];
    const speakers = (g as { speakers?: DialogueSpeaker[] }).speakers;
    this.speakers = Array.isArray(speakers) ? structuredClone(speakers) : [];
    const ds = (g as { dialogueSettings?: DialogueSettings | null }).dialogueSettings;
    this.dialogueSettings = ds !== undefined && ds !== null ? structuredClone(ds) : null;
    const timelines = (g as { timelines?: TimelineAsset[] }).timelines;
    this.timelines = Array.isArray(timelines) ? structuredClone(timelines) : [];
    const kinds = (g as { graphKinds?: Record<string, GraphKindDef> }).graphKinds;
    if (kinds !== undefined) this.graphKinds = structuredClone(kinds);
  }

  /**
   * Advance the copy from one applied change (the `setSettings` change
   * carries the full next map). False when the change does not fit the copy
   * (a graph edit on a graph that is not what the backend edited): the copy
   * is stale and the caller reads everything again.
   */
  protected applyContentChange(change: ChangeData): boolean {
    if (change.type === 'setSettings') {
      this.settings = { ...(change.next as Record<string, unknown>) };
    } else if (change.type === 'setTags') {
      this.tags = change.next.map((t) => ({ bit: t.bit, name: t.name }));
    } else if (change.type === 'setMaterial') {
      // One material before/after (null = none).
      this.materials = replaced(this.materials, (m) => m.materialId, change.materialId, change.next);
    } else if (change.type === 'setEnvironment') {
      // A scene's look, or the project's quality and presets.
      if (change.sceneId !== undefined) {
        if (change.next === null) this.sceneLooks.delete(change.sceneId);
        else this.sceneLooks.set(change.sceneId, structuredClone(change.next as SceneEnvironment));
      } else this.environment = change.next === null ? null : structuredClone(change.next as EnvironmentConfig);
    } else if (change.type === 'setSceneIndex') {
      // A scene the index gains brings the look the change carries (the looks listed are those of the
      // scenes added or removed; the wire leaves out `previous`); a removed one takes its look along.
      const kept = new Set(change.next.scenes.map((r) => r.sceneId));
      for (const id of [...this.sceneLooks.keys()]) if (!kept.has(id)) this.sceneLooks.delete(id);
      for (const [id, look] of Object.entries(change.environments ?? {})) if (kept.has(id)) this.sceneLooks.set(id, structuredClone(look));
    } else if (change.type === 'setInput') {
      this.input = change.next === null ? null : structuredClone(change.next);
    } else if (change.type === 'setCollisionLayers') {
      this.collisionLayers = [...change.next];
    } else if (change.type === 'setLightLayers') {
      this.lightLayers = [...change.next];
    } else if (change.type === 'setModes') {
      this.modes = structuredClone(change.next);
    } else if (change.type === 'setBehaviorGroups') {
      this.behaviorGroups = [...change.next];
    } else if (change.type === 'setEventCues') {
      this.eventCues = structuredClone(change.next);
    } else if (change.type === 'setLabels' || change.type === 'setAddress') {
      // Resources' entries (assets' are the content projection's).
      const touched = change.items.filter((i) => i.kind !== 'asset');
      if (touched.length > 0) {
        const key = (e: { kind: string; id: string }): string => `${e.kind}:${e.id}`;
        const gone = new Set(touched.map(key));
        const kept = this.loadable.filter((e) => !gone.has(key(e)));
        for (const i of touched) if (i.next.address !== undefined || (i.next.labels ?? []).length > 0) kept.push({ kind: i.kind, id: i.id, ...structuredClone(i.next) });
        this.loadable = kept.sort((a, b) => (key(a) < key(b) ? -1 : 1));
      }
    } else if (change.type === 'setShell') {
      this.shell = change.next === null ? null : structuredClone(change.next);
    } else if (change.type === 'setSaveSchema') {
      this.saveSchema = change.next === null ? null : structuredClone(change.next);
    } else if (change.type === 'setAnimator') {
      // One controller before/after (null = none).
      this.animators = replaced(this.animators, (c) => c.controllerId, change.controllerId, change.next);
    } else if (change.type === 'setGraph') {
      this.graphs = replaced(this.graphs, (g) => g.graphId, change.graphId, change.next);
    } else if (change.type === 'setScriptLibrary') {
      // One library before/after (null = none); its dependents' records travel in the same change.
      this.scriptLibraries = replaced(this.scriptLibraries, (l) => l.libraryId, change.libraryId, change.next);
    } else if (change.type === 'setScriptLibraries') {
      // A staged commit - several libraries before/after at once.
      let list = this.scriptLibraries;
      for (const l of change.libraries) {
        const rest = list.filter((x) => x.libraryId !== l.libraryId);
        list = l.next === null ? rest : [...rest, structuredClone(l.next)];
      }
      this.scriptLibraries = [...list].sort((a, b) => (a.libraryId < b.libraryId ? -1 : 1));
    } else if (change.type === 'setTimeline') {
      // One timeline before/after (null = none).
      this.timelines = replaced(this.timelines, (t) => t.timelineId, change.timelineId, change.next);
    } else if (change.type === 'setUi') {
      // One UI document or theme before/after (null = none).
      if (change.uiKind === 'document') this.uiDocuments = replaced(this.uiDocuments, (d) => d.uiDocumentId, change.id, change.next as UiDocument | null);
      else this.uiThemes = replaced(this.uiThemes, (t) => t.uiThemeId, change.id, change.next as UiTheme | null);
    } else if (change.type === 'setDialogue') {
      // One conversation, speaker or the settings before/after (null = none).
      if (change.dialogueKind === 'dialogue') this.dialogues = replaced(this.dialogues, (d) => d.dialogueId, change.id, change.next as DialogueDocument | null);
      else if (change.dialogueKind === 'speaker') this.speakers = replaced(this.speakers, (x) => x.speakerId, change.id, change.next as DialogueSpeaker | null);
      else this.dialogueSettings = change.next === null ? null : structuredClone(change.next as DialogueSettings);
    } else if (change.type === 'setKit') {
      // One kit before/after (null = none).
      this.kits = replaced(this.kits, (k) => k.kitId, change.kitId, change.next);
    } else if (change.type === 'setEffect') {
      // One effect before/after (null = none).
      this.effects = replaced(this.effects, (e) => e.effectId, change.effectId, change.next);
    } else if (change.type === 'graphEdit') {
      return this.applyGraphEdit(change);
    } else if (change.type === 'setLighting') {
      if (change.next === null) delete this.lighting[change.sceneId];
      else this.lighting[change.sceneId] = structuredClone(change.next);
    } else if (change.type === 'setBlockType') {
      // One block type before/after (null = none); the Scene view re-meshes.
      this.blockTypes = replaced(this.blockTypes, (t) => t.blockId, change.blockId, change.next);
      this.blockRevision += 1;
    } else if (change.type === 'setCellFields') {
      this.cellFields = structuredClone(change.next);
    } else if (change.type === 'setBlockStamp') {
      this.blockStamps = replaced(this.blockStamps, (x) => x.stampId, change.stampId, change.next);
    }
    return true;
  }

  /**
   * Advance the owner's graph from the change's ops (the backend applied and
   * validated the same ops). False when the copy does not fit.
   */
  private applyGraphEdit(change: Extract<ChangeData, { type: 'graphEdit' }>): boolean {
    if (change.owner.kind === 'graph') {
      const doc = this.graphs.find((g) => g.graphId === change.owner.id);
      const next = doc !== undefined ? applyGraphOpsLocal(doc.graph, change.ops) : null;
      if (doc === undefined || next === null) return false;
      this.graphs = this.graphs.map((g) => (g === doc ? { ...g, graph: next } : g));
    } else if (change.owner.kind === 'material') {
      // A graph material's graph.
      const m = this.materials.find((x) => x.materialId === change.owner.id);
      const next = m?.graph !== undefined ? applyGraphOpsLocal(m.graph, change.ops) : null;
      if (m === undefined || next === null) return false;
      this.materials = this.materials.map((x) => (x === m ? { ...x, graph: next } : x));
    } else if (change.owner.kind === 'dialogue') {
      // A conversation's graph.
      const d = this.dialogues.find((x) => x.dialogueId === change.owner.id);
      const next = d !== undefined ? applyGraphOpsLocal(d.graph, change.ops) : null;
      // A conversation this editor has not read is read when it is opened: nothing to advance.
      if (d !== undefined && next === null) return false;
      if (d !== undefined && next !== null) this.dialogues = this.dialogues.map((x) => (x === d ? { ...x, graph: next } : x));
    } else if (change.owner.kind === 'effect') {
      // One system's graph (owner id "<effectId>/<systemId>").
      const [effectId, systemId] = change.owner.id.split('/');
      const e = this.effects.find((x) => x.effectId === effectId);
      const sys = e?.systems.find((x) => x.systemId === systemId);
      const next = sys !== undefined ? applyGraphOpsLocal(sys.graph, change.ops) : null;
      if (e === undefined || sys === undefined || next === null) return false;
      this.effects = this.effects.map((x) => (x === e ? { ...x, systems: x.systems.map((y) => (y === sys ? { ...y, graph: next } : y)) } : x));
    }
    return true;
  }

  /** Whether the project content has been read from the backend (vs unknown). */
  getContentLoaded(): boolean {
    return this.contentLoaded;
  }

  /** The project tag registry, ascending bit. */
  getTags(): { bit: number; name: string }[] {
    return this.tags.map((t) => ({ ...t }));
  }

  /** The project materials. */
  getMaterials(): MaterialDef[] {
    return structuredClone(this.materials);
  }

  /** The project's part of the environment: the default quality and the presets (null = none). */
  getEnvironment(): EnvironmentConfig | null {
    return this.environment === null ? null : structuredClone(this.environment);
  }

  /** A scene's look: sky, fog, post, wind (null: the engine defaults). */
  getSceneEnvironment(sceneId: string): SceneEnvironment | null {
    const look = this.sceneLooks.get(sceneId);
    return look === undefined ? null : structuredClone(look);
  }

  /**
   * What the Scene view and the previews show for an active scene: its look
   * with the project's quality and presets (Unity's rule: with several scenes
   * open the active scene's settings apply). Null when neither sets anything.
   */
  protected shownEnvironment(activeScene: string | null): (EnvironmentConfig & SceneEnvironment) | null {
    const look = activeScene !== null ? this.sceneLooks.get(activeScene) : undefined;
    if (look === undefined && this.environment === null) return null;
    return structuredClone({ ...(this.environment ?? {}), ...(look ?? {}) });
  }

  /** The project save schema (null: no project saves). */
  getSaveSchema(): SaveSchema | null {
    return this.saveSchema === null ? null : structuredClone(this.saveSchema);
  }

  /** The project's named collision layers ("default" is implicit). */
  getCollisionLayers(): string[] {
    return [...this.collisionLayers];
  }

  /** The light layer names by number (index n names layer n + 1; "" or missing: unnamed). */
  getLightLayers(): string[] {
    return [...this.lightLayers];
  }

  /** The game modes (the first is the start mode). */
  getModes(): GameMode[] {
    return structuredClone(this.modes);
  }

  /** The behavior group names. */
  getBehaviorGroups(): string[] {
    return [...this.behaviorGroups];
  }

  /** A resource's address and labels (null: none). */
  getLoadable(kind: string, id: string): LoadableEntry | null {
    const e = this.loadable.find((x) => x.kind === kind && x.id === id);
    return e === undefined ? null : structuredClone(e);
  }

  /** The event → cue table. */
  getEventCues(): EventCue[] {
    return structuredClone(this.eventCues);
  }

  /** The game shell (null: none). */
  getShell(): GameShell | null {
    return this.shell === null ? null : structuredClone(this.shell);
  }

  /** The project's input actions (null = the defaults). */
  getInput(): InputConfig | null {
    return this.input === null ? null : structuredClone(this.input);
  }

  /** The descriptor registry (null until the first full state). */
  getDescriptors(): DescriptorRegistry | null {
    return this.descriptors;
  }

  /** The default input actions (what a project without its own uses). */
  getInputDefaults(): InputConfig {
    return structuredClone(this.inputDefaults);
  }

  /** The standalone graph documents (the editor treats them as read-only values). */
  getGraphs(): readonly GraphDocument[] {
    return this.graphs;
  }

  /** The kits (the editor treats them as read-only values). */
  getKits(): readonly KitDef[] {
    return this.kits;
  }

  /** The visual effects (the editor treats them as read-only values). */
  getEffects(): readonly EffectDef[] {
    return this.effects;
  }

  /** The project UI documents (the editor treats them as read-only values). */
  getUiDocuments(): readonly UiDocument[] {
    return this.uiDocuments;
  }

  /** The project UI themes. */
  getUiThemes(): readonly UiTheme[] {
    return this.uiThemes;
  }

  /** The conversations read so far (read-only values; `catalog.ensureResources('dialogue', ids)` reads more). */
  getDialogues(): readonly DialogueDocument[] {
    return this.dialogues;
  }

  /** The speaker registry. */
  getSpeakers(): readonly DialogueSpeaker[] {
    return this.speakers;
  }

  /** The dialogue settings (null: the defaults). */
  getDialogueSettings(): DialogueSettings | null {
    return this.dialogueSettings;
  }

  /** The timelines (the editor treats them as read-only values). */
  getTimelines(): readonly TimelineAsset[] {
    return this.timelines;
  }

  /** The shared script libraries (the editor treats them as read-only values). */
  getScriptLibraries(): readonly ScriptLibrary[] {
    return this.scriptLibraries;
  }

  /** The registered graph kinds (node catalogues, port types, rules), by kind id. */
  getGraphKinds(): Readonly<Record<string, GraphKindDef>> {
    return this.graphKinds;
  }

  /** The animator controllers. */
  getAnimators(): AnimatorController[] {
    return structuredClone(this.animators);
  }

  /** The block types (content.blockTypes). */
  getBlockTypes(): readonly BlockType[] {
    return this.blockTypes;
  }

  /** The cell metadata schema (content.cellFields). */
  getCellFields(): readonly CellField[] {
    return this.cellFields;
  }

  /** The saved stamps (content.blockStamps). */
  getBlockStamps(): readonly BlockStamp[] {
    return this.blockStamps;
  }

  /** Every block layer's component, chunks and regions (entity id → layer). */
  getBlockLayers(): ReadonlyMap<string, BlockLayerView> {
    return this.blockLayers;
  }

  /** Bumped whenever a layer's cells, the layer list or the block types change. */
  getBlockRevision(): number {
    return this.blockRevision;
  }

  /** Each scene's bake. */
  getLighting(): Record<string, LightingBake> {
    return structuredClone(this.lighting);
  }

  getSettings(): Record<string, unknown> | null {
    return this.settings === null ? null : { ...this.settings };
  }
}
