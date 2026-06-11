import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type WakeupStatus = "scheduled" | "triggering" | "triggered" | "cancelled" | "failed";

export type Wakeup = {
  id: string;
  sessionID: string;
  message: string;
  createdAt: number;
  runAt: number;
  status: WakeupStatus;
  error?: string;
  settledAt?: number;
};

type Timer = ReturnType<typeof setTimeout>;
type Listener = () => void;
type FireHandler = (wakeup: Wakeup) => Promise<void>;

type WakeupStore = {
  schedule(input: {
    sessionID: string;
    runAt: number;
    message?: string;
    onFire: FireHandler;
  }): Wakeup;
  cancel(id: string): Wakeup | undefined;
  list(): Wakeup[];
  listScheduled(sessionID?: string): Wakeup[];
  clear(): void;
  subscribe(listener: Listener): () => void;
  enablePersistence(pathForSession: (sessionID: string) => string, onFire: FireHandler): void;
  rehydrate(sessionID: string): void;
};

type StoreState = {
  wakeups: Map<string, Wakeup>;
  timers: Map<string, Timer>;
  listeners: Set<Listener>;
  // Derives the per-session state file. State is scoped per session so that
  // multiple concurrent opencode instances (each owning different sessions)
  // never read/write each other's files, which would otherwise cause lost
  // entries or duplicate firing.
  pathForSession?: (sessionID: string) => string;
  onFire?: FireHandler;
};

const DEFAULT_MESSAGE = "Wake up and continue from this scheduled reminder.";
const GLOBAL_KEY = "__opencode_wakeup_store__";
const MAX_TIMER_DELAY_MS = 2_147_483_647;
// How long terminal (triggered/failed/cancelled) entries are retained in memory
// before being pruned, so the in-memory map cannot grow without bound.
const TERMINAL_RETENTION_MS = 10 * 60_000;

function createID(): string {
  // UUID so that concurrent opencode instances can never mint colliding ids.
  return `wakeup_${randomUUID()}`;
}

function isTerminal(status: WakeupStatus): boolean {
  return status === "triggered" || status === "failed" || status === "cancelled";
}

function writeSessionFile(filePath: string, wakeups: Wakeup[]): void {
  try {
    const tmp = `${filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(wakeups), "utf8");
    renameSync(tmp, filePath);
  } catch {
    // Persistence is best-effort; failures must not break scheduling.
  }
}

function persist(state: StoreState): void {
  const pathForSession = state.pathForSession;
  if (!pathForSession) return;

  // Group this instance's wakeups by session and write one file per session.
  // Because each session is owned by exactly one instance, we can fully own
  // its file and do not need to merge foreign entries.
  const bySession = new Map<string, Wakeup[]>();
  for (const wakeup of state.wakeups.values()) {
    const list = bySession.get(wakeup.sessionID);
    if (list) list.push(wakeup);
    else bySession.set(wakeup.sessionID, [wakeup]);
  }

  for (const [sessionID, wakeups] of bySession) {
    writeSessionFile(pathForSession(sessionID), wakeups);
  }
}

function prune(state: StoreState): void {
  const cutoff = Date.now() - TERMINAL_RETENTION_MS;
  for (const [id, wakeup] of state.wakeups) {
    if (isTerminal(wakeup.status) && (wakeup.settledAt ?? 0) < cutoff) {
      state.wakeups.delete(id);
    }
  }
}

function emit(state: StoreState): void {
  prune(state);
  persist(state);
  for (const listener of state.listeners) {
    try {
      listener();
    } catch {
      // Listener failures should not affect scheduling.
    }
  }
}

function createStore(): WakeupStore {
  const state: StoreState = {
    wakeups: new Map(),
    timers: new Map(),
    listeners: new Set(),
  };

  // Arm (or re-arm) a timer for an already-registered scheduled wakeup. Shared
  // by schedule() and rehydration so both go through the same chunked,
  // long-timer-safe firing path.
  const armWakeup = (id: string, runAt: number, onFire: FireHandler): void => {
    const armTimer = () => {
      const delayMs = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, runAt - Date.now()));
      const timer = setTimeout(() => {
        if (Date.now() < runAt) {
          armTimer();
          return;
        }

        state.timers.delete(id);
        const current = state.wakeups.get(id);
        if (!current || current.status !== "scheduled") return;

        current.status = "triggering";
        emit(state);

        void onFire({ ...current })
          .then(() => {
            const latest = state.wakeups.get(id);
            if (!latest || latest.status === "cancelled") return;
            latest.status = "triggered";
            latest.settledAt = Date.now();
            emit(state);
          })
          .catch((error: unknown) => {
            const latest = state.wakeups.get(id);
            if (!latest || latest.status === "cancelled") return;
            latest.status = "failed";
            latest.error = error instanceof Error ? error.message : String(error);
            latest.settledAt = Date.now();
            emit(state);
          });
      }, delayMs);
      timer.unref?.();
      state.timers.set(id, timer);
    };

    armTimer();
  };

  return {
    schedule(input) {
      const id = createID();
      const wakeup: Wakeup = {
        id,
        sessionID: input.sessionID,
        message: input.message?.trim() || DEFAULT_MESSAGE,
        createdAt: Date.now(),
        runAt: input.runAt,
        status: "scheduled",
      };

      state.wakeups.set(id, wakeup);
      armWakeup(id, input.runAt, input.onFire);
      emit(state);

      return { ...wakeup };
    },

    cancel(id) {
      const wakeup = state.wakeups.get(id);
      if (!wakeup || wakeup.status !== "scheduled") return undefined;

      const timer = state.timers.get(id);
      if (timer) clearTimeout(timer);
      state.timers.delete(id);
      wakeup.status = "cancelled";
      wakeup.settledAt = Date.now();
      emit(state);

      return { ...wakeup };
    },

    list() {
      return Array.from(state.wakeups.values()).map((wakeup) => ({ ...wakeup }));
    },

    listScheduled(sessionID) {
      return Array.from(state.wakeups.values())
        .filter((wakeup) => wakeup.status === "scheduled")
        .filter((wakeup) => !sessionID || wakeup.sessionID === sessionID)
        .sort((a, b) => a.runAt - b.runAt)
        .map((wakeup) => ({ ...wakeup }));
    },

    clear() {
      for (const timer of state.timers.values()) clearTimeout(timer);
      state.timers.clear();
      state.wakeups.clear();
      emit(state);
    },

    subscribe(listener) {
      state.listeners.add(listener);
      return () => {
        state.listeners.delete(listener);
      };
    },

    enablePersistence(pathForSession, onFire) {
      state.pathForSession = pathForSession;
      state.onFire = onFire;
    },

    rehydrate(sessionID) {
      const pathForSession = state.pathForSession;
      const onFire = state.onFire;
      if (!pathForSession || !onFire) return;

      // Recover scheduled wakeups left in this session's state file by a
      // previous run (or a crashed/restarted instance) so they actually fire
      // instead of lingering as ghost entries. Past-due wakeups fire promptly
      // via the 0ms timer; safe to call repeatedly.
      let recovered = false;
      const filePath = pathForSession(sessionID);
      for (const wakeup of readWakeupsFile(filePath)) {
        if (wakeup.sessionID !== sessionID) continue;
        if (wakeup.status !== "scheduled") continue;

        if (state.wakeups.has(wakeup.id)) continue;
        state.wakeups.set(wakeup.id, { ...wakeup });
        armWakeup(wakeup.id, wakeup.runAt, onFire);
        recovered = true;
      }

      if (recovered) emit(state);
    },
  };
}

export function getWakeupStore(): WakeupStore {
  const globalObject = globalThis as typeof globalThis & { [GLOBAL_KEY]?: WakeupStore };
  globalObject[GLOBAL_KEY] ??= createStore();
  return globalObject[GLOBAL_KEY];
}

export function defaultWakeupMessage(): string {
  return DEFAULT_MESSAGE;
}

function hashScope(scope: string): string {
  return createHash("sha256").update(scope).digest("hex");
}

/**
 * Resolve the on-disk path used to bridge state between the server runtime and
 * the TUI runtime. Both processes derive the same path from the session id, so
 * the server can write and the TUI can read that session's wakeups.
 */
export function wakeupStatePath(scope: string): string {
  return join(tmpdir(), `opencode-wakeup-${hashScope(scope || "default")}.json`);
}

function isWakeupStatus(value: unknown): value is WakeupStatus {
  return (
    value === "scheduled" ||
    value === "triggering" ||
    value === "triggered" ||
    value === "cancelled" ||
    value === "failed"
  );
}

function isWakeup(value: unknown): value is Wakeup {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.sessionID === "string" &&
    typeof candidate.message === "string" &&
    typeof candidate.createdAt === "number" &&
    Number.isFinite(candidate.createdAt) &&
    typeof candidate.runAt === "number" &&
    Number.isFinite(candidate.runAt) &&
    isWakeupStatus(candidate.status) &&
    (candidate.error === undefined || typeof candidate.error === "string") &&
    (candidate.settledAt === undefined ||
      (typeof candidate.settledAt === "number" && Number.isFinite(candidate.settledAt)))
  );
}

function readWakeupsFile(filePath: string): Wakeup[] {
  try {
    if (!existsSync(filePath)) return [];
    const raw = readFileSync(filePath, "utf8");
    if (!raw.trim()) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isWakeup);
  } catch {
    return [];
  }
}

/**
 * Read scheduled wakeups directly from the shared state file. Used by the TUI
 * runtime, which does not share in-memory state with the server runtime.
 * Filters to the given session so concurrent opencode instances/terminals
 * sharing the file do not interfere with each other's sidebars.
 */
export function readScheduledWakeups(filePath: string, sessionID?: string): Wakeup[] {
  return readWakeupsFile(filePath)
    .filter((wakeup) => wakeup.status === "scheduled")
    .filter((wakeup) => !sessionID || wakeup.sessionID === sessionID)
    .sort((a, b) => a.runAt - b.runAt);
}
