/**
 * Packet 63 — additive CDP helpers for cross-origin frame evaluation.
 *
 * The m3-browser library (reused unchanged) collects every CDP event on the
 * page WebSocket in `page.events`. `Runtime.enable` (already sent) reports an
 * `executionContextCreated` event for every frame context — including
 * cross-origin iframes. Evaluating with that `contextId` reaches inside the
 * preview iframe without any same-origin access. Nothing here changes the
 * m3-browser library.
 */

/** The newest LIVE (not-yet-reported-destroyed) context for `origin`, or null. */
export function findContext(page, origin) {
  const destroyed = new Set(
    page.events.filter((e) => e.method === 'Runtime.executionContextDestroyed').map((e) => e.params?.executionContextId),
  );
  let best = null;
  for (const e of page.events) {
    if (e.method !== 'Runtime.executionContextCreated') continue;
    const ctx = e.params?.context;
    if (ctx?.origin === origin && !destroyed.has(ctx.id)) best = ctx; // newest live wins (reload)
  }
  return best ?? null;
}

/**
 * Wait for (and return) the execution contextId of the frame whose context
 * origin equals `origin` (polls the accumulated event log; new contexts are
 * reported when the frame's document loads). A context reported destroyed
 * (the iframe navigated) never wins.
 */
export async function waitForContext(page, origin, { timeoutMs = 45_000, pollMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ctx = findContext(page, origin);
    if (ctx !== null) return ctx.id;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** Evaluate one expression inside a frame context (returnByValue). */
export async function evalInContext(page, contextId, expression) {
  const r = await page.send('Runtime.evaluate', {
    expression,
    contextId,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) return { __exception: r.exceptionDetails.text ?? 'exception' };
  return r.result?.value;
}

/**
 * Evaluate inside the frame context for `origin`. Resolves the context
 * immediately when one is already live (cheap loop polling); waits up to
 * `timeoutMs` only when none is (first document load, or after a navigation
 * that reported the old context destroyed). A dead-context evaluate
 * re-resolves once. Returns `null` when the context cannot be (re-)resolved
 * before the timeout.
 */
export async function evalInFrame(page, origin, expression, { timeoutMs = 10_000 } = {}) {
  const attempt = async (contextId) => {
    try {
      return await evalInContext(page, contextId, expression);
    } catch (e) {
      if (!String(e).includes('Cannot find context')) throw e;
      const fresh = await waitForContext(page, origin, { timeoutMs });
      if (fresh === null) return null;
      try {
        return await evalInContext(page, fresh, expression);
      } catch (e2) {
        if (String(e2).includes('Cannot find context')) return null;
        throw e2;
      }
    }
  };
  const live = findContext(page, origin);
  const contextId = live?.id ?? (await waitForContext(page, origin, { timeoutMs }));
  if (contextId === null) return null;
  return attempt(contextId);
}

/**
 * A diagnostic summary of the frame context events for `origin` (for failure
 * dumps): which contexts were created/destroyed and when (relative ms).
 */
export function contextEvents(page, origin) {
  const out = { created: [], destroyed: [] };
  for (const e of page.events) {
    if (e.method === 'Runtime.executionContextCreated' && e.params?.context?.origin === origin) {
      out.created.push({ id: e.params.context.id, name: e.params.context.name, uniqueId: e.params.context.uniqueId });
    }
    if (e.method === 'Runtime.executionContextDestroyed') {
      out.destroyed.push(e.params?.executionContextId);
    }
  }
  return out;
}