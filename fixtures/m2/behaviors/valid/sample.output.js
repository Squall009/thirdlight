// tl-behavior-memory:src/util.ts
function drift(t, speed) {
  const wobble = (t % 10 - 5) / 100;
  return Math.max(-1, Math.min(1, speed / 10 + wobble));
}

// src/index.ts
var src_default = {
  prepare() {
    return { t: 0 };
  },
  instantiate(prepared, inst) {
    return { t: 0, speed: inst.properties.speed };
  },
  step(state, ctx) {
    state.t += 1;
    ctx.emit({ kind: "control_move", value: drift(state.t, state.speed) });
  },
  dispose() {
  }
};
export {
  src_default as default
};
