/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { readScheduledWakeups, wakeupStatePath, type Wakeup } from "./store.js";

const SIDEBAR_ORDER = 140;
const MAX_MESSAGE_LENGTH = 34;

function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp));
}

function shortID(id: string): string {
  return id.length <= 10 ? id : id.slice(-10);
}

function truncate(value: string, length: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (oneLine.length <= length) return oneLine;
  return `${oneLine.slice(0, Math.max(0, length - 3))}...`;
}

function WakeupLine(props: { wakeup: Wakeup; now: number; api: TuiPluginApi }) {
  const countdown = () => formatCountdown(props.wakeup.runAt - props.now);
  const message = () => truncate(props.wakeup.message, MAX_MESSAGE_LENGTH);

  return (
    <box gap={0}>
      <box flexDirection="row">
        <text fg={props.api.theme.current.textMuted} wrapMode="none">
          {countdown()}
        </text>
        <text fg={props.api.theme.current.textMuted} wrapMode="none">
          {" at "}
          {formatTime(props.wakeup.runAt)}
        </text>
      </box>
      <text fg={props.api.theme.current.text} wrapMode="none">
        {message()}
      </text>
      <text fg={props.api.theme.current.textMuted} wrapMode="none">
        id {shortID(props.wakeup.id)}
      </text>
    </box>
  );
}

function SidebarWakeups(props: { api: TuiPluginApi; sessionID: string }) {
  const statePath = createMemo(() => wakeupStatePath(props.sessionID));
  const [revision, setRevision] = createSignal(0);
  const [now, setNow] = createSignal(Date.now());

  const refresh = () => {
    setRevision((value) => value + 1);
    setNow(Date.now());
  };

  // The server writes wakeups to disk in a separate runtime, so poll the shared
  // state file instead of relying on shared in-memory state.
  const interval = setInterval(refresh, 1_000);
  onCleanup(() => {
    clearInterval(interval);
  });

  createEffect(() => {
    props.sessionID;
    refresh();
  });

  const scheduled = createMemo(() => {
    revision();
    return readScheduledWakeups(statePath(), props.sessionID);
  });

  const wakeups = createMemo(() => scheduled().slice(0, 5));

  const hiddenCount = createMemo(() => Math.max(0, scheduled().length - wakeups().length));

  return (
    <box gap={0}>
      <box flexDirection="row">
        <text fg={props.api.theme.current.text} wrapMode="none">
          <b>Wakeups</b>
        </text>
        <Show when={wakeups().length > 0}>
          <text fg={props.api.theme.current.textMuted} wrapMode="none">
            {" ("}
            {scheduled().length}
            {")"}
          </text>
        </Show>
      </box>

      <Show
        when={wakeups().length > 0}
        fallback={
          <text fg={props.api.theme.current.textMuted} wrapMode="none">
            No scheduled wakeups
          </text>
        }
      >
        <box gap={1}>
          {wakeups().map((wakeup) => (
            <WakeupLine wakeup={wakeup} now={now()} api={props.api} />
          ))}
          <Show when={hiddenCount() > 0}>
            <text fg={props.api.theme.current.textMuted} wrapMode="none">
              +{hiddenCount()} more
            </text>
          </Show>
        </box>
      </Show>
    </box>
  );
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: SIDEBAR_ORDER,
    slots: {
      sidebar_content(_ctx, props: { session_id: string }) {
        return <SidebarWakeups api={api} sessionID={props.session_id} />;
      },
    },
  });
};

const pluginModule: TuiPluginModule & { id: string } = {
  id: "opencode-wakeup",
  tui,
};

export default pluginModule;
