import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const TERMIX_URL = process.env.TERMIX_URL || "http://localhost:8080";
const TERMIX_USER = process.env.TERMIX_USER || "admin";
const TERMIX_PASSWORD = process.env.TERMIX_PASSWORD || "admin123";

console.log(`\n📦 Building plugin...`);
execSync("npm run build", { stdio: "inherit" });

console.log(`\n📦 Packing plugin...`);
const packOut = execSync("./node_modules/.bin/termix-plugin pack --out dist", {
  encoding: "utf8",
});
console.log(packOut.trim());

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const pkgFile = path.resolve(`dist/${manifest.id}-${manifest.version}.tmxplug`);

if (!fs.existsSync(pkgFile)) {
  console.error(`Error: Package file not found at ${pkgFile}`);
  process.exit(1);
}

const keyPath =
  "/Volumes/Code/test/termix-registry/.keys/termix-plugin-signing.key";
if (fs.existsSync(keyPath)) {
  console.log(`\n🔐 Signing package with local key...`);
  try {
    const key = fs.readFileSync(keyPath, "utf8").trim();
    execSync(
      `TERMIX_PLUGIN_SIGNING_KEY="${key}" ./node_modules/.bin/termix-plugin sign "${pkgFile}"`,
      {
        stdio: "inherit",
      },
    );
  } catch (err) {
    console.warn(`Sign warning: ${err.message}`);
  }
}

console.log(`\n🚀 Uploading and installing to local Termix (${TERMIX_URL})...`);

async function run() {
  // 1. Login
  const loginRes = await fetch(`${TERMIX_URL}/users/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: TERMIX_USER, password: TERMIX_PASSWORD }),
  });

  if (!loginRes.ok) {
    throw new Error(
      `Login failed (${loginRes.status}): ${await loginRes.text()}`,
    );
  }

  const cookie = loginRes.headers.get("set-cookie");
  const headers = cookie ? { Cookie: cookie.split(";")[0] } : {};

  // 2. Enable developer mode
  await fetch(`${TERMIX_URL}/plugins/developer-mode`, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });

  // 3. Upload .tmxplug
  const fileBuf = fs.readFileSync(pkgFile);
  const uploadRes = await fetch(`${TERMIX_URL}/plugins/upload`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/octet-stream" },
    body: fileBuf,
  });

  if (!uploadRes.ok) {
    throw new Error(
      `Upload failed (${uploadRes.status}): ${await uploadRes.text()}`,
    );
  }

  const uploadData = await uploadRes.json();
  const token = uploadData.token;
  const capabilities = uploadData.capabilities || manifest.capabilities || [];

  // 4. Install upload
  const installRes = await fetch(
    `${TERMIX_URL}/plugins/upload/${token}/install`,
    {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ capabilities }),
    },
  );

  if (!installRes.ok) {
    throw new Error(
      `Install failed (${installRes.status}): ${await installRes.text()}`,
    );
  }

  const installData = await installRes.json();
  console.log(
    `\n🎉 Success! ${manifest.name} (v${manifest.version}) is now installed and running in your local Termix.`,
  );
  console.log(
    `👉 Open http://localhost:8080/ to test immediately without waiting for GitHub Actions.`,
  );
}

run().catch((err) => {
  console.error(`\n❌ Local deploy failed:`, err.message);
  process.exit(1);
});
