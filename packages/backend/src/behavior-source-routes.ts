/**
 * The script source routes: `POST …/content/behaviors/source` prepares and
 * publishes a script's TypeScript source (or compiles it without publishing),
 * and the same route publishes a visual script from its stored graph. The
 * editor's Publish and MCP's script tool both send it, so a source reaches a
 * project one way.
 */
import { type IncomingMessage, type ServerResponse } from 'node:http';
import { canonicalContainerText, diagnosticsWithNodes, generateGraphSource, graphProblemsFailure } from '@thirdlight/behavior-build';
import { BEHAVIOR_ENTRY_PATH, ID_RE } from '@thirdlight/project-model/limits';
import { parseStrictJsonBytes, sessionError, statusFor, type SessionError } from '@thirdlight/protocol';
import { type CommandError, type WorkspaceService } from '@thirdlight/workspace';

import { publishBehaviorSource } from './behavior';
import { type createBehaviorCompilerPort } from './content';
import { type SessionRegistry } from './sessions';
import { type OriginDoc } from './util';

import type { Problem } from './backend';

export interface BehaviorSourceRoutesContext {
  readonly service: WorkspaceService;
  readonly sessions: SessionRegistry;
  readonly behaviorCompiler: ReturnType<typeof createBehaviorCompilerPort>;
  readonly sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  readonly sendError: (res: ServerResponse, error: SessionError, statusOverride?: number) => void;
  readonly requireAuth: (req: IncomingMessage, projectId: string, adminOnly: boolean) => SessionError | null;
  readonly readBody: (req: IncomingMessage) => Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error: SessionError }>;
  readonly workspaceError: (e: CommandError) => SessionError;
  readonly recordProblem: (projectId: string, source: Problem['source'], code: string, message: string) => void;
  readonly notifyMutationApplied: (projectId: string, requestId: string, revision: number, origin: OriginDoc | null, change: unknown) => void;
}

/**
 * The source container a request names by its files (`container: {files,
 * ownedTransforms?, requiredModules?}`), in the one canonical form the
 * compiler accepts: files in path order, the one entry path, and the
 * pinned script API module unless the request lists its own. A client sends
 * code without knowing the container's byte rules.
 */
export function containerBytesOf(raw: unknown, pinnedModuleIds: readonly string[]): { ok: true; bytes: Uint8Array } | { ok: false; error: SessionError } {
  const bad = (path: string, message: string) => ({ ok: false as const, error: sessionError('field_value', 'validation', message, { path }) });
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return bad('/container', 'container must be {files, ownedTransforms?, requiredModules?}');
  const c = raw as Record<string, unknown>;
  for (const key of Object.keys(c)) {
    if (!['files', 'ownedTransforms', 'requiredModules'].includes(key)) return { ok: false, error: sessionError('field_unexpected', 'validation', `unknown container field "${key}"`, { path: `/container/${key}` }) };
  }
  const strings = (v: unknown, path: string): string[] | { error: SessionError } => {
    if (!Array.isArray(v) || v.some((s) => typeof s !== 'string')) return { error: sessionError('field_value', 'validation', `${path.slice(11)} must be an array of strings`, { path }) };
    return [...(v as string[])].sort();
  };
  if (!Array.isArray(c.files) || c.files.length === 0) return bad('/container/files', 'container.files must be a non-empty array of {path, text}');
  const files: { path: string; text: string }[] = [];
  for (const [i, f] of (c.files as unknown[]).entries()) {
    const file = f as Record<string, unknown> | null;
    if (typeof file !== 'object' || file === null || typeof file.path !== 'string' || typeof file.text !== 'string' || Object.keys(file).some((k) => k !== 'path' && k !== 'text')) {
      return bad(`/container/files/${i}`, 'a file is exactly {path, text}');
    }
    files.push({ path: file.path, text: file.text });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const owned = c.ownedTransforms === undefined ? [] : strings(c.ownedTransforms, '/container/ownedTransforms');
  if (!Array.isArray(owned)) return { ok: false, error: owned.error };
  const modules = c.requiredModules === undefined ? [...pinnedModuleIds].sort() : strings(c.requiredModules, '/container/requiredModules');
  if (!Array.isArray(modules)) return { ok: false, error: modules.error };
  const text = canonicalContainerText({ graphVersion: 1, entryPath: BEHAVIOR_ENTRY_PATH, requiredModules: modules, ownedTransforms: owned, files });
  return { ok: true, bytes: new TextEncoder().encode(text) };
}

export function makeBehaviorSourceRoutes(ctx: BehaviorSourceRoutesContext) {
  const { service, sessions, behaviorCompiler, sendJson, sendError, requireAuth, readBody, workspaceError, recordProblem, notifyMutationApplied } = ctx;
  const pinnedModuleIds = behaviorCompiler.pinnedModules.map((m) => m.id);

  /**
   * `POST /api/v1/projects/:projectId/content/behaviors/source` — the additive
   * behavior-source preparation+publication route.
   *
   * It runs the behavior-source facade: stage read → trust gate → injected
   * compile → immutable blob, then the ordinary `publishBehavior{mode:'source'}`
   * command through `workspace.runCommand` (the sole executor). No second
   * commit path, no code evaluation.
   */
  const behaviorSourceRoute = async (req: IncomingMessage, res: ServerResponse, projectId: string): Promise<void> => {
    const authError = requireAuth(req, projectId, false);
    if (authError !== null) {
      sendError(res, authError);
      return;
    }
    const body = await readBody(req);
    if (!body.ok) {
      sendError(res, body.error);
      return;
    }
    const strict = parseStrictJsonBytes(body.bytes.length === 0 ? new TextEncoder().encode('{}') : body.bytes);
    if (!strict.ok) {
      sendError(res, strict.error);
      return;
    }
    const value = strict.value as Record<string, unknown>;
    for (const key of Object.keys(value)) {
      if (!['stageId', 'bytesBase64', 'container', 'behaviorId', 'displayName', 'declaration', 'expectedRevision', 'requestId', 'check', 'graph'].includes(key)) {
        sendError(res, sessionError('field_unexpected', 'validation', `unknown field "${key}"`, { path: `/${key}` }));
        return;
      }
    }
    // `check: true` — compile only (the script editor's save and
    // idle check). The same pinned compiler instance as publication; nothing
    // is written (no stage, no blob, no derived cache, no revision) and no
    // code runs, so the per-digest trust gate (which guards the runnable
    // artifact) does not apply.
    if (value.check !== undefined) {
      await behaviorCheck(res, projectId, value);
      return;
    }
    // `graph: true` — the source is generated from the behavior's
    // visual-script graph (as stored now); then the same preparation and
    // publication as any source (trust per exact digest, one command).
    let graphSource: { bytes: Uint8Array; lineNodes: Record<string, (string | null)[]> } | null = null;
    if (value.graph !== undefined) {
      if (value.graph !== true || value.stageId !== undefined || value.bytesBase64 !== undefined || value.container !== undefined) {
        sendError(res, sessionError('field_value', 'validation', 'graph must be true and comes without stageId/bytesBase64/container (the source is generated from the stored graph)', { path: '/graph' }));
        return;
      }
      const gen = behaviorGraphSource(projectId, value.behaviorId);
      if ('error' in gen) {
        sendError(res, gen.error, gen.status);
        return;
      }
      if (!gen.result.ok) {
        const failure = graphProblemsFailure(gen.result.problems);
        recordProblem(projectId, 'compile', failure.code, `Script ${String(value.behaviorId)} failed to compile: ${failure.diagnostics[0]?.message ?? failure.reason}`);
        sendJson(res, 400, { ok: false, error: { code: failure.code, cls: 'validation', message: failure.diagnostics[0]?.message ?? 'the graph does not compile', diagnostics: failure.diagnostics } });
        return;
      }
      graphSource = { bytes: gen.result.containerBytes, lineNodes: gen.result.lineNodes };
    }
    // `container: {files, …}` — the source sent as its files in the request
    // (up to the request bound) instead of a staged container.
    let sentSource: Uint8Array | null = null;
    if (value.container !== undefined) {
      if (value.stageId !== undefined || value.bytesBase64 !== undefined) {
        sendError(res, sessionError('field_value', 'validation', 'container comes without stageId/bytesBase64', { path: '/container' }));
        return;
      }
      const built = containerBytesOf(value.container, pinnedModuleIds);
      if (!built.ok) {
        sendError(res, built.error);
        return;
      }
      sentSource = built.bytes;
    }
    const behaviorId = value.behaviorId;
    const displayName = value.displayName;
    const declaration = value.declaration;
    const expectedRevision = value.expectedRevision;
    const requestId = value.requestId;
    const stageId = value.stageId;
    if (typeof behaviorId !== 'string' || !ID_RE.test(behaviorId)) {
      sendError(res, sessionError('field_value', 'validation', 'behaviorId must use the project-model ID syntax', { path: '/behaviorId' }));
      return;
    }
    if (typeof displayName !== 'string' || displayName.length < 1 || displayName.length > 128) {
      sendError(res, sessionError('field_value', 'validation', 'displayName must be a 1–128 character string', { path: '/displayName' }));
      return;
    }
    // Optional when the source declares its properties in code
    // (`export const properties`); a declaration sent along is then ignored.
    if (declaration !== undefined && (typeof declaration !== 'object' || declaration === null || Array.isArray(declaration))) {
      sendError(res, sessionError('field_type', 'validation', 'declaration must be a property-declaration object', { path: '/declaration' }));
      return;
    }
    if (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision) || expectedRevision < 0) {
      sendError(res, sessionError('field_value', 'validation', 'expectedRevision must be an integer ≥ 0', { path: '/expectedRevision' }));
      return;
    }
    if (typeof requestId !== 'string' || !/^req-[0-9a-f]{32}$/.test(requestId)) {
      sendError(res, sessionError('field_value', 'validation', 'requestId must be req- + 32 hex', { path: '/requestId' }));
      return;
    }
    const session = sessions.sessionForProject(projectId);
    const origin: OriginDoc = session !== undefined ? { kind: 'browser', clientId: session.sessionId } : { kind: 'admin', clientId: 'operator' };
    const outcome = await publishBehaviorSource(service, {
      projectId,
      ...(typeof stageId === 'string' ? { stageId } : {}),
      ...(graphSource !== null ? { bytes: graphSource.bytes } : sentSource !== null ? { bytes: sentSource } : {}),
      behaviorId,
      displayName,
      declaration: (declaration ?? { properties: [] }) as never,
      expectedRevision,
      requestId,
      origin,
    });
    if (outcome.ok) {
      // The editor follows this publication like any command, so its
      // behavior list stays current without a resync.
      if (outcome.result.duplicated === false) notifyMutationApplied(projectId, outcome.result.requestId, outcome.result.revision, origin, outcome.result.change);
      sendJson(res, 200, {
        ok: true,
        behaviorId,
        sourceDigest: outcome.prepared.sourceDigest,
        outputDigest: outcome.prepared.outputDigest,
        // The published declaration and where it came from.
        declaration: outcome.prepared.declaration,
        ...(outcome.prepared.declaredInCode === true ? { declaredInCode: true } : {}),
        ...(outcome.prepared.sourceKind === 'graph' ? { sourceKind: 'graph' } : {}),
        revision: outcome.result.revision,
        requestId,
      });
      return;
    }
    if (outcome.kind === 'compile') {
      recordProblem(projectId, 'compile', outcome.failure.code, `Script ${behaviorId} failed to compile: ${outcome.failure.reason}`);
      const diagnostics = outcome.failure.diagnostics.slice(0, 32);
      sendJson(res, 400, {
        ok: false,
        error: {
          code: outcome.failure.code,
          cls: 'validation',
          message: outcome.failure.reason.slice(0, 256),
          diagnostics: graphSource !== null ? diagnosticsWithNodes(diagnostics, graphSource.lineNodes) : diagnostics,
        },
      });
      return;
    }
    sendJson(res, statusFor(outcome.error.cls), { ok: false, error: outcome.error });
  };

  /**
   * The source generated from one behavior's stored visual-script
   * graph (the generator is pure: the same graph gives the same bytes, so a
   * check's digest is the digest the publication will ask trust for).
   */
  const behaviorGraphSource = (
    projectId: string,
    behaviorId: unknown,
  ): { result: ReturnType<typeof generateGraphSource> } | { error: SessionError; status?: number } => {
    if (typeof behaviorId !== 'string' || !ID_RE.test(behaviorId)) {
      return { error: sessionError('field_value', 'validation', 'behaviorId must use the project-model ID syntax', { path: '/behaviorId' }) };
    }
    const found = service.query({ op: 'queryBehaviors', projectId, args: { behaviorId, includeDeclaration: true, limit: 1, offset: 0 } }) as unknown as { ok: boolean; error?: CommandError; behaviors?: { behaviorId: string; graph?: unknown; functions?: unknown }[] };
    if (!found.ok && found.error?.code !== 'behavior_not_found') return { error: workspaceError(found.error as CommandError) };
    const record = found.behaviors?.find((b) => b.behaviorId === behaviorId);
    if (record === undefined) return { error: sessionError('field_value', 'not_found', `no behavior "${behaviorId}"`, { path: '/behaviorId' }), status: 404 };
    if (record.graph === undefined) return { error: sessionError('field_value', 'validation', `behavior "${behaviorId}" is not a visual script (it has no graph)`, { path: '/graph' }) };
    // With the script's functions and the project's shared functions (their code is part of the digest-bound source).
    const config = service.query({ op: 'queryGameConfig', projectId }) as unknown as { graphs?: unknown };
    return { result: generateGraphSource(record.graph as Parameters<typeof generateGraphSource>[0], { functions: record.functions, graphs: config.graphs ?? [] }) };
  };

  /** The compile-only check of `POST …/content/behaviors/source` (`check: true`). */
  const behaviorCheck = async (res: ServerResponse, projectId: string, value: Record<string, unknown>): Promise<void> => {
    if (value.check !== true) {
      sendError(res, sessionError('field_value', 'validation', 'check must be true', { path: '/check' }));
      return;
    }
    // `{check: true, graph: true, behaviorId}` compiles the behavior's stored graph.
    if (value.graph !== undefined) {
      for (const key of Object.keys(value)) {
        if (!['check', 'graph', 'behaviorId'].includes(key)) {
          sendError(res, sessionError('field_unexpected', 'validation', `a graph check takes check, graph and behaviorId only ("${key}")`, { path: `/${key}` }));
          return;
        }
      }
      if (value.graph !== true) {
        sendError(res, sessionError('field_value', 'validation', 'graph must be true', { path: '/graph' }));
        return;
      }
      const gen = behaviorGraphSource(projectId, value.behaviorId);
      if ('error' in gen) {
        sendError(res, gen.error, gen.status);
        return;
      }
      const behaviorId = value.behaviorId as string;
      if (!gen.result.ok) {
        const failure = graphProblemsFailure(gen.result.problems);
        sendJson(res, 200, { ok: true, compiled: false, behaviorId, code: failure.code, reason: failure.reason, diagnostics: failure.diagnostics });
        return;
      }
      const g = gen.result;
      const warnings = g.problems.slice(0, 32).map((p) => ({ message: p.message, ...(p.nodeId !== undefined ? { nodeId: p.nodeId } : {}) }));
      let compiled;
      try {
        compiled = await behaviorCompiler.compile({ behaviorId, declaration: g.declaration, containerBytes: g.containerBytes, pinnedModules: behaviorCompiler.pinnedModules });
      } catch (e) {
        compiled = { ok: false as const, code: 'behavior_compile_failed', reason: 'the compiler threw', diagnostics: [{ code: 'behavior_compile_failed', reason: 'throw', message: (e instanceof Error ? e.message : String(e)).slice(0, 256) }] };
      }
      if (compiled.ok) {
        sendJson(res, 200, {
          ok: true,
          compiled: true,
          behaviorId,
          sourceDigest: compiled.manifest.sourceDigest,
          outputByteLength: compiled.manifest.outputByteLength,
          declaration: compiled.manifest.declaration,
          declaredInCode: true,
          sourceKind: 'graph',
          diagnostics: [],
          warnings,
        });
        return;
      }
      sendJson(res, 200, { ok: true, compiled: false, behaviorId, code: compiled.code, reason: String(compiled.reason).slice(0, 256), diagnostics: diagnosticsWithNodes(compiled.diagnostics.slice(0, 32), g.lineNodes), warnings });
      return;
    }
    for (const key of Object.keys(value)) {
      if (!['check', 'bytesBase64', 'container', 'behaviorId', 'declaration'].includes(key)) {
        sendError(res, sessionError('field_unexpected', 'validation', `a check takes check, bytesBase64 or container, behaviorId and declaration only ("${key}")`, { path: `/${key}` }));
        return;
      }
    }
    const behaviorId = value.behaviorId;
    if (typeof behaviorId !== 'string' || !ID_RE.test(behaviorId)) {
      sendError(res, sessionError('field_value', 'validation', 'behaviorId must use the project-model ID syntax', { path: '/behaviorId' }));
      return;
    }
    let bytes: Uint8Array;
    if (value.container !== undefined && value.bytesBase64 === undefined) {
      const built = containerBytesOf(value.container, pinnedModuleIds);
      if (!built.ok) {
        sendError(res, built.error);
        return;
      }
      bytes = built.bytes;
    } else {
      const b64 = value.bytesBase64;
      if (typeof b64 !== 'string' || b64.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || value.container !== undefined) {
        sendError(res, sessionError('field_value', 'validation', 'bytesBase64 must be the base64 of the source-graph container (or send container instead)', { path: '/bytesBase64' }));
        return;
      }
      bytes = new Uint8Array(Buffer.from(b64, 'base64'));
    }
    const declaration = value.declaration;
    if (declaration !== undefined && (typeof declaration !== 'object' || declaration === null || Array.isArray(declaration))) {
      sendError(res, sessionError('field_type', 'validation', 'declaration must be a property-declaration object', { path: '/declaration' }));
      return;
    }
    // `@lib/<id>` imports link the project's script libraries.
    const libraries = service.scriptLibraryInputs(projectId);
    let result;
    try {
      result = await behaviorCompiler.compile({
        behaviorId,
        declaration: (declaration ?? { properties: [] }) as never,
        containerBytes: bytes,
        pinnedModules: behaviorCompiler.pinnedModules,
        ...(libraries.length > 0 ? { libraries } : {}),
      });
    } catch (e) {
      result = { ok: false as const, code: 'behavior_compile_failed', reason: 'the compiler threw', diagnostics: [{ code: 'behavior_compile_failed', reason: 'throw', message: (e instanceof Error ? e.message : String(e)).slice(0, 256) }] };
    }
    if (result.ok) {
      sendJson(res, 200, {
        ok: true,
        compiled: true,
        behaviorId,
        sourceDigest: result.manifest.sourceDigest,
        outputByteLength: result.manifest.outputByteLength,
        declaration: result.manifest.declaration,
        ...(result.manifest.declaredInCode === true ? { declaredInCode: true } : {}),
        ...(result.manifest.libraries !== undefined ? { libraries: result.manifest.libraries } : {}),
        diagnostics: [],
      });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      compiled: false,
      behaviorId,
      code: result.code,
      reason: String(result.reason).slice(0, 256),
      diagnostics: result.diagnostics.slice(0, 32),
    });
  };

  return { behaviorSourceRoute };
}
