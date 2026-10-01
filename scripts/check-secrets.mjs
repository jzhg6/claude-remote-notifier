import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

const roots = [
  "src",
  "resources",
  "test",
  "scripts",
  ".github",
  "README.md",
  "README_CN.md",
  "SECURITY.md",
];
const excluded = new Set(["node_modules", ".git", "dist", "coverage"]);
const patterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
];

const findings = [];
for (const root of roots) await scan(root);
if (findings.length > 0) {
  console.error("Potential secrets found:\n" + findings.join("\n"));
  process.exit(1);
}
console.log("secret_scan=clean");

async function scan(path) {
  let info;
  try {
    info = await stat(path);
  } catch {
    return;
  }
  if (info.isDirectory()) {
    if (excluded.has(path.split(/[\\/]/).at(-1))) return;
    for (const entry of await readdir(path)) await scan(join(path, entry));
    return;
  }
  if (!info.isFile() || info.size > 1024 * 1024) return;
  const text = await readFile(path, "utf8");
  for (const pattern of patterns) {
    if (pattern.test(text))
      findings.push(`${relative(process.cwd(), path)} matched ${pattern}`);
  }
}
