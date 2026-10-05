/**
 * Small helpers every panel's wiring shares: the bounded error a panel shows
 * for a refused edit, and the editor's own relay ids over the preview bridge.
 */
import type { MutableRefObject } from 'react';
import type { SessionClient } from '../../session/client';
import type { Viewport } from '../../viewport/viewport';
import type { ModelFiles } from '../../viewport/model-files';
import type { MutationResponse } from '../../session/envelope';
import type { GameplayBackendError } from '../GameplayPanel';

/** A bounded, actionable error the panels display. */
export interface UiError {
  code: string;
  message: string;
}

/** The result of one ordinary command. */
export type CommandResult = Awaited<ReturnType<SessionClient['command']>>;

/** The editor's session client, Scene view and model instances (made once per mount). */
export type ClientRef = MutableRefObject<SessionClient | null>;
export type ViewportRef = MutableRefObject<Viewport | null>;
export type ModelsRef = MutableRefObject<ModelFiles | null>;

/** Shows a dismissible message over the Scene view (null clears it). */
export type SetNotice = (message: string | null) => void;

/** Reports a failed edit where the user is looking (the notice over the Scene view). */
export type ReportFailure = (what: string, res: CommandResult) => void;

/** The bounded backend error for a failed command (the panels explain it, never lose it). */
export function commandError(res: { response: MutationResponse }): GameplayBackendError {
  const r = res.response;
  if (r.ok) return { code: 'unexpected_response', message: 'unexpected response shape' };
  return { code: r.code, message: r.message ?? r.code };
}

/** Why a command was refused, or null when it was applied. */
export const refusal = (res: CommandResult): string | null =>
  res.ok ? null : ((res.response as { message?: string; code?: string }).message ?? (res.response as { code?: string }).code ?? 'the edit was refused');

/** A fresh relay id for the editor's own requests to the running Play (never one of the backend's). */
export function localRelayId(): string {
  let hex = '';
  for (let i = 0; i < 32; i++) hex += Math.floor(Math.random() * 16).toString(16);
  return `relay-${hex}`;
}
