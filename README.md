# mcpaudit

> Static security scorecard for MCP servers. `npm audit` meets `semgrep`,
> purpose-built for the Model Context Protocol.

[![mcpaudit grade: A](https://img.shields.io/badge/mcpaudit-A-brightgreen)](#)

`mcpaudit` statically analyzes an MCP server (TypeScript/JavaScript) and
returns a per-tool security grade **before** you wire it into an AI agent.
It never executes the target code — every check is AST- or regex-based.

---

## Install

```sh
npm install -g mcpaudit
```

## Usage

```sh
mcpaudit https://github.com/owner/some-mcp-server
```

You can also point it at a local checkout:

```sh
mcpaudit ./path/to/server
```

Output formats:

```sh
mcpaudit owner/repo                       # default TUI
mcpaudit owner/repo --json                # machine-readable JSON
mcpaudit owner/repo --html --out card.html  # shareable scorecard
```

---

## Example output

Run against the deliberately risky fixture in this repo:

```
mcpaudit v0.1.0 — tests/fixtures/risky-server
Grade F (0/100)    Tools: 4  Files: 1  Findings: 13
2 critical  4 high  0 medium  7 low

┌─────────────┬───────┬───────┬──────┬──────┬─────┬─────┐
│ Tool        │ Grade │ Score │ CRIT │ HIGH │ MED │ LOW │
├─────────────┼───────┼───────┼──────┼──────┼─────┼─────┤
│ read_file   │   D   │    49 │    0 │    3 │   0 │   2 │
├─────────────┼───────┼───────┼──────┼──────┼─────┼─────┤
│ run_shell   │   C   │    64 │    1 │    0 │   0 │   2 │
├─────────────┼───────┼───────┼──────┼──────┼─────┼─────┤
│ eval_expr   │   C   │    64 │    1 │    0 │   0 │   2 │
├─────────────┼───────┼───────┼──────┼──────┼─────┼─────┤
│ delete_path │   B   │    82 │    0 │    1 │   0 │   1 │
└─────────────┴───────┴───────┴──────┴──────┴─────┴─────┘

[CRITICAL] SHELL_EXEC · Shell execution
  server.ts:13
  child_process.exec() called with dynamic input

[CRITICAL] EVAL_USE · Dynamic code execution
  server.ts:37
  eval() called with dynamic input
…
```

---

## How it works

1. **Resolve** — GitHub URL → shallow `degit` checkout into a temp dir
   (cleaned up on exit), or use a local path directly.
2. **Parse** — every `.ts`/`.js` file goes through
   `@typescript-eslint/typescript-estree`; tool registrations
   (`server.tool(...)`, object-form, low-level `setRequestHandler`) are
   extracted with their handler ranges.
3. **Score** — 12 risk checks (table below) run across the project; findings
   inside a tool's handler range are rolled up into a per-tool grade.
   Project starts at 100; CRITICAL −30 (cap −60), HIGH −15 (cap −45),
   MEDIUM −7 (cap −21), LOW −3 (cap −9). A 90+ · B 75+ · C 60+ · D 45+ · F.

---

## Findings reference

| Check ID                   | Severity | What it flags |
|----------------------------|----------|---------------|
| `SHELL_EXEC`               | CRITICAL | `child_process.exec/spawn/execSync/...` — downgrades to HIGH if only literal args observed |
| `EVAL_USE`                 | CRITICAL | `eval()`, `new Function()`, `vm.runIn*` — downgrades to HIGH if only literal args |
| `UNSCOPED_FETCH`           | HIGH     | `fetch()` / HTTP call where the URL is dynamic (SSRF risk) |
| `BROAD_FS_READ`            | HIGH     | `fs.readFile`/`readdir` with a glob or dynamic path |
| `BROAD_FS_WRITE`           | HIGH     | `fs.writeFile`/`unlink`/`rm` — can mutate or delete arbitrary files |
| `HARDCODED_SECRET`         | HIGH     | API keys, tokens, passwords embedded in source (AWS, GitHub, OpenAI, Anthropic, Slack, JWT, generic `key:"…"`) |
| `ENV_EXFIL`                | HIGH     | Function reads `process.env.*` and makes a network call in the same body |
| `NETWORK_EGRESS`           | MEDIUM   | Outbound HTTP request to a non-localhost host |
| `PROTOTYPE_POLLUTION`      | MEDIUM   | Assignment to `__proto__` or `constructor.prototype` |
| `PATH_TRAVERSAL`           | MEDIUM   | `path.join/resolve` with a dynamic segment — verify `../` is sanitized |
| `MISSING_INPUT_VALIDATION` | LOW      | Tool registered without an `inputSchema` |
| `OVERLY_BROAD_TOOLS`       | LOW      | Tool description contains `anything`, `all files`, `entire`, `arbitrary`, etc. |

---

## Badge

After publishing the scorecard, drop the badge into your project README:

```markdown
![mcpaudit grade: A](https://img.shields.io/badge/mcpaudit-A-brightgreen)
```

The HTML report has a one-click **Copy Badge Markdown** button that emits
the snippet for the grade you actually scored.

---

## CI integration

`mcpaudit` exits non-zero when the grade falls at or below the
`--fail-on` threshold (default: `f`). Use it as a gate in your pipeline:

```yaml
# .github/workflows/mcpaudit.yml
name: mcpaudit
on: [push, pull_request]
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npx mcpaudit . --json --out mcpaudit.json --fail-on d
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: mcpaudit-report
          path: mcpaudit.json
```

The JSON shape is stable (`schemaVersion: "1.0.0"`) and puts `grade` and
`score` at the top level so `jq .grade mcpaudit.json` just works.

`--fail-on` accepts: `never`, `f`, `d`, `c`, `b`, `any`.

---

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `--json` | off | Emit JSON instead of the TUI |
| `--html` | off | Emit a self-contained HTML scorecard |
| `--out <file>` | stdout | Write report to a file |
| `--fail-on <grade>` | `f` | Exit 1 when grade is at/below this threshold |
| `--quiet` | off | Suppress spinner/progress output |
| `-v, --version` | — | Print the mcpaudit version |

---

## Limitations

- Detection is purely structural. A handler that calls into a wrapper which
  calls `exec()` will not be flagged unless the wrapper lives in the same
  project. Reduce false negatives by keeping risky sinks visible.
- Hardcoded-secret detection ignores files under `tests/`, `fixtures/`,
  `__tests__/`, and `.test.ts` / `.spec.ts`.
- The CRITICAL→HIGH downgrade for `SHELL_EXEC`/`EVAL_USE` triggers when every
  visible argument is a string literal. A single non-literal restores
  CRITICAL. If you want to be conservative, treat any HIGH `SHELL_EXEC` as
  CRITICAL in your own gating.

---

## License

MIT
