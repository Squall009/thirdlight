/**
 * Generated geometry (rooms, roofs, walls, block walks) is built from
 * metre-sized parts on cells, so two coordinates that differ by less than a
 * micrometre are float noise of one place: the same point, on the same line.
 * One tolerance for every generator keeps their meeting edges agreeing.
 */
export const GEOMETRY_EPS = 1e-6;
