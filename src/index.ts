/**
 * mcpaudit CLI entrypoint.
 *
 * Pipeline: resolveSource → parseProject → scanProject → buildReport → reporter
 *
 * Exit codes:
 *   0   — scan completed; report emitted (regardless of grade unless --fail-on used)
 *   1   — scan completed but grade triggered the configured --fail-on threshold,
 *         OR a fatal error occurred (bad input, no MCP server detected, etc.)
 *   130 — interrupted (Ctrl-C)
 */

import * as fs from "fs";
import * as path from "path";
import { Command } from "commander";
import ora from "ora";
import chalk from "chalk";
import { version as MCPAUDIT_VERSION } from "../package.json";
import { resolveSource } from "./resolver";
import { parseProject } from "./parser";
import { scanProject } from "./scanner";
import { buildReport } from "./grader";
import { renderTui } from "./reporters/tui";
import { renderJson } from "./reporters/json";
import { renderHtml } from "./reporters/html";
import type { AuditReport, CliOptions, Grade } from "./types";

interface ProgramOptions extends CliOptions {
  failOn?: string;
}

const FAIL_ON_THRESHOLDS: Record<string, Grade[]> = {
  never: [],
  f: ["F"],
  d: ["F", "D"],
  c: ["F", "D", "C"],
  b: ["F", "D", "C", "B"],
  any: ["F", "D", "C", "B", "A"],
};

async function main(): Promise<void> {
  const program = new Command();

  program
    .name("mcpaudit")
    .description(
      "Static security scorecard for MCP (Model Context Protocol) servers",
    )
    .version(MCPAUDIT_VERSION, "-v, --version")
    .argument("<source>", "GitHub URL (https://github.com/owner/repo) or local path")
    .option("--json", "Output machine-readable JSON instead of TUI")
    .option("--html", "Output a self-contained HTML scorecard")
    .option("--out <file>", "Write the report to <file> instead of stdout")
    .option("--quiet", "Suppress progress output")
    .option(
      "--fail-on <grade>",
      "Exit 1 if grade is at or below this threshold (never|f|d|c|b|any)",
      "f",
    )
    .action(async (source: string, opts: ProgramOptions) => {
      const exitCode = await runAudit(source, opts);
      process.exit(exitCode);
    });

  await program.parseAsync(process.argv);
}

async function runAudit(source: string, opts: ProgramOptions): Promise<number> {
  const useSpinner = !opts.quiet && !opts.json && process.stderr.isTTY;
  const spinner = useSpinner
    ? ora({ stream: process.stderr, text: "Resolving source..." }).start()
    : null;

  try {
    const resolved = await resolveSource(source);
    if (spinner) spinner.text = "Parsing MCP server...";

    const parsed = parseProject(resolved.path);

    if (parsed.tools.length === 0 && !hasMcpDependency(resolved.path)) {
      if (spinner) spinner.fail("No MCP server detected");
      else process.stderr.write("error: No MCP server detected in source.\n");
      await resolved.cleanup();
      process.stderr.write(
        chalk.dim(
          "Hint: mcpaudit looks for `.tool(...)` registrations or @modelcontextprotocol/sdk imports.\n",
        ),
      );
      return 1;
    }

    if (spinner) spinner.text = `Scanning ${parsed.files.length} files...`;
    const findings = scanProject(parsed);

    if (spinner) spinner.text = "Grading...";
    const report = buildReport({
      parsed,
      findings,
      source: resolved.source,
      sourceType: resolved.sourceType,
      mcpauditVersion: MCPAUDIT_VERSION,
    });

    if (spinner) spinner.succeed("Audit complete");

    await emitReport(report, opts);
    await resolved.cleanup();

    return shouldFail(report.overall.grade, opts.failOn) ? 1 : 0;
  } catch (err) {
    if (spinner) spinner.fail("Audit failed");
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${message}\n`);
    return 1;
  }
}

async function emitReport(
  report: AuditReport,
  opts: ProgramOptions,
): Promise<void> {
  let output: string;
  let defaultExt: string;

  if (opts.json) {
    output = renderJson(report);
    defaultExt = ".json";
  } else if (opts.html) {
    output = renderHtml(report);
    defaultExt = ".html";
  } else {
    output = renderTui(report);
    defaultExt = ".txt";
  }

  if (opts.out) {
    const outPath = path.resolve(opts.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, output, "utf8");
    if (!opts.quiet) {
      process.stderr.write(
        chalk.dim(`Report written to ${outPath}\n`),
      );
    }
  } else if (opts.html && process.stdout.isTTY) {
    // Avoid dumping a wall of HTML into an interactive terminal: write to a
    // sensibly named file in the current directory instead.
    const filename = `mcpaudit-${slugify(report.meta.source)}${defaultExt}`;
    const outPath = path.resolve(filename);
    fs.writeFileSync(outPath, output, "utf8");
    process.stderr.write(chalk.dim(`HTML report written to ${outPath}\n`));
  } else {
    process.stdout.write(output);
    if (!output.endsWith("\n")) process.stdout.write("\n");
  }
}

function shouldFail(grade: Grade, failOn?: string): boolean {
  const key = (failOn ?? "f").toLowerCase();
  const triggers = FAIL_ON_THRESHOLDS[key] ?? FAIL_ON_THRESHOLDS.f;
  return triggers.includes(grade);
}

function hasMcpDependency(rootDir: string): boolean {
  const pkgPath = path.join(rootDir, "package.json");
  if (!fs.existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    return Object.keys(deps).some((d) => d.startsWith("@modelcontextprotocol/"));
  } catch {
    return false;
  }
}

function slugify(input: string): string {
  return input
    .replace(/^https?:\/\//, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "report";
}

main().catch((err) => {
  process.stderr.write(
    `unexpected error: ${err instanceof Error ? err.stack : String(err)}\n`,
  );
  process.exit(1);
});
