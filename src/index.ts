import { WakeupPlugin } from "./plugin.js";

const pluginModule = {
  id: "opencode-wakeup",
  server: WakeupPlugin,
};

export default pluginModule;
export { WakeupPlugin } from "./plugin.js";
export type { Wakeup, WakeupStatus } from "./store.js";
