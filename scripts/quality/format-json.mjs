import { writeFile } from "node:fs/promises";

import { readWorkspaceFile, workspaceFiles } from "../lib/workspace.mjs";

let formatted = 0;
for (const file of await workspaceFiles({ extensions: [".json"] })) {
  const source = await readWorkspaceFile(file);
  const normalized = `${JSON.stringify(JSON.parse(source), null, 2)}\n`;
  if (source.replace(/\r\n/g, "\n") !== normalized) {
    await writeFile(file, normalized, "utf8");
    formatted += 1;
  }
}

console.log(`Formatted ${formatted} JSON file${formatted === 1 ? "" : "s"}.`);
