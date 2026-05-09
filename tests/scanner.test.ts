import { describe, it, expect } from "vitest";
import * as path from "path";
import { parseProject } from "../src/parser";
import { scanProject, CHECK_CATALOG } from "../src/scanner";
import { buildReport, gradeFindings, scoreToGrade } from "../src/grader";
import { parseGithubUrl } from "../src/resolver";
import { renderJson, SCHEMA_VERSION } from "../src/reporters/json";
import type { CheckId } from "../src/types";

const FIXTURES = path.join(__dirname, "fixtures");

function audit(fixtureDir: string) {
  const root = path.join(FIXTURES, fixtureDir);
  const parsed = parseProject(root);
  const findings = scanProject(parsed);
  const report = buildReport({
    parsed,
    findings,
    source: root,
    sourceType: "local",
    mcpauditVersion: "test",
  });
  return { parsed, findings, report };
}

function findingChecks(findings: ReturnType<typeof scanProject>): Set<CheckId> {
  return new Set(findings.map((f) => f.checkId));
}

describe("clean fixture", () => {
  it("detects all registered tools", () => {
    const { parsed } = audit("clean-server");
    const names = parsed.tools.map((t) => t.name).sort();
    expect(names).toEqual(["echo", "fixed_path_lookup"]);
  });

  it("captures schemas (no MISSING_INPUT_VALIDATION)", () => {
    const { findings } = audit("clean-server");
    const checks = findingChecks(findings);
    expect(checks.has("MISSING_INPUT_VALIDATION")).toBe(false);
  });

  it("scores in the A range with no critical/high findings", () => {
    const { report } = audit("clean-server");
    expect(report.overall.counts.critical).toBe(0);
    expect(report.overall.counts.high).toBe(0);
    expect(["A", "B"]).toContain(report.overall.grade);
  });
});

describe("risky fixture", () => {
  it("detects all four tools", () => {
    const { parsed } = audit("risky-server");
    const names = parsed.tools.map((t) => t.name).sort();
    expect(names).toEqual(["delete_path", "eval_expr", "read_file", "run_shell"]);
  });

  it("flags every expected risky pattern", () => {
    const { findings } = audit("risky-server");
    const checks = findingChecks(findings);
    const expected: CheckId[] = [
      "SHELL_EXEC",
      "EVAL_USE",
      "UNSCOPED_FETCH",
      "BROAD_FS_READ",
      "BROAD_FS_WRITE",
      "ENV_EXFIL",
      "MISSING_INPUT_VALIDATION",
      "OVERLY_BROAD_TOOLS",
    ];
    for (const id of expected) {
      expect(checks, `missing ${id}`).toContain(id);
    }
  });

  it("yields an F grade", () => {
    const { report } = audit("risky-server");
    expect(report.overall.grade).toBe("F");
    expect(report.overall.score).toBeLessThan(45);
  });

  it("attributes per-tool findings via handler range", () => {
    const { report } = audit("risky-server");
    const runShell = report.tools.find((t) => t.name === "run_shell");
    expect(runShell).toBeDefined();
    expect(runShell!.findings.some((f) => f.checkId === "SHELL_EXEC")).toBe(true);

    const evalTool = report.tools.find((t) => t.name === "eval_expr");
    expect(evalTool!.findings.some((f) => f.checkId === "EVAL_USE")).toBe(true);

    const readFile = report.tools.find((t) => t.name === "read_file");
    expect(readFile!.findings.some((f) => f.checkId === "BROAD_FS_READ")).toBe(
      true,
    );
  });
});

describe("grader", () => {
  it("starts at 100 with no findings", () => {
    expect(gradeFindings([]).score).toBe(100);
    expect(gradeFindings([]).grade).toBe("A");
  });

  it("caps each severity bucket per spec", () => {
    const findings = Array.from({ length: 10 }, (_, i) => ({
      checkId: "SHELL_EXEC" as CheckId,
      severity: "CRITICAL" as const,
      file: "x.ts",
      line: i + 1,
      message: "x",
    }));
    // 10 CRITICAL → -30 each capped at -60 → score 40 → F
    const card = gradeFindings(findings);
    expect(card.score).toBe(40);
    expect(card.grade).toBe("F");
  });

  it("maps score boundaries correctly", () => {
    expect(scoreToGrade(100)).toBe("A");
    expect(scoreToGrade(90)).toBe("A");
    expect(scoreToGrade(89)).toBe("B");
    expect(scoreToGrade(75)).toBe("B");
    expect(scoreToGrade(74)).toBe("C");
    expect(scoreToGrade(60)).toBe("C");
    expect(scoreToGrade(59)).toBe("D");
    expect(scoreToGrade(45)).toBe("D");
    expect(scoreToGrade(44)).toBe("F");
    expect(scoreToGrade(0)).toBe("F");
  });
});

describe("resolver — parseGithubUrl", () => {
  it("parses https URLs", () => {
    expect(parseGithubUrl("https://github.com/owner/repo")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  it("strips .git suffix", () => {
    expect(parseGithubUrl("https://github.com/owner/repo.git")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  it("captures branch from /tree/<branch>", () => {
    expect(
      parseGithubUrl("https://github.com/owner/repo/tree/main"),
    ).toMatchObject({ owner: "owner", repo: "repo", branch: "main" });
  });

  it("captures subdir after /tree/<branch>/", () => {
    expect(
      parseGithubUrl("https://github.com/owner/repo/tree/main/packages/foo"),
    ).toMatchObject({
      owner: "owner",
      repo: "repo",
      branch: "main",
      subdir: "packages/foo",
    });
  });

  it("accepts owner/repo shorthand", () => {
    expect(parseGithubUrl("owner/repo")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  it("rejects local paths", () => {
    expect(parseGithubUrl("./local/path")).toBeNull();
    expect(parseGithubUrl("/abs/path")).toBeNull();
  });
});

describe("CHECK_CATALOG", () => {
  it("describes every CheckId emitted by the scanner", () => {
    const { findings } = audit("risky-server");
    for (const f of findings) {
      expect(CHECK_CATALOG[f.checkId], `catalog missing ${f.checkId}`).toBeDefined();
    }
  });
});

describe("JSON reporter", () => {
  it("emits the stable flat schema with grade/score at top level", () => {
    const { report } = audit("risky-server");
    const parsed = JSON.parse(renderJson(report));
    expect(parsed.schemaVersion).toBe(SCHEMA_VERSION);
    expect(parsed.grade).toBe("F");
    expect(typeof parsed.score).toBe("number");
    expect(parsed.summary).toMatchObject({
      critical: expect.any(Number),
      high: expect.any(Number),
      medium: expect.any(Number),
      low: expect.any(Number),
      total: expect.any(Number),
    });
    expect(Array.isArray(parsed.tools)).toBe(true);
    expect(Array.isArray(parsed.findings)).toBe(true);
  });
});
