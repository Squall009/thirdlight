/**
 * The vertex paint editor's Channels mode: the channel view (the material
 * as drawn, or one channel of the paint as grey: white where it is full),
 * what each of the four bytes means on this material, what the object
 * keeps painted, and — when a stroke found paint made for a model's earlier
 * vertices (it was reimported) — the offer to remove that stale paint. The
 * channel view is the column's list; the rest are docked panels.
 *
 * Browser-only (React).
 */
import type { JSX } from 'react';

import { PAINT_WET_CHANNEL } from '../../session/vertex-paint-channels';
import { Section } from '../editmode/controls';
import { EditPanels } from '../editmode/docks';
import { useEditStatus } from '../editmode/edit-status';
import type { EditModeView } from '../editmode/modes';
import { CHANNEL_LETTERS as LETTERS, ChannelViewList } from './ChannelView';
import { NoPaintBanner, StalePaintCheck } from './PaintColumn';
import { useVertexPaint } from './vertex-paint-column';

/** What the object keeps painted, in a few words. */
function paintedFacts(components: Record<string, unknown>): string {
  const vp = components['vertexPaint'] as { meshes?: unknown[]; paths?: unknown[] } | undefined;
  const inst = components['instances'] as { paint?: { painted: number } } | undefined;
  const parts: string[] = [];
  const n = (k: number, one: string, many: string): string => `${k} ${k === 1 ? one : many}`;
  if (vp?.meshes !== undefined) parts.push(n(vp.meshes.length, 'mesh', 'meshes'));
  if (vp?.paths !== undefined) parts.push(n(vp.paths.length, 'wall side', 'wall sides'));
  if (inst?.paint !== undefined) parts.push(n(inst.paint.painted, 'copy', 'copies'));
  return parts.length === 0 ? 'Nothing painted yet.' : `Painted: ${parts.join(', ')}.`;
}

export function ChannelsColumn({ entity, host }: EditModeView): JSX.Element {
  const vp = useVertexPaint(entity, host);
  const { channels } = vp;
  useEditStatus({ tool: 'Channels', text: 'Pick what the view shows: the material as drawn, or one channel of the paint as grey (white where it is full).', keys: [{ keys: ['V'], label: 'Channel view' }] });
  const meaning = (c: number): string => {
    const i = channels.targets.findIndex((t) => t.channel === c && t.channels === undefined);
    const name = i < 0 ? null : channels.tiles[i]!.name;
    if (channels.meaning === 'layers') return c === PAINT_WET_CHANNEL ? 'Wetness' : `${name ?? `Layer ${c + 2}`} (layer ${c + 2})`;
    return name ?? 'not read';
  };
  return (
    <div className="tl-vpaint" aria-label="vertex paint channels">
      <NoPaintBanner vp={vp} />
      <Section title="Channel view" aside={<span className="tl-sec__note">V cycles</span>}>
        <ChannelViewList vp={vp} />
      </Section>
      <EditPanels
        panels={[
          {
            id: 'channel-meaning',
            title: 'What the channels mean',
            dock: 'r',
            render: () => (
              <div className="tl-dpanel__pad">
                <table className="tl-chantable" aria-label="channel meanings">
                  <tbody>
                    {LETTERS.map((l, c) => (
                      <tr key={l}>
                        <th>{l}</th>
                        <td>{meaning(c)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {channels.meaning === 'layers' && <p className="tl-hint">The base is what R, G and B leave: where they add up to nothing, the base shows.</p>}
              </div>
            ),
          },
          {
            id: 'stored-paint',
            title: 'Stored paint',
            dock: 'r',
            collapsed: true,
            ...(host.paint.stale?.entityId === entity.id ? { badge: 'stale paint' } : {}),
            render: () => (
              <div className="tl-dpanel__pad">
                <p className="tl-hint">{paintedFacts(entity.components)}</p>
                <StalePaintCheck vp={vp} />
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}
