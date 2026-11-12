import { basename, relative } from "node:path";

import { readWorkspaceFile, WORKSPACE_ROOT, workspaceFiles } from "../lib/workspace.mjs";

const TEXT_EXTENSIONS = [".env", ".example", ".json", ".md", ".ts", ".mjs", ".yaml", ".yml"];
const findings = [];
const patterns = [
  {
    name: "private-key block",
    expression: new RegExp("-{5}BEGIN (?:RSA |EC |OPENSSH )?" + "PRIVATE KEY-{5}"),
  },
  {
    name: "provider credential",
    expression: new RegExp("\\bsk" + "-[A-Za-z0-9_-]{20,}\\b"),
  },
  {
    name: "XRPL family seed",
    expression: new RegExp("\\bs" + "[1-9A-HJ-NP-Za-km-z]{28,35}\\b"),
  },
  {
    name: "assigned secret value",
    expression: new RegExp(
      "(?:api[_-]?key|client[_-]?secret|private[_-]?key|password)\\s*[:=]\\s*[\\\"'](?!change-me|example|placeholder)[^\\\"']{12,}[\\\"']",
      "i",
    ),
  },
];

for (const file of await workspaceFiles()) {
  const display = relative(WORKSPACE_ROOT, file).replaceAll("\\", "/");
  const name = basename(file).toLowerCase();
  if (name.startsWith(".env") && name !== ".env.example") {
    findings.push(`${display}: local environment file must not enter the workspace artifact set`);
    continue;
  }
  if ([".pem", ".key", ".p12", ".pfx"].some((suffix) => name.endsWith(suffix))) {
    findings.push(`${display}: key or certificate material is not allowed`);
    continue;
  }
  if (!TEXT_EXTENSIONS.some((suffix) => name.endsWith(suffix))) continue;

  const source = await readWorkspaceFile(file);
  for (const pattern of patterns) {
    if (pattern.expression.test(source)) findings.push(`${display}: possible ${pattern.name}`);
  }
}

if (findings.length > 0) {
  console.error("Secret scan failed:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log("Secret scan passed.");
