// thirdlight prepared behavior output — FIXTURE STAND-IN (packet 33 produces the real artifact)
var __thirdlight_behavior_default = {
  prepare: function prepare() { return {}; },
  instantiate: function instantiate() { return { steps: 0 }; },
  step: function step(state, ctx) {
    state.steps += 1;
    var speed = ctx.properties.speed;
    ctx.emit({ kind: 'control_move', value: speed / 10 });
  },
  dispose: function dispose() {}
};
export default __thirdlight_behavior_default;
