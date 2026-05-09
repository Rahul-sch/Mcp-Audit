/**
 * JSON reporter.
 *
 * Emits a flat, stable shape designed for CI pipelines:
 *
 *   {
 *     "schemaVersion": "1.0.0",
 *     "mcpaudit":      "<binary version>",
 *     "grade":         "A" | "B" | "C" | "D" | "F",
 *     "score":         0..100,
 *     "summary":       { critical, high, medium, low, total },
 *     "meta":          { source, sourceType, scannedAt, fileCount, toolCount },
 *     "tools":         ToolReport[],
 *     "findings":      Finding[]
 *   }
 *
 * Top-level `grade` and `score` make `jq .grade` / `jq .score` trivial in
 * pipelines. Adding a new field is non-breaking; renaming/removing requires a
 * schema version bump.
 */

import type { AuditReport, Finding, Grade, ToolReport } from "../types";

export const SCHEMA_VERSION = "1.0.0";

interface JsonOutput {
  schemaVersion: string;
  mcpaudit: string;
  grade: Grade;
  score: number;
  summary: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    total: number;
  };
  meta: AuditReport["meta"];
  tools: ToolReport[];
  findings: Finding[];
}

export function renderJson(report: AuditReport): string {
  const payload = toJsonPayload(report);
  return JSON.stringify(payload, null, 2);
}

export function toJsonPayload(report: AuditReport): JsonOutput {
  return {
    schemaVersion: SCHEMA_VERSION,
    mcpaudit: report.meta.mcpauditVersion,
    grade: report.overall.grade,
    score: report.overall.score,
    summary: {
      critical: report.overall.counts.critical,
      high: report.overall.counts.high,
      medium: report.overall.counts.medium,
      low: report.overall.counts.low,
      total: report.findings.length,
    },
    meta: report.meta,
    tools: report.tools,
    findings: report.findings,
  };
}
