#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOTS = ["apps", "packages"];
const CODE_LIKE_COMMENT_PATTERN =
  /\b(function|const|let|import|return)\b|\bif\s*\(|\bfor\s*\(|=>/;
const MAGIC_STRING_ON_RIGHT_PATTERN = /(?:===|!==)\s*(['"`])(?:\\.|(?!\1).)+\1/;
const MAGIC_STRING_ON_LEFT_PATTERN = /(['"`])(?:\\.|(?!\1).)+\1\s*(?:===|!==)/;

type Severity = "error" | "warning";

type Finding = {
  message: string;
  severity: Severity;
};

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function isTypeScriptFile(filePath: string): boolean {
  return /(\.ts|\.tsx|\.mts|\.cts)$/.test(filePath) && !filePath.endsWith(".d.ts");
}

function isTestFile(filePath: string): boolean {
  return (
    /\.(test|spec)\.[cm]?tsx?$/.test(filePath) ||
    /(^|\/)(__tests__|tests)\//.test(filePath) ||
    filePath.includes(".test/") ||
    filePath.includes(".spec/")
  );
}

function shouldSkipDirectory(name: string): boolean {
  return name === "node_modules" || name === ".git" || name === "dist" || name === ".wrangler";
}

function collectTypeScriptFiles(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }

  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = normalizePath(path.join(current, entry.name));
      if (entry.isDirectory()) {
        if (!shouldSkipDirectory(entry.name)) {
          stack.push(fullPath);
        }
        continue;
      }

      if (entry.isFile() && isTypeScriptFile(fullPath)) {
        files.push(fullPath);
      }
    }
  }

  files.sort();
  return files;
}

function isImportLine(trimmed: string): boolean {
  return trimmed.startsWith("import ") || trimmed.startsWith("export {");
}

function hasMagicStringComparison(line: string): boolean {
  return MAGIC_STRING_ON_RIGHT_PATTERN.test(line) || MAGIC_STRING_ON_LEFT_PATTERN.test(line);
}

function collectCommentedOutCodeFindings(filePath: string, lines: string[]): Finding[] {
  const findings: Finding[] = [];
  let blockStart = -1;
  const blockLines: string[] = [];

  const flush = (): void => {
    if (
      blockStart >= 0 &&
      blockLines.length >= 3 &&
      blockLines.some((line) => CODE_LIKE_COMMENT_PATTERN.test(line.trim()))
    ) {
      findings.push({
        severity: "error",
        message: `DEAD_CODE: ${filePath}:${blockStart + 1} has commented-out code block. Delete it — git has history.`,
      });
    }
    blockStart = -1;
    blockLines.length = 0;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed.startsWith("//")) {
      flush();
      continue;
    }

    if (blockStart < 0) {
      blockStart = index;
    }
    blockLines.push(trimmed.slice(2).trim());
  }

  flush();
  return findings;
}

function collectMagicStringFindings(filePath: string, lines: string[]): Finding[] {
  if (isTestFile(filePath)) {
    return [];
  }

  const findings: Finding[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const trimmed = rawLine.trim();
    if (trimmed.startsWith("//") || isImportLine(trimmed)) {
      continue;
    }

    if (hasMagicStringComparison(rawLine)) {
      findings.push({
        severity: "warning",
        message: `MAGIC_STRING: ${filePath}:${index + 1} has inline string comparison. Consider using a constant.`,
      });
    }
  }

  return findings;
}

function collectReadmeFindings(): Finding[] {
  const findings: Finding[] = [];
  for (const root of ROOTS) {
    if (!existsSync(root)) {
      continue;
    }

    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const modulePath = normalizePath(path.join(root, entry.name));
      if (!existsSync(path.join(modulePath, "README.md"))) {
        findings.push({
          severity: "warning",
          message: `README_MISSING: ${modulePath} has no README.md. Add one describing scope and entry points.`,
        });
      }
    }
  }
  return findings;
}

function main(): void {
  const files = ROOTS.flatMap((root) => collectTypeScriptFiles(root));
  const findings: Finding[] = [];

  for (const filePath of files) {
    const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
    findings.push(...collectCommentedOutCodeFindings(filePath, lines));
    findings.push(...collectMagicStringFindings(filePath, lines));
  }
  findings.push(...collectReadmeFindings());

  const errors = findings.filter((item) => item.severity === "error");
  const warnings = findings.filter((item) => item.severity === "warning");

  for (const finding of errors) {
    console.error(finding.message);
  }
  for (const finding of warnings) {
    console.warn(finding.message);
  }

  console.log(`${errors.length} errors, ${warnings.length} warnings across ${files.length} files`);
  if (errors.length > 0) {
    process.exit(1);
  }
}

main();
