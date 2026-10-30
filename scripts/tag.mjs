import fs from "node:fs";
import { execSync } from "node:child_process";

const arg = process.argv[2] || "patch";
const message = process.argv[3] || "Maintenance update and release";
const manifestPath = "manifest.json";
const packagePath = "package.json";
const changelogPath = "CHANGELOG.md";

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

// Update manifest and package.json
for (const file of [manifestPath, packagePath]) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  data.version = nextVersion;
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

// Update CHANGELOG.md
if (fs.existsSync(changelogPath)) {
  let changelog = fs.readFileSync(changelogPath, "utf8");
  if (!changelog.includes(`## ${nextVersion}`)) {
    changelog = changelog.replace(
      /^# Changelog\s*\n/m,
      `# Changelog\n\n## ${nextVersion}\n\n### Changed\n\n- ${message}\n\n`,
    );
    fs.writeFileSync(changelogPath, changelog, "utf8");
  }
}

try {
  execSync(`git add ${manifestPath} ${packagePath} ${changelogPath}`, {
    stdio: "inherit",
  });
  execSync(`git commit -m "chore: bump version to ${tag}"`, {
    stdio: "inherit",
  });
  execSync(`git tag ${tag}`, { stdio: "inherit" });
  execSync(`git push origin HEAD --tags`, { stdio: "inherit" });
  try {
    execSync(
      `gh workflow run release.yml -R cong-yuan/Plugin-Cloud-Providers-CC -f tag=${tag}`,
      { stdio: "inherit" },
    );
  } catch {
    // optional fallback
  }
  console.log(`\n🎉 Successfully pushed ${tag}!`);
  console.log(
    `GitHub Actions will automatically build, sign, release and update your Termix registry.`,
  );
} catch (err) {
  console.error(`\nFailed to tag/push:`, err.message);
  process.exit(1);
}
