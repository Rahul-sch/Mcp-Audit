/**
 * Grader: turns a flat list of findings into a per-project + per-tool scorecard.
 *
 * Scoring (per the spec):
 *   - Start at 100 points
 *   - CRITICAL  -30 each, capped at -60
 *   - HIGH      -15 each, capped at -45
 *   - MEDIUM     -7 each, capped at -21
 *   - LOW        -3 each, capped at -9
 *
 * Letter grade:
 *   A 90–100 · B 75–89 · C 60–74 · D 45–59 · F <45
 *
 * Per-tool attribution: a finding belongs to a tool when either
 *   (a) the scanner already tagged it with `toolName`, or
 *   (b) the finding's file matches the tool's registration file AND its line
 *       number falls inside the tool's captured handler range.
 */

import type {
  AuditReport,
  Finding,
  Grade,
  ParseResult,
  ScoreCard,
  Severity,
  SeverityCounts,
  ToolReport,
} from "./types";

interface SeverityRule {
  perFinding: number;
  cap: number;
}

const SCORING_RULES: Record<Severity, SeverityRule> = {
  CRITICAL: { perFinding: 30, cap: 60 },
  HIGH: { perFinding: 15, cap: 45 },
  MEDIUM: { perFinding: 7, cap: 21 },
  LOW: { perFinding: 3, cap: 9 },
};

/** Convert a numeric score (0–100) into a letter grade. */
export function scoreToGrade(score: number): Grade {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 45) return "D";
  return "F";
}

/** Count findings by severity. */
export function countBySeverity(findings: Finding[]): SeverityCounts {
  const counts: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) {
    if (f.severity === "CRITICAL") counts.critical += 1;
    else if (f.severity === "HIGH") counts.high += 1;
    else if (f.severity === "MEDIUM") counts.medium += 1;
    else counts.low += 1;
  }
  return counts;
}

/** Compute the score and grade for a set of findings. */
export function gradeFindings(findings: Finding[]): ScoreCard {
  const counts = countBySeverity(findings);
  let score = 100;

  for (const severity of ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as Severity[]) {
    const count = countOf(counts, severity);
    if (count === 0) continue;
    const rule = SCORING_RULES[severity];
    const deduction = Math.min(count * rule.perFinding, rule.cap);
    score -= deduction;
  }

  if (score < 0) score = 0;

  return {
    score,
    grade: scoreToGrade(score),
    counts,
  };
}

function countOf(counts: SeverityCounts, severity: Severity): number {
  switch (severity) {
    case "CRITICAL":
      return counts.critical;
    case "HIGH":
      return counts.high;
    case "MEDIUM":
      return counts.medium;
    case "LOW":
      return counts.low;
  }
}

/**
 * Build the full audit report — overall grade + per-tool grades.
 */
export function buildReport(input: {
  parsed: ParseResult;
  findings: Finding[];
  source: string;
  sourceType: "github" | "local";
  mcpauditVersion: string;
}): AuditReport {
  const { parsed, findings, source, sourceType, mcpauditVersion } = input;

  const overall = gradeFindings(findings);

  const tools: ToolReport[] = parsed.tools
    .filter((t) => t.name !== "<call_tool_dispatch>")
    .map((tool) => {
      const toolFindings = findings.filter((f) => belongsToTool(f, tool));
      const card = gradeFindings(toolFindings);
      return {
        name: tool.name,
        description: tool.description,
        findings: toolFindings,
        ...card,
      };
    })
    .sort((a, b) => a.score - b.score); // worst tools first

  return {
    meta: {
      source,
      sourceType,
      scannedAt: new Date().toISOString(),
      mcpauditVersion,
      fileCount: parsed.files.length,
      toolCount: tools.length,
    },
    overall,
    tools,
    findings,
  };
}

function belongsToTool(
  finding: Finding,
  tool: ParseResult["tools"][number],
): boolean {
  if (finding.toolName === tool.name) return true;
  if (!tool.handlerRange) return false;
  if (finding.file !== tool.registrationFile) return false;
  return (
    finding.line >= tool.handlerRange.start &&
    finding.line <= tool.handlerRange.end
  );
}
