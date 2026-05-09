/**
 * HTML reporter — minimal placeholder (Phase 7 stub).
 *
 * Phase 8 will replace this with a self-contained, shareable scorecard
 * (inline CSS, no CDN, large grade badge, copy-markdown button).
 */

import type { AuditReport } from "../types";

export function renderHtml(report: AuditReport): string {
  const safe = (s: string) =>
    s.replace(/[&<>"']/g, (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]!,
    );

  return [
    "<!doctype html>",
    `<meta charset="utf-8">`,
    `<title>mcpaudit — ${safe(report.meta.source)}</title>`,
    `<h1>${safe(report.meta.source)}</h1>`,
    `<p>Grade: <strong>${report.overall.grade}</strong> (${report.overall.score}/100)</p>`,
    `<p>Findings: ${report.findings.length}</p>`,
    `<pre>${safe(JSON.stringify(report, null, 2))}</pre>`,
  ].join("\n");
}
