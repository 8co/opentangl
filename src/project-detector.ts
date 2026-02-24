import { access, constants, readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function detectProjectType(projectPath: string): Promise<string> {
  const resolvedPath = resolve(projectPath);

  const checks = [
    { condition: await fileExists(join(resolvedPath, 'sst.config.ts')), type: 'sst-v2' },
    {
      condition: await fileExists(join(resolvedPath, 'app.json')) &&
                 JSON.parse(await readFile(join(resolvedPath, 'app.json'), 'utf-8')).expo !== undefined,
      type: 'expo-react-native',
    },
    { condition: await fileExists(join(resolvedPath, 'serverless.yml')) || await fileExists(join(resolvedPath, 'serverless.yaml')), 
      type: (await fileExists(join(resolvedPath, 'tsconfig.json'))) ? 'serverless-ts' : 'serverless-js'
    },
    { condition: await fileExists(join(resolvedPath, 'next.config.js')) || 
                 await fileExists(join(resolvedPath, 'next.config.mjs')) || 
                 await fileExists(join(resolvedPath, 'next.config.ts')),
      type: (await fileExists(join(resolvedPath, 'tsconfig.json'))) ? 'nextjs-ts' : 'nextjs-js'
    },
    { condition: await fileExists(join(resolvedPath, 'vite.config.ts')) || 
                 await fileExists(join(resolvedPath, 'vite.config.js')),
      type: (await fileExists(join(resolvedPath, 'tsconfig.json'))) ? 'react-vite' : 'react-vite-js'
    },
    { condition: await fileExists(join(resolvedPath, 'tsconfig.json')), type: 'typescript-node' },
    { condition: await fileExists(join(resolvedPath, 'package.json')), type: 'javascript-node' }
  ];

  for (const check of checks) {
    if (check.condition) {
      return check.type;
    }
  }

  return 'unknown';
}

export async function detectModuleSystem(projectPath: string): Promise<'esm' | 'commonjs'> {
  const packageJsonPath = join(projectPath, 'package.json');

  if (await fileExists(packageJsonPath)) {
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf-8'));

    if (packageJson.type === 'module') {
      return 'esm';
    }
  }

  // Check for .mjs files in the project root
  const files = await readdir(projectPath);
  if (files.some(file => file.endsWith('.mjs'))) {
    return 'esm';
  }

  return 'commonjs';
}
