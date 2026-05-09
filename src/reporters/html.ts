/**
 * HTML reporter — self-contained single-file scorecard.
 *
 * Goals (per spec):
 *   - No CDN, no external resources — fully inlined CSS and JS.
 *   - Screenshot-friendly large grade badge using A/B/C/D/F colors.
 *   - Tool breakdown table + full findings list with file:line.
 *   - Timestamp + mcpaudit version footer.
 *   - "Copy Badge Markdown" button that yields a shields.io snippet.
 */

import type {
  AuditReport,
  Finding,
  Grade,
  Severity,
  ToolReport,
} from "../types";
import { CHECK_CATALOG } from "../scanner";

const GRADE_COLORS: Record<Grade, string> = {
  A: "#1f8b4c",
  B: "#1f6feb",
  C: "#bf8700",
  D: "#d97706",
  F: "#cf222e",
};

const GRADE_TEXT: Record<Grade, string> = {
  A: "Strong baseline",
  B: "Generally safe — minor issues",
  C: "Caution — review before wiring",
  D: "Risky — multiple high-severity issues",
  F: "Do not deploy without remediation",
};

const SEVERITY_COLORS: Record<Severity, string> = {
  CRITICAL: "#cf222e",
  HIGH: "#b45309",
  MEDIUM: "#bf8700",
  LOW: "#0969da",
};

export function renderHtml(report: AuditReport): string {
  const grade = report.overall.grade;
  const gradeColor = GRADE_COLORS[grade];
  const badgeMarkdown = badgeMarkdownFor(grade);
  const sourceShort = shortenSource(report.meta.source);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mcpaudit — ${esc(sourceShort)} (Grade ${grade})</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #ffffff;
    --fg: #1f2328;
    --muted: #57606a;
    --border: #d0d7de;
    --row: #f6f8fa;
    --code-bg: #f6f8fa;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0d1117;
      --fg: #e6edf3;
      --muted: #8d96a0;
      --border: #30363d;
      --row: #161b22;
      --code-bg: #161b22;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
    line-height: 1.5;
  }
  .container {
    max-width: 960px;
    margin: 0 auto;
    padding: 32px 24px 64px;
  }
  header.hero {
    display: flex;
    align-items: center;
    gap: 24px;
    flex-wrap: wrap;
    margin-bottom: 24px;
  }
  .badge {
    width: 140px;
    height: 140px;
    border-radius: 16px;
    background: ${gradeColor};
    color: #ffffff;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 92px;
    font-weight: 800;
    flex-shrink: 0;
    box-shadow: 0 6px 20px rgba(0,0,0,0.15);
  }
  .hero-meta { flex: 1; min-width: 280px; }
  h1 { margin: 0 0 4px; font-size: 22px; line-height: 1.2; word-break: break-all; }
  .source { font-size: 14px; color: var(--muted); margin-bottom: 8px; }
  .score { font-size: 16px; margin-bottom: 4px; }
  .blurb { font-size: 14px; color: var(--muted); }
  .summary {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    margin: 16px 0 24px;
  }
  .stat {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 14px;
    min-width: 100px;
  }
  .stat-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .stat-value { font-size: 18px; font-weight: 600; margin-top: 2px; }
  h2 { font-size: 16px; margin: 32px 0 12px; }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  th, td {
    text-align: left;
    padding: 8px 10px;
    border-bottom: 1px solid var(--border);
  }
  th { font-weight: 600; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
  tbody tr:nth-child(odd) { background: var(--row); }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .pill {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 999px;
    color: #ffffff;
    font-weight: 700;
    font-size: 12px;
  }
  .severity-tag {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 4px;
    color: #ffffff;
    font-weight: 700;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .finding {
    padding: 12px 14px;
    border: 1px solid var(--border);
    border-left-width: 4px;
    border-radius: 6px;
    margin-bottom: 10px;
    background: var(--row);
  }
  .finding-head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 6px; }
  .finding-id { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-weight: 600; }
  .finding-loc { color: var(--muted); font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px; }
  .finding-tool { color: var(--muted); font-size: 12px; }
  .finding-msg { font-size: 13px; }
  .finding-snippet {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 12px;
    background: var(--code-bg);
    padding: 6px 10px;
    border-radius: 4px;
    margin-top: 8px;
    overflow-x: auto;
    white-space: pre;
  }
  .badge-block {
    margin: 24px 0;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
  }
  .badge-block h2 { margin: 0 0 8px; }
  .badge-row { display: flex; gap: 8px; align-items: center; }
  .badge-row code {
    flex: 1;
    background: var(--code-bg);
    padding: 8px 10px;
    border-radius: 4px;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 12px;
    overflow-x: auto;
  }
  button.copy {
    background: ${gradeColor};
    color: #ffffff;
    border: 0;
    padding: 8px 14px;
    border-radius: 6px;
    font-weight: 600;
    cursor: pointer;
    font-size: 13px;
  }
  button.copy:active { opacity: 0.85; }
  button.copy[data-copied="1"]::after { content: " ✓"; }
  footer {
    margin-top: 48px;
    padding-top: 16px;
    border-top: 1px solid var(--border);
    color: var(--muted);
    font-size: 12px;
    display: flex;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
  }
  .empty {
    padding: 24px;
    border: 1px dashed var(--border);
    border-radius: 8px;
    color: var(--muted);
    text-align: center;
  }
</style>
</head>
<body>
<main class="container">
  <header class="hero">
    <div class="badge" aria-label="Grade ${grade}">${grade}</div>
    <div class="hero-meta">
      <h1>${esc(sourceShort)}</h1>
      <div class="source">${esc(report.meta.source)}</div>
      <div class="score">Score: <strong>${report.overall.score}/100</strong></div>
      <div class="blurb">${esc(GRADE_TEXT[grade])}</div>
    </div>
  </header>

  <section class="summary">
    <div class="stat"><div class="stat-label">Tools</div><div class="stat-value">${report.meta.toolCount}</div></div>
    <div class="stat"><div class="stat-label">Files</div><div class="stat-value">${report.meta.fileCount}</div></div>
    <div class="stat"><div class="stat-label">Findings</div><div class="stat-value">${report.findings.length}</div></div>
    <div class="stat"><div class="stat-label">Critical</div><div class="stat-value" style="color:${SEVERITY_COLORS.CRITICAL}">${report.overall.counts.critical}</div></div>
    <div class="stat"><div class="stat-label">High</div><div class="stat-value" style="color:${SEVERITY_COLORS.HIGH}">${report.overall.counts.high}</div></div>
    <div class="stat"><div class="stat-label">Medium</div><div class="stat-value" style="color:${SEVERITY_COLORS.MEDIUM}">${report.overall.counts.medium}</div></div>
    <div class="stat"><div class="stat-label">Low</div><div class="stat-value" style="color:${SEVERITY_COLORS.LOW}">${report.overall.counts.low}</div></div>
  </section>

  <section>
    <h2>Tool breakdown</h2>
    ${renderToolTable(report.tools)}
  </section>

  <section>
    <h2>Findings</h2>
    ${renderFindingsList(report.findings)}
  </section>

  <section class="badge-block">
    <h2>Embed badge</h2>
    <div class="badge-row">
      <code id="badge-md">${esc(badgeMarkdown)}</code>
      <button class="copy" id="copy-btn" type="button">Copy</button>
    </div>
  </section>

  <footer>
    <span>mcpaudit v${esc(report.meta.mcpauditVersion)}</span>
    <span>Scanned ${esc(report.meta.scannedAt)}</span>
  </footer>
</main>
<script>
  (function () {
    var btn = document.getElementById('copy-btn');
    var code = document.getElementById('badge-md');
    if (!btn || !code) return;
    btn.addEventListener('click', function () {
      var text = code.textContent || '';
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { mark(); });
      } else {
        var range = document.createRange();
        range.selectNodeContents(code);
        var sel = window.getSelection();
        if (sel) { sel.removeAllRanges(); sel.addRange(range); }
        try { document.execCommand('copy'); mark(); } catch (e) {}
      }
    });
    function mark() {
      btn.dataset.copied = '1';
      btn.textContent = 'Copied';
      setTimeout(function () {
        btn.dataset.copied = '';
        btn.textContent = 'Copy';
      }, 1500);
    }
  })();
</script>
</body>
</html>`;
}

function renderToolTable(tools: ToolReport[]): string {
  if (tools.length === 0) {
    return `<div class="empty">No tools detected.</div>`;
  }
  const rows = tools
    .map((t) => {
      const color = GRADE_COLORS[t.grade];
      return `<tr>
        <td>${esc(t.name)}</td>
        <td><span class="pill" style="background:${color}">${t.grade}</span></td>
        <td class="num">${t.score}</td>
        <td class="num" style="color:${SEVERITY_COLORS.CRITICAL}">${t.counts.critical || ""}</td>
        <td class="num" style="color:${SEVERITY_COLORS.HIGH}">${t.counts.high || ""}</td>
        <td class="num" style="color:${SEVERITY_COLORS.MEDIUM}">${t.counts.medium || ""}</td>
        <td class="num" style="color:${SEVERITY_COLORS.LOW}">${t.counts.low || ""}</td>
      </tr>`;
    })
    .join("\n");
  return `<table>
    <thead><tr><th>Tool</th><th>Grade</th><th>Score</th><th>Crit</th><th>High</th><th>Med</th><th>Low</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderFindingsList(findings: Finding[]): string {
  if (findings.length === 0) {
    return `<div class="empty">No findings — clean scan.</div>`;
  }
  const order: Record<Severity, number> = {
    CRITICAL: 0,
    HIGH: 1,
    MEDIUM: 2,
    LOW: 3,
  };
  const sorted = [...findings].sort((a, b) => {
    if (order[a.severity] !== order[b.severity]) return order[a.severity] - order[b.severity];
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    return a.line - b.line;
  });
  return sorted
    .map((f) => {
      const color = SEVERITY_COLORS[f.severity];
      const title = CHECK_CATALOG[f.checkId]?.title ?? f.checkId;
      const tool = f.toolName ? `<span class="finding-tool">tool: ${esc(f.toolName)}</span>` : "";
      const snippet = f.snippet
        ? `<div class="finding-snippet">${esc(f.snippet)}</div>`
        : "";
      return `<div class="finding" style="border-left-color:${color}">
        <div class="finding-head">
          <span class="severity-tag" style="background:${color}">${f.severity}</span>
          <span class="finding-id">${f.checkId}</span>
          <span>·</span>
          <span>${esc(title)}</span>
          <span class="finding-loc">${esc(f.file)}:${f.line}</span>
          ${tool}
        </div>
        <div class="finding-msg">${esc(f.message)}</div>
        ${snippet}
      </div>`;
    })
    .join("\n");
}

function badgeMarkdownFor(grade: Grade): string {
  const color = (
    {
      A: "brightgreen",
      B: "blue",
      C: "yellow",
      D: "orange",
      F: "red",
    } as Record<Grade, string>
  )[grade];
  return `![mcpaudit grade: ${grade}](https://img.shields.io/badge/mcpaudit-${grade}-${color})`;
}

function shortenSource(source: string): string {
  // Strip common URL prefixes for display.
  return source
    .replace(/^https?:\/\/(www\.)?github\.com\//, "")
    .replace(/\.git$/, "");
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[c]!,
  );
}
