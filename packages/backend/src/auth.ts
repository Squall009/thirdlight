/**
 * Who may call the authoring origin: bearer tokens and their scopes, the
 * trusted networks that stand in for the owner's token, and the Origin
 * allowlist.
 */
import type { IncomingMessage } from 'node:http';
import { sessionError, type SessionError } from '@thirdlight/protocol';

import type { BackendConfig } from './config';
import { bearerToken } from './http';
import { isTrustedRequest, parseCidrList } from './trusted';

export interface BackendAuth {
  /** The scope a token grants (a trusted request without one is the owner, `admin`); null: none. */
  tokenScope(token: string | null, req?: IncomingMessage): string | null;
  /** Whether a request comes from a trusted network. */
  trustedRequest(req: IncomingMessage): boolean;
  /**
   * Auth for a project-scoped route: an `authoring:<projectId>` token for
   * this project, or an `admin` token (adminOnly: `admin` only).
   */
  requireAuth(req: IncomingMessage, projectId: string, adminOnly: boolean): SessionError | null;
  /** The request's `Origin` when it is not allowed; null when allowed or absent. */
  originRejected(req: IncomingMessage): string | null;
  /** Whether the request carries any valid credential. */
  authorized(req: IncomingMessage): boolean;
}

export function createAuth(config: BackendConfig): BackendAuth {
  const tokenScopes = new Map<string, string>();
  for (const t of config.tokens) tokenScopes.set(t.token, t.scope);

  // A request from a trusted network (config.trustedNetworks, through a
  // listed proxy's X-Forwarded-For) is the owner without a token. The Origin
  // allowlist still applies to it.
  const trustedNetworks = parseCidrList(config.trustedNetworks);
  const trustedProxies = parseCidrList(config.trustedProxies);
  const trustedRequest = (req: IncomingMessage): boolean =>
    isTrustedRequest(req as unknown as Parameters<typeof isTrustedRequest>[0], trustedNetworks, trustedProxies);
  const tokenScope = (token: string | null, req?: IncomingMessage): string | null => {
    const scope = token === null ? null : (tokenScopes.get(token) ?? null);
    if (scope !== null) return scope;
    return req !== undefined && trustedRequest(req) ? 'admin' : null;
  };

  const requireAuth = (req: IncomingMessage, projectId: string, adminOnly: boolean): SessionError | null => {
    const scope = tokenScope(bearerToken(req), req);
    if (scope === null) return sessionError('unauthorized', 'validation', 'a valid bearer token is required');
    if (adminOnly) {
      return scope === 'admin' ? null : sessionError('unauthorized', 'validation', 'this route requires an admin token');
    }
    if (scope === 'admin') return null;
    if (scope === `authoring:${projectId}`) return null;
    return sessionError('unauthorized', 'validation', 'the token scope does not cover this project');
  };

  // Absent `Origin` header ⇒ not checked; present ⇒ exact match.
  const originRejected = (req: IncomingMessage): string | null => {
    const o = req.headers.origin;
    if (typeof o !== 'string') return null;
    return config.authoringOrigins.includes(o) ? null : o;
  };

  return { tokenScope, trustedRequest, requireAuth, originRejected, authorized: (req) => tokenScope(bearerToken(req), req) !== null };
}
