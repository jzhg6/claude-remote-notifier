import AdmZip from "adm-zip";
import { readFile, readdir } from "node:fs/promises";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const expected = `claude-remote-notifier-${packageJson.version}.vsix`;
const candidates = (await readdir(".")).filter((name) =>
  name.endsWith(".vsix"),
);
if (candidates.length !== 1 || candidates[0] !== expected) {
  throw new Error(
    `Expected exactly ${expected}; found ${candidates.join(", ") || "none"}`,
  );
}
const zip = new AdmZip(expected);
const names = zip.getEntries().map((entry) => entry.entryName);
const forbidden = [
  /node_modules\//,
  /(?:^|\/)test\//,
  /(?:^|\/)src\//,
  /\.claude\//,
  /settings(?:\.local)?\.json$/,
  /\.map$/,
  /\.env(?:\.|$)/,
  /\/home\//,
];
for (const name of names) {
  for (const pattern of forbidden) {
    if (pattern.test(name)) throw new Error(`Forbidden VSIX entry: ${name}`);
  }
}
const required = [
  "extension/dist/extension.js",
  "extension/resources/hook/event-bridge.cjs",
  "extension/README.md",
  "extension/README_CN.md",
  "extension/LICENSE.txt",
  "extension/THIRD_PARTY_NOTICES.md",
  "extension/media/icon.png",
];
const lowerNames = new Set(names.map((name) => name.toLowerCase()));
for (const name of required) {
  if (!lowerNames.has(name.toLowerCase()))
    throw new Error(`Missing VSIX entry: ${name}`);
}
const extension = zip.readAsText("extension/dist/extension.js");
if (
  /\/home\/[^/]+\//.test(extension) ||
  /[A-Z]:\\Users\\[^\\]+\\/i.test(extension)
) {
  throw new Error("VSIX contains a local absolute path");
}
console.log(`vsix_audit=clean entries=${names.length}`);
