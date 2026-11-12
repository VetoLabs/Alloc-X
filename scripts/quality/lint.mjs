import { spawnSync } from "node:child_process";
import { relative } from "node:path";

import { readWorkspaceFile, WORKSPACE_ROOT, workspaceFiles } from "../lib/workspace.mjs";

const sourceFiles = await workspaceFiles({ extensions: [".ts", ".mjs"] });
const failures = [];
const productionRoots = ["apps/", "packages/", "services/"];

for (const file of sourceFiles) {
  const display = relative(WORKSPACE_ROOT, file).replaceAll("\\", "/");
  const syntax = spawnSync(process.execPath, ["--check", file], {
    cwd: WORKSPACE_ROOT,
    encoding: "utf8",
  });
  if (syntax.status !== 0) {
    failures.push(`${display}: ${syntax.stderr.trim() || syntax.stdout.trim() || "syntax check failed"}`);
  }

  const source = await readWorkspaceFile(file);
  if (productionRoots.some((root) => display.startsWith(root)) && !display.includes("/test/")) {
    const unsafePatterns = [
      { expression: /\beval\s*\(/, message: "eval is forbidden" },
      { expression: /new\s+Function\s*\(/, message: "dynamic Function construction is forbidden" },
      { expression: /Math\.random\s*\(/, message: "Math.random is forbidden for product identifiers or security decisions" },
      { expression: /console\.log\s*\(/, message: "use structured, redacted observability instead of console.log" },
    ];
    for (const rule of unsafePatterns) {
      if (rule.expression.test(source)) failures.push(`${display}: ${rule.message}`);
    }
  }
}

if (failures.length > 0) {
  console.error("Lint check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Lint check passed for ${sourceFiles.length} source files.`);
