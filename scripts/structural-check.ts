#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOTS = ["apps", "packages"];
const MAX_LINES = 800;
const CODE_LIKE_COMMENT_PATTERN =
  /\b(function|const|let|import|return)\b|\bif\s*\(|\bfor\s*\(|=>/;
const MAGIC_STRING_ON_RIGHT_PATTERN = /(?:===|!==)\s*(['"`])(?:\\.|(?!\1).)+\1/;
const MAGIC_STRING_ON_LEFT_PATTERN = /(['"`])(?:\\.|(?!\1).)+\1\s*(?:===|!==)/;

type Severity = "error" | "warning";

type Finding = {
  code: string;
  filePath: string;
  line?: number;
  message: string;
  severity: Severity;
};

type ScanContext = {
  fix: boolean;
  scannedFiles: string[];
  findings: Finding[];
};

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function isTypeScriptFile(filePath: string): boolean {
  return /(\.ts|\.tsx|\.mts|\.cts)$/.test(filePath);
}

function isDefinitionFile(filePath: string): boolean {
  return filePath.endsWith(".d.ts");
}

function isTestFile(filePath: string): boolean {
  return (
    /\.(test|spec)\.[cm]?tsx?$/.test(filePath) ||
    /(^|\/)(__tests__|tests)\//.test(filePath) ||
    filePath.includes(".test/") ||
    filePath.includes(".spec/")
  );
}

function isConfigFile(filePath: string): boolean {
  return /\.config\.[cm]?tsx?$/.test(filePath);
}

function shouldSkipDirectory(name: string): boolean {
  return name === "node_modules" || name === ".git" || name === "dist" || name === ".wrangler";
}

function countLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }

  const newlineCount = (content.match(/\n/g) ?? []).length;
  return content.endsWith("\n") ? newlineCount : newlineCount + 1;
}

function collectTypeScriptFiles(root: string): string[] {
  const files: string[] = [];
  if (!existsSync(root)) {
    return files;
  }

  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!shouldSkipDirectory(entry.name)) {
          stack.push(fullPath);
        }
        continue;
      }

      const normalized = normalizePath(fullPath);
      if (!entry.isFile() || !isTypeScriptFile(normalized) || isDefinitionFile(normalized)) {
        continue;
      }

      files.push(normalized);
    }
  }

  files.sort();
  return files;
}

function addFinding(
  context: ScanContext,
  severity: Severity,
  code: string,
  filePath: string,
  line: number | undefined,
  message: string,
): void {
  context.findings.push({
    severity,
    code,
    filePath,
    line,
    message,
  });
}

function isConsoleRuleTarget(filePath: string): boolean {
  if (filePath.startsWith("apps/")) {
    return true;
  }

  return /^packages\/[^/]+\/src\//.test(filePath);
}

function isImportLine(trimmedLine: string): boolean {
  return trimmedLine.startsWith("import ") || trimmedLine.startsWith("export {");
}

function hasMagicStringComparison(line: string): boolean {
  return MAGIC_STRING_ON_RIGHT_PATTERN.test(line) || MAGIC_STRING_ON_LEFT_PATTERN.test(line);
}

function scanCommentedOutCode(context: ScanContext, filePath: string, lines: string[]): void {
  let blockStart = -1;
  const blockLines: string[] = [];

  const flush = (): void => {
    if (blockStart < 0) {
      return;
    }

    if (
      blockLines.length >= 3 &&
      blockLines.some((line) => CODE_LIKE_COMMENT_PATTERN.test(line.trim()))
    ) {
      addFinding(
        context,
        "error",
        "DEAD_CODE",
        filePath,
        blockStart + 1,
        `DEAD_CODE: ${filePath}:${blockStart + 1} has commented-out code block. Delete it — git has history.`,
      );
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
}

function scanFile(context: ScanContext, filePath: string): void {
  const content = readFileSync(filePath, "utf8");
  const lineCount = countLines(content);
  const lines = content.split(/\r?\n/);
  const inTestFile = isTestFile(filePath);

  if (lineCount > MAX_LINES) {
    addFinding(
      context,
      "error",
      "FILE_TOO_LARGE",
      filePath,
      undefined,
      `FILE_TOO_LARGE: ${filePath} is ${lineCount} lines (limit: ${MAX_LINES}). Split into focused modules.`,
    );
  }

  scanCommentedOutCode(context, filePath, lines);

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const rawLine = lines[index];
    const trimmed = rawLine.trim();
    if (trimmed.startsWith("//")) {
      continue;
    }

    if (!inTestFile) {
      if (/:\s*any\b/.test(rawLine) || /\bas\s+any\b/.test(rawLine) || /<\s*any\s*>/.test(rawLine)) {
        addFinding(
          context,
          "error",
          "UNSAFE_ANY",
          filePath,
          lineNumber,
          `UNSAFE_ANY: ${filePath}:${lineNumber} uses 'any'. Use 'unknown' with type narrowing instead.`,
        );
      }

      if (isConsoleRuleTarget(filePath) && /\bconsole\.(log|warn|error)\s*\(/.test(rawLine)) {
        addFinding(
          context,
          "error",
          "BARE_CONSOLE",
          filePath,
          lineNumber,
          `BARE_CONSOLE: ${filePath}:${lineNumber} uses console.log. Use structured logging.`,
        );
      }

      if (!isConfigFile(filePath) && /\bexport\s+default\b/.test(rawLine)) {
        addFinding(
          context,
          "error",
          "DEFAULT_EXPORT",
          filePath,
          lineNumber,
          `DEFAULT_EXPORT: ${filePath}:${lineNumber} uses default export. Use named exports only.`,
        );
      }

      if (!isImportLine(trimmed) && hasMagicStringComparison(rawLine)) {
        addFinding(
          context,
          "warning",
          "MAGIC_STRING",
          filePath,
          lineNumber,
          `MAGIC_STRING: ${filePath}:${lineNumber} has inline string comparison. Consider using a constant.`,
        );
      }
    }
  }
}

function collectModuleReadmeWarnings(context: ScanContext): void {
  for (const root of ROOTS) {
    if (!existsSync(root)) {
      continue;
    }

    const entries = readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const directoryPath = normalizePath(path.join(root, entry.name));
      if (!existsSync(path.join(directoryPath, "README.md"))) {
        addFinding(
          context,
          "warning",
          "README_MISSING",
          directoryPath,
          undefined,
          `README_MISSING: ${directoryPath} has no README.md. Add one describing scope and entry points.`,
        );
      }
    }
  }
}

function main(): void {
  const fix = process.argv.includes("--fix");
  const scannedFiles = ROOTS.flatMap((root) => collectTypeScriptFiles(root));

  const context: ScanContext = {
    fix,
    scannedFiles,
    findings: [],
  };

  for (const filePath of scannedFiles) {
    scanFile(context, filePath);
  }
  collectModuleReadmeWarnings(context);

  const errors = context.findings.filter((finding) => finding.severity === "error");
  const warnings = context.findings.filter((finding) => finding.severity === "warning");

  if (context.fix) {
    console.log("Auto-fix mode is enabled, but no structural rules are auto-fixable yet.");
  }

  for (const finding of errors) {
    console.error(finding.message);
  }
  for (const finding of warnings) {
    console.warn(finding.message);
  }

  console.log(`${errors.length} errors, ${warnings.length} warnings across ${scannedFiles.length} files`);
  if (errors.length > 0) {
    process.exit(1);
  }
}

main();
