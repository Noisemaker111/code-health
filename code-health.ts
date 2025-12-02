#!/usr/bin/env bun
/**
 * Unified Code Health Report
 * Combines: oxlint, knip (dead code), jscpd (duplicates), madge (orphans/circular), 
 * tsc (types), complexity analysis, architecture boundaries, structure analysis
 * 
 * Usage: 
 *   bun scripts/code-health.ts           # Full report
 *   bun scripts/code-health.ts --quick   # Skip slow checks (jscpd, madge, architecture)
 *   bun scripts/code-health.ts --fix     # Auto-fix what's possible
 */

import { writeFile, mkdir, readFile, readdir, stat } from "fs/promises";
import { join } from "path";

// ============================================================================
// Configuration
// ============================================================================

const LOG_DIR = join(process.cwd(), "logs");
const REPORT_FILE = join(LOG_DIR, "code-health-report.md");
const JSON_FILE = join(LOG_DIR, "code-health-report.json");

const args = process.argv.slice(2);
const isQuick = args.includes("--quick");
const isFix = args.includes("--fix");

interface CheckResult {
  name: string;
  status: "pass" | "warn" | "fail" | "skip";
  duration: number;
  issues: Issue[];
  summary: string;
  rawOutput?: string;
}

interface Issue {
  type: "error" | "warning" | "info";
  file?: string;
  line?: number;
  message: string;
  rule?: string;
  fix?: string; // Suggested fix for the issue
}

// Complexity thresholds - these are guidelines, not hard rules
const THRESHOLDS = {
  FILE_LINES_WARNING: 300,
  FILE_LINES_ERROR: 500,
  COMPONENT_HOOKS_WARNING: 6,  // Many hooks suggests component is doing too much
  COMPONENT_HOOKS_ERROR: 10,
  COMPONENT_USEEFFECT_WARNING: 4,  // Many effects suggests side-effect sprawl
  COMPONENT_USEMEMO_WARNING: 6,    // Many memos suggests over-optimization or complexity
  FOLDER_DEPTH_WARNING: 5,
  FOLDER_DEPTH_ERROR: 7,
  FILES_PER_FOLDER_WARNING: 15,
  FILES_PER_FOLDER_ERROR: 25,
};

interface HealthReport {
  timestamp: string;
  duration: number;
  checks: CheckResult[];
  totals: {
    errors: number;
    warnings: number;
    info: number;
  };
  grade: "A" | "B" | "C" | "D" | "F";
}

// ============================================================================
// Utility Functions
// ============================================================================

async function runCommand(cmd: string[], cwd?: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const proc = Bun.spawn(cmd, {
      stdout: "pipe",
      stderr: "pipe",
      cwd: cwd ?? process.cwd(),
    });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  } catch (error: any) {
    return { stdout: "", stderr: error.message, exitCode: 1 };
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function getStatusEmoji(status: CheckResult["status"]): string {
  switch (status) {
    case "pass": return "✅";
    case "warn": return "⚠️";
    case "fail": return "❌";
    case "skip": return "⏭️";
  }
}

// ============================================================================
// Check Implementations
// ============================================================================

async function checkEslint(): Promise<CheckResult> {
  const start = Date.now();
  const issues: Issue[] = [];

  console.log("  Running ESLint (import/complexity rules)...");
  
  const { stdout, stderr } = await runCommand(["bunx", "eslint", ".", "--ext", ".ts,.tsx", "--format", "json", "--max-warnings", "0"]);

  try {
    const parsed = JSON.parse(stdout);
    const eslintResults = Array.isArray(parsed) ? parsed : parsed.results || [];

    for (const result of eslintResults) {
      if (result.messages && Array.isArray(result.messages)) {
        for (const message of result.messages) {
          const line = message.line || 0;
          issues.push({
            type: message.severity === 2 ? "error" : "warning",
            file: result.filePath,
            line,
            message: message.message,
            rule: message.ruleId,
          });
        }
      }
    }
  } catch {
    // Fallback to text parsing
    const lines = stdout.split("\n").filter(Boolean);
    for (const line of lines) {
      if (line.includes("error") || line.includes("warning")) {
        const parts = line.split(":");
        const file = parts[0]?.trim();
        const lineNum = parseInt(parts[1]?.trim() || "0");
        const msg = parts.slice(2).join(":").trim();
        issues.push({ 
          type: line.includes("error") ? "error" : "warning", 
          file, 
          line: lineNum, 
          message: msg 
        });
      }
    }
  }

  const errors = issues.filter(i => i.type === "error").length;
  const warnings = issues.filter(i => i.type === "warning").length;

  return {
    name: "Import & Complexity (ESLint)",
    status: errors > 0 ? "fail" : warnings > 0 ? "warn" : "pass",
    duration: Date.now() - start,
    issues,
    summary: `${errors} errors, ${warnings} warnings`,
    rawOutput: stdout + stderr,
  };
}

async function checkOxlint(): Promise<CheckResult> {
  const start = Date.now();
  const issues: Issue[] = [];

  console.log("  Running oxlint...");
  
  const fixArgs = isFix ? ["--fix"] : [];
  const { stdout, stderr } = await runCommand(["bunx", "oxlint", "--format", "json", ...fixArgs]);

  try {
    const parsed = JSON.parse(stdout);
    
    // Handle oxlint JSON format with diagnostics array
    const diagnostics = parsed.diagnostics || (Array.isArray(parsed) ? parsed : []);
    
    for (const item of diagnostics) {
      // Extract line number from labels if available
      let line = item.line;
      if (!line && item.labels && item.labels[0]?.span?.line) {
        line = item.labels[0].span.line;
      }
      
      issues.push({
        type: item.severity === "error" ? "error" : "warning",
        file: item.filename || item.file,
        line,
        message: item.message,
        rule: item.code || item.ruleId || item.rule,
      });
    }
  } catch {
    // Non-JSON output, parse text
    const lines = stdout.split("\n").filter(Boolean);
    for (const line of lines) {
      if (line.includes("error") || line.includes("warning")) {
        issues.push({ type: "warning", message: line });
      }
    }
  }

  const errors = issues.filter(i => i.type === "error").length;
  const warnings = issues.filter(i => i.type === "warning").length;

  return {
    name: "Linting (oxlint)",
    status: errors > 0 ? "fail" : warnings > 0 ? "warn" : "pass",
    duration: Date.now() - start,
    issues,
    summary: `${errors} errors, ${warnings} warnings`,
    rawOutput: stdout + stderr,
  };
}

async function checkKnip(): Promise<CheckResult> {
  const start = Date.now();
  const issues: Issue[] = [];

  console.log("  Running knip (dead code detection)...");

  const { stdout, stderr } = await runCommand(["bunx", "knip", "--reporter", "json"]);

  try {
    const parsed = JSON.parse(stdout);
    
    // Process unused files
    if (parsed.files && Array.isArray(parsed.files)) {
      for (const file of parsed.files) {
        issues.push({
          type: "warning",
          file,
          message: "Unused file - not imported anywhere",
          rule: "knip/unused-file",
        });
      }
    }

    // Process issues array (knip v5 format)
    if (parsed.issues && Array.isArray(parsed.issues)) {
      for (const issue of parsed.issues) {
        const file = issue.file;
        
        // Unused dependencies
        if (issue.dependencies && Array.isArray(issue.dependencies)) {
          for (const dep of issue.dependencies) {
            issues.push({
              type: "warning",
              file,
              line: dep.line,
              message: `Unused dependency: ${dep.name}`,
              rule: "knip/unused-dependency",
            });
          }
        }
        
        // Unused devDependencies
        if (issue.devDependencies && Array.isArray(issue.devDependencies)) {
          for (const dep of issue.devDependencies) {
            issues.push({
              type: "info",
              file,
              line: dep.line,
              message: `Unused devDependency: ${dep.name}`,
              rule: "knip/unused-devdep",
            });
          }
        }
        
        // Unused exports
        if (issue.exports && Array.isArray(issue.exports)) {
          for (const exp of issue.exports) {
            issues.push({
              type: "info",
              file,
              line: exp.line,
              message: `Unused export: ${exp.name}`,
              rule: "knip/unused-export",
            });
          }
        }
        
        // Unused types
        if (issue.types && Array.isArray(issue.types)) {
          for (const typ of issue.types) {
            issues.push({
              type: "info",
              file,
              line: typ.line,
              message: `Unused type: ${typ.name}`,
              rule: "knip/unused-type",
            });
          }
        }
        
        // Unresolved imports
        if (issue.unresolved && Array.isArray(issue.unresolved)) {
          for (const unres of issue.unresolved) {
            issues.push({
              type: "error",
              file,
              line: unres.line,
              message: `Unresolved import: ${unres.name}`,
              rule: "knip/unresolved",
            });
          }
        }
        
        // Duplicate exports
        if (issue.duplicates && Array.isArray(issue.duplicates)) {
          for (const dup of issue.duplicates) {
            if (Array.isArray(dup) && dup.length > 1) {
              const names = dup.map((d: any) => d.name).join(", ");
              issues.push({
                type: "info",
                file,
                message: `Duplicate exports: ${names}`,
                rule: "knip/duplicate-export",
              });
            }
          }
        }
      }
    }

    // Fallback: old knip format
    if (parsed.exports && Array.isArray(parsed.exports)) {
      for (const exp of parsed.exports) {
        issues.push({
          type: "info",
          file: exp.file || exp.filename,
          message: `Unused export: ${exp.name || exp.symbol}`,
          rule: "knip/unused-export",
        });
      }
    }

    if (parsed.dependencies && Array.isArray(parsed.dependencies)) {
      for (const dep of parsed.dependencies) {
        issues.push({
          type: "warning",
          message: `Unused dependency: ${dep}`,
          rule: "knip/unused-dependency",
        });
      }
    }

    if (parsed.unlisted && Array.isArray(parsed.unlisted)) {
      for (const dep of parsed.unlisted) {
        issues.push({
          type: "error",
          message: `Unlisted dependency used: ${dep}`,
          rule: "knip/unlisted-dependency",
        });
      }
    }
  } catch {
    // Parse text output as fallback
    const lines = stdout.split("\n").filter(Boolean);
    for (const line of lines) {
      if (line.includes("Unused") || line.includes("unused")) {
        issues.push({ type: "warning", message: line.trim() });
      }
    }
  }

  const errors = issues.filter(i => i.type === "error").length;
  const warnings = issues.filter(i => i.type === "warning").length;
  const infos = issues.filter(i => i.type === "info").length;

  return {
    name: "Dead Code (knip)",
    status: errors > 0 ? "fail" : warnings > 0 ? "warn" : "pass",
    duration: Date.now() - start,
    issues,
    summary: `${errors} errors, ${warnings} unused deps, ${infos} unused exports`,
    rawOutput: stdout + stderr,
  };
}

async function checkJscpd(): Promise<CheckResult> {
  if (isQuick) {
    return {
      name: "Duplicate Code (jscpd)",
      status: "skip",
      duration: 0,
      issues: [],
      summary: "Skipped (--quick mode)",
    };
  }

  const start = Date.now();
  const issues: Issue[] = [];

  console.log("  Running jscpd (duplicate detection)...");

  const { stdout, stderr } = await runCommand([
    "bunx", "jscpd", 
    "./packages", "./apps",
    "--min-lines", "10",
    "--reporters", "json,console",
    "--ignore", "**/node_modules/**,**/*.test.*,**/_generated/**,**/routeTree.gen.ts",
  ]);

  const output = stdout + stderr;
  
  // Parse text output - jscpd outputs "Clone found" blocks to console
  // Format: Clone found (tsx):
  //  - file1.tsx [line:col - line:col] (X lines, Y tokens)
  //    file2.tsx [line:col - line:col]
  
  // Strip ANSI codes for cleaner parsing
  // eslint-disable-next-line no-control-regex
  const cleanOutput = output.replace(/\u001b\[[0-9;]*m/g, "");
  
  // Match clone blocks - each "Clone found" section
  const cloneRegex = /Clone found \((\w+)\):\s*\n\s*-\s*(.+?)\s*\[(\d+):\d+\s*-\s*(\d+):\d+\]\s*\((\d+)\s*lines[^)]*\)\s*\n\s*(.+?)\s*\[(\d+):\d+\s*-\s*(\d+):\d+\]/g;
  
  let match;
  while ((match = cloneRegex.exec(cleanOutput)) !== null) {
    const [, _lang, file1, startLine1, endLine1, lineCount, file2, startLine2, endLine2] = match;
    
    // Clean up file paths
    const cleanFile1 = file1.replace(/\\/g, "/").trim();
    const cleanFile2 = file2.replace(/\\/g, "/").trim();
    
    issues.push({
      type: "warning",
      file: cleanFile1,
      line: parseInt(startLine1),
      message: `Duplicate code (${lineCount} lines, L${startLine1}-${endLine1}) also in: ${cleanFile2} (L${startLine2}-${endLine2})`,
      rule: "jscpd/duplicate",
    });
  }

  // If regex didn't match, try simpler counting
  if (issues.length === 0 && cleanOutput.includes("Clone found")) {
    const cloneMatches = cleanOutput.match(/Clone found/g);
    const count = cloneMatches?.length || 0;
    
    // Parse simpler format line by line
    const lines = cleanOutput.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes("Clone found")) {
        // Get the next two lines for file info
        const file1Line = lines[i + 1] || "";
        const file2Line = lines[i + 2] || "";
        
        const file1Match = file1Line.match(/-\s*(.+?)\s*\[(\d+):\d+\s*-\s*(\d+):\d+\]\s*\((\d+)\s*lines/);
        const file2Match = file2Line.match(/^\s+(.+?)\s*\[(\d+):\d+\s*-\s*(\d+):\d+\]/);
        
        if (file1Match && file2Match) {
          const [, f1, start1, end1, lineCount] = file1Match;
          const [, f2, start2, end2] = file2Match;
          
          issues.push({
            type: "warning",
            file: f1.replace(/\\/g, "/").trim(),
            line: parseInt(start1),
            message: `Duplicate (${lineCount} lines, L${start1}-${end1}) → ${f2.replace(/\\/g, "/").trim()} (L${start2}-${end2})`,
            rule: "jscpd/duplicate",
          });
        }
      }
    }
    
    // Fallback if still no matches
    if (issues.length === 0 && count > 0) {
      issues.push({
        type: "warning",
        message: `Found ${count} code duplications (see logs/code-health-report.json for rawOutput)`,
        rule: "jscpd/duplicate",
      });
    }
  }

  // Try to read the JSON report for additional stats
  try {
    const jsonReport = await Bun.file(join(process.cwd(), "report", "jscpd-report.json")).json();
    if (jsonReport.statistics?.total) {
      const stats = jsonReport.statistics.total;
      if (stats.percentage > 0) {
        issues.push({
          type: "info",
          message: `Overall duplication: ${stats.percentage.toFixed(1)}% of codebase (${stats.clones || issues.length} clones, ${stats.duplicatedLines || "?"} duplicated lines)`,
          rule: "jscpd/stats",
        });
      }
    }
  } catch {
    // JSON report not available, that's fine
  }

  const warnings = issues.filter(i => i.type === "warning").length;

  return {
    name: "Duplicate Code (jscpd)",
    status: warnings > 10 ? "warn" : "pass",
    duration: Date.now() - start,
    issues,
    summary: `${warnings} duplicate blocks found`,
    rawOutput: output,
  };
}

async function checkMadge(): Promise<CheckResult> {
  if (isQuick) {
    return {
      name: "Dependency Graph (madge)",
      status: "skip",
      duration: 0,
      issues: [],
      summary: "Skipped (--quick mode)",
    };
  }

  const start = Date.now();
  const issues: Issue[] = [];

  console.log("  Running madge (orphans & circular deps)...");

  // Check for orphan files
  const orphanResult = await runCommand([
    "bunx", "madge", "--orphans", "--extensions", "ts,tsx",
    "./packages/backend/convex",
  ]);

  const orphans = orphanResult.stdout
    .split("\n")
    .map(line => line.trim())
    .filter(line => {
      if (!line) return false;
      if (line.includes("No orphans")) return false;
      if (line.startsWith("Using")) return false;
      if (line.startsWith("Processed")) return false;
      if (line.includes("files (")) return false;
      // Must look like a file path
      return line.endsWith(".ts") || line.endsWith(".tsx");
    });

  for (const orphan of orphans) {
    // Skip config files that are expected to be orphans
    const isExpectedOrphan = 
      orphan.includes("config.ts") || 
      orphan.includes(".config.ts") ||
      orphan.includes("_generated");
    
    issues.push({
      type: isExpectedOrphan ? "info" : "warning",
      file: `packages/backend/convex/${orphan}`,
      message: isExpectedOrphan 
        ? "Config file (expected to be standalone)" 
        : "Orphan file - nothing imports this",
      rule: "madge/orphan",
    });
  }

  // Check for circular dependencies
  const circularResult = await runCommand([
    "bunx", "madge", "--circular", "--extensions", "ts,tsx",
    "./packages/backend/convex",
  ]);

  // Parse circular deps - look for chains like "a.ts → b.ts → c.ts"
  const circularLines = circularResult.stdout
    .split("\n")
    .filter(line => line.includes("→") && !line.startsWith("Processed"));
    
  for (const cycle of circularLines) {
    const cleanCycle = cycle.trim();
    if (cleanCycle) {
      issues.push({
        type: "error",
        message: `Circular: ${cleanCycle}`,
        rule: "madge/circular",
      });
    }
  }

  const errors = issues.filter(i => i.type === "error").length;
  const warnings = issues.filter(i => i.type === "warning").length;

  return {
    name: "Dependency Graph (madge)",
    status: errors > 0 ? "fail" : warnings > 0 ? "warn" : "pass",
    duration: Date.now() - start,
    issues,
    summary: `${errors} circular deps, ${warnings} orphan files`,
    rawOutput: orphanResult.stdout + "\n---\n" + circularResult.stdout,
  };
}

async function checkTypeScript(): Promise<CheckResult> {
  const start = Date.now();
  const issues: Issue[] = [];

  console.log("  Running TypeScript type check...");

  const { stdout, stderr } = await runCommand([
    "bunx", "turbo", "check-types", "--output-logs=errors-only"
  ]);

  const output = stdout + stderr;
  
  // Parse TypeScript errors from turbo output
  const errorLines = output.split("\n").filter(line => 
    line.includes("error TS") || line.includes(": error")
  );

  for (const line of errorLines) {
    const match = line.match(/(.+?)\((\d+),\d+\):\s*error\s*(TS\d+):\s*(.+)/);
    if (match) {
      issues.push({
        type: "error",
        file: match[1],
        line: parseInt(match[2]),
        message: match[4],
        rule: match[3],
      });
    } else if (line.includes("error")) {
      issues.push({
        type: "error",
        message: line.trim(),
      });
    }
  }

  const errors = issues.length;

  return {
    name: "TypeScript Types",
    status: errors > 0 ? "fail" : "pass",
    duration: Date.now() - start,
    issues,
    summary: `${errors} type errors`,
    rawOutput: output,
  };
}

// ============================================================================
// Complexity Analysis - File size, hook patterns, component complexity
// ============================================================================

interface FileAnalysis {
  path: string;
  lines: number;
  hooks: {
    useState: number;
    useEffect: number;
    useMemo: number;
    useCallback: number;
    useRef: number;
    useQuery: number;
    useMutation: number;
    custom: number;
  };
  patterns: {
    inlineErrorBoundary: boolean;
    multipleComponents: boolean;
    deepJsxNesting: boolean;
    longFunctions: string[];
    mixedConcerns: boolean;
  };
}

async function analyzeFile(filePath: string): Promise<FileAnalysis | null> {
  try {
    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n");
    
    // Count hooks
    const hooks = {
      useState: (content.match(/useState\s*[<(]/g) || []).length,
      useEffect: (content.match(/useEffect\s*\(/g) || []).length,
      useMemo: (content.match(/useMemo\s*\(/g) || []).length,
      useCallback: (content.match(/useCallback\s*\(/g) || []).length,
      useRef: (content.match(/useRef\s*[<(]/g) || []).length,
      useQuery: (content.match(/useQuery\s*\(/g) || []).length,
      useMutation: (content.match(/useMutation\s*\(/g) || []).length,
      custom: (content.match(/\buse[A-Z][a-zA-Z]*\s*\(/g) || []).length - 
              (content.match(/useState|useEffect|useMemo|useCallback|useRef|useQuery|useMutation/g) || []).length,
    };
    
    // Detect problematic patterns
    const patterns = {
      // Inline error boundary class in a functional component file
      inlineErrorBoundary: /class\s+\w*Error\w*\s+extends\s+React\.Component/.test(content),
      
      // Multiple exported components in one file
      multipleComponents: (content.match(/export\s+(const|function)\s+[A-Z][a-zA-Z]*\s*[=:]/g) || []).length > 2,
      
      // Deep JSX nesting (rough heuristic: many nested divs/fragments)
      deepJsxNesting: (content.match(/<(?:div|Fragment|>)[^>]*>\s*<(?:div|Fragment|>)/g) || []).length > 10,
      
      // Long functions (functions over ~50 lines)
      longFunctions: detectLongFunctions(content),
      
      // Mixed concerns: business logic + UI in same file
      mixedConcerns: detectMixedConcerns(content),
    };
    
    return {
      path: filePath,
      lines: lines.length,
      hooks,
      patterns,
    };
  } catch {
    return null;
  }
}

function detectLongFunctions(content: string): string[] {
  const longFunctions: string[] = [];
  
  // Simple heuristic: find function declarations and check distance to next one
  const lines = content.split("\n");
  let currentFunction = "";
  let functionStartLine = 0;
  let braceDepth = 0;
  let inFunction = false;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Detect function start
    const funcMatch = line.match(/(?:function\s+(\w+)|const\s+(\w+)\s*=\s*(?:async\s*)?\(|const\s+(\w+)\s*=\s*React\.memo)/);
    if (funcMatch && !inFunction) {
      currentFunction = funcMatch[1] || funcMatch[2] || funcMatch[3] || "anonymous";
      functionStartLine = i;
      inFunction = true;
      braceDepth = 0;
    }
    
    // Track braces
    braceDepth += (line.match(/{/g) || []).length;
    braceDepth -= (line.match(/}/g) || []).length;
    
    // Function end
    if (inFunction && braceDepth <= 0 && i > functionStartLine) {
      const functionLength = i - functionStartLine;
      if (functionLength > 80) {
        longFunctions.push(`${currentFunction} (${functionLength} lines)`);
      }
      inFunction = false;
    }
  }
  
  return longFunctions;
}

function detectMixedConcerns(content: string): boolean {
  // Check if file has both heavy business logic AND JSX
  const hasJsx = /<\w+[^>]*>/.test(content);
  const hasHeavyLogic = 
    (content.match(/\.map\s*\(/g) || []).length > 3 &&
    (content.match(/\.filter\s*\(/g) || []).length > 2 ||
    (content.match(/if\s*\(/g) || []).length > 10;
  
  return hasJsx && hasHeavyLogic;
}

async function findFiles(dir: string, pattern: RegExp, ignore: RegExp[]): Promise<string[]> {
  const files: string[] = [];
  
  async function walk(currentDir: string) {
    try {
      const entries = await readdir(currentDir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = join(currentDir, entry.name);
        
        // Check ignore patterns
        if (ignore.some(re => re.test(fullPath))) continue;
        
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile() && pattern.test(entry.name)) {
          files.push(fullPath);
        }
      }
    } catch {
      // Directory not accessible
    }
  }
  
  await walk(dir);
  return files;
}

async function checkComplexity(): Promise<CheckResult> {
  const start = Date.now();
  const issues: Issue[] = [];

  console.log("  Running complexity analysis...");

  const ignorePatterns = [
    /node_modules/,
    /_generated/,
    /\.test\./,
    /\.spec\./,
    /routeTree\.gen/,
  ];

  // Find all TSX/TS files in apps/web/src
  const files = await findFiles(
    join(process.cwd(), "apps/web/src"),
    /\.(tsx?|ts)$/,
    ignorePatterns
  );

  let largeFiles = 0;
  let complexComponents = 0;

  for (const file of files) {
    const analysis = await analyzeFile(file);
    if (!analysis) continue;

    const relativePath = file.replace(process.cwd() + "/", "").replace(process.cwd() + "\\", "");

    // Check file size
    if (analysis.lines > THRESHOLDS.FILE_LINES_ERROR) {
      largeFiles++;
      issues.push({
        type: "error",
        file: relativePath,
        message: `File has ${analysis.lines} lines (max ${THRESHOLDS.FILE_LINES_ERROR})`,
        rule: "complexity/file-size",
        fix: "Split into smaller, focused modules. Extract hooks, utilities, and sub-components.",
      });
    } else if (analysis.lines > THRESHOLDS.FILE_LINES_WARNING) {
      issues.push({
        type: "warning",
        file: relativePath,
        message: `File has ${analysis.lines} lines (consider splitting at ${THRESHOLDS.FILE_LINES_WARNING}+)`,
        rule: "complexity/file-size",
        fix: "Consider extracting reusable logic into hooks or utilities.",
      });
    }

    // Check hook complexity (only for .tsx files - components)
    if (file.endsWith(".tsx")) {
      const totalHooks = analysis.hooks.useState + analysis.hooks.useEffect + 
                        analysis.hooks.useMemo + analysis.hooks.useCallback + 
                        analysis.hooks.useRef + analysis.hooks.custom;

      if (totalHooks >= THRESHOLDS.COMPONENT_HOOKS_ERROR) {
        complexComponents++;
        issues.push({
          type: "error",
          file: relativePath,
          message: `Component uses ${totalHooks} hooks (useState: ${analysis.hooks.useState}, useEffect: ${analysis.hooks.useEffect}, useMemo: ${analysis.hooks.useMemo}, useCallback: ${analysis.hooks.useCallback}, custom: ${analysis.hooks.custom})`,
          rule: "complexity/too-many-hooks",
          fix: "Extract related hooks into a custom hook (e.g., useComponentNameState). Split component into smaller pieces.",
        });
      } else if (totalHooks >= THRESHOLDS.COMPONENT_HOOKS_WARNING) {
        issues.push({
          type: "warning",
          file: relativePath,
          message: `Component uses ${totalHooks} hooks - getting complex`,
          rule: "complexity/too-many-hooks",
          fix: "Consider extracting related state and effects into a custom hook.",
        });
      }

      // Check for too many useEffects (side-effect sprawl)
      if (analysis.hooks.useEffect >= THRESHOLDS.COMPONENT_USEEFFECT_WARNING) {
        issues.push({
          type: "warning",
          file: relativePath,
          message: `Component has ${analysis.hooks.useEffect} useEffect calls - side-effect sprawl`,
          rule: "complexity/effect-sprawl",
          fix: "Consolidate related effects or extract to custom hooks. Consider if effects can be replaced with event handlers.",
        });
      }

      // Check for over-memoization
      if (analysis.hooks.useMemo + analysis.hooks.useCallback >= THRESHOLDS.COMPONENT_USEMEMO_WARNING) {
        issues.push({
          type: "info",
          file: relativePath,
          message: `Component has ${analysis.hooks.useMemo} useMemo and ${analysis.hooks.useCallback} useCallback - possible over-optimization`,
          rule: "complexity/over-memoization",
          fix: "Review if all memos are necessary. React 19 compiler handles most memoization automatically.",
        });
      }
    }

    // Check for problematic patterns
    if (analysis.patterns.inlineErrorBoundary) {
      issues.push({
        type: "warning",
        file: relativePath,
        message: "Inline error boundary class in component file",
        rule: "pattern/inline-error-boundary",
        fix: "Move error boundary to shared/components/ErrorBoundary.tsx and import it.",
      });
    }

    if (analysis.patterns.multipleComponents) {
      issues.push({
        type: "info",
        file: relativePath,
        message: "Multiple exported components in one file",
        rule: "pattern/multiple-components",
        fix: "Consider splitting each component into its own file for better organization.",
      });
    }

    if (analysis.patterns.longFunctions.length > 0) {
      for (const func of analysis.patterns.longFunctions.slice(0, 3)) {
        issues.push({
          type: "warning",
          file: relativePath,
          message: `Long function: ${func}`,
          rule: "complexity/long-function",
          fix: "Break down into smaller functions. Extract logic into utilities or hooks.",
        });
      }
    }

    if (analysis.patterns.mixedConcerns) {
      issues.push({
        type: "info",
        file: relativePath,
        message: "File appears to mix business logic with UI rendering",
        rule: "pattern/mixed-concerns",
        fix: "Extract business logic to hooks/utilities. Keep components focused on rendering.",
      });
    }
  }

  const errors = issues.filter(i => i.type === "error").length;
  const warnings = issues.filter(i => i.type === "warning").length;

  return {
    name: "Complexity Analysis",
    status: errors > 0 ? "fail" : warnings > 5 ? "warn" : "pass",
    duration: Date.now() - start,
    issues,
    summary: `${largeFiles} oversized files, ${complexComponents} complex components, ${warnings} warnings`,
  };
}

// ============================================================================
// Architecture Boundaries - Using dependency-cruiser
// ============================================================================

async function checkArchitecture(): Promise<CheckResult> {
  if (isQuick) {
    return {
      name: "Architecture Boundaries",
      status: "skip",
      duration: 0,
      issues: [],
      summary: "Skipped (--quick mode)",
    };
  }

  const start = Date.now();
  const issues: Issue[] = [];

  console.log("  Running architecture boundary check...");

  // Check if dependency-cruiser config exists
  const configPath = join(process.cwd(), ".dependency-cruiser.cjs");
  try {
    await stat(configPath);
  } catch {
    return {
      name: "Architecture Boundaries",
      status: "skip",
      duration: Date.now() - start,
      issues: [{
        type: "info",
        message: "No .dependency-cruiser.cjs config found - skipping architecture check",
        fix: "Create .dependency-cruiser.cjs to define module boundaries",
      }],
      summary: "Config not found",
    };
  }

  const { stdout, stderr } = await runCommand([
    "bunx", "dependency-cruiser", 
    "--config", ".dependency-cruiser.cjs",
    "--output-type", "json",
    "./apps/web/src"
  ]);

  try {
    const result = JSON.parse(stdout);
    
    if (result.summary) {
      // Parse violations
      for (const violation of result.output?.violations || []) {
        const severity = violation.rule?.severity || "warn";
        const fromPath = violation.from?.replace(process.cwd() + "/", "").replace(process.cwd() + "\\", "");
        const toPath = violation.to?.replace(process.cwd() + "/", "").replace(process.cwd() + "\\", "");
        
        issues.push({
          type: severity === "error" ? "error" : severity === "warn" ? "warning" : "info",
          file: fromPath,
          message: `${violation.rule?.name || "boundary-violation"}: imports ${toPath}`,
          rule: `architecture/${violation.rule?.name || "violation"}`,
          fix: violation.rule?.comment || "Review the import and consider restructuring.",
        });
      }
    }
  } catch {
    // Parse text output if JSON fails
    const lines = (stdout + stderr).split("\n").filter(Boolean);
    for (const line of lines) {
      if (line.includes("error") || line.includes("violation")) {
        issues.push({
          type: "warning",
          message: line.trim(),
          rule: "architecture/unknown",
        });
      }
    }
  }

  const errors = issues.filter(i => i.type === "error").length;
  const warnings = issues.filter(i => i.type === "warning").length;

  return {
    name: "Architecture Boundaries",
    status: errors > 0 ? "fail" : warnings > 0 ? "warn" : "pass",
    duration: Date.now() - start,
    issues,
    summary: `${errors} boundary violations, ${warnings} warnings`,
    rawOutput: stdout + stderr,
  };
}

// ============================================================================
// Structure Analysis - Folder depth, naming, organization
// ============================================================================

interface FolderAnalysis {
  path: string;
  depth: number;
  fileCount: number;
  hasIndex: boolean;
  mixedContent: boolean; // Has both components and other stuff without organization
}

async function analyzeFolderStructure(dir: string, basePath: string, depth: number = 0): Promise<FolderAnalysis[]> {
  const results: FolderAnalysis[] = [];
  
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    
    // Skip ignored directories
    if (dir.includes("node_modules") || dir.includes("_generated") || dir.includes(".git")) {
      return results;
    }
    
    const files = entries.filter(e => e.isFile());
    const dirs = entries.filter(e => e.isDirectory());
    
    const tsxFiles = files.filter(f => f.name.endsWith(".tsx"));
    const tsFiles = files.filter(f => f.name.endsWith(".ts") && !f.name.endsWith(".d.ts"));
    const hasIndex = files.some(f => f.name === "index.ts" || f.name === "index.tsx");
    
    // Check for mixed content (components and utils in same folder without subfolders)
    const hasComponents = tsxFiles.length > 0;
    const hasUtils = tsFiles.some(f => 
      f.name.includes("util") || f.name.includes("helper") || f.name.includes("service")
    );
    const hasHooks = tsFiles.some(f => f.name.startsWith("use"));
    const mixedContent = hasComponents && (hasUtils || hasHooks) && dirs.length === 0 && files.length > 5;
    
    const relativePath = dir.replace(basePath, "").replace(/^[/\\]/, "");
    
    if (relativePath) {
      results.push({
        path: relativePath,
        depth,
        fileCount: files.length,
        hasIndex,
        mixedContent,
      });
    }
    
    // Recurse into subdirectories
    for (const subDir of dirs) {
      const subResults = await analyzeFolderStructure(
        join(dir, subDir.name),
        basePath,
        depth + 1
      );
      results.push(...subResults);
    }
  } catch {
    // Directory not accessible
  }
  
  return results;
}

async function checkStructure(): Promise<CheckResult> {
  const start = Date.now();
  const issues: Issue[] = [];

  console.log("  Running structure analysis...");

  const webSrcPath = join(process.cwd(), "apps/web/src");
  const folders = await analyzeFolderStructure(webSrcPath, webSrcPath);

  let deepFolders = 0;
  let crowdedFolders = 0;

  for (const folder of folders) {
    // Check folder depth
    if (folder.depth >= THRESHOLDS.FOLDER_DEPTH_ERROR) {
      deepFolders++;
      issues.push({
        type: "error",
        file: `apps/web/src/${folder.path}`,
        message: `Folder depth ${folder.depth} exceeds maximum (${THRESHOLDS.FOLDER_DEPTH_ERROR})`,
        rule: "structure/deep-nesting",
        fix: "Flatten the structure. Consider co-locating related files or using a flatter hierarchy.",
      });
    } else if (folder.depth >= THRESHOLDS.FOLDER_DEPTH_WARNING) {
      issues.push({
        type: "warning",
        file: `apps/web/src/${folder.path}`,
        message: `Folder depth ${folder.depth} is getting deep`,
        rule: "structure/deep-nesting",
        fix: "Consider flattening nested folders.",
      });
    }

    // Check files per folder
    if (folder.fileCount >= THRESHOLDS.FILES_PER_FOLDER_ERROR) {
      crowdedFolders++;
      issues.push({
        type: "error",
        file: `apps/web/src/${folder.path}`,
        message: `Folder has ${folder.fileCount} files (max ${THRESHOLDS.FILES_PER_FOLDER_ERROR})`,
        rule: "structure/crowded-folder",
        fix: "Split into subfolders by domain or feature (e.g., /messages, /input, /sidebar).",
      });
    } else if (folder.fileCount >= THRESHOLDS.FILES_PER_FOLDER_WARNING) {
      issues.push({
        type: "warning",
        file: `apps/web/src/${folder.path}`,
        message: `Folder has ${folder.fileCount} files - consider organizing`,
        rule: "structure/crowded-folder",
        fix: "Consider grouping related files into subfolders.",
      });
    }

    // Check for mixed content without organization
    if (folder.mixedContent) {
      issues.push({
        type: "info",
        file: `apps/web/src/${folder.path}`,
        message: "Folder mixes components, hooks, and utilities without subfolders",
        rule: "structure/mixed-content",
        fix: "Organize into /components, /hooks, /utils subfolders or co-locate with features.",
      });
    }
  }

  // Check for common structural anti-patterns
  const featuresPath = join(webSrcPath, "features");
  try {
    const features = await readdir(featuresPath, { withFileTypes: true });
    const featureDirs = features.filter(f => f.isDirectory());
    
    for (const feature of featureDirs) {
      const featureContents = await readdir(join(featuresPath, feature.name), { withFileTypes: true });
      const hasComponentsFolder = featureContents.some(f => f.isDirectory() && f.name === "components");
      const _hasHooksFolder = featureContents.some(f => f.isDirectory() && f.name === "hooks");
      
      // Check if components folder is overcrowded
      if (hasComponentsFolder) {
        const componentFiles = await readdir(join(featuresPath, feature.name, "components"));
        const tsxCount = componentFiles.filter(f => f.endsWith(".tsx")).length;
        
        if (tsxCount > 20) {
          issues.push({
            type: "warning",
            file: `apps/web/src/features/${feature.name}/components`,
            message: `Feature has ${tsxCount} components in one folder`,
            rule: "structure/feature-organization",
            fix: `Group related components: e.g., /messages, /input, /sidebar within features/${feature.name}/components`,
          });
        }
      }
    }
  } catch {
    // Features folder doesn't exist or not accessible
  }

  const errors = issues.filter(i => i.type === "error").length;
  const warnings = issues.filter(i => i.type === "warning").length;

  return {
    name: "Structure Analysis",
    status: errors > 0 ? "fail" : warnings > 3 ? "warn" : "pass",
    duration: Date.now() - start,
    issues,
    summary: `${deepFolders} deep folders, ${crowdedFolders} crowded folders, ${warnings} warnings`,
  };
}

// ============================================================================
// Report Generation
// ============================================================================

// Compact issue format: "type|file:line|message|rule" or "type||message|rule" if no file
type CompactIssue = string;

interface CompactCheckResult {
  n: string; // name
  s: "pass" | "warn" | "fail" | "skip"; // status
  d: number; // duration
  i: CompactIssue[]; // issues
  sum: string; // summary
}

interface CompactReport {
  ts: string; // timestamp
  dur: number; // duration
  checks: CompactCheckResult[];
  totals: { e: number; w: number; i: number }; // errors, warnings, info
  grade: string;
}

function compactIssue(issue: Issue): CompactIssue {
  const t = issue.type === "error" ? "E" : issue.type === "warning" ? "W" : "I";
  const loc = issue.file ? `${issue.file}${issue.line ? `:${issue.line}` : ""}` : "";
  const r = issue.rule || "";
  // Format: "E|file.ts:42|message|rule" - compact single line
  return `${t}|${loc}|${issue.message}|${r}`;
}

function compactReport(report: HealthReport): CompactReport {
  return {
    ts: report.timestamp,
    dur: report.duration,
    checks: report.checks.map(c => ({
      n: c.name,
      s: c.status,
      d: c.duration,
      i: c.issues.map(compactIssue),
      sum: c.summary,
    })),
    totals: { e: report.totals.errors, w: report.totals.warnings, i: report.totals.info },
    grade: report.grade,
  };
}

function calculateGrade(report: HealthReport): HealthReport["grade"] {
  const { errors, warnings } = report.totals;
  
  if (errors === 0 && warnings === 0) return "A";
  if (errors === 0 && warnings <= 5) return "B";
  if (errors <= 2 && warnings <= 15) return "C";
  if (errors <= 5) return "D";
  return "F";
}

function generateMarkdownReport(report: HealthReport): string {
  const lines: string[] = [
    "# 🏥 Code Health Report",
    "",
    `**Generated:** ${report.timestamp}`,
    `**Duration:** ${formatDuration(report.duration)}`,
    `**Grade:** ${report.grade}`,
    "",
    "## 📊 Summary",
    "",
    "| Check | Status | Duration | Summary |",
    "|-------|--------|----------|---------|",
  ];

  for (const check of report.checks) {
    lines.push(
      `| ${check.name} | ${getStatusEmoji(check.status)} ${check.status} | ${formatDuration(check.duration)} | ${check.summary} |`
    );
  }

  lines.push("");
  lines.push("## 📈 Totals");
  lines.push("");
  lines.push(`- **Errors:** ${report.totals.errors}`);
  lines.push(`- **Warnings:** ${report.totals.warnings}`);
  lines.push(`- **Info:** ${report.totals.info}`);
  lines.push("");

  // Add detailed issues per check
  for (const check of report.checks) {
    if (check.issues.length === 0) continue;

    lines.push(`## ${getStatusEmoji(check.status)} ${check.name}`);
    lines.push("");

    const errorIssues = check.issues.filter(i => i.type === "error");
    const warnIssues = check.issues.filter(i => i.type === "warning");
    const infoIssues = check.issues.filter(i => i.type === "info");

    if (errorIssues.length > 0) {
      lines.push("### ❌ Errors");
      lines.push("");
      for (const issue of errorIssues.slice(0, 20)) {
        const location = issue.file ? `\`${issue.file}${issue.line ? `:${issue.line}` : ""}\`` : "";
        const rule = issue.rule ? ` [${issue.rule}]` : "";
        lines.push(`- ${location} ${issue.message}${rule}`);
        if (issue.fix) {
          lines.push(`  - 💡 **Fix:** ${issue.fix}`);
        }
      }
      if (errorIssues.length > 20) {
        lines.push(`- ... and ${errorIssues.length - 20} more errors`);
      }
      lines.push("");
    }

    if (warnIssues.length > 0) {
      lines.push("### ⚠️ Warnings");
      lines.push("");
      for (const issue of warnIssues.slice(0, 20)) {
        const location = issue.file ? `\`${issue.file}${issue.line ? `:${issue.line}` : ""}\`` : "";
        const rule = issue.rule ? ` [${issue.rule}]` : "";
        lines.push(`- ${location} ${issue.message}${rule}`);
        if (issue.fix) {
          lines.push(`  - 💡 **Fix:** ${issue.fix}`);
        }
      }
      if (warnIssues.length > 20) {
        lines.push(`- ... and ${warnIssues.length - 20} more warnings`);
      }
      lines.push("");
    }

    if (infoIssues.length > 0 && infoIssues.length <= 10) {
      lines.push("### ℹ️ Info");
      lines.push("");
      for (const issue of infoIssues) {
        const location = issue.file ? `\`${issue.file}\`` : "";
        lines.push(`- ${location} ${issue.message}`);
        if (issue.fix) {
          lines.push(`  - 💡 ${issue.fix}`);
        }
      }
      lines.push("");
    } else if (infoIssues.length > 10) {
      lines.push(`### ℹ️ Info (${infoIssues.length} items - see JSON for full list)`);
      lines.push("");
    }
  }

  // Add prioritized action items
  lines.push("## 🎯 Priority Action Items");
  lines.push("");
  lines.push("Based on the analysis, here are the most impactful fixes:");
  lines.push("");

  let priority = 1;

  const deadCodeCheck = report.checks.find(c => c.name.includes("knip"));
  const duplicateCheck = report.checks.find(c => c.name.includes("jscpd"));
  const orphanCheck = report.checks.find(c => c.name.includes("madge"));
  const complexityCheck = report.checks.find(c => c.name.includes("Complexity"));
  const architectureCheck = report.checks.find(c => c.name.includes("Architecture"));
  const structureCheck = report.checks.find(c => c.name.includes("Structure"));

  // Complexity issues are often the root cause
  if (complexityCheck) {
    const largeFiles = complexityCheck.issues.filter(i => i.rule === "complexity/file-size" && i.type === "error");
    const complexComponents = complexityCheck.issues.filter(i => i.rule === "complexity/too-many-hooks" && i.type === "error");
    
    if (largeFiles.length > 0) {
      lines.push(`${priority++}. **🔴 Split ${largeFiles.length} oversized file(s)** - These are too large to maintain`);
      for (const f of largeFiles.slice(0, 5)) {
        lines.push(`   - \`${f.file}\` - ${f.fix || "Split into smaller modules"}`);
      }
      lines.push("");
    }
    
    if (complexComponents.length > 0) {
      lines.push(`${priority++}. **🔴 Simplify ${complexComponents.length} complex component(s)** - Too many hooks indicate the component is doing too much`);
      for (const c of complexComponents.slice(0, 3)) {
        lines.push(`   - \`${c.file}\``);
        lines.push(`     - ${c.message}`);
        lines.push(`     - 💡 ${c.fix}`);
      }
      lines.push("");
    }
  }

  // Structure issues
  if (structureCheck) {
    const crowdedFolders = structureCheck.issues.filter(i => i.rule === "structure/crowded-folder");
    if (crowdedFolders.length > 0) {
      lines.push(`${priority++}. **📁 Organize ${crowdedFolders.length} crowded folder(s)** - Too many files in one place`);
      for (const f of crowdedFolders.slice(0, 3)) {
        lines.push(`   - \`${f.file}\` - ${f.fix || "Split into subfolders"}`);
      }
      lines.push("");
    }
  }

  // Architecture issues
  if (architectureCheck && architectureCheck.issues.filter(i => i.type === "error").length > 0) {
    const violations = architectureCheck.issues.filter(i => i.type === "error");
    lines.push(`${priority++}. **🏗️ Fix ${violations.length} architecture violation(s)** - Clean module boundaries`);
    for (const v of violations.slice(0, 3)) {
      lines.push(`   - \`${v.file}\` - ${v.message}`);
      if (v.fix) lines.push(`     - 💡 ${v.fix}`);
    }
    lines.push("");
  }

  // Duplicate code
  if (duplicateCheck && duplicateCheck.issues.filter(i => i.type === "warning").length > 0) {
    const dupes = duplicateCheck.issues.filter(i => i.type === "warning").length;
    lines.push(`${priority++}. **📋 Consolidate ${dupes} duplicate code block(s)** - DRY principle`);
    lines.push("   - Extract shared logic into utilities or shared components");
    lines.push("");
  }

  // Dead code
  if (deadCodeCheck && deadCodeCheck.issues.length > 0) {
    const unusedFiles = deadCodeCheck.issues.filter(i => i.rule === "knip/unused-file");
    const unusedExports = deadCodeCheck.issues.filter(i => i.rule?.includes("unused-export"));
    
    if (unusedFiles.length > 0) {
      lines.push(`${priority++}. **🗑️ Delete ${unusedFiles.length} unused file(s)** - Dead code`);
      for (const f of unusedFiles.slice(0, 5)) {
        lines.push(`   - \`${f.file}\``);
      }
      lines.push("");
    }
    
    if (unusedExports.length > 10) {
      lines.push(`${priority++}. **🧹 Clean up ${unusedExports.length} unused exports** - Remove or use them`);
      lines.push("");
    }
  }

  if (orphanCheck && orphanCheck.issues.filter(i => i.rule === "madge/circular").length > 0) {
    lines.push(`${priority++}. **🔄 Fix circular dependencies** - These can cause bundling issues`);
    lines.push("");
  }

  if (priority === 1) {
    lines.push("🎉 **No critical issues found!** Keep up the good work.");
    lines.push("");
  }

  lines.push("---");
  lines.push(`*Full JSON report available at: ${JSON_FILE}*`);

  return lines.join("\n");
}

// ============================================================================
// Main Execution
// ============================================================================

async function main() {
  const startTime = Date.now();

  console.log("🏥 Running Code Health Check...\n");
  
  if (isQuick) {
    console.log("⚡ Quick mode: skipping jscpd, madge, and architecture checks\n");
  }

  // Ensure logs directory exists
  await mkdir(LOG_DIR, { recursive: true });

  // Run all checks
  const checks: CheckResult[] = [];

  checks.push(await checkOxlint());
  checks.push(await checkEslint());
  checks.push(await checkKnip());
  checks.push(await checkJscpd());
  checks.push(await checkMadge());
  checks.push(await checkTypeScript());
  checks.push(await checkComplexity());
  checks.push(await checkArchitecture());
  checks.push(await checkStructure());

  // Calculate totals
  const totals = {
    errors: 0,
    warnings: 0,
    info: 0,
  };

  for (const check of checks) {
    for (const issue of check.issues) {
      if (issue.type === "error") totals.errors++;
      else if (issue.type === "warning") totals.warnings++;
      else totals.info++;
    }
  }

  const report: HealthReport = {
    timestamp: new Date().toISOString(),
    duration: Date.now() - startTime,
    checks,
    totals,
    grade: "A", // Will be calculated
  };

  report.grade = calculateGrade(report);

  // Generate reports
  const markdown = generateMarkdownReport(report);
  
  await writeFile(REPORT_FILE, markdown);
  await writeFile(JSON_FILE, JSON.stringify(compactReport(report)));

  // Print summary to console
  console.log("\n" + "=".repeat(60));
  console.log("📊 CODE HEALTH SUMMARY");
  console.log("=".repeat(60));
  console.log("");

  for (const check of checks) {
    console.log(`${getStatusEmoji(check.status)} ${check.name.padEnd(30)} ${check.summary}`);
  }

  console.log("");
  console.log("-".repeat(60));
  console.log(`Grade: ${report.grade}`);
  console.log(`Total: ${totals.errors} errors, ${totals.warnings} warnings, ${totals.info} info`);
  console.log(`Duration: ${formatDuration(report.duration)}`);
  console.log("-".repeat(60));
  console.log("");
  console.log(`📄 Full report: ${REPORT_FILE}`);
  console.log(`📋 JSON data:   ${JSON_FILE}`);

  // Exit with appropriate code
  process.exit(totals.errors > 0 ? 1 : 0);
}

main().catch(console.error);
