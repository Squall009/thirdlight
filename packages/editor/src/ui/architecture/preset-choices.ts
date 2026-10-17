/**
 * The architecture presets a picker offers, and their grouping by source.
 *
 * A project that added a kit pack holds the kit's presets beside the
 * engine's starters ("Room (Basic Kit)", "Room (starter)"); a flat list of
 * both reads as two of everything. The Rooms pickers group them: the kit the
 * rooms take their pieces from first, then the other kits, then the
 * project's presets in no kit, then the engine's starters.
 */
import type { GraphDocument, KitDef } from '@thirdlight/project-model';
import { ARCHITECTURE_PRESET_KIND, ARCHITECTURE_STARTER_GRAPHS } from '@thirdlight/runtime';

/** A picker's choice: its value, its text, and the heading of the group it is listed under (absent: none). */
export type PickOption = readonly [value: string, text: string, group?: string];

/** Every preset's id and name: the project's, then the engine's starters it does not replace. */
export function presetChoices(graphs: readonly GraphDocument[]): [string, string][] {
  const own = graphs.filter((g) => g.kind === ARCHITECTURE_PRESET_KIND).map((g) => [g.graphId, g.name] as [string, string]);
  const ids = new Set(own.map(([id]) => id));
  return [...own, ...ARCHITECTURE_STARTER_GRAPHS.filter((g) => g.kind === ARCHITECTURE_PRESET_KIND && !ids.has(g.graphId)).map((g) => [g.graphId, g.name] as [string, string])];
}

/** The heading of the project's presets that no kit lists. */
export const PROJECT_PRESETS_GROUP = 'This project';
/** The heading of the engine's starter presets. */
export const STARTER_PRESETS_GROUP = 'Engine starters';

/**
 * `presetChoices` grouped by source: `kitId`'s presets first (the rooms'
 * kit; its heading says so), then each other kit's in the project's order, then
 * the project's presets no kit lists, then the starters; within a group,
 * in `presetChoices`' order. A preset two kits list is under the first.
 */
export function groupedPresetChoices(graphs: readonly GraphDocument[], kits: readonly KitDef[], kitId: string | undefined): PickOption[] {
  const choices = presetChoices(graphs);
  const own = new Set(graphs.filter((g) => g.kind === ARCHITECTURE_PRESET_KIND).map((g) => g.graphId));
  const first = kits.find((k) => k.kitId === kitId);
  const ordered = first === undefined ? kits : [first, ...kits.filter((k) => k !== first)];
  const groups = [...ordered.map((k) => ({ label: k === first ? `${k.name} · the rooms' kit` : k.name, ids: new Set(k.presets ?? []) })), { label: PROJECT_PRESETS_GROUP, ids: null }, { label: STARTER_PRESETS_GROUP, ids: null }];
  const groupOf = (id: string): number => {
    if (!own.has(id)) return groups.length - 1;
    const at = groups.findIndex((g) => g.ids?.has(id) === true);
    return at >= 0 ? at : groups.length - 2;
  };
  return choices
    .map(([id, name], i) => ({ id, name, i, g: groupOf(id) }))
    .sort((a, b) => a.g - b.g || a.i - b.i)
    .map((c) => [c.id, c.name, groups[c.g]!.label] as const);
}
