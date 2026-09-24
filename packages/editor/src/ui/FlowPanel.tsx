/**
 * Phase 9.10: the Game window — the game flow in one place: the levels in
 * order (the scenes each loads, the spawn it starts at, its music), lives,
 * the title screen, the HUD layout, the menu look, menu texts, default
 * volumes, (phase 14.3) the score rules and (phase 14.5) the menu sounds,
 * each level's ambience and the title background and pan. Every edit is one `setFlow` with
 * the whole flow (text fields commit on Enter or when they lose focus);
 * "Remove game flow" goes back to one level with unlimited lives and no
 * title screen.
 *
 * Browser-only (React).
 */
import { useEffect, useState, type JSX } from 'react';
import type { FlowLevel, FlowScore, GameFlow, MenuSounds } from '@thirdlight/project-model';

interface Props {
  flow: GameFlow | null;
  /** Every scene of the project (a closed scene's spawns are not known until it is opened). */
  scenes: readonly { sceneId: string; name: string; start: boolean; open: boolean }[];
  /** Player spawns the editor knows (open scenes), with their scene. */
  spawns: readonly { id: string; name: string; sceneId: string | null }[];
  music: readonly { assetId: string; displayName: string }[];
  /** Phase 14.5: the project's audio (sound) assets — menu sounds and ambience. */
  sounds?: readonly { assetId: string; displayName: string }[];
  textures: readonly { assetId: string; displayName: string }[];
  /** The game block's spawn (the first level starts there by default). */
  gameSpawnId: string | null;
  onSave: (flow: GameFlow | null) => void;
  error: string | null;
  /** Phase 14.3: counter names the game counts (the engine's and the open scenes' custom pickup counters), offered for score rules. */
  counters?: readonly string[];
  /** Phase 9.11: forget the running Play's saves (null: no Play running). */
  onClearPlaySave?: (() => void) | null;
  /** Phase 14.4: open the Environment window on this level's look. */
  onEditLook?: (levelId: string) => void;
  note?: string | null;
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

const COUNTER_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
/** A new time bonus: a minute's target and 10 points a second — round starting figures the designer tunes. */
const DEFAULT_TIME_BONUS = { targetSeconds: 60, perSecond: 10 };

/** Phase 14.3: the Score section — points per counter and a time bonus. */
function ScoreSection(p: { score: FlowScore | undefined; counters: readonly string[]; onChange: (score: FlowScore | undefined) => void }): JSX.Element {
  const [name, setName] = useState('');
  const [points, setPoints] = useState('10');
  const sc = p.score;
  const rows = Object.entries(sc?.points ?? {});
  const withPoints = (next: Record<string, number>): FlowScore => {
    const { points: _p, ...rest } = sc ?? {};
    return Object.keys(next).length > 0 ? { ...rest, points: next } : rest;
  };
  const addName = name.trim();
  const addPoints = Number(points);
  const canAdd = sc !== undefined && COUNTER_RE.test(addName) && !(sc.points !== undefined && Object.prototype.hasOwnProperty.call(sc.points, addName)) && Number.isInteger(addPoints) && Math.abs(addPoints) <= 1_000_000;
  return (
    <>
      <div className="tl-panel__title">Score</div>
      <label className="tl-flag">
        <input type="checkbox" aria-label="keep score" checked={sc !== undefined} onChange={(e) => p.onChange(e.target.checked ? {} : undefined)} />
        keep score (shown on the HUD and the level complete and end screens; the best per level is saved)
      </label>
      {sc !== undefined && (
        <div className="tl-flow-panel__score" aria-label="score rules">
          {rows.length === 0 && <p className="tl-hint">No counter scores points yet: add one below.</p>}
          {rows.map(([k, v]) => (
            <div className="tl-animator__row" key={k}>
              <span className="tl-field__label">{k}</span>
              <label className="tl-field">
                <span className="tl-field__label">points each</span>
                <Text label={`points per ${k}`} value={String(v)} onCommit={(t) => Number.isInteger(Number(t)) && t.trim() !== '' && p.onChange(withPoints({ ...sc.points, [k]: Number(t) }))} />
              </label>
              <button type="button" className="tl-button" aria-label={`stop scoring ${k}`} onClick={() => p.onChange(withPoints(Object.fromEntries(rows.filter(([x]) => x !== k))))}>
                remove
              </button>
            </div>
          ))}
          <div className="tl-animator__row">
            <label className="tl-field">
              <span className="tl-field__label">counter</span>
              <input className="tl-input" aria-label="scored counter" list="tl-flow-score-counters" value={name} placeholder="coins" onChange={(e) => setName(e.target.value)} />
              <datalist id="tl-flow-score-counters">
                {p.counters.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </label>
            <label className="tl-field">
              <span className="tl-field__label">points each</span>
              <input className="tl-input" aria-label="points for the new counter" value={points} onChange={(e) => setPoints(e.target.value)} />
            </label>
            <button
              type="button"
              className="tl-button"
              disabled={!canAdd}
              title={canAdd ? undefined : 'a counter name (letters, digits, _) not scored yet, and whole points'}
              onClick={() => {
                p.onChange(withPoints({ ...(sc.points ?? {}), [addName]: addPoints }));
                setName('');
              }}
            >
              Add counter
            </button>
          </div>
          <label className="tl-flag">
            <input
              type="checkbox"
              aria-label="time bonus"
              checked={sc.timeBonus !== undefined}
              onChange={(e) => p.onChange(e.target.checked ? { ...sc, timeBonus: { ...DEFAULT_TIME_BONUS } } : (({ timeBonus: _t, ...rest }) => rest)(sc))}
            />
            time bonus (points for every second under a target time)
          </label>
          {sc.timeBonus !== undefined && (
            <div className="tl-animator__row">
              <label className="tl-field">
                <span className="tl-field__label">target seconds</span>
                <Text label="time bonus target seconds" value={String(sc.timeBonus.targetSeconds)} onCommit={(t) => Number(t) >= 1 && p.onChange({ ...sc, timeBonus: { ...sc.timeBonus!, targetSeconds: Number(t) } })} />
              </label>
              <label className="tl-field">
                <span className="tl-field__label">points per second</span>
                <Text label="time bonus points per second" value={String(sc.timeBonus.perSecond)} onCommit={(t) => t.trim() !== '' && Number(t) >= 0 && p.onChange({ ...sc, timeBonus: { ...sc.timeBonus!, perSecond: Number(t) } })} />
              </label>
            </div>
          )}
        </div>
      )}
    </>
  );
}

/** Phase 14.5: a new title pan — 4 m out and back over 20 s each way: a slow drift at human scale. */
const DEFAULT_TITLE_PAN = { distance: 4, seconds: 20 };
const MENU_SOUND_LABELS: Record<keyof MenuSounds, string> = { move: 'move', confirm: 'confirm', back: 'back' };

/** Phase 14.5: a level's ambience — up to four sounds looped while it plays. */
function Ambience(p: { index: number; ambience: readonly string[]; options: readonly { assetId: string; displayName: string }[]; onChange: (ambience: string[]) => void }): JSX.Element {
  const name = (id: string): string => p.options.find((o) => o.assetId === id)?.displayName ?? id;
  const free = p.options.filter((o) => !p.ambience.includes(o.assetId));
  return (
    <div className="tl-animator__row" aria-label={`level ${p.index + 1} ambience`}>
      <span className="tl-field__label">ambience</span>
      {p.ambience.length === 0 && <span className="tl-hint">none</span>}
      {p.ambience.map((id) => (
        <button key={id} type="button" className="tl-button" aria-label={`level ${p.index + 1} stop ambience ${name(id)}`} title="remove from the ambience" onClick={() => p.onChange(p.ambience.filter((x) => x !== id))}>
          {name(id)} ✕
        </button>
      ))}
      {p.ambience.length < 4 && free.length > 0 && (
        <select className="tl-input" aria-label={`level ${p.index + 1} add ambience`} value="" onChange={(e) => e.target.value !== '' && p.onChange([...p.ambience, e.target.value])}>
          <option value="">+ add a looping sound</option>
          {free.map((o) => (
            <option key={o.assetId} value={o.assetId}>
              {o.displayName}
            </option>
          ))}
        </select>
      )}
    </div>
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
    const tidy = (l: FlowLevel): FlowLevel => {
      let out = l.music === undefined || l.music === '' ? (({ music: _m, ...rest }) => rest)(l) : l;
      if (out.ambience !== undefined && out.ambience.length === 0) out = (({ ambience: _a, ...rest }) => rest)(out);
      return out as FlowLevel;
    };
    save({ levels: levels.map(tidy) });
  };
  const soundOptions = p.sounds ?? [];
  const ambienceOptions = [...soundOptions, ...p.music];
  const title = f.title ?? {};
  const setTitle = (patch: Partial<NonNullable<GameFlow['title']>>): void => {
    const next = { ...title, ...patch } as Record<string, unknown>;
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    save({ title: next as NonNullable<GameFlow['title']> });
  };
  const setSound = (k: keyof MenuSounds, id: string): void => {
    const next: Record<string, string> = { ...(f.sounds ?? {}) };
    if (id === '') delete next[k];
    else next[k] = id;
    p.onSave(Object.keys(next).length > 0 ? { ...f, sounds: next as MenuSounds } : (({ sounds: _s, ...rest }) => rest)(f));
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
              {p.onEditLook !== undefined && (
                <button
                  type="button"
                  className={l.environment !== undefined ? 'tl-button is-active' : 'tl-button'}
                  aria-label={`level ${i + 1} look`}
                  title={l.environment !== undefined ? `this level has its own ${Object.keys(l.environment).join(', ')}` : 'this level uses the project environment'}
                  onClick={() => p.onEditLook!(l.id)}
                >
                  Level look…{l.environment !== undefined ? ' (own)' : ''}
                </button>
              )}
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
            <Ambience index={i} ambience={l.ambience ?? []} options={ambienceOptions} onChange={(ambience) => setLevel(i, { ambience })} />
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
          <Text label="title subtitle" wide value={f.title?.subtitle ?? ''} onCommit={(v) => setTitle({ subtitle: v !== '' ? v : undefined })} />
        </label>
        <label className="tl-field">
          <span className="tl-field__label">music</span>
          <select className="tl-input" aria-label="title music" value={f.title?.music ?? ''} onChange={(e) => setTitle({ music: e.target.value !== '' ? e.target.value : undefined })}>
            <option value="">— none —</option>
            {p.music.map((m) => (
              <option key={m.assetId} value={m.assetId}>
                {m.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="tl-field">
          <span className="tl-field__label">background</span>
          <select className="tl-input" aria-label="title background scene" value={title.scene ?? ''} onChange={(e) => setTitle({ scene: e.target.value !== '' ? e.target.value : undefined })}>
            <option value="">— the first level's start —</option>
            {p.scenes.map((sc) => (
              <option key={sc.sceneId} value={sc.sceneId}>
                {sc.name}
              </option>
            ))}
          </select>
        </label>
        <label className="tl-flag">
          <input type="checkbox" aria-label="title camera pan" checked={title.pan !== undefined} onChange={(e) => setTitle({ pan: e.target.checked ? { ...DEFAULT_TITLE_PAN } : undefined })} />
          slow camera pan
        </label>
        {title.pan !== undefined && (
          <>
            <label className="tl-field">
              <span className="tl-field__label">pan metres (sideways)</span>
              <Text label="title pan distance" value={String(title.pan.distance)} onCommit={(v) => Number(v) !== 0 && Number.isFinite(Number(v)) && Math.abs(Number(v)) <= 100 && setTitle({ pan: { ...title.pan!, distance: Number(v) } })} />
            </label>
            <label className="tl-field">
              <span className="tl-field__label">seconds each way</span>
              <Text label="title pan seconds" value={String(title.pan.seconds)} onCommit={(v) => Number(v) >= 2 && Number(v) <= 600 && setTitle({ pan: { ...title.pan!, seconds: Number(v) } })} />
            </label>
          </>
        )}
      </div>
      {title.scene !== undefined && <p className="tl-hint">The camera frames the background scene's first player spawn (else its middle) as it frames the player; keep the scene apart from the levels.</p>}

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

      <div className="tl-panel__title">Menu sounds</div>
      <div className="tl-animator__row">
        {(['move', 'confirm', 'back'] as const).map((k) => (
          <label className="tl-field" key={k}>
            <span className="tl-field__label">{MENU_SOUND_LABELS[k]}</span>
            <select className="tl-input" aria-label={`menu sound ${k}`} value={f.sounds?.[k] ?? ''} onChange={(e) => setSound(k, e.target.value)}>
              <option value="">— none —</option>
              {soundOptions.map((o) => (
                <option key={o.assetId} value={o.assetId}>
                  {o.displayName}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>

      <ScoreSection score={f.score} counters={p.counters ?? []} onChange={(score) => p.onSave(score !== undefined ? { ...f, score } : (({ score: _s, ...rest }) => rest)(f))} />

      <div className="tl-panel__title">Default volumes</div>
      <div className="tl-animator__row">
        {(['music', 'sfx', 'ui'] as const).map((k) => {
          const commit = (v: number): void => save({ volumes: { music: f.volumes?.music ?? 0.8, sfx: f.volumes?.sfx ?? 1, ...(f.volumes?.ui !== undefined ? { ui: f.volumes.ui } : {}), [k]: v } });
          return (
            <label className="tl-field" key={k}>
              <span className="tl-field__label">{k === 'music' ? 'music' : k === 'sfx' ? 'sound effects' : 'menu sounds'}</span>
              <input
                type="range"
                aria-label={`default ${k} volume`}
                min={0}
                max={1}
                step={0.1}
                defaultValue={f.volumes?.[k] ?? (k === 'music' ? 0.8 : 1)}
                onPointerUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
                onKeyUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
              />
            </label>
          );
        })}
      </div>
      <div className="tl-panel__title">Saves</div>
      <p className="tl-hint">Players have three save slots and an autosave (at checkpoints and at the start of each level); Play keeps its own saves, apart from exported games.</p>
      <button type="button" className="tl-button" disabled={p.onClearPlaySave === null || p.onClearPlaySave === undefined} title={p.onClearPlaySave === null ? 'start Play first' : undefined} onClick={() => p.onClearPlaySave?.()}>
        Clear Play save
      </button>
      {p.note !== null && p.note !== undefined && <p className="tl-hint" role="status">{p.note}</p>}
      <button type="button" className="tl-button" onClick={() => p.onSave(null)}>
        Remove game flow
      </button>
    </div>
  );
}
