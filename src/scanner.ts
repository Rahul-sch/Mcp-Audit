/**
 * Risk-pattern scanner.
 *
 * Implements the 12 detection rules described in the README's "Findings
 * reference" table. Detection is purely static — no code from the target
 * server is ever executed.
 *
 * Two complementary techniques are used:
 *   - AST traversal (primary) via @typescript-eslint/typescript-estree, which
 *     gives accurate call-site line numbers and lets us inspect arguments to
 *     decide whether a sink is reachable from a dynamic input.
 *   - Regex fallback (secondary) for patterns that are tedious to express in
 *     AST form — most importantly HARDCODED_SECRET, where the value of
 *     interest is a string literal anywhere in the source.
 *
 * False-positive reduction:
 *   - SHELL_EXEC and EVAL_USE downgrade from CRITICAL to HIGH when every
 *     argument we can see is a string literal (no template, no identifier,
 *     no concatenation that could carry user input).
 *   - HARDCODED_SECRET ignores values inside obvious test/fixture files and
 *     ignores common false positives like `process.env.X`.
 */

import { parse, TSESTree } from "@typescript-eslint/typescript-estree";
import type {
  CheckId,
  Finding,
  McpTool,
  ParseResult,
  Severity,
  SourceFile,
} from "./types";

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function scanProject(parsed: ParseResult): Finding[] {
  const findings: Finding[] = [];
  for (const file of parsed.files) {
    findings.push(...scanFile(file));
  }
  findings.push(...scanTools(parsed.tools));
  return dedupeFindings(findings);
}

// ---------------------------------------------------------------------------
// Per-file AST + regex scanning
// ---------------------------------------------------------------------------

function scanFile(file: SourceFile): Finding[] {
  const findings: Finding[] = [];

  let ast: TSESTree.Program | null = null;
  try {
    ast = parse(file.contents, {
      loc: true,
      range: true,
      jsx: file.path.endsWith(".tsx") || file.path.endsWith(".jsx"),
      errorOnUnknownASTType: false,
      comment: false,
    });
  } catch {
    ast = null;
  }

  if (ast) {
    findings.push(...scanShellExec(ast, file));
    findings.push(...scanEvalUse(ast, file));
    findings.push(...scanFetchAndNetwork(ast, file));
    findings.push(...scanFsReads(ast, file));
    findings.push(...scanFsWrites(ast, file));
    findings.push(...scanEnvExfil(ast, file));
    findings.push(...scanPrototypePollution(ast, file));
    findings.push(...scanPathTraversal(ast, file));
  }

  // Regex-based checks (run regardless of AST success)
  findings.push(...scanHardcodedSecrets(file));

  return findings;
}

// ---------------------------------------------------------------------------
// Per-tool scanning
// ---------------------------------------------------------------------------

const BROAD_DESCRIPTION_KEYWORDS = [
  "anything",
  "all files",
  "entire",
  "any file",
  "any url",
  "arbitrary",
];

function scanTools(tools: McpTool[]): Finding[] {
  const findings: Finding[] = [];
  for (const tool of tools) {
    if (tool.name === "<call_tool_dispatch>") continue;

    if (!tool.hasInputSchema) {
      findings.push({
        checkId: "MISSING_INPUT_VALIDATION",
        severity: "LOW",
        file: tool.registrationFile,
        line: tool.registrationLine,
        message: `Tool "${tool.name}" is registered without an input schema`,
        toolName: tool.name,
      });
    }

    if (tool.description) {
      const lowered = tool.description.toLowerCase();
      const hit = BROAD_DESCRIPTION_KEYWORDS.find((kw) => lowered.includes(kw));
      if (hit) {
        findings.push({
          checkId: "OVERLY_BROAD_TOOLS",
          severity: "LOW",
          file: tool.registrationFile,
          line: tool.registrationLine,
          message: `Tool "${tool.name}" description contains "${hit}", suggesting an overly broad surface`,
          snippet: tool.description,
          toolName: tool.name,
        });
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

const SHELL_EXEC_CALLEES = new Set([
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "spawn",
  "spawnSync",
]);

function scanShellExec(ast: TSESTree.Program, file: SourceFile): Finding[] {
  const findings: Finding[] = [];
  const importedShell = importsAnyOf(ast, ["child_process", "node:child_process"]);

  visit(ast, (node) => {
    if (node.type !== "CallExpression") return;
    const calleeName = simpleCalleeName(node.callee);
    if (!calleeName || !SHELL_EXEC_CALLEES.has(calleeName)) return;

    // Reduce false positives: only flag if child_process is imported anywhere
    // in this file, or if the callee is a clear member expression like
    // `cp.exec(...)`. This filters out unrelated `exec` methods on other libs.
    const isMember = node.callee.type === "MemberExpression";
    if (!importedShell && !isMember) return;

    const dynamic = hasDynamicArg(node.arguments);
    findings.push({
      checkId: "SHELL_EXEC",
      severity: dynamic ? "CRITICAL" : "HIGH",
      file: file.path,
      line: node.loc.start.line,
      column: node.loc.start.column,
      message: dynamic
        ? `child_process.${calleeName}() called with dynamic input`
        : `child_process.${calleeName}() called (downgraded: only literal args observed)`,
      snippet: snippetFor(file, node),
    });
  });

  return findings;
}

function scanEvalUse(ast: TSESTree.Program, file: SourceFile): Finding[] {
  const findings: Finding[] = [];

  visit(ast, (node) => {
    // eval(...)
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === "eval"
    ) {
      const dynamic = hasDynamicArg(node.arguments);
      findings.push({
        checkId: "EVAL_USE",
        severity: dynamic ? "CRITICAL" : "HIGH",
        file: file.path,
        line: node.loc.start.line,
        message: dynamic
          ? "eval() called with dynamic input"
          : "eval() called (downgraded: only literal args observed)",
        snippet: snippetFor(file, node),
      });
      return;
    }

    // new Function(...)
    if (
      node.type === "NewExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === "Function"
    ) {
      const dynamic = hasDynamicArg(node.arguments);
      findings.push({
        checkId: "EVAL_USE",
        severity: dynamic ? "CRITICAL" : "HIGH",
        file: file.path,
        line: node.loc.start.line,
        message: dynamic
          ? "new Function() called with dynamic input"
          : "new Function() called (downgraded: only literal args observed)",
        snippet: snippetFor(file, node),
      });
      return;
    }

    // vm.runIn*(...)
    if (node.type === "CallExpression") {
      const calleeName = simpleCalleeName(node.callee);
      if (calleeName && /^runIn/.test(calleeName)) {
        findings.push({
          checkId: "EVAL_USE",
          severity: "CRITICAL",
          file: file.path,
          line: node.loc.start.line,
          message: `vm.${calleeName}() executes arbitrary code`,
          snippet: snippetFor(file, node),
        });
      }
    }
  });

  return findings;
}

function scanFetchAndNetwork(
  ast: TSESTree.Program,
  file: SourceFile,
): Finding[] {
  const findings: Finding[] = [];
  const httpImported = importsAnyOf(ast, [
    "http",
    "https",
    "node:http",
    "node:https",
    "axios",
    "node-fetch",
    "got",
  ]);

  visit(ast, (node) => {
    if (node.type !== "CallExpression") return;
    const calleeName = simpleCalleeName(node.callee);
    if (!calleeName) return;

    const isFetchLike =
      calleeName === "fetch" ||
      calleeName === "request" ||
      calleeName === "get" ||
      calleeName === "post" ||
      calleeName === "put" ||
      calleeName === "delete";
    if (!isFetchLike) return;

    // For non-fetch HTTP method calls (`get`, `post`, etc.), we only care if
    // an http-ish module is imported — otherwise we'd flag any `arr.get()`.
    if (calleeName !== "fetch" && !httpImported) return;
    if (calleeName !== "fetch" && node.callee.type !== "MemberExpression") {
      return;
    }

    const urlArg = node.arguments[0];
    if (!urlArg) return;

    const urlInfo = inspectUrlArg(urlArg);

    if (urlInfo.dynamic) {
      findings.push({
        checkId: "UNSCOPED_FETCH",
        severity: "HIGH",
        file: file.path,
        line: node.loc.start.line,
        message: `${calleeName}() URL is dynamic — verify it cannot be steered to attacker-controlled hosts`,
        snippet: snippetFor(file, node),
      });
      return;
    }

    if (urlInfo.literal && !isLocalhostUrl(urlInfo.literal)) {
      findings.push({
        checkId: "NETWORK_EGRESS",
        severity: "MEDIUM",
        file: file.path,
        line: node.loc.start.line,
        message: `${calleeName}() makes outbound request to ${urlInfo.literal}`,
        snippet: snippetFor(file, node),
      });
    }
  });

  return findings;
}

const FS_READ_METHODS = new Set([
  "readFile",
  "readFileSync",
  "createReadStream",
  "readdir",
  "readdirSync",
]);

function scanFsReads(ast: TSESTree.Program, file: SourceFile): Finding[] {
  const findings: Finding[] = [];
  visit(ast, (node) => {
    if (node.type !== "CallExpression") return;
    const calleeName = simpleCalleeName(node.callee);
    if (!calleeName || !FS_READ_METHODS.has(calleeName)) return;
    if (node.callee.type !== "MemberExpression") return;

    const pathArg = node.arguments[0];
    if (!pathArg) return;

    const dynamic = !isLiteralStringNode(pathArg) && !isHarmlessPath(pathArg);
    const looksLikeGlob =
      isLiteralStringNode(pathArg) &&
      typeof (pathArg as TSESTree.Literal).value === "string" &&
      /[*?]/.test((pathArg as TSESTree.Literal).value as string);

    if (dynamic || looksLikeGlob) {
      findings.push({
        checkId: "BROAD_FS_READ",
        severity: "HIGH",
        file: file.path,
        line: node.loc.start.line,
        message: `fs.${calleeName}() called with ${looksLikeGlob ? "glob pattern" : "dynamic path"} — verify input is constrained`,
        snippet: snippetFor(file, node),
      });
    }
  });
  return findings;
}

const FS_WRITE_METHODS = new Set([
  "writeFile",
  "writeFileSync",
  "appendFile",
  "appendFileSync",
  "unlink",
  "unlinkSync",
  "rm",
  "rmSync",
  "rmdir",
  "rmdirSync",
  "createWriteStream",
]);

function scanFsWrites(ast: TSESTree.Program, file: SourceFile): Finding[] {
  const findings: Finding[] = [];
  visit(ast, (node) => {
    if (node.type !== "CallExpression") return;
    const calleeName = simpleCalleeName(node.callee);
    if (!calleeName || !FS_WRITE_METHODS.has(calleeName)) return;
    if (node.callee.type !== "MemberExpression") return;

    findings.push({
      checkId: "BROAD_FS_WRITE",
      severity: "HIGH",
      file: file.path,
      line: node.loc.start.line,
      message: `fs.${calleeName}() can mutate the filesystem — verify the path is bounded`,
      snippet: snippetFor(file, node),
    });
  });
  return findings;
}

function scanEnvExfil(ast: TSESTree.Program, file: SourceFile): Finding[] {
  const findings: Finding[] = [];

  // Walk every function/arrow body. If a function reads process.env.X *and*
  // makes a network call, flag it.
  const functionLikes: TSESTree.Node[] = [];
  visit(ast, (node) => {
    if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression"
    ) {
      functionLikes.push(node);
    }
  });

  for (const fn of functionLikes) {
    let usesEnv = false;
    let networkCall: TSESTree.CallExpression | null = null;

    visit(fn, (node) => {
      if (
        node.type === "MemberExpression" &&
        !node.computed &&
        node.property.type === "Identifier" &&
        node.object.type === "MemberExpression" &&
        !node.object.computed &&
        node.object.property.type === "Identifier" &&
        node.object.property.name === "env" &&
        node.object.object.type === "Identifier" &&
        node.object.object.name === "process"
      ) {
        usesEnv = true;
      }
      if (node.type === "CallExpression" && !networkCall) {
        const name = simpleCalleeName(node.callee);
        if (
          name === "fetch" ||
          name === "request" ||
          name === "post" ||
          name === "put" ||
          name === "send"
        ) {
          networkCall = node;
        }
      }
    });

    if (usesEnv && networkCall) {
      findings.push({
        checkId: "ENV_EXFIL",
        severity: "HIGH",
        file: file.path,
        line: networkCall.loc.start.line,
        message:
          "Function reads from process.env and makes a network call — verify env values are not exfiltrated",
        snippet: snippetFor(file, networkCall),
      });
    }
  }

  return findings;
}

function scanPrototypePollution(
  ast: TSESTree.Program,
  file: SourceFile,
): Finding[] {
  const findings: Finding[] = [];
  visit(ast, (node) => {
    if (node.type !== "AssignmentExpression") return;
    const left = node.left;
    if (left.type !== "MemberExpression") return;

    // x.__proto__ = ...
    if (
      !left.computed &&
      left.property.type === "Identifier" &&
      left.property.name === "__proto__"
    ) {
      findings.push({
        checkId: "PROTOTYPE_POLLUTION",
        severity: "MEDIUM",
        file: file.path,
        line: node.loc.start.line,
        message: "Direct __proto__ assignment can pollute prototypes",
        snippet: snippetFor(file, node),
      });
      return;
    }

    // x.constructor.prototype = ...  /  x.constructor.prototype.foo = ...
    let cursor: TSESTree.MemberExpression | TSESTree.Node = left;
    while (cursor.type === "MemberExpression") {
      if (
        !cursor.computed &&
        cursor.property.type === "Identifier" &&
        cursor.property.name === "prototype" &&
        cursor.object.type === "MemberExpression" &&
        !cursor.object.computed &&
        cursor.object.property.type === "Identifier" &&
        cursor.object.property.name === "constructor"
      ) {
        findings.push({
          checkId: "PROTOTYPE_POLLUTION",
          severity: "MEDIUM",
          file: file.path,
          line: node.loc.start.line,
          message: "Assigning to constructor.prototype can pollute prototypes",
          snippet: snippetFor(file, node),
        });
        return;
      }
      cursor = cursor.object;
    }
  });
  return findings;
}

function scanPathTraversal(
  ast: TSESTree.Program,
  file: SourceFile,
): Finding[] {
  const findings: Finding[] = [];
  visit(ast, (node) => {
    // Template literal / string concat carrying ".." into a path.join / fs sink.
    if (node.type !== "CallExpression") return;
    const calleeName = simpleCalleeName(node.callee);
    if (calleeName !== "join" && calleeName !== "resolve") return;
    if (node.callee.type !== "MemberExpression") return;
    const obj = simpleCalleeName(node.callee.object);
    if (obj !== "path") return;

    const usesDynamic = node.arguments.some((arg) => !isLiteralStringNode(arg));
    if (!usesDynamic) return;

    findings.push({
      checkId: "PATH_TRAVERSAL",
      severity: "MEDIUM",
      file: file.path,
      line: node.loc.start.line,
      message: `path.${calleeName}() called with dynamic segment — verify input is sanitized against ../`,
      snippet: snippetFor(file, node),
    });
  });
  return findings;
}

// ---------------------------------------------------------------------------
// Hardcoded secret detection (regex)
// ---------------------------------------------------------------------------

interface SecretPattern {
  name: string;
  regex: RegExp;
}

const SECRET_PATTERNS: SecretPattern[] = [
  { name: "AWS access key", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "GitHub token", regex: /\bghp_[A-Za-z0-9]{36,}\b/g },
  { name: "GitHub fine-grained token", regex: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g },
  { name: "OpenAI API key", regex: /\bsk-[A-Za-z0-9_\-]{32,}\b/g },
  { name: "Anthropic API key", regex: /\bsk-ant-[A-Za-z0-9_\-]{20,}\b/g },
  { name: "Slack token", regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "JWT", regex: /\beyJ[A-Za-z0-9_\-]+\.eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b/g },
  {
    name: "Generic API key assignment",
    regex:
      /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*["'`][A-Za-z0-9_\-]{16,}["'`]/gi,
  },
];

function scanHardcodedSecrets(file: SourceFile): Finding[] {
  if (looksLikeFixtureOrTestFile(file.path)) return [];

  const findings: Finding[] = [];
  for (const pattern of SECRET_PATTERNS) {
    pattern.regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.regex.exec(file.contents)) !== null) {
      const before = file.contents.slice(0, match.index);
      const line = before.split("\n").length;
      const lineStart = before.lastIndexOf("\n") + 1;
      const column = match.index - lineStart;

      // Skip placeholders that obviously aren't real secrets.
      const matched = match[0];
      if (
        /xxx+|placeholder|example|your[-_]?key|fake/i.test(matched) ||
        /process\.env/.test(file.contents.slice(Math.max(0, match.index - 20), match.index))
      ) {
        continue;
      }

      findings.push({
        checkId: "HARDCODED_SECRET",
        severity: "HIGH",
        file: file.path,
        line,
        column,
        message: `Possible hardcoded secret (${pattern.name})`,
        snippet: redact(matched),
      });
    }
  }
  return findings;
}

function looksLikeFixtureOrTestFile(filePath: string): boolean {
  return (
    /(^|\/)tests?(\/|$)/.test(filePath) ||
    /(^|\/)__tests__(\/|$)/.test(filePath) ||
    /(^|\/)fixtures?(\/|$)/.test(filePath) ||
    /\.test\.[tj]sx?$/.test(filePath) ||
    /\.spec\.[tj]sx?$/.test(filePath)
  );
}

function redact(value: string): string {
  if (value.length <= 8) return "***";
  return value.slice(0, 4) + "…" + value.slice(-2);
}

// ---------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------

function importsAnyOf(ast: TSESTree.Program, modules: string[]): boolean {
  const wanted = new Set(modules);
  for (const node of ast.body) {
    if (
      node.type === "ImportDeclaration" &&
      typeof node.source.value === "string" &&
      wanted.has(node.source.value)
    ) {
      return true;
    }
    if (
      node.type === "VariableDeclaration"
    ) {
      for (const decl of node.declarations) {
        if (
          decl.init &&
          decl.init.type === "CallExpression" &&
          decl.init.callee.type === "Identifier" &&
          decl.init.callee.name === "require" &&
          decl.init.arguments[0] &&
          decl.init.arguments[0].type === "Literal" &&
          typeof decl.init.arguments[0].value === "string" &&
          wanted.has(decl.init.arguments[0].value as string)
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

function simpleCalleeName(callee: TSESTree.Node): string | null {
  if (callee.type === "Identifier") return callee.name;
  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier"
  ) {
    return callee.property.name;
  }
  return null;
}

function isLiteralStringNode(node: TSESTree.Node): boolean {
  return (
    node.type === "Literal" &&
    typeof (node as TSESTree.Literal).value === "string"
  );
}

function isHarmlessPath(node: TSESTree.Node): boolean {
  // path.join(__dirname, "thing") — first arg is __dirname, treat as bounded.
  if (
    node.type === "CallExpression" &&
    simpleCalleeName(node.callee) === "join" &&
    node.arguments.length > 0 &&
    node.arguments[0].type === "Identifier" &&
    (node.arguments[0].name === "__dirname" ||
      node.arguments[0].name === "__filename")
  ) {
    return true;
  }
  return false;
}

function hasDynamicArg(args: readonly TSESTree.CallExpressionArgument[]): boolean {
  for (const arg of args) {
    if (arg.type === "SpreadElement") return true;
    if (arg.type === "Literal") continue;
    if (
      arg.type === "TemplateLiteral" &&
      arg.expressions.length === 0
    ) {
      continue; // template with no interpolations is effectively a literal
    }
    return true;
  }
  return false;
}

interface UrlInfo {
  literal?: string;
  dynamic: boolean;
}

function inspectUrlArg(node: TSESTree.Node): UrlInfo {
  if (
    node.type === "Literal" &&
    typeof (node as TSESTree.Literal).value === "string"
  ) {
    return { literal: (node as TSESTree.Literal).value as string, dynamic: false };
  }
  if (node.type === "TemplateLiteral") {
    if (node.expressions.length === 0) {
      return { literal: node.quasis.map((q) => q.value.cooked).join(""), dynamic: false };
    }
    return { dynamic: true };
  }
  return { dynamic: true };
}

function isLocalhostUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.hostname === "localhost" ||
      u.hostname === "127.0.0.1" ||
      u.hostname === "::1" ||
      u.hostname.endsWith(".local")
    );
  } catch {
    // relative URLs or non-URLs — treat as local-ish to avoid noise
    return true;
  }
}

function snippetFor(file: SourceFile, node: TSESTree.Node): string {
  const start = node.loc.start.line;
  const end = node.loc.end.line;
  const lines = file.contents.split("\n");
  if (end - start > 3) {
    return lines[start - 1]?.trim() ?? "";
  }
  return lines
    .slice(start - 1, end)
    .map((l) => l.trim())
    .join(" ⏎ ");
}

function visit(node: TSESTree.Node, visitor: (n: TSESTree.Node) => void): void {
  visitor(node);
  for (const key of Object.keys(node) as (keyof typeof node)[]) {
    if (key === "parent" || key === "loc" || key === "range") continue;
    const value = node[key] as unknown;
    if (!value) continue;
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === "object" && "type" in child) {
          visit(child as TSESTree.Node, visitor);
        }
      }
    } else if (typeof value === "object" && "type" in (value as object)) {
      visit(value as TSESTree.Node, visitor);
    }
  }
}

function dedupeFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const f of findings) {
    const key = `${f.checkId}|${f.file}|${f.line}|${f.column ?? -1}|${f.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

// Re-export the catalog of checks so the reporters and grader can describe them.
export const CHECK_CATALOG: Record<
  CheckId,
  { severity: Severity; title: string; description: string }
> = {
  SHELL_EXEC: {
    severity: "CRITICAL",
    title: "Shell execution",
    description:
      "Calls into child_process (exec/spawn/execSync) — can run arbitrary commands if input is attacker-controlled.",
  },
  EVAL_USE: {
    severity: "CRITICAL",
    title: "Dynamic code execution",
    description:
      "Uses eval(), new Function(), or vm.runIn* — evaluates arbitrary code at runtime.",
  },
  UNSCOPED_FETCH: {
    severity: "HIGH",
    title: "Unscoped fetch",
    description:
      "fetch()/HTTP call where the URL is dynamic — can be steered to attacker-controlled hosts (SSRF).",
  },
  BROAD_FS_READ: {
    severity: "HIGH",
    title: "Broad filesystem read",
    description:
      "fs.readFile/readdir called with a glob or dynamic path — may expose arbitrary files.",
  },
  BROAD_FS_WRITE: {
    severity: "HIGH",
    title: "Broad filesystem write",
    description:
      "fs.writeFile/unlink/rm — can mutate or delete arbitrary files if path is unbounded.",
  },
  HARDCODED_SECRET: {
    severity: "HIGH",
    title: "Hardcoded secret",
    description:
      "Looks like an API key, token, or password is embedded directly in the source.",
  },
  ENV_EXFIL: {
    severity: "HIGH",
    title: "Environment exfiltration risk",
    description:
      "Function reads process.env values and makes a network call — may exfiltrate secrets.",
  },
  NETWORK_EGRESS: {
    severity: "MEDIUM",
    title: "Network egress",
    description:
      "Server makes outbound HTTP requests to non-local hosts — review whether the destination is trusted.",
  },
  PROTOTYPE_POLLUTION: {
    severity: "MEDIUM",
    title: "Prototype pollution",
    description:
      "Assigns to __proto__ or constructor.prototype — can poison built-in objects across the process.",
  },
  PATH_TRAVERSAL: {
    severity: "MEDIUM",
    title: "Path traversal",
    description:
      "path.join/resolve called with dynamic segments — validate that ../ cannot escape the intended root.",
  },
  MISSING_INPUT_VALIDATION: {
    severity: "LOW",
    title: "Missing input validation",
    description:
      "Tool handler is registered without a schema — inputs are not structurally validated before use.",
  },
  OVERLY_BROAD_TOOLS: {
    severity: "LOW",
    title: "Overly broad tool description",
    description:
      "Tool description advertises an unbounded surface (e.g. 'anything', 'all files', 'entire').",
  },
};
