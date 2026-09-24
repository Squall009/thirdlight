/**
 * Phase 9.9: the gameplay block sections of the Inspector — mover, trigger,
 * switch, health, pickup, enemy — plus a collider's one-way flag and a hazard
 * zone's damage. Each edit is one `setComponent` with the changed fields
 * (`null` removes an optional field, a `null` value removes the component);
 * "Add gameplay component" adds one with working defaults.
 *
 * Browser-only (React).
 */
import { useEffect, useState, type JSX } from 'react';
import type { BlockName } from '../session/projection';

type Value = Record<string, unknown>;

interface Props {
  blocks: Partial<Record<BlockName, Value>>;
  /** The collider value, when the entity has one (the one-way flag). */
  collider?: unknown;
  /** The zone value, when the entity is a hazard zone (its damage). */
  hazard?: { damage?: number } | null;
  /** One component edit: a partial value, or null to remove the component. */
  onSave: (component: string, value: Value | null) => void;
  /** Phase 9.10: the audio and music assets an audio source can play. */
  sounds?: readonly { assetId: string; displayName: string }[];
}

export const BLOCK_DEFAULTS: Record<BlockName, Value> = {
  mover: { waypoints: [[4, 0, 0]], speed: 2, mode: 'pingpong', wait: 0.5 },
  trigger: { size: [2, 2], signal: 'trigger' },
  switch: { mode: 'interact', signal: 'open', size: [1, 1] },
  health: { max: 3, invulnerableSeconds: 1 },
  pickup: { kind: 'coin', value: 1 },
  enemy: { patrol: 'edges', speed: 1.5, size: [0.8, 0.8], contactDamage: 1, stompable: true, health: 1 },
  audioSource: { assetId: '', volume: 0.8, range: 12 },
};

const TITLES: Record<BlockName, string> = { mover: 'Mover (moving platform)', trigger: 'Trigger', switch: 'Switch', health: 'Health', pickup: 'Pickup', enemy: 'Enemy', audioSource: 'Audio source (loops, louder nearby)' };

/** A text field that commits on Enter or blur when it changed (the backend refuses invalid values). */
function Field(p: { label: string; aria: string; value: string; onCommit: (raw: string) => void; title?: string }): JSX.Element {
  const [draft, setDraft] = useState(p.value);
  useEffect(() => setDraft(p.value), [p.value]);
  return (
    <label className="tl-field" title={p.title}>
      <span className="tl-field__label">{p.label}</span>
      <input
        className="tl-input"
        aria-label={p.aria}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft !== p.value && p.onCommit(draft)}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
    </label>
  );
}

const nums = (raw: string): number[] => raw.split(/[\s,]+/).filter((s) => s !== '').map(Number);
const vec2Text = (v: unknown): string => (Array.isArray(v) ? v.join(', ') : '');

export function BlocksEditor({ blocks, collider, hazard, onSave, sounds = [] }: Props): JSX.Element {
  const missing = (['mover', 'trigger', 'switch', 'health', 'pickup', 'enemy', 'audioSource'] as const).filter((n) => blocks[n] === undefined && (n !== 'audioSource' || sounds.length > 0));
  const set = (n: string, patch: Value): void => onSave(n, patch);
  const num = (n: BlockName, key: string, label: string, integer = false): JSX.Element => (
    <Field
      key={key}
      label={label}
      aria={`${n} ${key}`}
      value={blocks[n]?.[key] === undefined ? '' : String(blocks[n]![key])}
      onCommit={(raw) => set(n, { [key]: raw.trim() === '' ? null : integer ? Math.round(Number(raw)) : Number(raw) })}
    />
  );
  const size = (n: BlockName, label = 'size w, h (m)'): JSX.Element => (
    <Field key="size" label={label} aria={`${n} size`} value={vec2Text(blocks[n]?.['size'])} onCommit={(raw) => set(n, { size: raw.trim() === '' ? null : nums(raw) })} />
  );
  const text = (n: BlockName, key: string, label: string): JSX.Element => (
    <Field key={key} label={label} aria={`${n} ${key}`} value={String(blocks[n]?.[key] ?? '')} onCommit={(raw) => set(n, { [key]: raw.trim() === '' ? null : raw.trim() })} />
  );
  const select = (n: BlockName, key: string, label: string, options: readonly string[], patch: (v: string) => Value = (v) => ({ [key]: v })): JSX.Element => (
    <label className="tl-field" key={key}>
      <span className="tl-field__label">{label}</span>
      <select className="tl-input" aria-label={`${n} ${key}`} value={String(blocks[n]?.[key] ?? options[0])} onChange={(e) => set(n, patch(e.target.value))}>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
  const flag = (n: BlockName, key: string, label: string): JSX.Element => (
    <label className="tl-flag" key={key}>
      <input type="checkbox" aria-label={`${n} ${key}`} checked={blocks[n]?.[key] === true} onChange={(e) => set(n, { [key]: n === 'enemy' ? e.target.checked : e.target.checked ? true : null })} />
      {label}
    </label>
  );
  const body = (n: BlockName): JSX.Element[] => {
    const v = blocks[n]!;
    switch (n) {
      case 'mover':
        return [
          <Field
            key="waypoints"
            label="path (offsets x y z; …)"
            aria="mover waypoints"
            title="Offsets from the placed position, one per stop, separated by ;"
            value={(v['waypoints'] as number[][]).map((p) => p.join(' ')).join('; ')}
            onCommit={(raw) => set(n, { waypoints: raw.split(';').filter((s) => s.trim() !== '').map((s) => { const p = nums(s); return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0]; }) })}
          />,
          num(n, 'speed', 'speed (m/s)'),
          select(n, 'mode', 'mode', ['pingpong', 'loop', 'once']),
          num(n, 'wait', 'wait at stops (s)'),
          select(n, 'easing', 'easing', ['linear', 'smooth']),
          text(n, 'startOn', 'waits for signal'),
        ];
      case 'trigger':
        return [size(n), text(n, 'signal', 'sends signal'), flag(n, 'once', 'only once')];
      case 'switch':
        return [select(n, 'mode', 'mode', ['interact', 'stand']), size(n), text(n, 'signal', 'sends signal'), flag(n, 'once', 'only once')];
      case 'health':
        return [num(n, 'max', 'max health', true), num(n, 'invulnerableSeconds', 'invulnerable after a hit (s)')];
      case 'pickup':
        return [
          select(n, 'kind', 'kind', ['coin', 'gem', 'heart', 'life', 'key', 'custom'], (k) => (k === 'custom' ? { kind: k, counter: 'stars' } : { kind: k, counter: null })),
          num(n, 'value', 'value', true),
          ...(v['kind'] === 'custom' ? [text(n, 'counter', 'counter')] : []),
          size(n, 'size w, h (m, empty: the box)'),
          select(n, 'respawn', 'comes back', ['never', 'death']),
        ];
      case 'enemy':
        return [
          select(n, 'patrol', 'patrol', ['edges', 'points'], (p) => (p === 'points' ? { patrol: p, range: [-2, 2] } : { patrol: p, range: null })),
          ...(v['patrol'] === 'points' ? [<Field key="range" label="walks between x (left, right)" aria="enemy range" value={vec2Text(v['range'])} onCommit={(raw) => set(n, { range: nums(raw) })} />] : []),
          num(n, 'speed', 'speed (m/s)'),
          size(n),
          num(n, 'contactDamage', 'contact damage', true),
          num(n, 'health', 'hits to defeat', true),
          flag(n, 'stompable', 'defeated by jumping on it'),
        ];
      case 'audioSource':
        return [
          <label className="tl-field" key="assetId">
            <span className="tl-field__label">sound</span>
            <select className="tl-input" aria-label="audioSource assetId" value={String(v['assetId'] ?? '')} onChange={(e) => set(n, { assetId: e.target.value })}>
              {!sounds.some((s) => s.assetId === v['assetId']) && <option value={String(v['assetId'] ?? '')}>{String(v['assetId'] ?? '')}</option>}
              {sounds.map((s) => (
                <option key={s.assetId} value={s.assetId}>
                  {s.displayName}
                </option>
              ))}
            </select>
          </label>,
          num(n, 'volume', 'volume (0–1)'),
          num(n, 'range', 'heard within (m)'),
        ];
      default:
        return [];
    }
  };
  return (
    <div className="tl-inspector__section" aria-label="gameplay components">
      <div className="tl-panel__title">Gameplay</div>
      {collider !== undefined && (
        <label className="tl-flag">
          <input type="checkbox" aria-label="collider one-way" checked={(collider as { oneWay?: boolean }).oneWay === true} onChange={(e) => onSave('collider', { oneWay: e.target.checked ? true : null })} />
          one-way platform (jump up through it; Down + Jump drops through)
        </label>
      )}
      {hazard !== undefined && hazard !== null && (
        <Field
          label="damage (empty: kills)"
          aria="hazard damage"
          value={hazard.damage === undefined ? '' : String(hazard.damage)}
          onCommit={(raw) => onSave('gameZone', { damage: raw.trim() === '' ? null : Math.round(Number(raw)) })}
        />
      )}
      {(Object.keys(blocks) as BlockName[]).map((n) => (
        <div className="tl-inspector__block" key={n} aria-label={`${n} component`}>
          <div className="tl-animator__bar">
            <strong>{TITLES[n]}</strong>
            <button type="button" className="tl-button" aria-label={`remove ${n}`} onClick={() => onSave(n, null)}>
              remove
            </button>
          </div>
          {body(n)}
        </div>
      ))}
      {missing.length > 0 && (
        <select
          className="tl-input"
          aria-label="add gameplay component"
          value=""
          onChange={(e) => {
            const n = e.target.value as BlockName;
            if (n === 'audioSource') onSave(n, { ...BLOCK_DEFAULTS.audioSource, assetId: sounds[0]!.assetId });
            else if (n in BLOCK_DEFAULTS) onSave(n, BLOCK_DEFAULTS[n]);
          }}
        >
          <option value="">+ Add gameplay component…</option>
          {missing.map((n) => (
            <option key={n} value={n}>
              {TITLES[n]}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
