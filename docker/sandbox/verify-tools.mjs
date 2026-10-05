// Image-build check for the sandbox toolset contract
// (packages/sandbox/src/image-tools.json): every declared tool runs, no
// excluded tool resolves on PATH, and the vendored semgrep rules validate.
// Agents are told exactly this toolset, so a drift fails the build instead
// of a run.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));
const problems = [];

for (const tool of manifest.present) {
  try {
    execFileSync(tool.check[0], tool.check.slice(1), { stdio: "ignore" });
  } catch (err) {
    problems.push(`declared tool ${tool.name} does not run: ${err.message}`);
  }
}

for (const name of manifest.absent) {
  try {
    const found = execFileSync("sh", ["-c", `command -v ${name}`], {
      encoding: "utf8",
    }).trim();
    problems.push(`excluded tool ${name} is present at ${found}`);
  } catch (err) {
    // `command -v` exits non-zero when the name is unknown (dash: 127, bash: 1);
    // only a failure to run the shell at all is unexpected.
    if (typeof err.status !== "number") throw err;
  }
}

try {
  execFileSync(
    "semgrep",
    [
      "scan",
      "--validate",
      "--metrics",
      "off",
      "--disable-version-check",
      "--config",
      manifest.semgrep_rules,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
} catch (err) {
  problems.push(
    `semgrep rules at ${manifest.semgrep_rules} do not validate: ${String(err.stderr ?? err.message).slice(-2000)}`,
  );
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(
  `sandbox toolset verified: ${manifest.present.map((t) => t.name).join(", ")}`,
);
