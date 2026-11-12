import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const EXCLUDED_DIRECTORIES = new Set([".git", "node_modules", "coverage", "dist", ".next", ".turbo"]);

export async function workspaceFiles(options = {}) {
  const extensions = options.extensions ? new Set(options.extensions) : undefined;
  const files = [];
  await visit(WORKSPACE_ROOT, files, extensions);
  return files.sort();
}

export async function readWorkspaceFile(file) {
  return readFile(file, "utf8");
}

export async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return false;
    throw error;
  }
}

async function visit(directory, files, extensions) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await visit(path, files, extensions);
    } else if (entry.isFile() && (!extensions || extensions.has(extname(entry.name)))) {
      files.push(path);
    }
  }
}
