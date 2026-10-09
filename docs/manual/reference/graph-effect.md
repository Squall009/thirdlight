# Graph: Particle system

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The Particle system node catalogue: port types, then each category's nodes with their inputs, outputs and fields.

<a id="graph-effect"></a>
## Particle system

- Graph kind: `effect`
- Stored in: the `effect` documents that own it
- Node budget: 256
- Cycles: refused

Port types:

| Type | Label |
|---|---|
| `spawn` | spawn chain |
| `init` | initialize chain |
| `update` | update chain |
| `render` | output chain |
| `float` | float |
| `vec3` | vec3 |
| `color` | colour |

Implicit conversions:

- float → vec3 (all components)
- float → colour (grey, alpha 1)
- vec3 → colour (alpha 1)
- colour → vec3 (RGB)

<a id="graph-effect--contexts"></a>
## Contexts

- Spawn (`spawn`): How many particles are born each step: the sum of its blocks (rates, bursts, distance, events).
- Initialize (`initialize`): Runs once for each new particle, in chain order: where it starts, how it moves, how long it lasts, how it looks.
- Update (`update`): Runs every step for each living particle, in chain order: forces, then the position moves, then collisions and kills.
- Output (`output`): How the particles are drawn: every renderer on the chain draws them (in chain order).

<a id="node-effect--spawn"></a>
### Spawn (`spawn`)

How many particles are born each step: the sum of its blocks (rates, bursts, distance, events).

(every graph needs one; at most 1 per graph; part of every graph, not in the catalogue)

Outputs:

- `then` (spawn): one wire

<a id="node-effect--initialize"></a>
### Initialize (`initialize`)

Runs once for each new particle, in chain order: where it starts, how it moves, how long it lasts, how it looks.

(every graph needs one; at most 1 per graph; part of every graph, not in the catalogue)

Outputs:

- `then` (init): one wire

<a id="node-effect--update"></a>
### Update (`update`)

Runs every step for each living particle, in chain order: forces, then the position moves, then collisions and kills.

(every graph needs one; at most 1 per graph; part of every graph, not in the catalogue)

Outputs:

- `then` (update): one wire

<a id="node-effect--output"></a>
### Output (`output`)

How the particles are drawn: every renderer on the chain draws them (in chain order).

(every graph needs one; at most 1 per graph; part of every graph, not in the catalogue)

Outputs:

- `then` (render): one wire

<a id="graph-effect--spawn"></a>
## Spawn

- Constant rate (`spawn.rate`): Particles per second while the effect plays (fractions carry over to the next step).
- Burst (`spawn.burst`): A number of particles at once at a time of the effect; repeated `cycles` times every `interval` seconds (0 cycles: forever).
- Over distance (`spawn.distance`): Particles per metre the effect moves (trails behind moving objects); spread along the path.
- From event (`spawn.event`): Particles born where particles of another system of this effect die, are born or collide; they may inherit its velocity and colour.

<a id="node-effect--spawn-rate"></a>
### Constant rate (`spawn.rate`)

Particles per second while the effect plays (fractions carry over to the next step).

Inputs:

- `in` (spawn)
- `rate` "rate (/s)" (float)

Outputs:

- `then` (spawn): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `rate` | Rate (/s) | number | `10` | 0 – 100000 |

<a id="node-effect--spawn-burst"></a>
### Burst (`spawn.burst`)

A number of particles at once at a time of the effect; repeated `cycles` times every `interval` seconds (0 cycles: forever).

Inputs:

- `in` (spawn)
- `count` (float)
- `time` "time (s)" (float)

Outputs:

- `then` (spawn): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `count` | Count | number | `20` | 0 – 100000 |
| `time` | Time (s) | number | `0` | 0 – 3600 |
| `cycles` | Cycles | number | `1` | 0 – 10000 |
| `interval` | Interval (s) | number | `1` | 0.001 – 3600 |

<a id="node-effect--spawn-distance"></a>
### Over distance (`spawn.distance`)

Particles per metre the effect moves (trails behind moving objects); spread along the path.

Inputs:

- `in` (spawn)
- `perMeter` "per metre" (float)

Outputs:

- `then` (spawn): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `perMeter` | Per metre | number | `5` | 0 – 100000 |

<a id="node-effect--spawn-event"></a>
### From event (`spawn.event`)

Particles born where particles of another system of this effect die, are born or collide; they may inherit its velocity and colour.

Inputs:

- `in` (spawn)

Outputs:

- `then` (spawn): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `system` | System | string | `""` | ≤ 64 chars; matches `[a-z0-9][a-z0-9_-]{0,63}` |
| `event` | Event | enum | `"death"` | `death`, `birth`, `collision` |
| `count` | Per event | number | `1` | 0 – 64 |
| `inheritVelocity` | Inherit velocity | number | `0` | 0 – 1 |
| `inheritColor` | Inherit colour | boolean | `false` |  |

<a id="graph-effect--position"></a>
## Position

- Point (`init.position.point`): Starts at one point (offset from the base). Direction: up.
- Sphere (`init.position.sphere`): A random point in a sphere (or on its surface). Direction: outward.
- Box (`init.position.box`): A random point in a box (or on its faces). Direction: up.
- Circle (`init.position.circle`): A random point in a disc (or on its edge) around an axis. Direction: outward in the disc.
- Cone (`init.position.cone`): A random point on the base disc of a cone; the direction spreads within the cone angle around the axis.
- Line (`init.position.line`): A random point on a segment. Direction: up.
- Mesh surface (`init.position.mesh`): A random point on the surface of a model asset (triangles weighted by area). Direction: the surface normal.

<a id="node-effect--init-position-point"></a>
### Point (`init.position.point`)

Starts at one point (offset from the base). Direction: up.

Inputs:

- `in` (init)
- `offset` (vec3)

Outputs:

- `then` (init): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `offset` | Offset | vector | `[0,0,0]` | -10000 – 10000; 3 components |

<a id="node-effect--init-position-sphere"></a>
### Sphere (`init.position.sphere`)

A random point in a sphere (or on its surface). Direction: outward.

Inputs:

- `in` (init)
- `center` "centre" (vec3)
- `radius` (float)

Outputs:

- `then` (init): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `center` | Centre | vector | `[0,0,0]` | -10000 – 10000; 3 components |
| `radius` | Radius | number | `0.5` | 0 – 10000 |
| `surface` | Surface only | boolean | `false` |  |

<a id="node-effect--init-position-box"></a>
### Box (`init.position.box`)

A random point in a box (or on its faces). Direction: up.

Inputs:

- `in` (init)
- `center` "centre" (vec3)
- `size` (vec3)

Outputs:

- `then` (init): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `center` | Centre | vector | `[0,0,0]` | -10000 – 10000; 3 components |
| `size` | Size | vector | `[1,1,1]` | -10000 – 10000; 3 components |
| `surface` | Surface only | boolean | `false` |  |

<a id="node-effect--init-position-circle"></a>
### Circle (`init.position.circle`)

A random point in a disc (or on its edge) around an axis. Direction: outward in the disc.

Inputs:

- `in` (init)
- `center` "centre" (vec3)
- `radius` (float)

Outputs:

- `then` (init): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `center` | Centre | vector | `[0,0,0]` | -10000 – 10000; 3 components |
| `radius` | Radius | number | `0.5` | 0 – 10000 |
| `axis` | Axis | enum | `"y"` | `x`, `y`, `z` |
| `edge` | Edge only | boolean | `false` |  |

<a id="node-effect--init-position-cone"></a>
### Cone (`init.position.cone`)

A random point on the base disc of a cone; the direction spreads within the cone angle around the axis.

Inputs:

- `in` (init)
- `center` "centre" (vec3)
- `radius` "base radius" (float)
- `angle` "angle (deg)" (float)

Outputs:

- `then` (init): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `center` | Centre | vector | `[0,0,0]` | -10000 – 10000; 3 components |
| `radius` | Base radius | number | `0` | 0 – 10000 |
| `angle` | Angle (deg) | number | `25` | 0 – 89 |
| `axis` | Axis | enum | `"y"` | `x`, `y`, `z` |

<a id="node-effect--init-position-line"></a>
### Line (`init.position.line`)

A random point on a segment. Direction: up.

Inputs:

- `in` (init)
- `start` (vec3)
- `end` (vec3)

Outputs:

- `then` (init): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `start` | Start | vector | `[0,0,0]` | -10000 – 10000; 3 components |
| `end` | End | vector | `[1,0,0]` | -10000 – 10000; 3 components |

<a id="node-effect--init-position-mesh"></a>
### Mesh surface (`init.position.mesh`)

A random point on the surface of a model asset (triangles weighted by area). Direction: the surface normal.

Inputs:

- `in` (init)
- `scale` (float)

Outputs:

- `then` (init): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `model` | Model | string | `""` | ≤ 64 chars; matches `[a-z0-9][a-z0-9_-]{0,63}`; a model asset |
| `scale` | Scale | number | `1` | 0 – 1000 |

<a id="graph-effect--initialize"></a>
## Initialize

- Velocity (`init.velocity`): Adds a random velocity between min and max (per axis).
- Velocity from direction (`init.velocity.direction`): Adds a velocity along the direction the position block chose, with a random speed between min and max.
- Lifetime (`init.lifetime`): How long the particle lasts: random between min and max seconds.
- Size (`init.size`): The particle size in metres: random between min and max.
- Colour (`init.color`): The particle colour and opacity.
- Colour from gradient (`init.color.gradient`): A random colour picked along a gradient.
- Rotation (`init.rotation`): The particle angle (degrees, around its facing axis) and its spin (degrees per second), each random between min and max.
- Mass (`init.mass`): The particle mass in kg (forces other than gravity accelerate lighter particles more): random between min and max.

<a id="node-effect--init-velocity"></a>
### Velocity (`init.velocity`)

Adds a random velocity between min and max (per axis).

Inputs:

- `in` (init)
- `min` (vec3)
- `max` (vec3)

Outputs:

- `then` (init): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `min` | Min | vector | `[0,1,0]` | -10000 – 10000; 3 components |
| `max` | Max | vector | `[0,1,0]` | -10000 – 10000; 3 components |

<a id="node-effect--init-velocity-direction"></a>
### Velocity from direction (`init.velocity.direction`)

Adds a velocity along the direction the position block chose, with a random speed between min and max.

Inputs:

- `in` (init)
- `speedMin` "speed min" (float)
- `speedMax` "speed max" (float)

Outputs:

- `then` (init): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `speedMin` | Speed min | number | `1` | 0 – 10000 |
| `speedMax` | Speed max | number | `2` | 0 – 10000 |

<a id="node-effect--init-lifetime"></a>
### Lifetime (`init.lifetime`)

How long the particle lasts: random between min and max seconds.

Inputs:

- `in` (init)
- `min` "min (s)" (float)
- `max` "max (s)" (float)

Outputs:

- `then` (init): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `min` | Min (s) | number | `1` | 0.001 – 3600 |
| `max` | Max (s) | number | `1` | 0.001 – 3600 |

<a id="node-effect--init-size"></a>
### Size (`init.size`)

The particle size in metres: random between min and max.

Inputs:

- `in` (init)
- `min` "min (m)" (float)
- `max` "max (m)" (float)

Outputs:

- `then` (init): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `min` | Min (m) | number | `0.1` | 0 – 10000 |
| `max` | Max (m) | number | `0.1` | 0 – 10000 |

<a id="node-effect--init-color"></a>
### Colour (`init.color`)

The particle colour and opacity.

Inputs:

- `in` (init)
- `color` "colour" (color)

Outputs:

- `then` (init): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `color` | Colour | color | `"#ffffff"` |  |
| `alpha` | Alpha | number | `1` | 0 – 1 |

<a id="node-effect--init-color-gradient"></a>
### Colour from gradient (`init.color.gradient`)

A random colour picked along a gradient.

Inputs:

- `in` (init)

Outputs:

- `then` (init): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `gradient` | Gradient | gradient | `[0,1,1,1,1,1,1,1,1,1]` |  |

<a id="node-effect--init-rotation"></a>
### Rotation (`init.rotation`)

The particle angle (degrees, around its facing axis) and its spin (degrees per second), each random between min and max.

Inputs:

- `in` (init)
- `angleMin` "angle min" (float)
- `angleMax` "angle max" (float)
- `spinMin` "spin min" (float)
- `spinMax` "spin max" (float)

Outputs:

- `then` (init): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `angleMin` | Angle min | number | `0` | -360 – 360 |
| `angleMax` | Angle max | number | `0` | -360 – 360 |
| `spinMin` | Spin min | number | `0` | -3600 – 3600 |
| `spinMax` | Spin max | number | `0` | -3600 – 3600 |

<a id="node-effect--init-mass"></a>
### Mass (`init.mass`)

The particle mass in kg (forces other than gravity accelerate lighter particles more): random between min and max.

Inputs:

- `in` (init)
- `min` "min (kg)" (float)
- `max` "max (kg)" (float)

Outputs:

- `then` (init): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `min` | Min (kg) | number | `1` | 0.0001 – 1000000 |
| `max` | Max (kg) | number | `1` | 0.0001 – 1000000 |

<a id="graph-effect--forces"></a>
## Forces

- Gravity (`update.gravity`): A constant acceleration in world space (independent of mass).
- Drag (`update.drag`): Slows the particle: velocity × e^(−coefficient × dt / mass).
- Wind (`update.wind`): Pushes the particle toward the project's global wind velocity (Environment → Wind, with its gusts).
- Vortex (`update.vortex`): Swirls around an axis through a centre (tangential acceleration) and pulls toward the axis.
- Turbulence (`update.turbulence`): Curl-noise acceleration: a divergence-free swirl field that scrolls over time (per effect seed).
- Attractor (`update.attractor`): Accelerates toward a point (negative strength repels); radius 0 reaches everywhere, else only within the radius.

<a id="node-effect--update-gravity"></a>
### Gravity (`update.gravity`)

A constant acceleration in world space (independent of mass).

Inputs:

- `in` (update)
- `acceleration` (vec3)

Outputs:

- `then` (update): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `acceleration` | Acceleration | vector | `[0,-9.81,0]` | -10000 – 10000; 3 components |

<a id="node-effect--update-drag"></a>
### Drag (`update.drag`)

Slows the particle: velocity × e^(−coefficient × dt / mass).

Inputs:

- `in` (update)
- `coefficient` (float)

Outputs:

- `then` (update): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `coefficient` | Coefficient | number | `1` | 0 – 1000 |

<a id="node-effect--update-wind"></a>
### Wind (`update.wind`)

Pushes the particle toward the project's global wind velocity (Environment → Wind, with its gusts).

Inputs:

- `in` (update)
- `influence` (float)

Outputs:

- `then` (update): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `influence` | Influence | number | `1` | 0 – 100 |

<a id="node-effect--update-vortex"></a>
### Vortex (`update.vortex`)

Swirls around an axis through a centre (tangential acceleration) and pulls toward the axis.

Inputs:

- `in` (update)
- `center` "centre" (vec3)
- `axis` (vec3)
- `strength` (float)
- `pull` (float)

Outputs:

- `then` (update): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `center` | Centre | vector | `[0,0,0]` | -10000 – 10000; 3 components |
| `axis` | Axis | vector | `[0,1,0]` | -1 – 1; 3 components |
| `strength` | Strength | number | `2` | -10000 – 10000 |
| `pull` | Pull | number | `0` | -10000 – 10000 |

<a id="node-effect--update-turbulence"></a>
### Turbulence (`update.turbulence`)

Curl-noise acceleration: a divergence-free swirl field that scrolls over time (per effect seed).

Inputs:

- `in` (update)
- `frequency` "frequency (1/m)" (float)
- `strength` (float)
- `speed` "scroll (/s)" (float)

Outputs:

- `then` (update): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `frequency` | Frequency (1/m) | number | `1` | 0.001 – 100 |
| `strength` | Strength | number | `1` | 0 – 10000 |
| `octaves` | Octaves | number | `1` | 1 – 4 |
| `speed` | Scroll (/s) | number | `0.5` | 0 – 100 |

<a id="node-effect--update-attractor"></a>
### Attractor (`update.attractor`)

Accelerates toward a point (negative strength repels); radius 0 reaches everywhere, else only within the radius.

Inputs:

- `in` (update)
- `position` (vec3)
- `strength` (float)
- `radius` (float)

Outputs:

- `then` (update): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `position` | Position | vector | `[0,0,0]` | -10000 – 10000; 3 components |
| `strength` | Strength | number | `5` | -10000 – 10000 |
| `radius` | Radius | number | `0` | 0 – 10000 |

<a id="graph-effect--collision"></a>
## Collision

- Collide with plane (`update.collide.plane`): Bounces off an infinite plane (after the position moves): bounce keeps that share of the normal speed, friction removes that share of the tangential speed.
- Collide with scene (depth) (`update.collide.depth`): Bounces off whatever the camera sees, using the depth buffer — honoured only by the WebGPU executor; the CPU fallback (WebGL 2) ignores it.

<a id="node-effect--update-collide-plane"></a>
### Collide with plane (`update.collide.plane`)

Bounces off an infinite plane (after the position moves): bounce keeps that share of the normal speed, friction removes that share of the tangential speed.

Inputs:

- `in` (update)
- `point` (vec3)
- `normal` (vec3)
- `bounce` (float)
- `friction` (float)

Outputs:

- `then` (update): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `point` | Point | vector | `[0,0,0]` | -10000 – 10000; 3 components |
| `normal` | Normal | vector | `[0,1,0]` | -1 – 1; 3 components |
| `bounce` | Bounce | number | `0.5` | 0 – 1 |
| `friction` | Friction | number | `0.1` | 0 – 1 |
| `lifetimeLoss` | Lifetime loss | number | `0` | 0 – 1 |
| `kill` | Kill on hit | boolean | `false` |  |

<a id="node-effect--update-collide-depth"></a>
### Collide with scene (depth) (`update.collide.depth`)

Bounces off whatever the camera sees, using the depth buffer — honoured only by the WebGPU executor; the CPU fallback (WebGL 2) ignores it.

Inputs:

- `in` (update)
- `bounce` (float)
- `friction` (float)

Outputs:

- `then` (update): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `bounce` | Bounce | number | `0.5` | 0 – 1 |
| `friction` | Friction | number | `0.1` | 0 – 1 |
| `thickness` | Thickness (m) | number | `0.1` | 0.001 – 10 |
| `kill` | Kill on hit | boolean | `false` |  |

<a id="graph-effect--over-life"></a>
## Over life

- Size over life (`update.size.curve`): Multiplies the initial size by a curve of the normalized age (0 at birth, 1 at death).
- Colour over life (`update.color.gradient`): Multiplies (or replaces) the initial colour by a gradient of the normalized age.
- Speed limit over life (`update.velocity.curve`): Caps the speed at a curve of the normalized age (m/s).

<a id="node-effect--update-size-curve"></a>
### Size over life (`update.size.curve`)

Multiplies the initial size by a curve of the normalized age (0 at birth, 1 at death).

Inputs:

- `in` (update)

Outputs:

- `then` (update): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `curve` | Curve | curve | `[0,1,1,0]` | 0 – 100 |

<a id="node-effect--update-color-gradient"></a>
### Colour over life (`update.color.gradient`)

Multiplies (or replaces) the initial colour by a gradient of the normalized age.

Inputs:

- `in` (update)

Outputs:

- `then` (update): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `gradient` | Gradient | gradient | `[0,1,1,1,1,1,1,1,1,0]` |  |
| `mode` | Mode | enum | `"multiply"` | `multiply`, `set` |

<a id="node-effect--update-velocity-curve"></a>
### Speed limit over life (`update.velocity.curve`)

Caps the speed at a curve of the normalized age (m/s).

Inputs:

- `in` (update)

Outputs:

- `then` (update): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `curve` | Max speed | curve | `[0,10,1,10]` | 0 – 10000 |

<a id="graph-effect--kill"></a>
## Kill

- Kill behind plane (`update.kill.plane`): Kills particles on the far side of a plane (against its normal).
- Kill sphere (`update.kill.sphere`): Kills particles inside (or outside) a sphere.
- Kill box (`update.kill.box`): Kills particles inside (or outside) a box.
- Kill when slow (`update.kill.speed`): Kills particles slower than a speed (m/s) — e.g. debris that came to rest.

<a id="node-effect--update-kill-plane"></a>
### Kill behind plane (`update.kill.plane`)

Kills particles on the far side of a plane (against its normal).

Inputs:

- `in` (update)
- `point` (vec3)
- `normal` (vec3)

Outputs:

- `then` (update): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `point` | Point | vector | `[0,0,0]` | -10000 – 10000; 3 components |
| `normal` | Normal | vector | `[0,1,0]` | -1 – 1; 3 components |

<a id="node-effect--update-kill-sphere"></a>
### Kill sphere (`update.kill.sphere`)

Kills particles inside (or outside) a sphere.

Inputs:

- `in` (update)
- `center` "centre" (vec3)
- `radius` (float)

Outputs:

- `then` (update): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `center` | Centre | vector | `[0,0,0]` | -10000 – 10000; 3 components |
| `radius` | Radius | number | `1` | 0 – 10000 |
| `mode` | Kill | enum | `"inside"` | `inside`, `outside` |

<a id="node-effect--update-kill-box"></a>
### Kill box (`update.kill.box`)

Kills particles inside (or outside) a box.

Inputs:

- `in` (update)
- `center` "centre" (vec3)
- `size` (vec3)

Outputs:

- `then` (update): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `center` | Centre | vector | `[0,0,0]` | -10000 – 10000; 3 components |
| `size` | Size | vector | `[1,1,1]` | -10000 – 10000; 3 components |
| `mode` | Kill | enum | `"outside"` | `inside`, `outside` |

<a id="node-effect--update-kill-speed"></a>
### Kill when slow (`update.kill.speed`)

Kills particles slower than a speed (m/s) — e.g. debris that came to rest.

Inputs:

- `in` (update)
- `speed` "below (m/s)" (float)

Outputs:

- `then` (update): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `speed` | Below (m/s) | number | `0.05` | 0 – 10000 |

<a id="graph-effect--output"></a>
## Output

- Billboard (`output.billboard`): A textured quad per particle: facing the camera, aligned with its velocity, or turning around a fixed axis.
- Mesh particles (`output.mesh`): A model asset drawn per particle (scaled by its size, turned by its rotation).
- Ribbon / trail (`output.ribbon`): Trail: each particle draws a strip through its recent positions. Ribbon: one strip joins the particles in birth order.
- Lights (`output.light`): A point light at up to `max lights` particles (the oldest living ones), coloured by the particle. It lights the objects in its light layers (bit n: layer n + 1) and follows its importance like a scene point light.

<a id="node-effect--output-billboard"></a>
### Billboard (`output.billboard`)

A textured quad per particle: facing the camera, aligned with its velocity, or turning around a fixed axis.

Inputs:

- `in` (render)
- `axis` "fixed axis" (vec3)
- `softDistance` "soft distance (m)" (float)

Outputs:

- `then` (render): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `orient` | Orientation | enum | `"camera"` | `camera`, `velocity`, `axis` |
| `axis` | Fixed axis | vector | `[0,1,0]` | -1 – 1; 3 components |
| `texture` | Texture | string | `""` | ≤ 64 chars; matches `[a-z0-9][a-z0-9_-]{0,63}`; a texture asset |
| `flipbook` | Flipbook | enum | `"none"` | `none`, `overLife`, `fps` |
| `columns` | Columns | number | `1` | 1 – 64 |
| `rows` | Rows | number | `1` | 1 – 64 |
| `fps` | Frames/s | number | `12` | 0.01 – 240 |
| `blend` | Blending | enum | `"alpha"` | `alpha`, `additive`, `premultiplied`, `multiply`, `opaque` |
| `soft` | Soft particles | boolean | `false` |  |
| `softDistance` | Soft distance (m) | number | `0.25` | 0.001 – 100 |
| `shading` | Shading | enum | `"unlit"` | `unlit`, `lit`, `material` |
| `material` | Material | string | `""` | ≤ 64 chars; matches `[a-z0-9][a-z0-9_-]{0,63}` |

<a id="node-effect--output-mesh"></a>
### Mesh particles (`output.mesh`)

A model asset drawn per particle (scaled by its size, turned by its rotation).

Inputs:

- `in` (render)

Outputs:

- `then` (render): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `model` | Model | string | `""` | ≤ 64 chars; matches `[a-z0-9][a-z0-9_-]{0,63}`; a model asset |
| `blend` | Blending | enum | `"alpha"` | `alpha`, `additive`, `premultiplied`, `multiply`, `opaque` |
| `shading` | Shading | enum | `"unlit"` | `unlit`, `lit`, `material` |
| `material` | Material | string | `""` | ≤ 64 chars; matches `[a-z0-9][a-z0-9_-]{0,63}` |

<a id="node-effect--output-ribbon"></a>
### Ribbon / trail (`output.ribbon`)

Trail: each particle draws a strip through its recent positions. Ribbon: one strip joins the particles in birth order.

Inputs:

- `in` (render)
- `width` "width (× size)" (float)

Outputs:

- `then` (render): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `mode` | Mode | enum | `"trail"` | `trail`, `ribbon` |
| `trailLength` | Trail length (s) | number | `0.5` | 0.01 – 10 |
| `segments` | Segments | number | `16` | 2 – 64 |
| `width` | Width (× size) | number | `1` | 0 – 100 |
| `texture` | Texture | string | `""` | ≤ 64 chars; matches `[a-z0-9][a-z0-9_-]{0,63}`; a texture asset |
| `blend` | Blending | enum | `"alpha"` | `alpha`, `additive`, `premultiplied`, `multiply`, `opaque` |
| `shading` | Shading | enum | `"unlit"` | `unlit`, `lit`, `material` |
| `material` | Material | string | `""` | ≤ 64 chars; matches `[a-z0-9][a-z0-9_-]{0,63}` |

<a id="node-effect--output-light"></a>
### Lights (`output.light`)

A point light at up to `max lights` particles (the oldest living ones), coloured by the particle. It lights the objects in its light layers (bit n: layer n + 1) and follows its importance like a scene point light.

Inputs:

- `in` (render)
- `intensity` "intensity (cd)" (float)
- `range` "range (m)" (float)

Outputs:

- `then` (render): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `maxLights` | Max lights | number | `4` | 1 – 16 |
| `intensity` | Intensity (cd) | number | `1` | 0 – 1000 |
| `range` | Range (m) | number | `2` | 0.01 – 1000 |
| `lightMask` | Light layers (mask) | number | `255` | 0 – 255 |
| `importance` | Importance | enum | `"auto"` | `auto`, `pixel`, `vertex` |

<a id="graph-effect--values"></a>
## Values

- Float (`value.float`): A constant number.
- Vector (`value.vec3`): A constant 3-vector.
- Colour (`value.color`): A constant colour and alpha.
- Parameter (`value.parameter`): An exposed parameter of the effect (objects may override public ones); its type is the declaration's.
- Random (`value.random`): A random number between min and max: per particle (fixed for its life) or per step in Spawn.
- Random vector (`value.randomVec3`): A random 3-vector between min and max (per axis).
- Curve (`value.curve`): A curve read at the particle's normalized age (in Spawn: the effect time), the effect's normalized time, or a per-particle random position.
- Gradient (`value.gradient`): A gradient read at the particle's normalized age (in Spawn: the effect time), the effect's normalized time, or a per-particle random position.
- Particle attribute (`value.attribute`): A value of the particle (not in Spawn): position, velocity, age, normalized age, lifetime, size, colour, mass, speed or its fixed random number.
- Effect time (`value.time`): Seconds since the effect (re)started, and that time over the duration (0–1).

<a id="node-effect--value-float"></a>
### Float (`value.float`)

A constant number.

Outputs:

- `value` (float)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `value` | Value | number | `0` | -1000000 – 1000000 |

<a id="node-effect--value-vec3"></a>
### Vector (`value.vec3`)

A constant 3-vector.

Outputs:

- `value` (vec3)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `value` | Value | vector | `[0,0,0]` | -1000000 – 1000000; 3 components |

<a id="node-effect--value-color"></a>
### Colour (`value.color`)

A constant colour and alpha.

Outputs:

- `value` (color)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `color` | Colour | color | `"#ffffff"` |  |
| `alpha` | Alpha | number | `1` | 0 – 1 |

<a id="node-effect--value-parameter"></a>
### Parameter (`value.parameter`)

An exposed parameter of the effect (objects may override public ones); its type is the declaration's.

Outputs:

- `value` (float): type from field `key`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `key` | Parameter | string | `""` | ≤ 32 chars; matches `[A-Za-z_][A-Za-z0-9_]{0,31}` |

<a id="node-effect--value-random"></a>
### Random (`value.random`)

A random number between min and max: per particle (fixed for its life) or per step in Spawn.

Outputs:

- `value` (float)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `min` | Min | number | `0` | -1000000 – 1000000 |
| `max` | Max | number | `1` | -1000000 – 1000000 |

<a id="node-effect--value-random-vec3"></a>
### Random vector (`value.randomVec3`)

A random 3-vector between min and max (per axis).

Outputs:

- `value` (vec3)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `min` | Min | vector | `[-1,-1,-1]` | -1000000 – 1000000; 3 components |
| `max` | Max | vector | `[1,1,1]` | -1000000 – 1000000; 3 components |

<a id="node-effect--value-curve"></a>
### Curve (`value.curve`)

A curve read at the particle's normalized age (in Spawn: the effect time), the effect's normalized time, or a per-particle random position.

Outputs:

- `value` (float)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `curve` | Curve | curve | `[0,1,1,0]` | -1000000 – 1000000 |
| `input` | Input | enum | `"age"` | `age`, `effectTime`, `random` |

<a id="node-effect--value-gradient"></a>
### Gradient (`value.gradient`)

A gradient read at the particle's normalized age (in Spawn: the effect time), the effect's normalized time, or a per-particle random position.

Outputs:

- `value` (color)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `gradient` | Gradient | gradient | `[0,1,1,1,1,1,1,1,1,0]` |  |
| `input` | Input | enum | `"age"` | `age`, `effectTime`, `random` |

<a id="node-effect--value-attribute"></a>
### Particle attribute (`value.attribute`)

A value of the particle (not in Spawn): position, velocity, age, normalized age, lifetime, size, colour, mass, speed or its fixed random number.

Outputs:

- `value` (float): type from field `attribute`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `attribute` | Attribute | enum | `"age"` | `position`, `velocity`, `age`, `normalizedAge`, `lifetime`, `size`, `color`, `mass`, `speed`, `random` |

<a id="node-effect--value-time"></a>
### Effect time (`value.time`)

Seconds since the effect (re)started, and that time over the duration (0–1).

Outputs:

- `time` (float)
- `normalized` (float)

<a id="graph-effect--maths"></a>
## Maths

- Add (`math.add`): a + b.
- Subtract (`math.subtract`): a − b.
- Multiply (`math.multiply`): a × b (per component).
- Divide (`math.divide`): a ÷ b (per component; ÷ 0 gives 0).
- Minimum (`math.min`): The smaller of a and b (per component).
- Maximum (`math.max`): The larger of a and b (per component).
- Lerp (`math.lerp`): a + (b − a) × t.
- One minus (`math.oneMinus`): 1 − x (per component).
- Sine (`math.sine`): sin(x) (radians).
- Length (`math.length`): The length of a vector.
- Normalize (`math.normalize`): The vector scaled to length 1 (0 stays 0).
- Combine (`math.combine`): Three numbers into a vector.
- Split (`math.split`): A vector into its three numbers.

<a id="node-effect--math-add"></a>
### Add (`math.add`)

a + b.

Inputs:

- `a` (float): unconnected: `0`, type from field `type`
- `b` (float): unconnected: `0`, type from field `type`

Outputs:

- `out` (float): type from field `type`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `type` | Type | enum | `"auto"` | `auto`, `float`, `vec3`, `color` |

<a id="node-effect--math-subtract"></a>
### Subtract (`math.subtract`)

a − b.

Inputs:

- `a` (float): unconnected: `0`, type from field `type`
- `b` (float): unconnected: `0`, type from field `type`

Outputs:

- `out` (float): type from field `type`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `type` | Type | enum | `"auto"` | `auto`, `float`, `vec3`, `color` |

<a id="node-effect--math-multiply"></a>
### Multiply (`math.multiply`)

a × b (per component).

Inputs:

- `a` (float): unconnected: `1`, type from field `type`
- `b` (float): unconnected: `1`, type from field `type`

Outputs:

- `out` (float): type from field `type`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `type` | Type | enum | `"auto"` | `auto`, `float`, `vec3`, `color` |

<a id="node-effect--math-divide"></a>
### Divide (`math.divide`)

a ÷ b (per component; ÷ 0 gives 0).

Inputs:

- `a` (float): unconnected: `1`, type from field `type`
- `b` (float): unconnected: `1`, type from field `type`

Outputs:

- `out` (float): type from field `type`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `type` | Type | enum | `"auto"` | `auto`, `float`, `vec3`, `color` |

<a id="node-effect--math-min"></a>
### Minimum (`math.min`)

The smaller of a and b (per component).

Inputs:

- `a` (float): unconnected: `0`, type from field `type`
- `b` (float): unconnected: `0`, type from field `type`

Outputs:

- `out` (float): type from field `type`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `type` | Type | enum | `"auto"` | `auto`, `float`, `vec3`, `color` |

<a id="node-effect--math-max"></a>
### Maximum (`math.max`)

The larger of a and b (per component).

Inputs:

- `a` (float): unconnected: `0`, type from field `type`
- `b` (float): unconnected: `0`, type from field `type`

Outputs:

- `out` (float): type from field `type`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `type` | Type | enum | `"auto"` | `auto`, `float`, `vec3`, `color` |

<a id="node-effect--math-lerp"></a>
### Lerp (`math.lerp`)

a + (b − a) × t.

Inputs:

- `a` (float): unconnected: `0`, type from field `type`
- `b` (float): unconnected: `1`, type from field `type`
- `t` (float): unconnected: `0.5`

Outputs:

- `out` (float): type from field `type`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `type` | Type | enum | `"auto"` | `auto`, `float`, `vec3`, `color` |

<a id="node-effect--math-one-minus"></a>
### One minus (`math.oneMinus`)

1 − x (per component).

Inputs:

- `in` (float): unconnected: `0`, type from field `type`

Outputs:

- `out` (float): type from field `type`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `type` | Type | enum | `"auto"` | `auto`, `float`, `vec3`, `color` |

<a id="node-effect--math-sine"></a>
### Sine (`math.sine`)

sin(x) (radians).

Inputs:

- `in` (float): unconnected: `0`

Outputs:

- `out` (float)

<a id="node-effect--math-length"></a>
### Length (`math.length`)

The length of a vector.

Inputs:

- `in` (vec3): unconnected: `[0,0,0]`

Outputs:

- `out` (float)

<a id="node-effect--math-normalize"></a>
### Normalize (`math.normalize`)

The vector scaled to length 1 (0 stays 0).

Inputs:

- `in` (vec3): unconnected: `[0,0,0]`

Outputs:

- `out` (vec3)

<a id="node-effect--math-combine"></a>
### Combine (`math.combine`)

Three numbers into a vector.

Inputs:

- `x` (float): unconnected: `0`
- `y` (float): unconnected: `0`
- `z` (float): unconnected: `0`

Outputs:

- `out` (vec3)

<a id="node-effect--math-split"></a>
### Split (`math.split`)

A vector into its three numbers.

Inputs:

- `in` (vec3): unconnected: `[0,0,0]`

Outputs:

- `x` (float)
- `y` (float)
- `z` (float)
