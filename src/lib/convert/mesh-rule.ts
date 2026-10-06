/**
 * How a conversion finds its heavy solids, the dense ones (wire coils, springs) that are meshed coarser than the rest.
 * - 'once': every solid is meshed at the heavy setting first; above 16,000 triangles it keeps that mesh, below it is
 *   meshed again finely. No heavy solid is meshed twice, which takes about 5 s off Hammer's 28. Near the line a solid
 *   can come out heavy where 'planned' meshed it finely: in Hammer, hammer_coil (1), meshed like its six siblings.
 * - 'planned', the original rule: every solid is meshed coarsely to count its triangles, then meshed again for good.
 * MESH_RULE is the rule a build uses; setting it back to 'planned' undoes the change. The tests check both rules
 * against test/golden.json, so either is ready to ship.
 */
export type MeshRule = 'once' | 'planned';
export const MESH_RULES: MeshRule[] = ['once', 'planned'];
export const MESH_RULE: MeshRule = 'once';
