/**
 * The request envelope as the service reads it before a command runs: the
 * project and request ids, the canonical-JSON gate, the query envelope, and
 * the failure payload that echoes what could be parsed.
 */

import type { CommandError, MutationResult } from '@thirdlight/commands';

import { invalidRequest, pointerSegment } from './errors';

export function envelopeProjectId(request: unknown): string | null {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) return null;
  const v = (request as Record<string, unknown>)['projectId'];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** A missing/unparseable projectId cannot be resolved: `invalid_request`. */
export function invalidRequestFor(request: unknown): CommandError {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return invalidRequest('', jsonTypeName(request), 'object (mutation request)', 'a mutation request must be an object');
  }
  const v = (request as Record<string, unknown>)['projectId'];
  if (v === undefined) {
    return invalidRequest('/projectId', undefined, 'project-model ID syntax', "required field 'projectId' is missing");
  }
  return invalidRequest('/projectId', v, 'project-model ID syntax: [a-z0-9][a-z0-9_-]{0,63}', 'projectId must use the project-model ID syntax');
}

/** Extract the request envelope's requestId (string or null). */
export function envelopeRequestId(request: unknown): string | null {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) return null;
  const v = (request as Record<string, unknown>)['requestId'];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * The first non-canonicalizable part of the request
 * value, or null when the ENTIRE value is a JSON value under the digest's
 * canonical rules (the same canonical-bytes semantics the
 * model's canonical serialization relies on: plain objects, arrays, finite
 * numbers, strings, booleans, null). Reports the first offending field with
 * a JSON-pointer-style path (first key order, then array order).
 */
export interface CanonicalIssue {
  path: string;
  value: unknown;
  expected: string;
  message: string;
}

export function canonicalIssue(value: unknown): CanonicalIssue | null {
  const stack = new Set<object>();
  const walk = (v: unknown, path: string): CanonicalIssue | null => {
    if (v === null) return null;
    if (typeof v === 'string' || typeof v === 'boolean') return null;
    if (typeof v === 'number') {
      return Number.isFinite(v)
        ? null
        : {
            path,
            value: v,
            expected: 'finite number',
            message: 'non-finite number is not a JSON value',
          };
    }
    if (
      typeof v === 'undefined' ||
      typeof v === 'bigint' ||
      typeof v === 'symbol' ||
      typeof v === 'function'
    ) {
      return {
        path,
        value: v,
        expected: 'JSON value (string, number, boolean, null, array or object)',
        message: `${typeof v} is not a JSON value`,
      };
    }
    // From here on v is an object (array or non-array object).
    if (stack.has(v)) {
      return {
        path,
        value: '[circular]',
        expected: 'acyclic JSON value',
        message: 'self-referencing value is not a JSON value',
      };
    }
    if (Array.isArray(v)) {
      stack.add(v);
      for (let i = 0; i < v.length; i += 1) {
        const issue = walk(v[i], `${path}/${i}`);
        if (issue !== null) return issue;
      }
      stack.delete(v);
      return null;
    }
    const tag = Object.prototype.toString.call(v);
    if (tag !== '[object Object]') {
      // Date, Map, Set, typed arrays, … — not plain JSON objects. (The
      // digest's canonicalizer would silently fold an empty-keyed Date into
      // `{}` — bytes that disagree with the JSON wire form — so these are
      // rejected here, before any digest is computed.)
      return {
        path,
        value: tag.slice(8, -1),
        expected: 'plain object (JSON object)',
        message: `${tag.slice(8, -1)} is not a plain JSON object`,
      };
    }
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) {
      return {
        path,
        value: 'Object',
        expected: 'plain object (JSON object)',
        message: 'class instance is not a plain JSON object',
      };
    }
    const rec = v as Record<string, unknown>;
    stack.add(v);
    for (const k of Object.keys(rec)) {
      const issue = walk(rec[k], `${path}/${pointerSegment(k)}`);
      if (issue !== null) return issue;
    }
    stack.delete(v);
    return null;
  };
  return walk(value, '');
}

/** A failure payload with the parseable echo fields (`op` ≤ 32 chars, `projectId` when parseable, `requestId` ≤ 64 chars). */
export function failRequest(request: unknown, error: CommandError): MutationResult {
  const out: {
    ok: false;
    op?: string;
    projectId?: string;
    requestId?: string;
    error: CommandError;
  } = { ok: false, error };
  if (typeof request === 'object' && request !== null && !Array.isArray(request)) {
    const req = request as Record<string, unknown>;
    const op = echoOp(req['op']);
    if (op !== undefined) out.op = op;
    if (typeof req['projectId'] === 'string') out.projectId = req['projectId'];
    const rid = req['requestId'];
    if (typeof rid === 'string' && rid.length > 0) {
      out.requestId = rid.length > 64 ? rid.slice(0, 64) : rid;
    }
  }
  return out as MutationResult;
}

export function echoOp(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  return v.length > 32 ? v.slice(0, 32) : v;
}

export function echoProjectId(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** Query envelope validation (request-level `invalid_request`). */
export function validateQueryRequest(request: unknown):
  | {
      ok: true;
      op: 'queryProject' | 'queryEntity' | 'queryEntities' | 'queryAssets' | 'queryPrefabs' | 'queryBehaviors' | 'queryGameConfig' | 'queryBlocks' | 'queryIndex' | 'queryTerrain';
      projectId: string;
      args: Record<string, unknown> | undefined;
    }
  | { ok: false; error: CommandError } {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return {
      ok: false,
      error: invalidRequest('', jsonTypeName(request), 'object (query request)', 'a query request must be an object'),
    };
  }
  const req = request as Record<string, unknown>;
  for (const k of Object.keys(req)) {
    if (!['op', 'projectId', 'args'].includes(k)) {
      return {
        ok: false,
        error: invalidRequest(`/${pointerSegment(k)}`, k, 'known fields: op, projectId, args (optional)', 'unknown field is not permitted (strict M1 request drops nothing)'),
      };
    }
  }
  const op = req['op'];
  if (
    op !== 'queryProject' &&
    op !== 'queryEntity' &&
    op !== 'queryEntities' &&
    op !== 'queryAssets' &&
    op !== 'queryPrefabs' &&
    op !== 'queryBehaviors' &&
    op !== 'queryGameConfig' &&
    op !== 'queryBlocks' &&
    op !== 'queryIndex' &&
    op !== 'queryTerrain'
  ) {
    return {
      ok: false,
      error: invalidRequest('/op', op, 'one of: queryProject, queryEntity, queryEntities, queryAssets, queryPrefabs, queryBehaviors, queryGameConfig, queryBlocks, queryIndex, queryTerrain', typeof op !== 'string' ? 'op must be a string query op' : 'op is not one of the accepted query ops'),
    };
  }
  const projectId = req['projectId'];
  if (typeof projectId !== 'string' || projectId.length === 0) {
    return {
      ok: false,
      error: invalidRequest('/projectId', projectId, 'project-model ID syntax', 'projectId must be a non-empty string'),
    };
  }
  let args: Record<string, unknown> | undefined;
  if (req['args'] !== undefined) {
    if (typeof req['args'] !== 'object' || req['args'] === null || Array.isArray(req['args'])) {
      return {
        ok: false,
        error: invalidRequest('/args', jsonTypeName(req['args']), 'object', 'args must be an object'),
      };
    }
    args = req['args'] as Record<string, unknown>; // shape-checked above
  }
  return { ok: true, op, projectId, args };
}

export function jsonTypeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** `name` 1–128 chars, no control characters. */
export function validName(s: string): boolean {
  if (s.length < 1 || s.length > 128) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return false;
  }
  return true;
}
