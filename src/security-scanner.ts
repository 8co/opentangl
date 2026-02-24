/**
 * Security Validation
 * Scans code for dangerous patterns before allowing autonomous commits.
 * Prevents: code execution, file deletion, unbounded operations.
 */

import * as fs from 'fs';

export interface SecurityViolation {
  pattern: string;
  line: number;
  severity: 'critical' | 'high' | 'medium';
  message: string;
}

export interface SecurityScanResult {
  safe: boolean;
  violations: SecurityViolation[];
}

interface SecurityPattern {
  regex: RegExp;
  message: string;
}

// Critical: Never allow these
const CRITICAL_PATTERNS: SecurityPattern[] = [
  { regex: /\beval\s*\(/g, message: 'Use of eval() detected - code execution risk' },
  { regex: /\bFunction\s*\(/g, message: 'Use of Function() constructor - code execution risk' },
  { regex: /\bexec\s*\(/g, message: 'Use of exec() detected - shell execution risk' },
  { regex: /\brm\s+-rf/g, message: 'Use of rm -rf detected - destructive operation' },
  { regex: /\.unlink\(.*\{.*recursive.*true/g, message: 'Recursive file deletion detected' },
];

// High risk: Usually bad, rare legitimate uses
const HIGH_RISK_PATTERNS: SecurityPattern[] = [
  { regex: /while\s*\(\s*true\s*\)/g, message: 'Infinite loop detected (while true)' },
  { regex: /for\s*\(\s*;\s*;\s*\)/g, message: 'Infinite loop detected (for ;;)' },
  { regex: /process\.exit\(0\).*catch/g, message: 'Exit with success in error handler' },
  { regex: /spawn\s*\(.*\$\{/g, message: 'Shell spawn with template literal - injection risk' },
];

// Medium risk: Review needed
const MEDIUM_RISK_PATTERNS: SecurityPattern[] = [
  { regex: /process\.env\.\w+\s*=\s*/g, message: 'Modifying process.env - unexpected behavior' },
  { regex: /\.\.\/\.\.\/\.\.\//g, message: 'Excessive path traversal detected' },
  { regex: /for\s*\([^)]*\)\s*\{[^}]*for\s*\([^)]*\)\s*\{[^}]*for/g, message: 'Triple nested loop - performance concern' },
];

/**
 * Scan code for security violations
 */
export function scanCode(code: string, filePath: string): SecurityScanResult {
  const violations: SecurityViolation[] = [];
  const lines: string[] = code.split('\n');

  const scanPatterns = (patterns: SecurityPattern[], severity: SecurityViolation['severity']) => {
    for (const { regex, message } of patterns) {
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          violations.push({
            pattern: regex.source,
            line: i + 1,
            severity,
            message: `${message} at line ${i + 1}`,
          });
        }
        regex.lastIndex = 0; // Reset regex state
      }
    }
  };

  // Check critical, high risk, and medium risk patterns
  scanPatterns(CRITICAL_PATTERNS, 'critical');
  scanPatterns(HIGH_RISK_PATTERNS, 'high');
  scanPatterns(MEDIUM_RISK_PATTERNS, 'medium');

  // Fail if any critical or high severity violations
  const hasCritical = violations.some(v => v.severity === 'critical');
  const hasHigh = violations.some(v => v.severity === 'high');

  return {
    safe: !hasCritical && !hasHigh,
    violations,
  };
}

/**
 * Format violations for display
 */
export function formatViolations(result: SecurityScanResult, filePath: string): string {
  if (result.safe && result.violations.length === 0) {
    return '✅ No security violations detected';
  }

  const critical = result.violations.filter(v => v.severity === 'critical');
  const high = result.violations.filter(v => v.severity === 'high');
  const medium = result.violations.filter(v => v.severity === 'medium');

  const lines: string[] = [
    `🔒 Security Scan: ${filePath}`,
    '',
  ];

  if (critical.length > 0) {
    lines.push('🔴 CRITICAL VIOLATIONS (blocking):');
    for (const v of critical) {
      lines.push(`   Line ${v.line}: ${v.message}`);
    }
    lines.push('');
  }

  if (high.length > 0) {
    lines.push('🟠 HIGH RISK (blocking):');
    for (const v of high) {
      lines.push(`   Line ${v.line}: ${v.message}`);
    }
    lines.push('');
  }

  if (medium.length > 0) {
    lines.push('🟡 MEDIUM RISK (warning):');
    for (const v of medium) {
      lines.push(`   Line ${v.line}: ${v.message}`);
    }
    lines.push('');
  }

  if (!result.safe) {
    lines.push('❌ Security check FAILED - changes blocked');
  }

  return lines.join('\n');
}

/**
 * Files that should always be scanned for security issues
 */
export const SECURITY_CRITICAL_FILES: string[] = [
  'src/cli.ts',
  'src/scheduler.ts',
  'src/autonomous-runner.ts',
  'src/git-ops.ts',
  'src/verify-runner.ts',
];

/**
 * Check if a file requires security scanning.
 * Critical file list is orchestrator-specific — only applies when
 * projectId is 'orchestrator' or undefined (backward-compatible default).
 * General security patterns (eval, exec, rm -rf) still apply to all projects
 * via scanCode().
 */
export function requiresSecurityScan(filePath: string, projectId?: string): boolean {
  // Only enforce orchestrator-specific critical file list for the orchestrator
  if (projectId && projectId !== 'orchestrator') return false;
  return SECURITY_CRITICAL_FILES.some((critical: string) => filePath.endsWith(critical));
}

/**
 * Read a file and scan for security issues, with enhanced error handling
 */
export function readFileAndScan(filePath: string): SecurityScanResult {
  try {
    const code: string = fs.readFileSync(filePath, 'utf8');
    return scanCode(code, filePath);
  } catch (error: unknown) {
    console.error(`Error reading file ${filePath}:`, (error as Error).message);
    return {
      safe: false,
      violations: [{
        pattern: '',
        line: 0,
        severity: 'critical',
        message: `Error reading file: ${(error as Error).message}`
      }]
    };
  }
}
