import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { defaultWakeupMessage, getWakeupStore, readScheduledWakeups, wakeupStatePath, type Wakeup } from "../src/store.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const tempDirs: string[] = [];

function tempStateFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "opencode-wakeup-test-"));
  tempDirs.push(dir);
  return join(dir, "state.json");
}

function wakeup(input: Partial<Wakeup> & Pick<Wakeup, "id" | "sessionID" | "runAt">): Wakeup {
  return {
    message: "test reminder",
    createdAt: Date.now(),
    status: "scheduled",
    ...input,
  };
}

describe("wakeup store", () => {
  beforeEach(() => {
    getWakeupStore().clear();
  });

  afterEach(() => {
    getWakeupStore().clear();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("persists scheduled wakeups and cancellation", () => {
    const store = getWakeupStore();
    const filePath = tempStateFile();
    const sessionID = "store-cancel";

    store.enablePersistence(() => filePath, async () => {});
    const scheduled = store.schedule({
      sessionID,
      runAt: Date.now() + 60_000,
      message: "cancel me",
      onFire: async () => {},
    });

    expect(readScheduledWakeups(filePath, sessionID).map((item) => item.id)).toEqual([scheduled.id]);

    const cancelled = store.cancel(scheduled.id);
    expect(cancelled?.status).toBe("cancelled");
    expect(readScheduledWakeups(filePath, sessionID)).toHaveLength(0);

    const persisted = JSON.parse(readFileSync(filePath, "utf8")) as Wakeup[];
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.status).toBe("cancelled");
  });

  test("uses the default message for blank messages", () => {
    const store = getWakeupStore();

    const scheduled = store.schedule({
      sessionID: "store-default-message",
      runAt: Date.now() + 60_000,
      message: "   ",
      onFire: async () => {},
    });

    expect(scheduled.message).toBe(defaultWakeupMessage());
  });

  test("lists scheduled wakeups by session and run time", () => {
    const store = getWakeupStore();
    const now = Date.now();

    const later = store.schedule({
      sessionID: "session-a",
      runAt: now + 120_000,
      message: "later",
      onFire: async () => {},
    });
    const otherSession = store.schedule({
      sessionID: "session-b",
      runAt: now + 30_000,
      message: "other",
      onFire: async () => {},
    });
    const earlier = store.schedule({
      sessionID: "session-a",
      runAt: now + 60_000,
      message: "earlier",
      onFire: async () => {},
    });

    expect(store.listScheduled("session-a").map((item) => item.id)).toEqual([earlier.id, later.id]);
    expect(store.listScheduled().map((item) => item.id)).toEqual([otherSession.id, earlier.id, later.id]);
  });

  test("rehydrates and fires a future wakeup", async () => {
    const store = getWakeupStore();
    const filePath = tempStateFile();
    const sessionID = "store-rehydrate";
    let fired = 0;

    const onFire = async () => {
      fired += 1;
    };

    store.enablePersistence(() => filePath, onFire);
    store.schedule({ sessionID, runAt: Date.now() + 30, message: "fire", onFire });
    store.clear();

    store.enablePersistence(() => filePath, onFire);
    store.rehydrate(sessionID);
    await sleep(120);

    expect(fired).toBe(1);
    expect(store.list().find((item) => item.sessionID === sessionID)?.status).toBe("triggered");
  });

  test("fires overdue scheduled wakeups during rehydration", async () => {
    const store = getWakeupStore();
    const filePath = tempStateFile();
    const sessionID = "store-overdue";
    const overdue = wakeup({ id: "overdue", sessionID, runAt: Date.now() - 120_000 });
    const future = wakeup({ id: "future", sessionID, runAt: Date.now() + 60_000 });
    let fired = 0;

    writeFileSync(filePath, JSON.stringify([overdue, future]), "utf8");
    store.enablePersistence(() => filePath, async () => {
      fired += 1;
    });

    store.rehydrate(sessionID);
    await sleep(80);

    const persisted = JSON.parse(readFileSync(filePath, "utf8")) as Wakeup[];
    expect(fired).toBe(1);
    expect(persisted.map((item) => item.id)).toEqual(["overdue", "future"]);
    expect(persisted.find((item) => item.id === "overdue")?.status).toBe("triggered");
    expect(readScheduledWakeups(filePath, sessionID).map((item) => item.id)).toEqual(["future"]);
  });

  test("readScheduledWakeups includes overdue scheduled wakeups", () => {
    const filePath = tempStateFile();
    const sessionID = "store-read-overdue";
    writeFileSync(
      filePath,
      JSON.stringify([wakeup({ id: "overdue", sessionID, runAt: Date.now() - 120_000 })]),
      "utf8",
    );

    expect(readScheduledWakeups(filePath, sessionID).map((item) => item.id)).toEqual(["overdue"]);
  });

  test("readScheduledWakeups ignores malformed and unrelated entries", () => {
    const filePath = tempStateFile();
    const sessionID = "store-read-filtered";
    writeFileSync(
      filePath,
      JSON.stringify([
        wakeup({ id: "valid", sessionID, runAt: Date.now() + 60_000 }),
        wakeup({ id: "wrong-session", sessionID: "other-session", runAt: Date.now() + 30_000 }),
        { id: "missing-fields", status: "scheduled" },
      ]),
      "utf8",
    );

    expect(readScheduledWakeups(filePath, sessionID).map((item) => item.id)).toEqual(["valid"]);
  });

  test("uses a stable sha256-derived state path", () => {
    expect(wakeupStatePath("session-a")).toBe(wakeupStatePath("session-a"));
    expect(wakeupStatePath("session-a")).not.toBe(wakeupStatePath("session-b"));
    expect(basename(wakeupStatePath("session-a"))).toMatch(/^opencode-wakeup-[a-f0-9]{64}\.json$/);
  });
});
