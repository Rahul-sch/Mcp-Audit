/**
 * Input resolution: turn a CLI argument (GitHub URL or local path) into an
 * on-disk directory the rest of the pipeline can read.
 *
 * GitHub URLs are fetched via `degit` (no .git history) into a temp directory
 * that is registered for cleanup on process exit. Local paths are returned
 * as-is with a no-op cleanup.
 */

import * as fs from "fs";
import * as path from "path";
import * as tmp from "tmp";
import degit from "degit";
import type { ResolvedSource, SourceType } from "./types";

tmp.setGracefulCleanup();

/** Pending cleanups so we can tear down temp dirs on signals or unhandled exits. */
const pendingCleanups = new Set<() => Promise<void>>();
let signalHandlersInstalled = false;

function installSignalHandlers(): void {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;

  const runAll = async () => {
    const tasks = Array.from(pendingCleanups).map((fn) =>
      fn().catch(() => undefined),
    );
    await Promise.all(tasks);
  };

  process.on("exit", () => {
    // Synchronous-only at this point; cleanups already attempted via signal handlers
    // or manual disposal. Best-effort here.
    void runAll();
  });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, async () => {
      await runAll();
      process.exit(130);
    });
  }
}

/** Result of parsing a GitHub URL into a degit-compatible spec. */
interface GithubSpec {
  owner: string;
  repo: string;
  branch?: string;
  subdir?: string;
}

/**
 * Parse the various GitHub URL/shorthand formats users might pass.
 * Accepts:
 *   - https://github.com/owner/repo
 *   - https://github.com/owner/repo.git
 *   - https://github.com/owner/repo/tree/<branch>
 *   - https://github.com/owner/repo/tree/<branch>/sub/dir
 *   - github.com/owner/repo
 *   - owner/repo (treated as github shorthand)
 */
export function parseGithubUrl(input: string): GithubSpec | null {
  const trimmed = input.trim();

  // Bare shorthand: owner/repo (no slashes beyond one, no protocol).
  if (
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed) &&
    !trimmed.includes("://")
  ) {
    const [owner, repo] = trimmed.split("/");
    return { owner, repo: stripGitSuffix(repo) };
  }

  // Strip protocol + host prefix to a normalized path.
  const hostMatch = trimmed.match(
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/(.+)$/i,
  );
  if (!hostMatch) return null;

  const segments = hostMatch[1].split("/").filter(Boolean);
  if (segments.length < 2) return null;

  const owner = segments[0];
  const repo = stripGitSuffix(segments[1]);
  let branch: string | undefined;
  let subdir: string | undefined;

  // .../tree/<branch>[/<subdir...>]
  if (segments[2] === "tree" && segments[3]) {
    branch = segments[3];
    if (segments.length > 4) {
      subdir = segments.slice(4).join("/");
    }
  }

  return { owner, repo, branch, subdir };
}

function stripGitSuffix(name: string): string {
  return name.endsWith(".git") ? name.slice(0, -4) : name;
}

/** Build the degit spec string (`owner/repo[/subdir][#branch]`). */
function toDegitSpec(spec: GithubSpec): string {
  let out = `${spec.owner}/${spec.repo}`;
  if (spec.subdir) out += `/${spec.subdir}`;
  if (spec.branch) out += `#${spec.branch}`;
  return out;
}

/** Decide whether the input looks like a GitHub source rather than a local path. */
export function isGithubInput(input: string): boolean {
  return parseGithubUrl(input) !== null;
}

/**
 * Resolve the CLI input to a directory on disk plus a cleanup hook.
 * Throws an Error with a clear message on bad input.
 */
export async function resolveSource(input: string): Promise<ResolvedSource> {
  installSignalHandlers();

  const githubSpec = parseGithubUrl(input);
  if (githubSpec) {
    return resolveGithub(input, githubSpec);
  }

  return resolveLocal(input);
}

async function resolveGithub(
  rawInput: string,
  spec: GithubSpec,
): Promise<ResolvedSource> {
  const tmpDir = tmp.dirSync({
    prefix: "mcpaudit-",
    unsafeCleanup: true,
  });

  const degitSpec = toDegitSpec(spec);
  const emitter = degit(degitSpec, {
    cache: false,
    force: true,
    verbose: false,
  });

  try {
    await emitter.clone(tmpDir.name);
  } catch (err) {
    tmpDir.removeCallback();
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to fetch ${rawInput}: ${reason}\n` +
        `Hint: ensure the repository exists and is public, or pass a local path instead.`,
    );
  }

  const cleanup = async () => {
    try {
      tmpDir.removeCallback();
    } catch {
      // best effort
    }
    pendingCleanups.delete(cleanup);
  };
  pendingCleanups.add(cleanup);

  return {
    path: tmpDir.name,
    source: rawInput,
    sourceType: "github" as SourceType,
    cleanup,
  };
}

async function resolveLocal(input: string): Promise<ResolvedSource> {
  const absolute = path.resolve(input);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absolute);
  } catch {
    throw new Error(
      `Path not found: ${input}\n` +
        `Hint: pass a directory containing an MCP server or a github URL like ` +
        `https://github.com/owner/repo`,
    );
  }
  if (!stat.isDirectory()) {
    throw new Error(`Expected a directory but got a file: ${input}`);
  }

  return {
    path: absolute,
    source: input,
    sourceType: "local" as SourceType,
    cleanup: async () => undefined,
  };
}
