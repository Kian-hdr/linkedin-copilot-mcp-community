/** Supplemental tracked-file hygiene; use a full-history secret scanner as well. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const paths = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
if (!paths.length) throw Error("No staged/tracked files to review.");
const failures = [];
for (const path of paths) {
  if (
    /(^|\/)(node_modules|runtime|data|\.openai|\.shared-memory)(\/|$)|\.(sqlite(?:-wal|-shm)?|db|log|pem|key|zip|tgz)$/i.test(
      path,
    ) ||
    (/(^|\/)\.env(?:\.|$)/.test(path) && !path.endsWith(".example"))
  )
    failures.push(path + ": excluded file class");
  const bytes = readFileSync(path);
  const text = bytes.toString("utf8");
  if (bytes.subarray(0, 16).equals(Buffer.from("SQLite format 3\0")))
    failures.push(path + ": SQLite data");
  if (
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|appgprj_[a-f0-9]{20,}|appgdep_[a-f0-9]{20,}/.test(
      text,
    )
  )
    failures.push(path + ": possible credential or deployment identifier");
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else
  console.log(
    `Reviewed ${paths.length} tracked paths: supplemental hygiene passed. Manual and full-history review still required.`,
  );
