import fs from "node:fs";
import { execSync } from "node:child_process";

const arg = process.argv[2] || "patch";
const manifestPath = "manifest.json";
const packagePath = "package.json";

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const currentVersion = manifest.version;

function bump(ver, type) {
  const parts = ver.split(".").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) {
    throw new Error(`Invalid semver: ${ver}`);
  }
  if (type === "major") return `${parts[0] + 1}.0.0`;
  if (type === "minor") return `${parts[0]}.${parts[1] + 1}.0`;
  if (type === "patch") return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
  return type.replace(/^v/, "");
}

const nextVersion = bump(currentVersion, arg);
const tag = `v${nextVersion}`;

console.log(
  `Bumping version from ${currentVersion} -> ${nextVersion} (${tag})...`,
);

for (const file of [manifestPath, packagePath]) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  data.version = nextVersion;
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

try {
  execSync(`git add ${manifestPath} ${packagePath}`, { stdio: "inherit" });
  execSync(`git commit -m "chore: bump version to ${tag}"`, {
    stdio: "inherit",
  });
  execSync(`git tag ${tag}`, { stdio: "inherit" });
  execSync(`git push origin HEAD --tags`, { stdio: "inherit" });
  console.log(`\n🎉 Successfully pushed ${tag}!`);
  console.log(
    `GitHub Actions will automatically build, sign, release and update your Termix registry.`,
  );
} catch (err) {
  console.error(`\nFailed to tag/push:`, err.message);
  process.exit(1);
}
