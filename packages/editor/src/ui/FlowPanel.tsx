/**
 * Phase 9.10: the Game window — the game flow in one place: the levels in
 * order (the scenes each loads, the spawn it starts at, its music), lives,
 * the title screen, the HUD layout, the menu look, menu texts and default
 * volumes. Every edit is one `setFlow` with the whole flow (text fields
 * commit on Enter or when they lose focus); "Remove game flow" goes back to
 * one level with unlimited lives and no title screen.
 *
 * Browser-only (React).
 */
import { useEffect, useState, type JSX } from 'react';
import type { FlowLevel, GameFlow } from '@thirdlight/project-model';

interface Props {
  flow: GameFlow | null;
  /** Every scene of the project (a closed scene's spawns are not known until it is opened). */
  scenes: readonly { sceneId: string; name: string; start: boolean; open: boolean }[];
  /** Player spawns the editor knows (open scenes), with their scene. */
  spawns: readonly { id: string; name: string; sceneId: string | null }[];
  music: readonly { assetId: string; displayName: string }[];
  textures: readonly { assetId: string; displayName: string }[];
  /** The game block's spawn (the first level starts there by default). */
  gameSpawnId: string | null;
  onSave: (flow: GameFlow | null) => void;
  error: string | null;
}

/** A text input that commits on Enter or blur when it changed. */
function Text(p: { label: string; value: string; onCommit: (v: string) => void; wide?: boolean; area?: boolean }): JSX.Element {
  const [draft, setDraft] = useState(p.value);
  useEffect(() => setDraft(p.value), [p.value]);
  const commit = (): void => {
    if (draft !== p.value) p.onCommit(draft);
  };
  return p.area === true ? (
    <textarea className="tl-input" aria-label={p.label} value={draft} rows={3} onChange={(e) => setDraft(e.target.value)} onBlur={commit} />
  ) : (
    <input className={p.wide === true ? 'tl-input tl-input--wide' : 'tl-input'} aria-label={p.label} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
  );
}

const nextLevelId = (levels: readonly FlowLevel[]): string => {
  for (let i = levels.length + 1; ; i++) if (!levels.some((l) => l.id === `level-${i}`)) return `level-${i}`;
};

export function FlowPanel(p: Props): JSX.Element {
  const f = p.flow;
  if (f === null) {
    const start = p.scenes.filter((s) => s.start).map((s) => s.sceneId);
    return (
      <div className="tl-panel tl-flow-panel" aria-label="game flow">
        <p className="tl-hint">This game has one level (the start scenes), unlimited lives and no title screen.</p>
        <button
          type="button"
          className="tl-button"
          disabled={p.gameSpawnId === null || start.length === 0}
          title={p.gameSpawnId === null ? 'set up the game (Gameplay tab) first' : undefined}
          onClick={() => p.onSave({ levels: [{ id: 'level-1', name: 'Level 1', scenes: start, spawnId: p.gameSpawnId! }], lives: { start: 3, max: 9 }, title: {}, hud: { preset: 'classic' } })}
        >
          Set up levels and menus
        </button>
        {p.error !== null && (
          <p className="tl-lighting__message" role="alert">
            {p.error}
          </p>
        )}
      </div>
    );
  }
  const save = (patch: Partial<GameFlow>): void => p.onSave({ ...f, ...patch });
  const setLevel = (i: number, patch: Partial<FlowLevel>): void => {
    const levels = f.levels.map((l, j) => (j === i ? { ...l, ...patch } : l));
    save({ levels: levels.map((l) => (l.music === undefined || l.music === '' ? (({ music: _m, ...rest }) => rest)(l) : l)) as FlowLevel[] });
  };
  const move = (i: number, d: number): void => {
    const levels = [...f.levels];
    const [l] = levels.splice(i, 1);
    levels.splice(i + d, 0, l!);
    save({ levels });
  };
  const ui = f.ui ?? { font: 'sans' as const, accent: '#ffc857', panel: '#1b2330', text: '#f4f1e8' };
  return (
    <div className="tl-panel tl-flow-panel" aria-label="game flow">
      {p.error !== null && (
        <p className="tl-lighting__message" role="alert">
          {p.error}
        </p>
      )}
      <div className="tl-panel__title">Levels (played in this order)</div>
      <ol className="tl-flow-panel__levels">
        {f.levels.map((l, i) => (
          <li key={l.id} className="tl-flow-panel__level" aria-label={`level ${l.name}`}>
            <div className="tl-animator__row">
              <Text label={`level ${i + 1} name`} value={l.name} onCommit={(v) => v.trim() !== '' && setLevel(i, { name: v.trim() })} />
              <label className="tl-field">
                <span className="tl-field__label">starts at</span>
                <select className="tl-input" aria-label={`level ${i + 1} spawn`} value={l.spawnId} onChange={(e) => setLevel(i, { spawnId: e.target.value })}>
                  {!p.spawns.some((s) => s.id === l.spawnId) && <option value={l.spawnId}>{l.spawnId}</option>}
                  {p.spawns.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                      {s.sceneId !== null ? ` (${p.scenes.find((x) => x.sceneId === s.sceneId)?.name ?? s.sceneId})` : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label className="tl-field">
                <span className="tl-field__label">music</span>
                <select className="tl-input" aria-label={`level ${i + 1} music`} value={l.music ?? ''} onChange={(e) => setLevel(i, { music: e.target.value })}>
                  <option value="">— none —</option>
                  {p.music.map((m) => (
                    <option key={m.assetId} value={m.assetId}>
                      {m.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" className="tl-button" aria-label={`move level ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                ↑
              </button>
              <button type="button" className="tl-button" aria-label={`move level ${i + 1} down`} disabled={i === f.levels.length - 1} onClick={() => move(i, 1)}>
                ↓
              </button>
              <button type="button" className="tl-button" aria-label={`remove level ${i + 1}`} disabled={f.levels.length === 1} onClick={() => save({ levels: f.levels.filter((_, j) => j !== i) })}>
                remove
              </button>
            </div>
            <div className="tl-flow-panel__scenes" aria-label={`level ${i + 1} scenes`}>
              {p.scenes.map((s) => (
                <label key={s.sceneId} className="tl-flag">
                  <input
                    type="checkbox"
                    aria-label={`level ${i + 1} loads ${s.name}`}
                    checked={l.scenes.includes(s.sceneId)}
                    onChange={(e) => {
                      const scenes = e.target.checked ? [...l.scenes, s.sceneId] : l.scenes.filter((x) => x !== s.sceneId);
                      if (scenes.length > 0) setLevel(i, { scenes });
                    }}
                  />
                  {s.name}
                </label>
              ))}
              {l.scenes.some((id) => p.scenes.find((s) => s.sceneId === id)?.open === false) && (
                <span className="tl-hint">open this level's scenes in the Hierarchy to choose a spawn in them</span>
              )}
            </div>
          </li>
        ))}
      </ol>
      <button
        type="button"
        className="tl-button"
        disabled={f.levels.length >= 32}
        onClick={() => {
          const last = f.levels[f.levels.length - 1]!;
          save({ levels: [...f.levels, { id: nextLevelId(f.levels), name: `Level ${f.levels.length + 1}`, scenes: [...last.scenes], spawnId: last.spawnId }] });
        }}
      >
        Add level
      </button>

      <div className="tl-panel__title">Lives</div>
      <label className="tl-flag">
        <input type="checkbox" aria-label="limited lives" checked={f.lives !== undefined} onChange={(e) => (e.target.checked ? save({ lives: { start: 3, max: 9 } }) : p.onSave((({ lives: _l, ...rest }) => rest)(f)))} />
        limited lives (game over at 0)
      </label>
      {f.lives !== undefined && (
        <div className="tl-animator__row">
          <label className="tl-field">
            <span className="tl-field__label">start with</span>
            <Text label="lives at start" value={String(f.lives.start)} onCommit={(v) => save({ lives: { start: Math.round(Number(v)), max: Math.max(f.lives!.max, Math.round(Number(v))) } })} />
          </label>
          <label className="tl-field">
            <span className="tl-field__label">at most</span>
            <Text label="most lives" value={String(f.lives.max)} onCommit={(v) => save({ lives: { start: f.lives!.start, max: Math.round(Number(v)) } })} />
          </label>
        </div>
      )}

      <div className="tl-panel__title">Title screen</div>
      <div className="tl-animator__row">
        <label className="tl-field">
          <span className="tl-field__label">subtitle</span>
          <Text label="title subtitle" wide value={f.title?.subtitle ?? ''} onCommit={(v) => save({ title: { ...(f.title ?? {}), ...(v !== '' ? { subtitle: v } : { subtitle: undefined }) } })} />
        </label>
        <label className="tl-field">
          <span className="tl-field__label">music</span>
          <select className="tl-input" aria-label="title music" value={f.title?.music ?? ''} onChange={(e) => save({ title: { ...(f.title?.subtitle !== undefined ? { subtitle: f.title.subtitle } : {}), ...(e.target.value !== '' ? { music: e.target.value } : {}) } })}>
            <option value="">— none —</option>
            {p.music.map((m) => (
              <option key={m.assetId} value={m.assetId}>
                {m.displayName}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="tl-panel__title">HUD and menus</div>
      <div className="tl-animator__row">
        <label className="tl-field">
          <span className="tl-field__label">HUD layout</span>
          <select className="tl-input" aria-label="HUD layout" value={f.hud?.preset ?? 'classic'} onChange={(e) => save({ hud: { ...(f.hud ?? {}), preset: e.target.value as 'classic' | 'minimal' | 'corners' } })}>
            <option value="classic">classic</option>
            <option value="minimal">minimal</option>
            <option value="corners">corners</option>
          </select>
        </label>
        <label className="tl-flag">
          <input type="checkbox" aria-label="level timer" checked={f.hud?.timer === true} onChange={(e) => save({ hud: { preset: f.hud?.preset ?? 'classic', timer: e.target.checked } })} />
          level timer
        </label>
        <label className="tl-field">
          <span className="tl-field__label">font</span>
          <select className="tl-input" aria-label="menu font" value={ui.font} onChange={(e) => save({ ui: { ...ui, font: e.target.value as typeof ui.font } })}>
            {(['sans', 'serif', 'mono', 'rounded'] as const).map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        </label>
        {(['accent', 'panel', 'text'] as const).map((k) => (
          <label className="tl-field" key={k}>
            <span className="tl-field__label">{k}</span>
            <input type="color" aria-label={`menu ${k} colour`} value={ui[k]} onChange={(e) => save({ ui: { ...ui, [k]: e.target.value } })} />
          </label>
        ))}
        <label className="tl-field">
          <span className="tl-field__label">logo</span>
          <select className="tl-input" aria-label="menu logo" value={ui.logo ?? ''} onChange={(e) => save({ ui: { font: ui.font, accent: ui.accent, panel: ui.panel, text: ui.text, ...(e.target.value !== '' ? { logo: e.target.value } : {}) } })}>
            <option value="">— none —</option>
            {p.textures.map((t) => (
              <option key={t.assetId} value={t.assetId}>
                {t.displayName}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="tl-animator__row">
        <label className="tl-field">
          <span className="tl-field__label">level complete text</span>
          <Text label="level complete text" value={f.texts?.levelComplete ?? ''} onCommit={(v) => save({ texts: { ...(f.texts ?? {}), levelComplete: v === '' ? undefined : v } })} />
        </label>
        <label className="tl-field">
          <span className="tl-field__label">game over text</span>
          <Text label="game over text" value={f.texts?.gameOver ?? ''} onCommit={(v) => save({ texts: { ...(f.texts ?? {}), gameOver: v === '' ? undefined : v } })} />
        </label>
      </div>
      <label className="tl-field">
        <span className="tl-field__label">credits (the end screen)</span>
        <Text label="credits" area value={f.texts?.credits ?? ''} onCommit={(v) => save({ texts: { ...(f.texts ?? {}), credits: v === '' ? undefined : v } })} />
      </label>

      <div className="tl-panel__title">Default volumes</div>
      <div className="tl-animator__row">
        {(['music', 'sfx'] as const).map((k) => (
          <label className="tl-field" key={k}>
            <span className="tl-field__label">{k === 'music' ? 'music' : 'sound effects'}</span>
            <input
              type="range"
              aria-label={`default ${k} volume`}
              min={0}
              max={1}
              step={0.1}
              defaultValue={f.volumes?.[k] ?? (k === 'music' ? 0.8 : 1)}
              onPointerUp={(e) => save({ volumes: { music: f.volumes?.music ?? 0.8, sfx: f.volumes?.sfx ?? 1, [k]: Number((e.target as HTMLInputElement).value) } })}
              onKeyUp={(e) => save({ volumes: { music: f.volumes?.music ?? 0.8, sfx: f.volumes?.sfx ?? 1, [k]: Number((e.target as HTMLInputElement).value) } })}
            />
          </label>
        ))}
      </div>
      <button type="button" className="tl-button" onClick={() => p.onSave(null)}>
        Remove game flow
      </button>
    </div>
  );
}
