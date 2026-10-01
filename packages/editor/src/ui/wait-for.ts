/** Poll `get` each animation frame (up to ~2 s) until it yields a value (a change arriving over the socket). */
export function waitFor<T>(get: () => T | null): Promise<T | null> {
  return new Promise((resolve) => {
    const started = performance.now();
    const tick = (): void => {
      const v = get();
      if (v !== null || performance.now() - started > 2000) resolve(v);
      else requestAnimationFrame(tick);
    };
    tick();
  });
}
