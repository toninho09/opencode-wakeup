import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

await fs.copyFile(path.join(rootDir, "src", "tui.tsx"), path.join(rootDir, "dist", "tui.tsx"));
await fs.rm(path.join(rootDir, "dist", "tui.jsx"), { force: true });
await fs.rm(path.join(rootDir, "dist", "tui.jsx.map"), { force: true });
