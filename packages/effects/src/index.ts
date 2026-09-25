/**
 * @thirdlight/effects — phase 20.1: the CPU reference semantics of visual
 * effect graphs (graph kind `effect`): compile an effect's system graphs
 * (`compileEffect`, with diagnostics) and simulate it deterministically per
 * seed over typed arrays (`EffectInstance`); the Output maths (flipbook,
 * billboard axes, lights, ribbons) for the renderers of phase 20.2.
 *
 * Visual only: never imported by the deterministic runtime simulation.
 */
export { compileEffect, POST_INTEGRATION_BLOCKS, type CompiledNode, type CompileOptions, type EffectDiagnostic, type EffectProgram, type SystemProgram, type TrailSpec, type WireSource } from './program';
export { convertValue, EffectInstance, SystemState, type EffectEvent, type EffectInstanceOptions, type EffectMesh, type SpawnPlan, type StepInput } from './evaluator';
export { billboardAxes, flipbookFrame, flipbookRect, lightParticles, ribbonOrder } from './output';
export { evalCurve, evalGradient, evalGradientSrgb, hexToLinear, srgbToLinear } from './curves';
export { GradientNoise } from './noise';
export { hash32, hashFloat, hashString, Rng } from './rng';
export { IDENTITY_ORIGIN, rotate, toLocalPoint, toLocalVector, toWorldDirection, toWorldPoint, toWorldVector, type EffectOrigin, type Quat, type Vec3, type Vec4 } from './math';
