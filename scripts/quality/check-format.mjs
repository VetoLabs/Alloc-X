import { relative } from "node:path";

import { readWorkspaceFile, WORKSPACE_ROOT, workspaceFiles } from "../lib/workspace.mjs";

const TEXT_EXTENSIONS = [".json", ".md", ".ts", ".mjs"];
const failures = [];

for (const file of await workspaceFiles({ extensions: TEXT_EXTENSIONS })) {
  const display = relative(WORKSPACE_ROOT, file);
  const source = await readWorkspaceFile(file);
  const normalized = source.replace(/\r\n/g, "\n");

  if (!normalized.endsWith("\n")) failures.push(`${display}: missing final newline`);
  if (/\t/.test(normalized)) failures.push(`${display}: tab character found`);

  const lines = normalized.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const intentionalMarkdownBreak = file.endsWith(".md") && /\S {2}$/.test(line);
    if (/[ \t]+$/.test(line) && !intentionalMarkdownBreak) {
      failures.push(`${display}:${index + 1}: trailing whitespace`);
    }
  }

  if (file.endsWith(".json")) {
    try {
      const parsed = JSON.parse(normalized);
      const expected = `${JSON.stringify(parsed, null, 2)}\n`;
      if (normalized !== expected) failures.push(`${display}: JSON is not normalized with two-space indentation`);
    } catch (error) {
      failures.push(`${display}: invalid JSON (${error instanceof Error ? error.message : "unknown error"})`);
    }
  }
}

if (failures.length > 0) {
  console.error("Formatting check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Formatting check passed.");
