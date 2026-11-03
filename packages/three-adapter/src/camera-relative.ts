/**
 * Draws a node material's vertices relative to the camera with a model-view
 * matrix made on the CPU in 64 bits, so objects far from the world origin
 * (a voxel world kilometres out) draw without 32-bit jitter.
 *
 * three's node materials make the view-space position on the GPU from the
 * camera's view matrix and the object's world matrix, each rounded to 32
 * bits first: at 8 km a 32-bit step is about 1 mm, and the two large
 * translations cancel only after that rounding, so vertices wobble by a few
 * millimetres as the camera moves. Here the product is taken in JavaScript
 * (64-bit) for every object and camera drawn, the shadow cameras included,
 * and only the small camera-relative result is rounded. That is the floating
 * origin's rule (32-bit consumers see positions relative to an origin made
 * in 64 bits) with the camera as the origin of every draw, so nothing has to
 * be re-based as the camera travels.
 *
 * It is three's own high-precision model-view, given per material through
 * its context (the renderer's `highPrecision` would change every program of
 * the scene). Instancing still applies first, to the local position, so
 * instanced meshes take it too. three's material observer refreshes a draw
 * whose context sets the model-view every time it is drawn, so the matrix
 * follows a moving camera even on a material without node properties.
 * World-space reads in the material (`positionWorld`) stay 32-bit; their
 * error is sub-millimetre and does not follow the camera.
 */
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';

const { context, uniform } = TSL;

/**
 * The drawn object's model-view matrix, made in 64 bits for the camera of
 * the pass being drawn (an object-update uniform: set before each draw).
 */
export const cameraRelativeModelView = uniform(new THREE.Matrix4()).onObjectUpdate(({ object, camera }, self) => {
  if (object === null || camera === null) return undefined;
  (self.value as THREE.Matrix4).multiplyMatrices(camera.matrixWorldInverse, object.matrixWorld);
  return undefined;
});

/** Makes `material` place its vertices with {@link cameraRelativeModelView}; returns it. */
export function cameraRelative<M extends THREE.NodeMaterial>(material: M): M {
  material.contextNode = context({ modelViewMatrix: cameraRelativeModelView });
  return material;
}
