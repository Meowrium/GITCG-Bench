/**
 * GBRL tree inference in pure TypeScript.
 *
 * Oblivious decision trees: each level has one feature_idx + threshold.
 * Leaves are binary-coded: leaf_idx = Σ(bit[i] << i) for i in 0..depth-1.
 * Prediction = Σ tree.leaves[leafIdx] + bias.
 */

export interface GbrlTreeLevel {
  feature_idx: number;
  threshold: number;
}

export interface GbrlTree {
  depth: number;
  levels: GbrlTreeLevel[];
  leaves: number[];
}

export interface GbrlTreeExport {
  bias: number;
  feature_names: string[];
  trees: GbrlTree[];
}

/**
 * Predict a single value from a GBRL tree ensemble.
 * @param trees - the exported tree ensemble
 * @param features - flat feature dict (feature_name → value)
 * @returns predicted value
 */
export function predictGbrlTrees(
  trees: GbrlTreeExport,
  features: Record<string, number>,
): number {
  // Build feature vector aligned to feature_names
  const featVec = new Float64Array(trees.feature_names.length);
  for (let i = 0; i < trees.feature_names.length; i++) {
    featVec[i] = features[trees.feature_names[i]] ?? 0;
  }

  let sum = trees.bias;
  for (const tree of trees.trees) {
    sum += predictTree(tree, featVec);
  }
  return sum;
}

function predictTree(tree: GbrlTree, featVec: Float64Array): number {
  let leafIdx = 0;
  for (let level = 0; level < tree.depth; level++) {
    const { feature_idx, threshold } = tree.levels[level];
    const bit = featVec[feature_idx] > threshold ? 1 : 0;
    leafIdx = (leafIdx << 1) | bit;
  }
  return tree.leaves[leafIdx];
}
