import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';

const MODULE_SYSTEM_COMMONJS = 'CommonJS';
const MODULE_SYSTEM_ES_MODULES = 'ES modules';

interface PackageJson {
  name?: string;
  description?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  type?: string;
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const data = await readFile(filePath, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function detectLanguage(projectPath: string): Promise<'TypeScript' | 'JavaScript'> {
  try {
    const tsConfigExists = await stat(resolve(projectPath, 'tsconfig.json')).then(() => true).catch(() => false);
    if (tsConfigExists) {
      return 'TypeScript';
    }

    const srcFiles = await readdir(resolve(projectPath, 'src'));
    if (srcFiles.some(file => file.endsWith('.ts'))) {
      return 'TypeScript';
    }

    return 'JavaScript';
  } catch {
    return 'JavaScript';
  }
}

async function detectModuleSystem(projectPath: string): Promise<string> {
  const packageJson = await readJsonFile<PackageJson>(resolve(projectPath, 'package.json'));
  if (packageJson?.type === 'module') {
    return MODULE_SYSTEM_ES_MODULES;
  }

  try {
    const srcFiles = await readdir(resolve(projectPath, 'src'));
    if (srcFiles.some(file => file.endsWith('.mjs'))) {
      return MODULE_SYSTEM_ES_MODULES;
    }
  } catch {
    // ignore errors and fallback
  }

  return MODULE_SYSTEM_COMMONJS;
}

async function readTSConfigRunStrictMode(projectPath: string): Promise<boolean> {
  try {
    const tsconfig = await readJsonFile<{ compilerOptions?: { strict?: boolean } }>(resolve(projectPath, 'tsconfig.json'));
    return tsconfig?.compilerOptions?.strict ?? false;
  } catch {
    return false;
  }
}

async function checkFileExists(projectPath: string, fileName: string): Promise<boolean> {
  try {
    await stat(resolve(projectPath, fileName));
    return true;
  } catch {
    return false;
  }
}

async function listDependencies(packageJson: PackageJson): Promise<string[]> {
  const dependencies = packageJson.dependencies || {};
  const devDependencies = packageJson.devDependencies || {};
  const allDependencies = { ...dependencies, ...devDependencies };

  const categories = {
    'AWS SDK': ['@aws-sdk/*'],
    'React': ['react', 'react-dom'],
    'Database': ['dynamodb', 'mongoose'],
    'Testing': ['jest', 'vitest', 'mocha'],
  };

  const matchedDependencies: string[] = [];

  for (const [name, packages] of Object.entries(categories)) {
    for (const packagePattern of packages) {
      if (packagePattern.endsWith('/*')) {
        const prefix = packagePattern.slice(0, -2);
        if (Object.keys(allDependencies).some(dep => dep.startsWith(prefix))) {
          matchedDependencies.push(name);
        }
      } else if (allDependencies[packagePattern]) {
        matchedDependencies.push(name);
      }
    }
  }

  return matchedDependencies;
}

async function sampleSourceFiles(projectPath: string): Promise<string[]> {
  const patterns: string[] = [];
  try {
    const srcPath = resolve(projectPath, 'src');
    const files = await readdir(srcPath);
    for (const file of files.slice(0, 3)) {
      if (!file.endsWith('.ts') && !file.endsWith('.js') && !file.endsWith('.mjs')) continue;
      try {
        const content = await readFile(join(srcPath, file), 'utf-8');
        let lines = content.split('\n').slice(0, 50);

        const requireUsage = lines.some(line => line.includes('require('));
        const exportUsage = lines.some(line => line.includes('module.exports'));
        const importUsage = lines.some(line => line.includes('import '));
        const esExportUsage = lines.some(line => line.includes('export '));

        patterns.push(`File: ${file}`);
        if (requireUsage) patterns.push(`  Using require`);
        if (exportUsage) patterns.push(`  Using module.exports`);
        if (importUsage) patterns.push(`  Using import`);
        if (esExportUsage) patterns.push(`  Using export`);
        patterns.push("");
      } catch {
        continue;
      }
    }
  } catch {
    // Handle errors if the src directory does not exist or cannot be read
  }

  return patterns;
}

async function generateProjectContext(projectPath: string): Promise<string> {
  const packageJson: PackageJson | null = await readJsonFile(resolve(projectPath, 'package.json'));
  const name = packageJson?.name || 'Unknown Project';
  const description = packageJson?.description || 'No description provided';

  const language = await detectLanguage(projectPath);
  const moduleSystem = await detectModuleSystem(projectPath);
  
  const isTSStrict = await readTSConfigRunStrictMode(projectPath);
  const tsStr = isTSStrict ? ', TypeScript project with strict mode' : '';

  const isServerless = await checkFileExists(projectPath, 'serverless.yml') || await checkFileExists(projectPath, 'serverless.yaml');
  const serverlessStr = isServerless ? ', Serverless Framework project' : '';

  const isSST = await checkFileExists(projectPath, 'sst.config.ts');
  const sstStr = isSST ? ', SST project' : '';

  const keyDependencies = packageJson ? await listDependencies(packageJson) : [];
  const keyDependenciesString = keyDependencies.length > 0 ? keyDependencies.join(', ') : 'None';

  const patterns = await sampleSourceFiles(projectPath);
  const patternsString = patterns.length > 0 ? patterns.join('\n') : 'No patterns detected';

  return `## Project Context
- Name: ${name}
- Description: ${description}
- Language: ${language}${tsStr}${serverlessStr}${sstStr}
- Module System: ${moduleSystem}
- Key Dependencies: ${keyDependenciesString}
- Patterns:\n${patternsString}`;
}

export { generateProjectContext, detectLanguage };
