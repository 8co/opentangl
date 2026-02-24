#!/usr/bin/env node
/**
 * Security Check Runner
 * CLI wrapper for security-scanner that can be invoked by verify-runner.
 * Scans recent git changes for security violations.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { 
  scanCode, 
  formatViolations, 
  requiresSecurityScan,
  type SecurityScanResult 
} from './security-scanner.js';

/**
 * Get list of changed files in working directory
 */
async function getChangedFiles(cwd: string): Promise<string[]> {
  return new Promise((res, rej) => {
    let stdout = '';
    const proc = spawn('git', ['diff', '--name-only', 'HEAD'], { cwd });
    proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    proc.on('close', (code) => {
      if (code !== 0) {
        console.warn('No git repository or no changes detected.');
        res([]);
      } else {
        const files = stdout.trim().split('\n').filter(Boolean);
        res(files);
      }
    });
    proc.on('error', (error) => {
      console.error(`Error executing git command: ${error.message}`);
      res([]);
    });
  });
}

async function main() {
  try {
    const cwd = process.cwd();
  
    console.log('🔒 Running security scan...\n');

    // Get changed files
    const changedFiles = await getChangedFiles(cwd);

    if (changedFiles.length === 0) {
      console.log('✅ No changed files to scan');
      process.exit(0);
    }

    // Filter to security-critical files (orchestrator context — no projectId)
    const filesToScan = changedFiles.filter((f) => requiresSecurityScan(f));

    if (filesToScan.length === 0) {
      console.log(`   Scanned ${changedFiles.length} file(s) - none are security-critical`);
      console.log('✅ Security scan passed\n');
      process.exit(0);
    }

    console.log(`   Found ${filesToScan.length} security-critical file(s) to scan:\n`);

    let allSafe = true;
    const results: Array<{ file: string; result: SecurityScanResult }> = [];

    // Scan each file
    for (const file of filesToScan) {
      const fullPath = resolve(cwd, file);
      
      try {
        const code = await readFile(fullPath, 'utf-8');
        const result = scanCode(code, file);
        results.push({ file, result });

        if (!result.safe) {
          allSafe = false;
        }
      } catch (error) {
        console.error(`   ⚠️  Could not read ${file}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    // Display results
    for (const { file, result } of results) {
      console.log(formatViolations(result, file));
      console.log('');
    }

    // Summary
    const failed = results.filter(r => !r.result.safe).length;
    const passed = results.filter(r => r.result.safe).length;

    if (allSafe) {
      console.log(`✅ Security scan passed: ${passed}/${results.length} files safe\n`);
      process.exit(0);
    } else {
      console.log(`❌ Security scan failed: ${failed} file(s) with violations\n`);
      console.log('   Critical or high-risk patterns detected.');
      console.log('   Review the violations above and fix before committing.\n');
      process.exit(1);
    }
  } catch (err) {
    console.error('❌ Security check failed:', err instanceof Error ? err.message : 'Unknown error');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('❌ Unexpected error:', err instanceof Error ? err.message : 'Unknown error');
  process.exit(1);
});
