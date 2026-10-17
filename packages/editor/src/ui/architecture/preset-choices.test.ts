import { describe, expect, it } from 'vitest';
import type { GraphDocument, KitDef } from '@thirdlight/project-model';
import { ARCHITECTURE_PRESET_KIND, ARCHITECTURE_STARTER_GRAPHS } from '@thirdlight/runtime';

import { groupedPresetChoices, PROJECT_PRESETS_GROUP, STARTER_PRESETS_GROUP } from './preset-choices';

const preset = (graphId: string, name: string): GraphDocument => ({ graphId, kind: ARCHITECTURE_PRESET_KIND, name, graph: { nodes: [], edges: [] } }) as unknown as GraphDocument;
const kit = (kitId: string, name: string, presets: string[]): KitDef => ({ kitId, name, presets, blockTypes: [], pieces: {} }) as unknown as KitDef;

describe('the Rooms preset pickers group presets by source', () => {
  const graphs = [preset('town-room', 'Room (Town)'), preset('basic-room', 'Room (Basic Kit)'), preset('basic-hall', 'Hall (Basic Kit)'), preset('mine', 'My room')];
  const kits = [kit('basic', 'Basic Kit', ['basic-room', 'basic-hall']), kit('town', 'Town', ['town-room', 'basic-room'])];
  const starters = ARCHITECTURE_STARTER_GRAPHS.filter((g) => g.kind === ARCHITECTURE_PRESET_KIND);

  it("lists the rooms' kit first, then the other kits, the project's own, then the engine's starters", () => {
    const c = groupedPresetChoices(graphs, kits, 'town');
    expect(c.slice(0, 5)).toEqual([
      ['town-room', 'Room (Town)', "Town · the rooms' kit"],
      // Listed by both kits: under the rooms' kit, the first.
      ['basic-room', 'Room (Basic Kit)', "Town · the rooms' kit"],
      ['basic-hall', 'Hall (Basic Kit)', 'Basic Kit'],
      ['mine', 'My room', PROJECT_PRESETS_GROUP],
      [starters[0]!.graphId, starters[0]!.name, STARTER_PRESETS_GROUP],
    ]);
    expect(c.slice(4).every((o) => o[2] === STARTER_PRESETS_GROUP)).toBe(true);
    expect(c).toHaveLength(4 + starters.length);
  });

  it('with no kit picked, keeps the kits in the project order', () => {
    expect(groupedPresetChoices(graphs, kits, undefined).slice(0, 3).map((o) => o[2])).toEqual(['Basic Kit', 'Basic Kit', 'Town']);
  });

  it('a project preset replacing a starter (same id) is the project\'s, not a starter', () => {
    const own = starters[0]!;
    const c = groupedPresetChoices([preset(own.graphId, 'Room (edited)')], [], undefined);
    expect(c[0]).toEqual([own.graphId, 'Room (edited)', PROJECT_PRESETS_GROUP]);
    expect(c.filter((o) => o[0] === own.graphId)).toHaveLength(1);
  });
});
