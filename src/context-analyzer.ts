import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

function extractRelativeImports(content: string): string[] {
  const importRegex = /import\s+.*\s+from\s+['"](\.\/[^'"]+)['"]/g;
  const imports: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(content)) !== null) {
    imports.push(match[1]);
  }
  return imports;
}

async function readAndExtractImports(filePath: string): Promise<string[]> {
  const content = await readFile(filePath, 'utf-8');
  return extractRelativeImports(content);
}

async function resolveAndDeduplicate(
  filePath: string, 
  basePath: string, 
  level: number,
  visited: Set<string>
): Promise<void> {
  if (level > 3 || visited.has(filePath)) return;

  visited.add(filePath);
  const imports = await readAndExtractImports(filePath);

  for (const imp of imports) {
    const resolvedPath = resolve(dirname(filePath), imp);
    await resolveAndDeduplicate(resolvedPath, basePath, level + 1, visited);
  }
}

export async function analyzeContext(entryFile: string, basePath: string): Promise<string[]> {
  const fullPath = resolve(basePath, entryFile);
  const visited = new Set<string>();
  await resolveAndDeduplicate(fullPath, basePath, 0, visited);
  return Array.from(visited);
}

export async function getFileExports(filePath: string): Promise<string[]> {
  const content = await readFile(filePath, 'utf-8');
  const exportRegex = /export\s+(?:function|class|interface|const|type)\s+([A-Za-z_]\w*)/g;
  const exports: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = exportRegex.exec(content)) !== null) {
    exports.push(match[1]);
  }
  return exports;
}
