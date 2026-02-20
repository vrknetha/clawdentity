#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const MAX_LINES = 800;
const EXCLUDED_DIR_SEGMENTS = new Set([
  "dist",
  ".wrangler",
  "node_modules",
]);
const EXCLUDED_PATH_SNIPPETS = ["/drizzle/meta/"];
const EXCLUDED_BASENAMES = new Set(["worker-configuration.d.ts"]);
const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".d.ts",
  ".json",
  ".jsonc",
  ".sql",
  ".sh",
]);

function compareStrings(left, right) {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
}

const trackedFilesOutput = execFileSync("git", ["ls-files", "--", "apps", "packages"], {
  encoding: "utf8",
});

const trackedFiles = trackedFilesOutput
  .split("\n")
  .map((filePath) => filePath.trim())
  .filter(Boolean)
  .map((filePath) => filePath.replaceAll("\\", "/"))
  .sort(compareStrings);

function isExcluded(filePath) {
  if (EXCLUDED_BASENAMES.has(filePath.split("/").at(-1))) {
    return true;
  }

  if (EXCLUDED_PATH_SNIPPETS.some((snippet) => filePath.includes(snippet))) {
    return true;
  }

  const segments = filePath.split("/");
  return segments.some((segment) => EXCLUDED_DIR_SEGMENTS.has(segment));
}

function getExtension(filePath) {
  if (filePath.endsWith(".d.ts")) {
    return ".d.ts";
  }

  const extensionStart = filePath.lastIndexOf(".");
  if (extensionStart === -1) {
    return "";
  }

  return filePath.slice(extensionStart);
}

function countLines(filePath) {
  const contents = readFileSync(filePath, "utf8");

  if (contents.length === 0) {
    return 0;
  }

  const newlineMatches = contents.match(/\n/g);
  const newlineCount = newlineMatches === null ? 0 : newlineMatches.length;
  return contents.endsWith("\n") ? newlineCount : newlineCount + 1;
}

const sourceFiles = trackedFiles.filter((filePath) => {
  if (!existsSync(filePath)) {
    return false;
  }

  if (isExcluded(filePath)) {
    return false;
  }

  return SOURCE_EXTENSIONS.has(getExtension(filePath));
});

const violations = sourceFiles
  .map((filePath) => ({ filePath, lineCount: countLines(filePath) }))
  .filter(({ lineCount }) => lineCount > MAX_LINES)
  .sort((left, right) => {
    if (right.lineCount !== left.lineCount) {
      return right.lineCount - left.lineCount;
    }
    return compareStrings(left.filePath, right.filePath);
  });

if (violations.length > 0) {
  console.error(
    `Found ${violations.length} source file(s) exceeding ${MAX_LINES} lines under apps/ and packages/:`,
  );

  for (const violation of violations) {
    console.error(`- ${violation.filePath}: ${violation.lineCount} lines`);
  }

  process.exit(1);
}

console.log(
  `File-size guard passed: ${sourceFiles.length} source file(s) checked (max ${MAX_LINES} lines).`,
);
