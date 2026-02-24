import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface DependencyNode {
  file: string;
  imports: string[];
  importedBy: string[];
}

export async function buildDependencyGraph(basePath: string): Promise<Map<string, DependencyNode>> {
  const graph = new Map<string, DependencyNode>();

  async function addFileToGraph(filePath: string) {
    const fileContent = await fs.readFile(filePath, 'utf-8');
    const imports: string[] = [];
    const importRegex = /import\s+.*\s+from\s+['"](.*)['"]/g;
    let match: RegExpExecArray | null;

    while ((match = importRegex.exec(fileContent)) !== null) {
      let importPath = match[1];
      if (importPath.startsWith('./') || importPath.startsWith('../')) {
        let absoluteImportPath = path.resolve(path.dirname(filePath), importPath);
        if (!absoluteImportPath.endsWith('.ts')) {
          absoluteImportPath += '.ts';
        }
        imports.push(path.relative(basePath, absoluteImportPath));
      }
    }

    const relativeFilePath = path.relative(basePath, filePath);
    const node = graph.get(relativeFilePath) || { file: relativeFilePath, imports: [], importedBy: [] };
    node.imports = imports;

    graph.set(relativeFilePath, node);

    for (const imp of imports) {
      const importedNode = graph.get(imp) || { file: imp, imports: [], importedBy: [] };
      importedNode.importedBy.push(relativeFilePath);
      graph.set(imp, importedNode);
    }
  }

  async function processDirectory(directory: string) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await processDirectory(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        await addFileToGraph(fullPath);
      }
    }
  }

  await processDirectory(basePath);
  return graph;
}

export function getModuleDepth(graph: Map<string, DependencyNode>, file: string): number {
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function computeDepth(target: string, currentDepth: number): number {
    if (inStack.has(target)) {
      return currentDepth;
    }

    if (visited.has(target)) {
      const cachedNode = graph.get(target);
      if (!cachedNode || cachedNode.imports.length === 0) {
        return 0;
      }
      return currentDepth;
    }

    const node = graph.get(target);
    if (!node || node.imports.length === 0) {
      return 0;
    }

    visited.add(target);
    inStack.add(target);

    let maxDepth = 0;
    for (const imp of node.imports) {
      const depth = computeDepth(imp, currentDepth + 1);
      maxDepth = Math.max(maxDepth, depth + 1);
    }

    inStack.delete(target);
    return maxDepth;
  }

  return computeDepth(file, 0);
}

export function findOrphans(graph: Map<string, DependencyNode>): string[] {
  const orphans: string[] = [];
  for (const [file, node] of graph.entries()) {
    if (node.imports.length === 0 && node.importedBy.length === 0) {
      orphans.push(file);
    }
  }
  return orphans;
}

export function toJSON(graph: Map<string, DependencyNode>): string {
  const obj: Record<string, DependencyNode> = {};
  for (const [key, value] of graph.entries()) {
    obj[key] = value;
  }
  return JSON.stringify(obj, null, 2);
}
