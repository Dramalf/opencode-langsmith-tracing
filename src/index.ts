/**
 * LangSmith tracing plugin for opencode.
 *
 * Listens to opencode's plugin hooks and translates them into LangSmith
 * runs, mirroring the trace taxonomy produced by
 * `langsmith-claude-code-plugins`:
 *
 *   Turn (chain)
 *   ├── Assistant (llm)
 *   ├── ToolA   (tool)
 *   ├── ToolB   (tool)
 *   └── Assistant (llm)  ← for multi-step turns
 *
 * Context compaction events are captured as sibling chain runs under
 * the active turn (or standalone if no turn is open).
 */

import { loadConfig } from "./config.js";
import { defaultEnvFileCandidates, loadEnvFromFirst } from "./env-file.js";
import * as logger from "./logger.js";
import { initTracing } from "./langsmith.js";
import {
  flushAll,
  handleChatMessage,
  handleMessagePartUpdated,
  handleMessageUpdated,
  handlePreCompact,
  handleSessionCompacted,
  handleSessionDeleted,
  handleSessionError,
  handleSessionIdle,
  handleToolAfter,
  handleToolBefore,
  setConfig,
} from "./tracer.js";
import type { Event, MessageInfo, Part, UserMessageInfo } from "./types.js";

interface OpenCodeHooks {
  event?: (input: { event: { type: string; properties: unknown } }) => Promise<void>;
  "tool.execute.before"?: (
    input: { tool: string; sessionID: string; callID: string },
    output: { args: Record<string, unknown> },
  ) => Promise<void>;
  "tool.execute.after"?: (
    input: {
      tool: string;
      sessionID: string;
      callID: string;
      args: Record<string, unknown>;
    },
    output: { title: string; output: string; metadata: unknown },
  ) => Promise<void>;
  "experimental.session.compacting"?: (
    input: { sessionID: string },
    output: { context: string[]; prompt?: string },
  ) => Promise<void>;
  "chat.message"?: (
    input: {
      sessionID: string;
      agent?: string;
      model?: { providerID: string; modelID: string };
      messageID?: string;
      variant?: string;
    },
    output: { message: UserMessageInfo; parts: Part[] },
  ) => Promise<void>;
}

type PluginFunction = (ctx: {
  project?: unknown;
  directory?: string;
  worktree?: string;
  client?: unknown;
  $?: unknown;
  serverUrl?: URL;
}) => Promise<OpenCodeHooks>;

function isEvent(value: unknown): value is Event {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof (value as { type: unknown }).type === "string"
  );
}

async function dispatchEvent(ev: Event): Promise<void> {
  switch (ev.type) {
    case "message.updated": {
      const info = (ev.properties as { info?: MessageInfo } | undefined)?.info;
      if (!info) return;
      await handleMessageUpdated(info);
      return;
    }
    case "message.part.updated": {
      const props = ev.properties as
        | { part?: Part; delta?: string }
        | undefined;
      if (!props?.part) return;
      await handleMessagePartUpdated(props.part, props.delta);
      return;
    }
    case "session.idle": {
      const sid = (ev.properties as { sessionID?: string } | undefined)?.sessionID;
      if (!sid) return;
      await handleSessionIdle(sid);
      return;
    }
    case "session.status": {
      const props = ev.properties as
        | { sessionID?: string; status?: { type: string } }
        | undefined;
      if (props?.status?.type === "idle" && props.sessionID) {
        await handleSessionIdle(props.sessionID);
      }
      return;
    }
    case "session.error": {
      const props = ev.properties as
        | { sessionID?: string; error?: unknown }
        | undefined;
      await handleSessionError(props?.sessionID, props?.error);
      return;
    }
    case "session.compacted": {
      const props = ev.properties as
        | { sessionID?: string; [k: string]: unknown }
        | undefined;
      if (!props?.sessionID) return;
      const { sessionID, ...detail } = props;
      await handleSessionCompacted(sessionID, detail);
      return;
    }
    case "session.deleted": {
      const sid = (ev.properties as { sessionID?: string } | undefined)?.sessionID;
      if (!sid) return;
      await handleSessionDeleted(sid);
      return;
    }
    case "message.removed":
    case "message.part.removed":
    case "session.created":
    case "session.updated":
    case "session.diff":
    case "installation.updated":
    case "file.edited":
    case "file.watcher.updated":
    case "todo.updated":
    case "command.executed":
    case "permission.asked":
    case "permission.replied":
    case "server.connected":
    case "shell.env":
    case "lsp.client.diagnostics":
    case "lsp.updated":
    case "tui.prompt.append":
    case "tui.command.execute":
    case "tui.toast.show":
      return;
    default:
      logger.debug(`Unhandled event type: ${ev.type}`);
      return;
  }
}

export const LangsmithTracingPlugin: PluginFunction = async (ctx) => {
  const loaded = loadEnvFromFirst(defaultEnvFileCandidates(ctx?.directory));
  const cfg = loadConfig();
  logger.setDebug(cfg.debug);
  if (loaded) logger.debug(`Loaded env vars from ${loaded}`);

  if (!cfg.enabled) {
    logger.debug(
      "Tracing disabled (set TRACE_TO_LANGSMITH=true and OC_LANGSMITH_API_KEY to enable)",
    );
    return {};
  }

  if (!cfg.apiKey && !cfg.replicas) {
    logger.warn(
      "TRACE_TO_LANGSMITH=true but OC_LANGSMITH_API_KEY is not set — tracing disabled",
    );
    return {};
  }

  initTracing(cfg.apiKey, cfg.apiBaseUrl, cfg.replicas);
  setConfig(cfg);

  return {
    event: async ({ event }) => {
      try {
        if (!isEvent(event)) return;
        await dispatchEvent(event);
      } catch (err) {
        logger.error(`event dispatch error: ${err}`);
      }
    },
    "tool.execute.before": async (input, output) => {
      try {
        handleToolBefore(
          input.sessionID,
          input.callID,
          input.tool,
          output.args ?? {},
        );
      } catch (err) {
        logger.error(`tool.execute.before error: ${err}`);
      }
    },
    "tool.execute.after": async (input, output) => {
      try {
        await handleToolAfter(
          input.sessionID,
          input.callID,
          input.tool,
          input.args ?? {},
          output,
        );
      } catch (err) {
        logger.error(`tool.execute.after error: ${err}`);
      }
    },
    "experimental.session.compacting": async (input) => {
      try {
        handlePreCompact(input.sessionID);
      } catch (err) {
        logger.error(`experimental.session.compacting error: ${err}`);
      }
    },
    "chat.message": async (input, output) => {
      try {
        if (!output?.message) return;
        await handleChatMessage(
          input.sessionID,
          output.message,
          output.parts ?? [],
        );
      } catch (err) {
        logger.error(`chat.message error: ${err}`);
      }
    },
  };
};

export default LangsmithTracingPlugin;

// NOTE: opencode's plugin loader treats every export of a plugin module as a
// plugin function ("exports one or more plugin functions" — see
// https://opencode.ai/docs/plugins). Re-exporting non-plugin utilities here
// crashes startup with `TypeError: undefined is not an object (evaluating
// '_.auth')` because opencode tries to read .auth on whatever the export
// returns. Keep this module's exports limited to the plugin function only.
