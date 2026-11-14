/**
 * Commands as a test or a benchmark sends them: the envelope the editor and
 * MCP send (the project's current revision, a fresh request id, an MCP
 * origin) over a backend's command route. One place builds it, so a change to
 * the envelope reaches every spec at once.
 */
import { randomBytes } from 'node:crypto';

/** What sends a command envelope's JSON body and answers its JSON (tests/e2e/backend.ts's `E2EBackend`). */
export interface CommandRoute {
  projectId: string;
  command(body: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface CommandOptions {
  /** The MCP origin's client id (what the project's history and feed name as the sender); null: no origin (the route's own). */
  clientId?: string | null;
  /** Another project of the same backend (default: the route's own). */
  projectId?: string;
  /** `mustCommand`: an edit that changes nothing (`no_change`) counts as done. */
  noChangeIsDone?: boolean;
}

/** A fresh request id in the format commands take (`req-` and 32 hex digits). */
export function newRequestId(): string {
  return `req-${randomBytes(16).toString('hex')}`;
}

/** The project's acknowledged revision (`queryProject`). */
export async function projectRevision(be: CommandRoute, projectId = be.projectId): Promise<number> {
  return Number((await be.command({ op: 'queryProject', projectId, args: {} }))['revision']);
}

/** The envelope of one command at `expectedRevision` (a fresh request id, an MCP origin unless `clientId` is null). */
export function commandEnvelope(op: string, projectId: string, expectedRevision: unknown, args: Record<string, unknown>, clientId: string | null = 'e2e'): Record<string, unknown> {
  return { op, projectId, expectedRevision, requestId: newRequestId(), ...(clientId !== null ? { origin: { kind: 'mcp', clientId } } : {}), args };
}

/** Send one command at the project's current revision; answers the result as it came (a refusal included). */
export async function sendCommand(be: CommandRoute, op: string, args: Record<string, unknown>, o: CommandOptions = {}): Promise<Record<string, unknown>> {
  const projectId = o.projectId ?? be.projectId;
  return be.command(commandEnvelope(op, projectId, await projectRevision(be, projectId), args, o.clientId));
}

/** `sendCommand`, and throw (with the answer) unless it was applied. */
export async function mustCommand(be: CommandRoute, op: string, args: Record<string, unknown>, o: CommandOptions = {}): Promise<Record<string, unknown>> {
  const res = await sendCommand(be, op, args, o);
  if (o.noChangeIsDone === true && (res['error'] as { code?: unknown } | undefined)?.code === 'no_change') return res;
  if (res['ok'] !== true) throw new Error(`${op} refused: ${JSON.stringify(res).slice(0, 600)}`);
  return res;
}
