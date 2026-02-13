import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const REQUIRED_HEADINGS = [
  "Goal",
  "In Scope",
  "Out of Scope",
  "Dependencies",
  "Execution Mode",
  "Parallel Wave",
  "Required Skills",
  "Deliverables",
  "Refactor Opportunities",
  "Definition of Done",
  "Validation Steps",
];

const TICKET_CODES = Array.from({ length: 39 }, (_, index) =>
  `T${String(index).padStart(2, "0")}`,
);

const projectRoot = process.cwd();
const issuesDir = resolve(projectRoot, "issues");
const executionPlanPath = resolve(issuesDir, "EXECUTION_PLAN.md");

const errors = [];
const dependencyGraph = new Map();
const blockerGraph = new Map();

function readUtf8(path) {
  return readFileSync(path, "utf8");
}

function parseHeadings(markdown) {
  return [...markdown.matchAll(/^##\s+(.+)$/gm)].map((match) => ({
    heading: match[1]?.trim() ?? "",
    index: match.index ?? -1,
    fullLength: match[0].length,
  }));
}

function extractSection(markdown, headings, sectionName) {
  const sectionIndex = headings.findIndex(
    (entry) => entry.heading === sectionName,
  );
  if (sectionIndex < 0) {
    return null;
  }

  const sectionStart =
    (headings[sectionIndex]?.index ?? 0) +
    (headings[sectionIndex]?.fullLength ?? 0);
  const sectionEnd =
    sectionIndex < headings.length - 1
      ? (headings[sectionIndex + 1]?.index ?? markdown.length)
      : markdown.length;

  return markdown.slice(sectionStart, sectionEnd).trim();
}

function parseTicketReferences(text) {
  return new Set(text.match(/\bT\d{2}\b/g) ?? []);
}

for (const code of TICKET_CODES) {
  const ticketPath = resolve(issuesDir, `${code}.md`);
  if (!existsSync(ticketPath)) {
    errors.push(`Missing ticket file: issues/${code}.md`);
    continue;
  }

  const markdown = readUtf8(ticketPath);
  const headings = parseHeadings(markdown);
  let previousRequiredIndex = -1;

  for (const heading of REQUIRED_HEADINGS) {
    const currentIndex = headings.findIndex((entry) => entry.heading === heading);
    if (currentIndex < 0) {
      errors.push(`issues/${code}.md is missing section: "## ${heading}"`);
      continue;
    }
    if (currentIndex < previousRequiredIndex) {
      errors.push(
        `issues/${code}.md has out-of-order section: "## ${heading}"`,
      );
    }
    previousRequiredIndex = currentIndex;
  }

  const dependenciesSection = extractSection(markdown, headings, "Dependencies");
  if (dependenciesSection === null) {
    dependencyGraph.set(code, new Set());
    blockerGraph.set(code, new Set());
    continue;
  }

  const blockersMatch = dependenciesSection.match(
    /^\s*-\s*Blockers:\s*(.+)$/im,
  );
  if (!blockersMatch) {
    errors.push(`issues/${code}.md is missing a "- Blockers:" line`);
  }

  const dependencyIds = new Set();
  for (const line of dependenciesSection.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("-")) {
      continue;
    }
    if (/^-\s*Blockers:/i.test(trimmed)) {
      continue;
    }
    for (const ticketId of parseTicketReferences(trimmed)) {
      dependencyIds.add(ticketId);
    }
  }

  const blockerIds = blockersMatch
    ? parseTicketReferences(blockersMatch[1] ?? "")
    : new Set();

  dependencyGraph.set(code, dependencyIds);
  blockerGraph.set(code, blockerIds);
}

for (const [ticket, dependencies] of dependencyGraph.entries()) {
  for (const dep of dependencies) {
    if (!TICKET_CODES.includes(dep)) {
      errors.push(`issues/${ticket}.md references unknown dependency: ${dep}`);
    }
  }
}

for (const [ticket, blockers] of blockerGraph.entries()) {
  for (const blocker of blockers) {
    if (!TICKET_CODES.includes(blocker)) {
      errors.push(`issues/${ticket}.md references unknown blocker: ${blocker}`);
    }
  }
}

for (let ticketNumber = 1; ticketNumber <= 36; ticketNumber += 1) {
  const ticket = `T${String(ticketNumber).padStart(2, "0")}`;
  const dependencies = dependencyGraph.get(ticket) ?? new Set();
  const blockers = blockerGraph.get(ticket) ?? new Set();

  if (!dependencies.has("T38")) {
    errors.push(`issues/${ticket}.md must include T38 under Dependencies`);
  }
  if (!blockers.has("T38")) {
    errors.push(`issues/${ticket}.md must include T38 in Blockers`);
  }
}

const dfsState = new Map();
const recursionStack = [];

function visit(ticket) {
  const state = dfsState.get(ticket) ?? 0;
  if (state === 1) {
    const cycleStart = recursionStack.indexOf(ticket);
    const cyclePath = [...recursionStack.slice(cycleStart), ticket].join(" -> ");
    errors.push(`Dependency cycle detected: ${cyclePath}`);
    return;
  }
  if (state === 2) {
    return;
  }

  dfsState.set(ticket, 1);
  recursionStack.push(ticket);
  for (const dep of dependencyGraph.get(ticket) ?? []) {
    if (TICKET_CODES.includes(dep)) {
      visit(dep);
    }
  }
  recursionStack.pop();
  dfsState.set(ticket, 2);
}

for (const ticket of TICKET_CODES) {
  visit(ticket);
}

const executionPlan = readUtf8(executionPlanPath);
const sequenceMatch = executionPlan.match(/`(T\d{2}\s*->[^`]+)`/);
if (!sequenceMatch) {
  errors.push("issues/EXECUTION_PLAN.md is missing canonical sequential order");
}

const sequentialOrder = sequenceMatch
  ? sequenceMatch[1]
      .split("->")
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
  : [];
const sequentialIndex = new Map();
for (const [index, ticket] of sequentialOrder.entries()) {
  if (sequentialIndex.has(ticket)) {
    errors.push(`Sequential order duplicates ticket ${ticket}`);
  } else {
    sequentialIndex.set(ticket, index);
  }
}

for (const ticket of TICKET_CODES) {
  if (!sequentialIndex.has(ticket)) {
    errors.push(`Sequential order is missing ticket ${ticket}`);
  }
}

for (const [ticket, dependencies] of dependencyGraph.entries()) {
  const ticketOrder = sequentialIndex.get(ticket);
  if (ticketOrder === undefined) {
    continue;
  }
  for (const dep of dependencies) {
    const dependencyOrder = sequentialIndex.get(dep);
    if (dependencyOrder === undefined) {
      continue;
    }
    if (dependencyOrder >= ticketOrder) {
      errors.push(
        `Sequential order violation: ${ticket} appears before dependency ${dep}`,
      );
    }
  }
}

const waveMatches = [...executionPlan.matchAll(/^- Wave \d+:\s*`([^`]+)`$/gm)];
const waveByTicket = new Map();
for (const [waveIndex, match] of waveMatches.entries()) {
  const tickets = (match[1] ?? "")
    .split(",")
    .map((ticket) => ticket.trim())
    .filter((ticket) => ticket.length > 0);
  for (const ticket of tickets) {
    if (waveByTicket.has(ticket)) {
      errors.push(
        `Parallel waves duplicate ticket ${ticket} (wave ${waveByTicket.get(ticket)} and wave ${waveIndex})`,
      );
      continue;
    }
    waveByTicket.set(ticket, waveIndex);
  }
}

for (const [ticket, dependencies] of dependencyGraph.entries()) {
  const ticketWave = waveByTicket.get(ticket);
  if (ticketWave === undefined) {
    continue;
  }
  for (const dep of dependencies) {
    const dependencyWave = waveByTicket.get(dep);
    if (dependencyWave === undefined) {
      continue;
    }
    if (dependencyWave === ticketWave) {
      errors.push(
        `Parallel wave conflict: ${ticket} and dependency ${dep} are both in wave ${ticketWave}`,
      );
    }
  }
}

if (errors.length > 0) {
  console.error("issues:validate failed");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(
  `issues:validate passed (${TICKET_CODES.length} tickets, ${waveMatches.length} waves checked)`,
);
