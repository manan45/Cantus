#!/usr/bin/env node
// Creates the dev symlink src-tauri/binaries/node-aarch64-apple-darwin -> system node
// so that `cargo clippy` and `cargo check` find the sidecar without a full bundle-node.sh run.
// Safe to re-run: no-ops if a real binary (non-symlink) already exists.
import { execSync } from "node:child_process";
import { existsSync, lstatSync, symlinkSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dest = join(root, "src-tauri", "binaries", "node-aarch64-apple-darwin");

if (existsSync(dest) && !lstatSync(dest).isSymbolicLink()) {
  console.log("Real sidecar binary already present — skipping dev symlink.");
  process.exit(0);
}

const node = execSync("which node", { encoding: "utf8" }).trim();
if (!node) {
  console.error("node not found on PATH — install Node.js first.");
  process.exit(1);
}

if (existsSync(dest)) unlinkSync(dest);
symlinkSync(node, dest);
console.log(`Dev symlink: ${dest} -> ${node}`);
