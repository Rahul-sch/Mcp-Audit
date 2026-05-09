/**
 * MCP server parser: walks a directory, parses every TypeScript/JavaScript
 * file, and extracts the MCP tools the server registers.
 *
 * Detection is intentionally pragmatic — there is no canonical AST shape for
 * "this is an MCP tool" across SDK versions, so the parser looks for the
 * structural patterns that cover the overwhelming majority of real servers:
 *
 *   1. `<expr>.tool("name", ..., handler)`        — high-level SDK
 *   2. `<expr>.tool({ name, description, ... })`   — object-form registration
 *   3. `<expr>.registerTool(...)`                  — alternate name
 *   4. `setRequestHandler(CallToolRequestSchema, async (req) => { ... })`
 *      — low-level SDK; the handler body is captured as a single synthetic
 *      tool because individual tool names live in a separate ListTools handler
 *      and dispatching is usually a switch statement.
 *
 * Files in node_modules / dist / build / coverage / .git are skipped.
 */

import * as fs from "fs";
import * as path from "path";
import { parse, TSESTree } from "@typescript-eslint/typescript-estree";
import type { McpTool, ParseResult, SourceFile } from "./types";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

const SKIP_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".git",
  ".next",
  ".turbo",
  ".cache",
  ".vercel",
]);

const TOOL_REGISTRATION_METHODS = new Set([
  "tool",
  "registerTool",
  "addTool",
]);

/** Walk a directory and return every source file we should analyze. */
export function collectSourceFiles(rootDir: string): SourceFile[] {
  const files: SourceFile[] = [];

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        if (entry.name.startsWith(".")) continue;
        walk(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name);
      if (!SOURCE_EXTENSIONS.has(ext)) continue;

      const absolute = path.join(dir, entry.name);
      let contents: string;
      try {
        contents = fs.readFileSync(absolute, "utf8");
      } catch {
        continue;
      }
      // Skip very large files (>1 MB) — likely vendored or generated.
      if (contents.length > 1_000_000) continue;
      files.push({
        path: path.relative(rootDir, absolute),
        absolutePath: absolute,
        contents,
      });
    }
  };

  walk(rootDir);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

/**
 * Parse a single file and return discovered tools. Falls back to an empty
 * list if the file cannot be parsed (e.g. JSX in a `.js` file with non-default
 * syntax). The scanner can still run against the raw contents in that case.
 */
export function extractToolsFromFile(file: SourceFile): McpTool[] {
  let ast: TSESTree.Program;
  try {
    ast = parse(file.contents, {
      loc: true,
      range: true,
      jsx: file.path.endsWith(".tsx") || file.path.endsWith(".jsx"),
      errorOnUnknownASTType: false,
      comment: false,
    });
  } catch {
    return [];
  }

  const tools: McpTool[] = [];
  visit(ast, (node) => {
    if (node.type !== "CallExpression") return;
    const callee = node.callee;

    if (callee.type === "MemberExpression" && !callee.computed) {
      const property = callee.property;
      if (property.type !== "Identifier") return;

      if (TOOL_REGISTRATION_METHODS.has(property.name)) {
        const tool = extractToolFromCall(node, file);
        if (tool) tools.push(tool);
        return;
      }

      // Low-level SDK: server.setRequestHandler(CallToolRequestSchema, handler)
      if (property.name === "setRequestHandler") {
        const tool = extractCallToolHandler(node, file);
        if (tool) tools.push(tool);
      }
    }
  });

  return tools;
}

/** Run the parser across the whole directory. */
export function parseProject(rootDir: string): ParseResult {
  const files = collectSourceFiles(rootDir);
  const tools: McpTool[] = [];
  for (const file of files) {
    tools.push(...extractToolsFromFile(file));
  }
  return { files, tools };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function extractToolFromCall(
  call: TSESTree.CallExpression,
  file: SourceFile,
): McpTool | null {
  const args = call.arguments;
  if (args.length === 0) return null;

  // Form A: .tool("name", <schema>?, handler)
  const first = args[0];
  if (first.type === "Literal" && typeof first.value === "string") {
    const name = first.value;
    const handlerArg = findFunctionArg(args.slice(1));
    const schemaArg = args.length >= 3 ? args[1] : undefined;
    return makeTool({
      name,
      description: undefined,
      hasInputSchema: !!schemaArg && !isFunctionLike(schemaArg),
      file,
      registrationLine: call.loc.start.line,
      handler: handlerArg,
    });
  }

  // Form B: .tool({ name, description, inputSchema, handler })
  if (first.type === "ObjectExpression") {
    const name = readStringProp(first, "name");
    if (!name) return null;
    const description = readStringProp(first, "description");
    const hasInputSchema =
      hasProp(first, "inputSchema") || hasProp(first, "schema");
    const handlerProp = readProp(first, "handler") ?? readProp(first, "execute");
    const handlerNode = handlerProp && isFunctionLike(handlerProp)
      ? handlerProp
      : undefined;
    return makeTool({
      name,
      description,
      hasInputSchema,
      file,
      registrationLine: call.loc.start.line,
      handler: handlerNode,
    });
  }

  return null;
}

function extractCallToolHandler(
  call: TSESTree.CallExpression,
  file: SourceFile,
): McpTool | null {
  const args = call.arguments;
  if (args.length < 2) return null;

  const schemaArg = args[0];
  // Heuristic: only treat this as the call-tool handler if the schema arg
  // identifier mentions CallTool. This avoids picking up ListTools handlers.
  const schemaName = identifierName(schemaArg);
  if (!schemaName || !/CallTool/i.test(schemaName)) return null;

  const handlerArg = args[1];
  if (!isFunctionLike(handlerArg)) return null;

  return makeTool({
    name: "<call_tool_dispatch>",
    description: "Low-level CallToolRequestSchema dispatcher",
    hasInputSchema: false,
    file,
    registrationLine: call.loc.start.line,
    handler: handlerArg,
  });
}

interface MakeToolInput {
  name: string;
  description?: string;
  hasInputSchema: boolean;
  file: SourceFile;
  registrationLine: number;
  handler?: TSESTree.Node;
}

function makeTool(input: MakeToolInput): McpTool {
  const tool: McpTool = {
    name: input.name,
    description: input.description,
    hasInputSchema: input.hasInputSchema,
    registrationFile: input.file.path,
    registrationLine: input.registrationLine,
  };
  if (input.handler && input.handler.range) {
    const start = input.handler.loc.start.line;
    const end = input.handler.loc.end.line;
    const [rangeStart, rangeEnd] = input.handler.range;
    tool.handlerRange = { start, end };
    tool.handlerSource = input.file.contents.slice(rangeStart, rangeEnd);
  }
  return tool;
}

function findFunctionArg(
  args: readonly TSESTree.CallExpressionArgument[],
): TSESTree.Node | undefined {
  for (let i = args.length - 1; i >= 0; i--) {
    const arg = args[i];
    if (isFunctionLike(arg)) return arg;
  }
  return undefined;
}

function isFunctionLike(node: TSESTree.Node): boolean {
  return (
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionExpression"
  );
}

function readStringProp(
  obj: TSESTree.ObjectExpression,
  name: string,
): string | undefined {
  const prop = readProp(obj, name);
  if (
    prop &&
    prop.type === "Literal" &&
    typeof (prop as TSESTree.Literal).value === "string"
  ) {
    return (prop as TSESTree.Literal).value as string;
  }
  return undefined;
}

function hasProp(obj: TSESTree.ObjectExpression, name: string): boolean {
  return readProp(obj, name) !== undefined;
}

function readProp(
  obj: TSESTree.ObjectExpression,
  name: string,
): TSESTree.Node | undefined {
  for (const prop of obj.properties) {
    if (prop.type !== "Property") continue;
    const key = prop.key;
    if (key.type === "Identifier" && key.name === name) return prop.value;
    if (
      key.type === "Literal" &&
      typeof key.value === "string" &&
      key.value === name
    ) {
      return prop.value;
    }
  }
  return undefined;
}

function identifierName(node: TSESTree.Node): string | null {
  if (node.type === "Identifier") return node.name;
  if (
    node.type === "MemberExpression" &&
    !node.computed &&
    node.property.type === "Identifier"
  ) {
    return node.property.name;
  }
  return null;
}

/** Depth-first AST walker. Calls `visitor` on every node. */
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
