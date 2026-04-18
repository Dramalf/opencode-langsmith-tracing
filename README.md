# LangSmith Tracing Plugin for opencode

[![CI](https://github.com/Dramalf/langsmith-opencode-tracing/actions/workflows/ci.yml/badge.svg)](https://github.com/Dramalf/langsmith-opencode-tracing/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](./tsconfig.json)
[![Node >=20](https://img.shields.io/badge/Node-%3E%3D20-339933?logo=node.js&logoColor=white)](./package.json)

> **Full observability for [opencode](https://opencode.ai) sessions.**
> Stream every conversation turn, LLM call, tool call, reasoning step, token
> usage, cost, and context compaction to
> [LangSmith](https://smith.langchain.com). Trace taxonomy compatible with
> the official
> [`langsmith-claude-code-plugins`](https://github.com/langchain-ai/langsmith-claude-code-plugins),
> so existing LangSmith dashboards and evaluators built for Claude Code
> work unchanged.

**Keywords**: opencode tracing · LangSmith tracing for opencode · opencode
plugin · opencode observability · LLM tracing · agent tracing · Claude Code
equivalent for opencode.

## Trace hierarchy

```
OpenCode Turn                (chain)  ← one per user prompt
├── OpenCode Assistant       (llm)    ← one per assistant message / step
├── <tool name>              (tool)   ← one per tool call
├── <tool name>              (tool)
└── Context Compaction       (chain)  ← when session is compacted
```

Every run carries:

- `ls_provider` / `ls_model_name` extracted from opencode's provider/model ids
- `usage_metadata` (input, output, reasoning, cache read/write tokens)
- `cost_usd` from opencode's own cost accounting
- `thread_id`, `turn_number`, `agent`, and any custom metadata you supply

Interrupted turns (e.g. the user starts a new prompt before the assistant
finishes) are closed with `error: "Interrupted"` so they remain visible in
LangSmith rather than hanging open.

## Installation

### As a global opencode plugin

1. Publish or install this package (either from npm or from a local
   checkout). From a local clone:

   ```bash
   cd langsmith-opencode-tracing
   npm install
   npm run build
   npm link
   ```

2. Add the plugin to your opencode configuration (`opencode.json` at the
   project root, or `~/.config/opencode/opencode.json` globally):

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "plugin": ["langsmith-opencode-tracing"]
   }
   ```

   For locally-checked-out plugins, opencode also loads any file under
   `.opencode/plugins/` or `~/.config/opencode/plugins/`. A thin shim
   such as the following is enough:

   ```ts
   // ~/.config/opencode/plugins/langsmith.ts
   export { LangsmithTracingPlugin as default } from "langsmith-opencode-tracing";
   ```

### From a monorepo / single-file drop-in

If you'd rather not publish the package, copy the bundled `dist/` output
into `~/.config/opencode/plugins/` and re-export:

```ts
// ~/.config/opencode/plugins/langsmith.ts
export { default } from "./dist/index.js";
```

## Configuration

The plugin reads its configuration from environment variables. At minimum,
set `TRACE_TO_LANGSMITH=true` and `OC_LANGSMITH_API_KEY`.

| Variable                           | Required | Default                           | Description                                                                      |
| ---------------------------------- | -------- | --------------------------------- | -------------------------------------------------------------------------------- |
| `TRACE_TO_LANGSMITH`               | Yes\*    | —                                 | Set to `true` to enable tracing. Also accepts `OC_TRACE_TO_LANGSMITH` / `LANGSMITH_TRACING`. |
| `OC_LANGSMITH_API_KEY`             | Yes\*\*  | —                                 | LangSmith API key (falls back to `LANGSMITH_API_KEY`).                           |
| `OC_LANGSMITH_PROJECT`             | No       | `"opencode"`                       | LangSmith project name (falls back to `LANGSMITH_PROJECT`).                      |
| `LANGSMITH_ENDPOINT`               | No       | `https://api.smith.langchain.com` | LangSmith API base URL.                                                          |
| `OC_LANGSMITH_DEBUG`               | No       | `false`                           | Enable verbose debug logging to stderr.                                          |
| `OC_LANGSMITH_PARENT_DOTTED_ORDER` | No       | —                                 | Dotted-order of an existing run to nest every opencode trace under.              |
| `OC_LANGSMITH_METADATA`            | No       | —                                 | JSON object of metadata merged into every run's `extra.metadata`.                |
| `OC_LANGSMITH_RUNS_ENDPOINTS`      | No       | —                                 | JSON array of LangSmith replica endpoints for multi-project tracing.             |

\* Tracing is disabled unless one of the `*_TRACING` vars is truthy.
\*\* Required unless `OC_LANGSMITH_RUNS_ENDPOINTS` is supplied.

### Example — shell profile

```bash
export TRACE_TO_LANGSMITH="true"
export OC_LANGSMITH_API_KEY="lsv2_pt_..."
export OC_LANGSMITH_PROJECT="my-opencode"
```

### Example — opencode config

opencode does not currently inject env vars from its config, so use your
shell profile / `direnv` / process manager to set them.

### Nesting under an existing LangSmith run

```bash
export OC_LANGSMITH_PARENT_DOTTED_ORDER="$(python - <<'PY'
from langsmith import traceable, get_current_run_tree
print(get_current_run_tree().dotted_order)
PY
)"
```

or, from TypeScript:

```ts
import { traceable, getCurrentRunTree } from "langsmith/traceable";
import { spawnSync } from "node:child_process";

const run = traceable(async (prompt: string) => {
  const tree = getCurrentRunTree();
  return spawnSync("opencode", ["run", prompt], {
    env: {
      ...process.env,
      TRACE_TO_LANGSMITH: "true",
      OC_LANGSMITH_API_KEY: process.env.LANGSMITH_API_KEY,
      OC_LANGSMITH_PROJECT: "my-opencode",
      OC_LANGSMITH_PARENT_DOTTED_ORDER: tree?.dotted_order,
    },
  });
}, { name: "run_opencode" });
```

## Which opencode events are captured

| opencode event / hook                | LangSmith effect                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------------- |
| `message.updated` (role `user`)      | Opens a new `Turn` chain run for the user prompt.                                |
| `message.part.updated` (user parts)  | Streams the user's text and attachments into the `Turn` inputs.                  |
| `message.updated` (role `assistant`) | Opens an LLM run with provider/model/agent metadata.                              |
| `message.part.updated` (text)        | Accumulates assistant text output.                                               |
| `message.part.updated` (reasoning)   | Captured as a `thinking` block on the assistant run output.                      |
| `message.part.updated` (tool)        | Creates a tool run on `running`, patches it on `completed`/`error`.              |
| `message.part.updated` (step-finish) | Accumulates input/output/reasoning/cache token counts and cost.                  |
| `tool.execute.before` / `.after`     | Captures argument and output fidelity for tools opencode routes through plugins. |
| `experimental.session.compacting`    | Starts a compaction timer so the duration can be attached later.                 |
| `session.compacted`                  | Creates a `Context Compaction` chain run under the active turn.                  |
| `session.idle` / `session.status: idle` | Closes the open assistant, tool, and turn runs and flushes traces.              |
| `session.error`                      | Closes the open turn with the error details.                                     |
| `session.deleted`                    | Closes the open turn with `error: "Session deleted"`.                            |

Unknown event types are silently ignored.

## Development

```bash
npm install
npm run dev       # tsc --watch
npm run build     # ./dist
npm run typecheck # no-emit typecheck
```

## License

MIT
