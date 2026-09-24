/**
 * The in-play HUD (delivery.md §3.1/§3.2, B04/B07/B15) — plain DOM, built
 * from a structural host-side interface so the module runs in Node tests
 * (fake DOM) and the real browser (real `document`) alike.
 *
 * Hard rules (delivery.md §3.1 "HUD rules"):
 *  - text via `textContent` ONLY — project-supplied strings (title,
 *    objective, instructions) are NEVER injected as HTML (the packet-55
 *    malicious-title case: an authored title containing `<script>` markup
 *    renders as inert literal text);
 *  - no remote font/asset requests — system font stack and text only;
 *  - the host owns exactly this HUD DOM and removes it on `dispose()`.
 *
 * The HUD is display-only: it never mutates game state. The Start/Mute
 * buttons call the host's `control()` channel (delivery.md §4.1 — the same
 * bounded channel the keyboard/gamepad menu uses), never the runtime.
 */

/** The minimal structural node surface the HUD writes (real DOM nodes satisfy it). */
export interface HostDomNode {
  appendChild(child: HostDomNode): void;
  remove(): void;
  textContent: string;
  setAttribute?(name: string, value: string): void;
  addEventListener?(type: string, handler: () => void): void;
  removeEventListener?(type: string, handler: () => void): void;
}

/** The structural document surface the HUD builder reads. */
export interface HostDom {
  createElement(tag: string): HostDomNode;
}

/** The one-shot HUD state the host recomputes from the committed view. */
export interface HudState {
  /** The authored game title (rendered as text, never HTML). */
  readonly title: string;
  /** The authored objective (rendered as text, never HTML). */
  readonly objective: string;
  /** The authored instructions string (rendered as a text node). */
  readonly instructions: string;
  /** The committed run state (HUD switches on this only). */
  readonly state: 'awaitingStart' | 'playing' | 'respawning' | 'won' | 'failed';
  /** The committed death count (B08/B09). */
  readonly deathCount: number;
  /** The committed checkpoint activation flag (B09: status is visible). */
  readonly checkpointActive: boolean;
  /** The committed checkpoint step (the last activated one, if any). */
  readonly checkpointStep: number | null;
  /** The mapped audio status for the HUD line. */
  readonly sound: 'ready' | 'muted' | 'blocked' | 'unavailable';
  /** Phase 9.9: the run's counters and health, formatted ("Coins 3 · Health 2/3"), or ''. */
  readonly counters?: string;
  /** Phase 9.10: with a game flow, the one HUD line (level, lives, counters, health, timer); the menus show the rest. */
  readonly flowLine?: string;
}

export interface Hud {
  /** The root node the host appended to its container. */
  readonly root: HostDomNode;
  /** Recompute every text line from the committed state (textContent only). */
  update(state: HudState): void;
  /** Remove every host-owned node and listener. Idempotent. */
  dispose(): void;
}

/** The prompt text per run state (local shell; the relay page reuses it). */
export const HUD_PROMPTS: Readonly<Record<HudState['state'], string>> = Object.freeze({
  awaitingStart: 'Press Enter or Space (or the controller confirm) to start',
  playing: 'A/D or the controller to move, Space or the controller confirm to jump, M to mute',
  respawning: 'Respawning…',
  won: 'You win — press Enter or Space (or the controller confirm) to replay',
  failed: 'The run failed — reload to try again',
});

export function createHud(dom: HostDom, config: {
  readonly onStart: () => void;
  readonly onMuteToggle: () => void;
  /** Phase 9.10: a game flow's HUD layout (absent: the classic HUD with its Start button). */
  readonly preset?: 'classic' | 'minimal' | 'corners';
}): Hud {
  const disposers: Array<() => void> = [];
  const text = (node: HostDomNode, value: string): void => {
    node.textContent = value; // textContent ONLY (never innerHTML)
  };

  const root = dom.createElement('div');
  root.setAttribute?.('class', config.preset !== undefined ? `tl-game-host-hud tl-flow-hud tl-hud--${config.preset}` : 'tl-game-host-hud');

  const titleNode = dom.createElement('h1');
  text(titleNode, '');
  const objectiveNode = dom.createElement('p');
  text(objectiveNode, '');
  const instructionsNode = dom.createElement('p');
  text(instructionsNode, '');
  const promptNode = dom.createElement('p');
  text(promptNode, '');
  const statusNode = dom.createElement('p');
  text(statusNode, '');
  const startButton = dom.createElement('button');
  text(startButton, 'Start');
  const muteButton = dom.createElement('button');
  text(muteButton, 'Mute');

  const startHandler = (): void => config.onStart();
  const muteHandler = (): void => config.onMuteToggle();
  startButton.addEventListener?.('click', startHandler);
  muteButton.addEventListener?.('click', muteHandler);
  disposers.push(() => {
    startButton.removeEventListener?.('click', startHandler);
    muteButton.removeEventListener?.('click', muteHandler);
  });

  root.appendChild(titleNode);
  root.appendChild(objectiveNode);
  root.appendChild(instructionsNode);
  root.appendChild(promptNode);
  root.appendChild(statusNode);
  if (config.preset === undefined) root.appendChild(startButton);
  root.appendChild(muteButton);

  let lastTitle = '';
  let lastObjective = '';
  let lastInstructions = '';

  return {
    root,
    update(state: HudState): void {
      if (state.flowLine !== undefined) {
        // Phase 9.10: title, objective and prompts live in the menus.
        if (lastTitle !== '') {
          text(titleNode, '');
          text(instructionsNode, '');
          text(promptNode, '');
          lastTitle = '';
          lastInstructions = '';
        }
        objectiveNode.setAttribute?.('class', 'tl-flow-hud__line');
        if (state.flowLine !== lastObjective) {
          text(objectiveNode, state.flowLine);
          lastObjective = state.flowLine;
        }
        text(statusNode, `sound: ${state.sound}`);
        return;
      }
      if (state.title !== lastTitle) {
        text(titleNode, state.title);
        lastTitle = state.title;
      }
      if (state.objective !== lastObjective) {
        text(objectiveNode, state.objective);
        lastObjective = state.objective;
      }
      if (state.instructions !== lastInstructions) {
        text(instructionsNode, state.instructions);
        lastInstructions = state.instructions;
      }
      text(promptNode, HUD_PROMPTS[state.state] ?? HUD_PROMPTS.playing);
      const checkpoint = state.checkpointActive && state.checkpointStep !== null
        ? ` (checkpoint @ step ${state.checkpointStep} active)`
        : '';
      const counters = state.counters !== undefined && state.counters !== '' ? `${state.counters} · ` : '';
      text(statusNode, `${counters}Deaths: ${state.deathCount}${checkpoint} — sound: ${state.sound}`);
    },
    dispose(): void {
      for (const fn of disposers.splice(0)) fn();
      root.remove();
    },
  };
}