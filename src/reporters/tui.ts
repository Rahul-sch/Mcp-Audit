/**
 * Terminal reporter — chalk + cli-table3.
 *
 * Default output format. Designed to be readable on a standard 80-column
 * terminal and also usable when piped (chalk auto-disables colors when
 * stdout isn't a TTY).
 */

import chalk from "chalk";
import Table from "cli-table3";
import type { AuditReport, Grade, Severity } from "../types";
import { CHECK_CATALOG } from "../scanner";

export function renderTui(report: AuditReport): string {
  const lines: string[] = [];

  lines.push(renderHeader(report));
  lines.push("");
  lines.push(renderToolTable(report));
  lines.push("");
  lines.push(renderFindings(report));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Header / summary
// ---------------------------------------------------------------------------

function renderHeader(report: AuditReport): string {
  const { meta, overall } = report;
  const title = `mcpaudit v${meta.mcpauditVersion} — ${meta.source}`;
  const gradeBadge = colorGrade(overall.grade)(
    `Grade ${overall.grade} (${overall.score}/100)`,
  );

  const summaryLeft = `Tools: ${meta.toolCount}  Files: ${meta.fileCount}  Findings: ${report.findings.length}`;
  const counts = overall.counts;
  const summaryRight = [
    counts.critical
      ? chalk.red(`${counts.critical} critical`)
      : chalk.dim("0 critical"),
    counts.high ? chalk.red(`${counts.high} high`) : chalk.dim("0 high"),
    counts.medium
      ? chalk.yellow(`${counts.medium} medium`)
      : chalk.dim("0 medium"),
    counts.low ? chalk.cyan(`${counts.low} low`) : chalk.dim("0 low"),
  ].join("  ");

  return [
    chalk.bold(title),
    `${gradeBadge}    ${summaryLeft}`,
    summaryRight,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Per-tool table
// ---------------------------------------------------------------------------

function renderToolTable(report: AuditReport): string {
  if (report.tools.length === 0) {
    return chalk.dim("No tools detected — overall score reflects file-level findings only.");
  }

  const table = new Table({
    head: [
      chalk.bold("Tool"),
      chalk.bold("Grade"),
      chalk.bold("Score"),
      chalk.bold("CRIT"),
      chalk.bold("HIGH"),
      chalk.bold("MED"),
      chalk.bold("LOW"),
    ],
    style: { head: [], border: ["grey"] },
    colAligns: ["left", "center", "right", "right", "right", "right", "right"],
  });

  for (const tool of report.tools) {
    table.push([
      tool.name,
      colorGrade(tool.grade)(tool.grade),
      String(tool.score),
      severityCell(tool.counts.critical, "CRITICAL"),
      severityCell(tool.counts.high, "HIGH"),
      severityCell(tool.counts.medium, "MEDIUM"),
      severityCell(tool.counts.low, "LOW"),
    ]);
  }

  return table.toString();
}

function severityCell(count: number, severity: Severity): string {
  if (count === 0) return chalk.dim("0");
  return colorSeverity(severity)(String(count));
}

// ---------------------------------------------------------------------------
// Findings list
// ---------------------------------------------------------------------------

function renderFindings(report: AuditReport): string {
  if (report.findings.length === 0) {
    return chalk.green("No findings.");
  }

  const sorted = [...report.findings].sort((a, b) => {
    const order: Record<Severity, number> = {
      CRITICAL: 0,
      HIGH: 1,
      MEDIUM: 2,
      LOW: 3,
    };
    if (order[a.severity] !== order[b.severity]) {
      return order[a.severity] - order[b.severity];
    }
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    return a.line - b.line;
  });

  const lines: string[] = [chalk.bold("Findings")];
  for (const f of sorted) {
    const severityTag = colorSeverity(f.severity).bold(`[${f.severity}]`);
    const checkTitle = CHECK_CATALOG[f.checkId]?.title ?? f.checkId;
    const location = chalk.dim(`${f.file}:${f.line}`);
    const toolBadge = f.toolName ? chalk.cyan(` (tool: ${f.toolName})`) : "";

    lines.push(`${severityTag} ${chalk.bold(f.checkId)} ${chalk.dim("·")} ${checkTitle}`);
    lines.push(`  ${location}${toolBadge}`);
    lines.push(`  ${f.message}`);
    if (f.snippet) {
      lines.push(`  ${chalk.dim("│ ")}${chalk.dim(truncate(f.snippet, 100))}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

function colorGrade(grade: Grade): (s: string) => string {
  switch (grade) {
    case "A":
      return chalk.green.bold;
    case "B":
      return chalk.blue.bold;
    case "C":
      return chalk.yellow.bold;
    case "D":
      return chalk.hex("#ff8800").bold;
    case "F":
      return chalk.red.bold;
  }
}

function colorSeverity(severity: Severity): chalk.Chalk {
  switch (severity) {
    case "CRITICAL":
      return chalk.red;
    case "HIGH":
      return chalk.red;
    case "MEDIUM":
      return chalk.yellow;
    case "LOW":
      return chalk.cyan;
  }
}
