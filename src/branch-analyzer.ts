/**
 * Branch Analyzer
 * Analyzes which files each branch touches and determines optimal merge order.
 * Branches with no file overlap are safe to merge in any order.
 * Overlapping branches are merged sequentially to minimize conflicts.
 */

import { getBranchChangedFiles } from './github-ops.js';

// --- Types ---

export interface BranchAnalysis {
  branch: string;
  files: string[];
}

export interface OverlapEdge {
  branchA: string;
  branchB: string;
  sharedFiles: string[];
}

export interface BranchOrderResult {
  /** Branches that share no files with any other branch — safe to merge first */
  independent: string[];
  /** Branches that share files, ordered by least overlap first */
  overlapping: string[];
  /** Full analysis details per branch */
  analyses: BranchAnalysis[];
  /** All overlap edges between branches */
  overlaps: OverlapEdge[];
}

// --- Public API ---

/**
 * Analyze a set of branches to determine which files each touches
 * relative to a target branch.
 */
export async function analyzeBranches(
  cwd: string,
  branches: string[],
  targetBranch: string
): Promise<BranchAnalysis[]> {
  const analyses: BranchAnalysis[] = [];

  for (const branch of branches) {
    const files = await getBranchChangedFiles(cwd, branch, targetBranch);
    analyses.push({ branch, files });
  }

  return analyses;
}

/**
 * Find all overlapping file pairs between branches.
 */
export function findOverlaps(analyses: BranchAnalysis[]): OverlapEdge[] {
  const overlaps: OverlapEdge[] = [];

  for (let i = 0; i < analyses.length; i++) {
    for (let j = i + 1; j < analyses.length; j++) {
      const a = analyses[i];
      const b = analyses[j];

      const aSet = new Set(a.files);
      const sharedFiles = b.files.filter((f) => aSet.has(f));

      if (sharedFiles.length > 0) {
        overlaps.push({
          branchA: a.branch,
          branchB: b.branch,
          sharedFiles,
        });
      }
    }
  }

  return overlaps;
}

/**
 * Determine optimal merge order for a set of branches.
 *
 * Strategy:
 * 1. Identify independent branches (no file overlap with any other branch)
 * 2. Sort overlapping branches by least overlap (fewest shared files first)
 *    — merging the least-overlapping first minimizes cascading conflicts
 *
 * Returns the full ordering: independent branches first, then overlapping.
 */
export function orderBranches(analyses: BranchAnalysis[]): BranchOrderResult {
  const overlaps = findOverlaps(analyses);

  // Build set of branches that appear in any overlap
  const overlappingSet = new Set<string>();
  for (const edge of overlaps) {
    overlappingSet.add(edge.branchA);
    overlappingSet.add(edge.branchB);
  }

  // Separate independent from overlapping
  const independent: string[] = [];
  const overlappingBranches: string[] = [];

  for (const analysis of analyses) {
    if (overlappingSet.has(analysis.branch)) {
      overlappingBranches.push(analysis.branch);
    } else {
      independent.push(analysis.branch);
    }
  }

  // Sort overlapping branches by total overlap count (ascending)
  // A branch that overlaps with fewer others should merge first
  const overlapCount = new Map<string, number>();
  for (const branch of overlappingBranches) {
    const count = overlaps.filter(
      (e) => e.branchA === branch || e.branchB === branch
    ).reduce((sum, e) => sum + e.sharedFiles.length, 0);
    overlapCount.set(branch, count);
  }

  overlappingBranches.sort((a, b) => {
    const countA = overlapCount.get(a) ?? 0;
    const countB = overlapCount.get(b) ?? 0;
    return countA - countB;
  });

  return {
    independent,
    overlapping: overlappingBranches,
    analyses,
    overlaps,
  };
}

/**
 * Get the full ordered merge list (independent first, then overlapping).
 */
export async function getMergeOrder(
  cwd: string,
  branches: string[],
  targetBranch: string
): Promise<BranchOrderResult> {
  const analyses = await analyzeBranches(cwd, branches, targetBranch);
  return orderBranches(analyses);
}

/**
 * Print a human-readable summary of the branch analysis.
 */
export function printBranchAnalysis(result: BranchOrderResult): void {
  console.log('\n  📊 Branch Analysis:');

  if (result.independent.length > 0) {
    console.log(`\n  Independent (no overlap — safe to merge in any order):`);
    for (const branch of result.independent) {
      const analysis = result.analyses.find((a) => a.branch === branch);
      console.log(`    🟢 ${branch} (${analysis?.files.length ?? 0} files)`);
    }
  }

  if (result.overlapping.length > 0) {
    console.log(`\n  Overlapping (will merge sequentially):`);
    for (const branch of result.overlapping) {
      const analysis = result.analyses.find((a) => a.branch === branch);
      const branchOverlaps = result.overlaps.filter(
        (e) => e.branchA === branch || e.branchB === branch
      );
      const totalShared = branchOverlaps.reduce((s, e) => s + e.sharedFiles.length, 0);
      console.log(`    🟡 ${branch} (${analysis?.files.length ?? 0} files, ${totalShared} overlapping)`);
    }
  }

  if (result.overlaps.length > 0) {
    console.log(`\n  Overlap details:`);
    for (const edge of result.overlaps) {
      console.log(`    ${edge.branchA} <-> ${edge.branchB}: ${edge.sharedFiles.join(', ')}`);
    }
  }

  const total = result.independent.length + result.overlapping.length;
  console.log(`\n  Merge order: ${result.independent.length} independent + ${result.overlapping.length} sequential = ${total} total`);
}
