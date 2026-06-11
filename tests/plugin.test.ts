import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { WakeupPlugin } from "../src/plugin.js";
import { getWakeupStore, wakeupStatePath } from "../src/store.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function localDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toolContext(sessionID: string) {
  return {
    sessionID,
    messageID: "message-test",
    agent: "agent-test",
    directory: process.cwd(),
    worktree: process.cwd(),
    abort: new AbortController().signal,
    metadata() {},
    ask: async () => {},
  };
}

function fakeClient(prompts: unknown[], sessions: Array<{ id: string }> = []) {
  return {
    session: {
      list: async () => ({ data: sessions, error: undefined }),
      prompt: async (params: unknown) => {
        prompts.push(params);
      },
    },
    app: {
      log: async () => {},
    },
  };
}

describe("wakeup plugin", () => {
  beforeEach(() => {
    getWakeupStore().clear();
  });

  afterEach(() => {
    getWakeupStore().clear();
  });

  test("rehydrates wakeups from session events that carry info.id", async () => {
    const sessionID = `plugin-rehydrate-${Date.now()}`;
    const filePath = wakeupStatePath(sessionID);
    const store = getWakeupStore();
    const prompts: unknown[] = [];

    rmSync(filePath, { force: true });
    store.enablePersistence((id) => wakeupStatePath(id), async () => {});
    store.schedule({ sessionID, runAt: Date.now() + 30, message: "rehydrate", onFire: async () => {} });
    store.clear();

    const plugin = await WakeupPlugin({ client: fakeClient(prompts) } as never);
    await plugin.event?.({ event: { type: "session.updated", properties: { info: { id: sessionID } } } as never });
    await sleep(120);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toEqual(
      expect.objectContaining({
        path: { id: sessionID },
      }),
    );

    await plugin.dispose?.();
    rmSync(filePath, { force: true });
  });

  test("rehydrates overdue wakeups when an old session is selected", async () => {
    const sessionID = `plugin-select-${Date.now()}`;
    const filePath = wakeupStatePath(sessionID);
    const prompts: unknown[] = [];

    rmSync(filePath, { force: true });
    writeFileSync(
      filePath,
      JSON.stringify([
        {
          id: "wakeup-overdue-select",
          sessionID,
          message: "selected overdue",
          createdAt: Date.now() - 180_000,
          runAt: Date.now() - 120_000,
          status: "scheduled",
        },
      ]),
      "utf8",
    );

    const plugin = await WakeupPlugin({ client: fakeClient(prompts) } as never);
    await plugin.event?.({ event: { type: "tui.session.select", properties: { sessionID } } as never });
    await sleep(120);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toEqual(
      expect.objectContaining({
        path: { id: sessionID },
      }),
    );

    await plugin.dispose?.();
    rmSync(filePath, { force: true });
  });

  test("rehydrates known sessions on startup", async () => {
    const sessionID = `plugin-startup-${Date.now()}`;
    const filePath = wakeupStatePath(sessionID);
    const prompts: unknown[] = [];

    rmSync(filePath, { force: true });
    writeFileSync(
      filePath,
      JSON.stringify([
        {
          id: "wakeup-startup-known-session",
          sessionID,
          message: "startup overdue",
          createdAt: Date.now() - 180_000,
          runAt: Date.now() - 120_000,
          status: "scheduled",
        },
      ]),
      "utf8",
    );

    const plugin = await WakeupPlugin({ client: fakeClient(prompts, [{ id: sessionID }]), directory: process.cwd() } as never);
    await sleep(120);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toEqual(
      expect.objectContaining({
        path: { id: sessionID },
      }),
    );

    await plugin.dispose?.();
    rmSync(filePath, { force: true });
  });

  test("schedules, lists, and cancels through tools", async () => {
    const sessionID = `plugin-tools-${Date.now()}`;
    const filePath = wakeupStatePath(sessionID);
    const prompts: unknown[] = [];

    rmSync(filePath, { force: true });
    const plugin = await WakeupPlugin({ client: fakeClient(prompts) } as never);
    const context = toolContext(sessionID) as never;

    const scheduled = JSON.parse(
      (await plugin.tool?.wakeup_after.execute({ seconds: 60, message: "tool reminder" }, context)) as string,
    ) as { id: string; status: string; message: string };
    expect(scheduled.status).toBe("scheduled");
    expect(scheduled.message).toBe("tool reminder");

    const listed = JSON.parse((await plugin.tool?.wakeup_list.execute({}, context)) as string) as {
      count: number;
      wakeups: Array<{ id: string }>;
    };
    expect(listed.count).toBe(1);
    expect(listed.wakeups[0]?.id).toBe(scheduled.id);

    const cancelled = JSON.parse(
      (await plugin.tool?.wakeup_cancel.execute({ id: scheduled.id }, context)) as string,
    ) as { status: string; id: string };
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.id).toBe(scheduled.id);

    const empty = JSON.parse((await plugin.tool?.wakeup_list.execute({}, context)) as string) as { count: number };
    expect(empty.count).toBe(0);
    expect(prompts).toHaveLength(0);

    await plugin.dispose?.();
    rmSync(filePath, { force: true });
  });

  test("lists only current-session wakeups unless allSessions is true", async () => {
    const sessionID = `plugin-list-current-${Date.now()}`;
    const otherSessionID = `plugin-list-other-${Date.now()}`;
    const prompts: unknown[] = [];

    rmSync(wakeupStatePath(sessionID), { force: true });
    rmSync(wakeupStatePath(otherSessionID), { force: true });
    const plugin = await WakeupPlugin({ client: fakeClient(prompts) } as never);

    const current = JSON.parse(
      (await plugin.tool?.wakeup_after.execute({ seconds: 120, message: "current" }, toolContext(sessionID) as never)) as string,
    ) as { id: string };
    const other = JSON.parse(
      (await plugin.tool?.wakeup_after.execute(
        { seconds: 60, message: "other" },
        toolContext(otherSessionID) as never,
      )) as string,
    ) as { id: string };

    const currentOnly = JSON.parse(
      (await plugin.tool?.wakeup_list.execute({}, toolContext(sessionID) as never)) as string,
    ) as { count: number; wakeups: Array<{ id: string }> };
    const allSessions = JSON.parse(
      (await plugin.tool?.wakeup_list.execute({ allSessions: true }, toolContext(sessionID) as never)) as string,
    ) as { count: number; wakeups: Array<{ id: string }> };

    expect(currentOnly.count).toBe(1);
    expect(currentOnly.wakeups.map((item) => item.id)).toEqual([current.id]);
    expect(allSessions.count).toBe(2);
    expect(allSessions.wakeups.map((item) => item.id)).toEqual([other.id, current.id]);

    await plugin.dispose?.();
    rmSync(wakeupStatePath(sessionID), { force: true });
    rmSync(wakeupStatePath(otherSessionID), { force: true });
  });

  test("schedules bare ISO dates at local midnight", async () => {
    const sessionID = `plugin-date-only-${Date.now()}`;
    const filePath = wakeupStatePath(sessionID);
    const prompts: unknown[] = [];
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const datetime = localDateString(tomorrow);
    const expectedRunAt = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate()).toISOString();

    rmSync(filePath, { force: true });
    const plugin = await WakeupPlugin({ client: fakeClient(prompts) } as never);

    const scheduled = JSON.parse(
      (await plugin.tool?.wakeup_at.execute({ datetime, message: "tomorrow" }, toolContext(sessionID) as never)) as string,
    ) as { id: string; runAt: string; message: string };

    expect(scheduled.runAt).toBe(expectedRunAt);
    expect(scheduled.message).toBe("tomorrow");

    await plugin.dispose?.();
    rmSync(filePath, { force: true });
  });

  test("returns not_found when cancelling an unknown wakeup", async () => {
    const sessionID = `plugin-cancel-missing-${Date.now()}`;
    const filePath = wakeupStatePath(sessionID);
    const prompts: unknown[] = [];

    rmSync(filePath, { force: true });
    const plugin = await WakeupPlugin({ client: fakeClient(prompts) } as never);

    const cancelled = JSON.parse(
      (await plugin.tool?.wakeup_cancel.execute({ id: "missing" }, toolContext(sessionID) as never)) as string,
    ) as { status: string; id: string };

    expect(cancelled).toEqual({ status: "not_found", id: "missing" });

    await plugin.dispose?.();
    rmSync(filePath, { force: true });
  });
});
