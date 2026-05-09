/**
 * Shared types for the mcpaudit static analysis pipeline.
 *
 * These interfaces define the contract between resolver → parser → scanner →
 * grader → reporters. Every module consumes one of these shapes and produces
 * the next, so this file is the single source of truth for the data model.
 */

/** Severity levels assigned to each detection rule. */
export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

/** Letter grade derived from the numeric score. */
export type Grade = "A" | "B" | "C" | "D" | "F";

/** Identifier for each detection rule the scanner runs. */
export type CheckId =
  | "SHELL_EXEC"
  | "EVAL_USE"
  | "UNSCOPED_FETCH"
  | "BROAD_FS_READ"
  | "BROAD_FS_WRITE"
  | "HARDCODED_SECRET"
  | "ENV_EXFIL"
  | "NETWORK_EGRESS"
  | "PROTOTYPE_POLLUTION"
  | "PATH_TRAVERSAL"
  | "MISSING_INPUT_VALIDATION"
  | "OVERLY_BROAD_TOOLS";

/** Static metadata about every check the scanner knows about. */
export interface CheckDefinition {
  id: CheckId;
  severity: Severity;
  title: string;
  description: string;
}

/** Whether the input came from a remote git URL or a local filesystem path. */
export type SourceType = "github" | "local";

/** Result of resolving a CLI input to an on-disk path the scanner can read. */
export interface ResolvedSource {
  /** Absolute path to the directory holding the MCP server source. */
  path: string;
  /** Original input the user supplied (URL or path). */
  source: string;
  /** Where the source came from. */
  sourceType: SourceType;
  /** Tear-down hook for any temp directory the resolver created. */
  cleanup: () => Promise<void>;
}

/** A single MCP tool extracted from the server source. */
export interface McpTool {
  /** Tool name as registered with the MCP server. */
  name: string;
  /** Human-readable description, if any. */
  description?: string;
  /** Whether the tool declares an input schema (zod, JSON schema, etc.). */
  hasInputSchema: boolean;
  /** File where the tool is registered. */
  registrationFile: string;
  /** Line number of the registration. */
  registrationLine: number;
  /** Source of the handler function body (for per-tool scanning). */
  handlerSource?: string;
  /** Range of lines occupied by the handler body in `registrationFile`. */
  handlerRange?: { start: number; end: number };
}

/** A single security finding produced by the scanner. */
export interface Finding {
  checkId: CheckId;
  severity: Severity;
  /** Repo-relative file path. */
  file: string;
  line: number;
  column?: number;
  /** Short human-readable explanation specific to this hit. */
  message: string;
  /** The matched code snippet, if available. */
  snippet?: string;
  /** Name of the tool the finding belongs to, if it falls inside a tool handler. */
  toolName?: string;
}

/** Aggregated counts of findings by severity. */
export interface SeverityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

/** Score + grade for either the whole project or a single tool. */
export interface ScoreCard {
  score: number;
  grade: Grade;
  counts: SeverityCounts;
}

/** Per-tool report emitted by the grader. */
export interface ToolReport extends ScoreCard {
  name: string;
  description?: string;
  findings: Finding[];
}

/** Top-level metadata about the audit run. */
export interface AuditMeta {
  source: string;
  sourceType: SourceType;
  scannedAt: string;
  mcpauditVersion: string;
  fileCount: number;
  toolCount: number;
}

/** Complete audit report — the canonical artifact passed to every reporter. */
export interface AuditReport {
  meta: AuditMeta;
  overall: ScoreCard;
  tools: ToolReport[];
  findings: Finding[];
}

/** Options accepted by the CLI and threaded through the pipeline. */
export interface CliOptions {
  json?: boolean;
  html?: boolean;
  out?: string;
  /** Suppress the spinner and progress output (useful in CI). */
  quiet?: boolean;
}

/** A source file the scanner will analyze. */
export interface SourceFile {
  /** Repo-relative path. */
  path: string;
  /** Absolute path on disk. */
  absolutePath: string;
  contents: string;
}

/** Result returned by the parser. */
export interface ParseResult {
  files: SourceFile[];
  tools: McpTool[];
}

/** Reporter contract — every reporter takes the report and returns rendered output. */
export interface Reporter {
  render(report: AuditReport): string;
}
