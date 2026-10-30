import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const [registryDir, manifestPath, packagePath, sigPath, tag, repoUrl] =
  process.argv.slice(2);

if (!registryDir || !manifestPath || !packagePath || !sigPath || !tag) {
  console.error(
    "Usage: node update-registry.mjs <registryDir> <manifestPath> <packagePath> <sigPath> <tag> [repoUrl]",
  );
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const pkgBuffer = fs.readFileSync(packagePath);
const sigText = fs.readFileSync(sigPath, "utf8").trim();

const sha256 = crypto.createHash("sha256").update(pkgBuffer).digest("hex");
const size = pkgBuffer.length;
const packageFileName = path.basename(packagePath);
const version = manifest.version;

const registryIndexPath = path.join(registryDir, "index.json");
const registry = JSON.parse(fs.readFileSync(registryIndexPath, "utf8"));

const effectiveRepoUrl =
  repoUrl || `https://github.com/cong-yuan/Plugin-Cloud-Providers-CC`;
const downloadUrl = `${effectiveRepoUrl}/releases/download/${tag}/${packageFileName}`;
const releaseNotesUrl = `${effectiveRepoUrl}/releases/tag/${tag}`;

const now = new Date().toISOString();

const newVersionEntry = {
  version,
  api: String(manifest.api || "1"),
  url: downloadUrl,
  sha256,
  signature: sigText,
  size,
  capabilities: manifest.capabilities || [],
  releaseNotesUrl,
  publishedAt: now,
};

let plugin = registry.plugins.find((p) => p.id === manifest.id);
if (!plugin) {
  plugin = {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description || "",
    author: manifest.author || "cong-yuan",
    category: "Infrastructure",
    repository: effectiveRepoUrl,
    icon: manifest.icon || "Cloud",
    features: [
      "Works with AWS EC2 and Lightsail with automatic key pair download",
      "Picks instances or syncs whole accounts on timer",
      "Detects SSH username, port and keys automatically",
    ],
    versions: [],
  };
  registry.plugins.push(plugin);
}

// Update existing version or prepend new version
const existingVerIndex = plugin.versions.findIndex(
  (v) => v.version === version,
);
if (existingVerIndex >= 0) {
  plugin.versions[existingVerIndex] = newVersionEntry;
} else {
  plugin.versions.unshift(newVersionEntry);
}

registry.updatedAt = now;

fs.writeFileSync(
  registryIndexPath,
  JSON.stringify(registry, null, 2) + "\n",
  "utf8",
);
console.log(`Updated registry index for ${manifest.id}@${version} (${sha256})`);
