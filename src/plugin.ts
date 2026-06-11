import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { defaultWakeupMessage, getWakeupStore, wakeupStatePath, type Wakeup } from "./store.js";

type OpencodeClient = {
  session: {
    list?(params?: { query?: { directory?: string } }): Promise<{
      data?: Array<{ id: string }>;
      error?: unknown;
    }>;
    prompt(params: {
      path: { id: string };
      body: {
        parts: Array<{ type: "text"; text: string }>;
      };
    }): Promise<unknown>;
  };
  app?: {
    log(params: {
      body: {
        service: string;
        level: "debug" | "info" | "warn" | "error";
        message: string;
        extra?: Record<string, unknown>;
      };
    }): Promise<unknown>;
  };
};

function formatToolResult(wakeup: Wakeup) {
  return {
    status: wakeup.status,
    id: wakeup.id,
    sessionID: wakeup.sessionID,
    runAt: new Date(wakeup.runAt).toISOString(),
    delaySeconds: Math.max(0, Math.ceil((wakeup.runAt - Date.now()) / 1000)),
    message: wakeup.message,
  };
}

function parseRunAt(value: string): number {
  const trimmed = value.trim();

  // A bare ISO date ("2026-06-11") is parsed by Date.parse as UTC midnight,
  // which silently shifts the target by the local offset (and can land in the
  // past). Interpret date-only input as local midnight instead, matching what
  // a user typing a date naturally expects.
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  let timestamp: number;

  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    const localDate = new Date(year, month - 1, day);

    if (
      localDate.getFullYear() !== year ||
      localDate.getMonth() !== month - 1 ||
      localDate.getDate() !== day
    ) {
      throw new Error("datetime must be a valid calendar date.");
    }

    timestamp = localDate.getTime();
  } else {
    timestamp = Date.parse(trimmed);
  }

  if (!Number.isFinite(timestamp)) {
    throw new Error("datetime must be a valid date/time string, preferably ISO 8601.");
  }

  if (timestamp <= Date.now()) {
    throw new Error("datetime must be in the future.");
  }

  return timestamp;
}

function parseDelaySeconds(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error("seconds must be a positive number.");
  }

  const delayMs = Math.ceil(seconds * 1000);
  if (!Number.isSafeInteger(delayMs)) {
    throw new Error("seconds is too large.");
  }

  return Date.now() + delayMs;
}

function buildWakeupPrompt(wakeup: Wakeup): string {
  return [
    `Scheduled wakeup reminder (wakeup id: ${wakeup.id}):`,
    wakeup.message || defaultWakeupMessage(),
    "",
    "Continue the current session using this reminder as the new user request.",
  ].join("\n");
}

function sessionIDFromEvent(event: unknown): string | undefined {
  const eventSessionID = (event as { sessionID?: unknown }).sessionID;
  if (typeof eventSessionID === "string" && eventSessionID) return eventSessionID;

  const properties = (event as { properties?: unknown }).properties;
  if (!properties || typeof properties !== "object") return undefined;

  const direct = (properties as { sessionID?: unknown }).sessionID;
  if (typeof direct === "string" && direct) return direct;

  const session = (properties as { session?: unknown }).session;
  if (session && typeof session === "object") {
    const id = (session as { id?: unknown }).id;
    if (typeof id === "string" && id) return id;
  }

  const params = (properties as { params?: unknown }).params;
  if (params && typeof params === "object") {
    const id = (params as { sessionID?: unknown }).sessionID;
    if (typeof id === "string" && id) return id;
  }

  const info = (properties as { info?: unknown }).info;
  if (!info || typeof info !== "object") return undefined;

  const id = (info as { id?: unknown }).id;
  return typeof id === "string" && id ? id : undefined;
}

export const WakeupPlugin: Plugin = async ({ client, directory }) => {
  const store = getWakeupStore();
  const typedClient = client as unknown as OpencodeClient;

  async function log(level: "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) {
    try {
      await typedClient.app?.log({
        body: {
          service: "opencode-wakeup",
          level,
          message,
          extra,
        },
      });
    } catch {
      // Logging is best-effort only.
    }
  }

  async function fireWakeup(wakeup: Wakeup): Promise<void> {
    await typedClient.session.prompt({
      path: { id: wakeup.sessionID },
      body: {
        parts: [{ type: "text", text: buildWakeupPrompt(wakeup) }],
      },
    });
    await log("info", "Wakeup fired", { id: wakeup.id, sessionID: wakeup.sessionID });
  }

  // The server and TUI run in separate runtimes, so the in-memory store is not
  // shared. Persist wakeups to a per-session file the TUI can poll. Scoping by
  // session (not worktree) lets multiple concurrent opencode instances coexist
  // without reading/writing each other's wakeups.
  store.enablePersistence((sessionID) => wakeupStatePath(sessionID), fireWakeup);

  // Rehydrate each session's wakeups the first time we observe it, so wakeups
  // scheduled before a restart still fire. Safe to call repeatedly.
  const rehydrated = new Set<string>();
  function rehydrateSession(sessionID: string | undefined): void {
    if (!sessionID || rehydrated.has(sessionID)) return;
    rehydrated.add(sessionID);
    store.rehydrate(sessionID);
  }

  async function rehydrateKnownSessions(): Promise<void> {
    try {
      const result = await typedClient.session.list?.({ query: { directory } });
      for (const session of result?.data ?? []) {
        rehydrateSession(session.id);
      }
    } catch (error) {
      await log("warn", "Failed to rehydrate known sessions", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  void rehydrateKnownSessions();

  return {
    event: async ({ event }) => {
      rehydrateSession(sessionIDFromEvent(event));
    },
    dispose: async () => {
      store.clear();
    },
    tool: {
      wakeup_after: tool({
        description:
          "Schedule a wakeup for the current opencode session after a relative delay in seconds. Use this to make the session resume itself later, especially when you do not know how long a task will take to finish (for example waiting on an external integration, deploy, build, or async job). Returns a status and wakeup ID that can be cancelled with wakeup_cancel.",
        args: {
          seconds: tool.schema.number().positive().describe("Delay from now, in seconds."),
          message: tool.schema
            .string()
            .optional()
            .describe("Optional message to send back to the session when the wakeup fires."),
        },
        async execute(args, context) {
          rehydrateSession(context.sessionID);
          const wakeup = store.schedule({
            sessionID: context.sessionID,
            runAt: parseDelaySeconds(args.seconds),
            message: args.message,
            onFire: fireWakeup,
          });

          return JSON.stringify(formatToolResult(wakeup), null, 2);
        },
      }),

      wakeup_at: tool({
        description:
          "Schedule a wakeup for the current opencode session at a specific date/time. Use this to make the session resume itself at a known future moment, especially when you do not know how long a task will take to finish (for example waiting on an external integration, deploy, build, or async job). Prefer ISO 8601 datetime strings. Returns a status and wakeup ID that can be cancelled with wakeup_cancel.",
        args: {
          datetime: tool.schema
            .string()
            .describe("Date/time when the wakeup should fire. Prefer ISO 8601, for example 2026-06-10T15:30:00-03:00."),
          message: tool.schema
            .string()
            .optional()
            .describe("Optional message to send back to the session when the wakeup fires."),
        },
        async execute(args, context) {
          rehydrateSession(context.sessionID);
          const wakeup = store.schedule({
            sessionID: context.sessionID,
            runAt: parseRunAt(args.datetime),
            message: args.message,
            onFire: fireWakeup,
          });

          return JSON.stringify(formatToolResult(wakeup), null, 2);
        },
      }),

      wakeup_list: tool({
        description:
          "List the currently scheduled wakeups. By default only wakeups for the current opencode session are returned. Returns an array of pending wakeups with their status, ID, target time, remaining delay, and message.",
        args: {
          allSessions: tool.schema
            .boolean()
            .optional()
            .describe("When true, list scheduled wakeups across all sessions instead of only the current one."),
        },
        async execute(args, context) {
          rehydrateSession(context.sessionID);
          const wakeups = args.allSessions
            ? store.listScheduled()
            : store.listScheduled(context.sessionID);
          return JSON.stringify(
            {
              count: wakeups.length,
              wakeups: wakeups.map(formatToolResult),
            },
            null,
            2,
          );
        },
      }),

      wakeup_cancel: tool({
        description: "Cancel a scheduled opencode wakeup by ID.",
        args: {
          id: tool.schema.string().min(1).describe("Wakeup ID returned by wakeup_after or wakeup_at."),
        },
        async execute(args, context) {
          rehydrateSession(context.sessionID);
          const wakeup = store.cancel(args.id);
          if (!wakeup) {
            return JSON.stringify(
              {
                status: "not_found",
                id: args.id,
              },
              null,
              2,
            );
          }

          await log("info", "Wakeup cancelled", { id: wakeup.id, sessionID: wakeup.sessionID });
          return JSON.stringify(formatToolResult(wakeup), null, 2);
        },
      }),
    },
  };
};
