import crypto from "node:crypto";
import type { PluginFetch } from "@termix-ssh/plugin-sdk/backend";
import { signV4 } from "./auth/sigv4.js";
import { send, splitList } from "./http.js";
import { child, childText, items, parseXml } from "./xml.js";
import type { CloudInstance, Credentials, Provider } from "./types.js";

const EC2_VERSION = "2016-11-15";
const LIGHTSAIL_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-2",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "eu-central-1",
  "eu-north-1",
  "ca-central-1",
  "ap-south-1",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-northeast-1",
  "ap-northeast-2",
];

interface Keys {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

function keys(creds: Credentials): Keys {
  return {
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    sessionToken: creds.sessionToken || undefined,
  };
}

async function ec2Call(
  fetch: PluginFetch,
  creds: Credentials,
  region: string,
  params: Record<string, string>,
): Promise<ReturnType<typeof parseXml>> {
  const url = `https://ec2.${region}.amazonaws.com/`;
  const body = new URLSearchParams({
    ...params,
    Version: EC2_VERSION,
  }).toString();
  const headers = signV4({
    method: "POST",
    url,
    region,
    service: "ec2",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    ...keys(creds),
  });
  const response = await send(fetch, url, { method: "POST", headers, body });
  return parseXml(await response.text());
}

async function regionsFor(
  fetch: PluginFetch,
  creds: Credentials,
): Promise<string[]> {
  const chosen = splitList(creds.regions);
  if (chosen.length && !chosen.includes("all")) return chosen;
  const root = await ec2Call(fetch, creds, "us-east-1", {
    Action: "DescribeRegions",
  });
  const names = items(root, "regionInfo")
    .map((r) => childText(r, "regionName"))
    .filter((n): n is string => Boolean(n));
  return names.length ? names : ["us-east-1"];
}

async function listEc2(
  fetch: PluginFetch,
  creds: Credentials,
  region: string,
): Promise<CloudInstance[]> {
  const out: CloudInstance[] = [];
  let token: string | undefined;
  for (let page = 0; page < 200; page += 1) {
    const params: Record<string, string> = { Action: "DescribeInstances" };
    if (token) params.NextToken = token;
    const root = await ec2Call(fetch, creds, region, params);
    for (const reservation of items(root, "reservationSet")) {
      for (const node of items(reservation, "instancesSet")) {
        const state = childText(child(node, "instanceState"), "name");
        if (state === "terminated" || state === "shutting-down") continue;
        const tags = items(node, "tagSet").map((t) => ({
          key: childText(t, "key") ?? "",
          value: childText(t, "value") ?? "",
        }));
        const id = childText(node, "instanceId") ?? "";
        const keyName = childText(node, "keyName");
        const platform = childText(node, "platform");
        const inst: CloudInstance = {
          id: `${region}/${id}`,
          name: tags.find((t) => t.key === "Name")?.value || id,
          publicIp: childText(node, "ipAddress") ?? null,
          privateIp: childText(node, "privateIpAddress") ?? null,
          region,
          state:
            state === "running"
              ? "running"
              : state === "stopped"
                ? "stopped"
                : "other",
          tags: tags
            .filter((t) => t.key !== "Name" && !t.key.startsWith("aws:"))
            .map((t) => (t.value ? `${t.key}:${t.value}` : t.key)),
        };
        if (keyName) inst.keyName = keyName;
        if (platform === "windows") inst.user = "Administrator";
        inst.network = {
          type: "pay_as_you_go",
          label: "按量计费 (最高 5 Gbps)",
        };
        out.push(inst);
      }
    }
    token = childText(root, "nextToken");
    if (!token) break;
  }
  return out;
}

interface LightsailPort {
  fromPort: number;
  toPort: number;
  protocol: string;
}

interface LightsailInstance {
  name: string;
  username?: string;
  sshKeyName?: string;
  publicIpAddress?: string;
  privateIpAddress?: string;
  state?: { name?: string };
  location?: { regionName?: string };
  tags?: Array<{ key: string; value?: string }>;
  networking?: {
    ports?: LightsailPort[];
    monthlyTransfer?: {
      gbPerMonthAllocated?: number;
    };
  };
}

function toRsaPrivateKeyPem(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes("-----BEGIN")) {
    return trimmed;
  }
  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8");
    if (decoded.includes("-----BEGIN")) {
      return decoded.trim();
    }
  } catch {}
  const clean = trimmed.replace(/\s+/g, "");
  const lines = clean.match(/.{1,64}/g) || [clean];
  return `-----BEGIN RSA PRIVATE KEY-----\n${lines.join("\n")}\n-----END RSA PRIVATE KEY-----\n`;
}

function rsaToOpenSshPublicKey(
  privateKeyPem: string,
  rawPublicKey?: string,
): string {
  try {
    const priv = crypto.createPrivateKey(privateKeyPem);
    const pub = crypto.createPublicKey(priv);
    const jwk = pub.export({ format: "jwk" });
    if (jwk.kty === "RSA" && jwk.n && jwk.e) {
      const e = Buffer.from(jwk.e, "base64url");
      const n = Buffer.from(jwk.n, "base64url");
      const eBuf = e[0] & 0x80 ? Buffer.concat([Buffer.from([0]), e]) : e;
      const nBuf = n[0] & 0x80 ? Buffer.concat([Buffer.from([0]), n]) : n;
      const prefix = Buffer.from("ssh-rsa");
      const len = 4 + prefix.length + 4 + eBuf.length + 4 + nBuf.length;
      const buf = Buffer.alloc(len);
      let offset = 0;
      buf.writeUInt32BE(prefix.length, offset);
      offset += 4;
      prefix.copy(buf, offset);
      offset += prefix.length;
      buf.writeUInt32BE(eBuf.length, offset);
      offset += 4;
      eBuf.copy(buf, offset);
      offset += eBuf.length;
      buf.writeUInt32BE(nBuf.length, offset);
      offset += 4;
      nBuf.copy(buf, offset);
      return `ssh-rsa ${buf.toString("base64")}`;
    }
  } catch {}

  if (rawPublicKey) {
    const trimmed = rawPublicKey.trim();
    if (trimmed.startsWith("ssh-rsa")) return trimmed;
    try {
      const decoded = Buffer.from(trimmed, "base64").toString("utf8");
      if (decoded.startsWith("ssh-rsa")) return decoded.trim();
    } catch {}
    const clean = trimmed.replace(/\s+/g, "");
    const lines = clean.match(/.{1,64}/g) || [clean];
    const pubPem = `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----\n`;
    try {
      const pub = crypto.createPublicKey(pubPem);
      const jwk = pub.export({ format: "jwk" });
      if (jwk.n && jwk.e) {
        const e = Buffer.from(jwk.e, "base64url");
        const n = Buffer.from(jwk.n, "base64url");
        const eBuf = e[0] & 0x80 ? Buffer.concat([Buffer.from([0]), e]) : e;
        const nBuf = n[0] & 0x80 ? Buffer.concat([Buffer.from([0]), n]) : n;
        const prefix = Buffer.from("ssh-rsa");
        const len = 4 + prefix.length + 4 + eBuf.length + 4 + nBuf.length;
        const buf = Buffer.alloc(len);
        let offset = 0;
        buf.writeUInt32BE(prefix.length, offset);
        offset += 4;
        prefix.copy(buf, offset);
        offset += prefix.length;
        buf.writeUInt32BE(eBuf.length, offset);
        offset += 4;
        eBuf.copy(buf, offset);
        offset += eBuf.length;
        buf.writeUInt32BE(nBuf.length, offset);
        offset += 4;
        nBuf.copy(buf, offset);
        return `ssh-rsa ${buf.toString("base64")}`;
      }
    } catch {}
  }
  return "";
}

async function downloadLightsailDefaultKeyPair(
  fetch: PluginFetch,
  creds: Credentials,
  region: string,
): Promise<{
  name: string;
  privateKey: string;
  publicKey: string;
  keyType: string;
} | null> {
  try {
    const url = `https://lightsail.${region}.amazonaws.com/`;
    const body = "{}";
    const headers = signV4({
      method: "POST",
      url,
      region,
      service: "lightsail",
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": "Lightsail_20161128.DownloadDefaultKeyPair",
      },
      body,
      ...keys(creds),
    });
    const response = await send(fetch, url, { method: "POST", headers, body });
    const json = (await response.json()) as {
      privateKeyBase64?: string;
      publicKeyBase64?: string;
    };
    if (!json.privateKeyBase64) return null;
    const privateKey = toRsaPrivateKeyPem(json.privateKeyBase64);
    const publicKey = rsaToOpenSshPublicKey(privateKey, json.publicKeyBase64);
    return {
      name: `Lightsail-${region}-DefaultKeyPair`,
      privateKey,
      publicKey,
      keyType: "ssh-rsa",
    };
  } catch {
    return null;
  }
}

function detectLightsailPort(i: LightsailInstance): number {
  for (const t of i.tags ?? []) {
    if (t.key.toLowerCase() === "termix-port" && t.value) {
      const p = Number(t.value);
      if (p > 0 && p <= 65535) return p;
    }
    const match = /^termix-port[:=](\d+)$/i.exec(t.key);
    if (match) {
      const p = Number(match[1]);
      if (p > 0 && p <= 65535) return p;
    }
  }
  return 22;
}

async function getLightsailMetric(
  fetch: PluginFetch,
  creds: Credentials,
  region: string,
  instanceName: string,
): Promise<number | null> {
  try {
    const url = `https://lightsail.${region}.amazonaws.com/`;
    const now = new Date();
    const startTime = Math.floor(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000,
    );
    const endTime = Math.floor(Date.now() / 1000);

    const body = JSON.stringify({
      instanceName,
      metricName: "NetworkOut",
      period: 86400,
      startTime,
      endTime,
      unit: "Bytes",
      statistics: ["Sum"],
    });

    const headers = signV4({
      method: "POST",
      url,
      region,
      service: "lightsail",
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": "Lightsail_20161128.GetInstanceMetricData",
      },
      body,
      ...keys(creds),
    });

    const response = await send(fetch, url, { method: "POST", headers, body });
    if (!response.ok) return null;
    const json = (await response.json()) as {
      metricData?: Array<{ sum?: number }>;
    };
    if (json.metricData && json.metricData.length > 0) {
      const totalBytes = json.metricData.reduce(
        (acc, dp) => acc + (dp.sum || 0),
        0,
      );
      return totalBytes;
    }
    return 0;
  } catch {
    return null;
  }
}

async function listLightsail(
  fetch: PluginFetch,
  creds: Credentials,
  region: string,
): Promise<CloudInstance[]> {
  const out: CloudInstance[] = [];
  const url = `https://lightsail.${region}.amazonaws.com/`;
  let pageToken: string | undefined;
  let defaultKeyPromise: Promise<{
    name: string;
    privateKey: string;
    publicKey: string;
    keyType: string;
  } | null> | null = null;

  for (let page = 0; page < 200; page += 1) {
    const body = JSON.stringify(pageToken ? { pageToken } : {});
    const headers = signV4({
      method: "POST",
      url,
      region,
      service: "lightsail",
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": "Lightsail_20161128.GetInstances",
      },
      body,
      ...keys(creds),
    });
    const response = await send(fetch, url, { method: "POST", headers, body });
    const json = (await response.json()) as {
      instances?: LightsailInstance[];
      nextPageToken?: string;
    };
    for (const i of json.instances ?? []) {
      const port = detectLightsailPort(i);
      const inst: CloudInstance = {
        id: `lightsail/${region}/${i.name}`,
        name: i.name,
        publicIp: i.publicIpAddress ?? null,
        privateIp: i.privateIpAddress ?? null,
        region,
        state:
          i.state?.name === "running"
            ? "running"
            : i.state?.name === "stopped"
              ? "stopped"
              : "other",
        tags: (i.tags ?? []).map((t) =>
          t.value ? `${t.key}:${t.value}` : t.key,
        ),
      };
      if (i.username) inst.user = i.username;
      if (port !== 22) inst.port = port;
      if (i.sshKeyName) inst.keyName = i.sshKeyName;

      const transferGb = i.networking?.monthlyTransfer?.gbPerMonthAllocated;
      if (typeof transferGb === "number" && transferGb > 0) {
        const quotaStr =
          transferGb >= 1000
            ? `${(transferGb / 1000).toFixed(transferGb % 1000 === 0 ? 0 : 1)} TB`
            : `${transferGb} GB`;
        inst.network = {
          type: "traffic_package",
          monthlyTransferGb: transferGb,
          label: `${quotaStr}/月`,
        };

        if (inst.state === "running") {
          try {
            const usedBytes = await Promise.race([
              getLightsailMetric(fetch, creds, region, i.name),
              new Promise<null>((resolve) =>
                setTimeout(() => resolve(null), 2500),
              ),
            ]);
            if (typeof usedBytes === "number") {
              const usedGb = Number(
                (usedBytes / (1024 * 1024 * 1024)).toFixed(2),
              );
              inst.network.usedTransferGb = usedGb;
              const percent = ((usedGb / transferGb) * 100).toFixed(1);
              inst.network.label = `${usedGb} GB / ${quotaStr} (${percent}%)`;
            }
          } catch {}
        }
      }

      const isDefaultKey =
        !i.sshKeyName || i.sshKeyName.toLowerCase().includes("defaultkeypair");

      if (isDefaultKey) {
        if (!defaultKeyPromise) {
          defaultKeyPromise = downloadLightsailDefaultKeyPair(
            fetch,
            creds,
            region,
          );
        }
        const autoKey = await defaultKeyPromise;
        if (autoKey) {
          inst.autoKey = autoKey;
        }
      }

      out.push(inst);
    }
    pageToken = json.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

export const aws: Provider = {
  id: "aws",
  defaultUser: "ec2-user",
  fields: [
    { key: "accessKeyId", type: "text", required: true },
    { key: "secretAccessKey", type: "secret", required: true },
    { key: "sessionToken", type: "secret", required: false },
    {
      key: "regions",
      type: "text",
      required: false,
      placeholder: "us-east-1, eu-west-1",
    },
    {
      key: "service",
      type: "select",
      required: true,
      options: ["both", "lightsail", "ec2"],
    },
  ],
  async list(creds, fetch) {
    const service = creds.service || "both";
    const out: CloudInstance[] = [];
    if (service === "ec2" || service === "both") {
      for (const region of await regionsFor(fetch, creds)) {
        out.push(...(await listEc2(fetch, creds, region)));
      }
    }
    if (service === "lightsail" || service === "both") {
      const chosen = splitList(creds.regions);
      const regions =
        chosen.length && !chosen.includes("all") ? chosen : LIGHTSAIL_REGIONS;
      for (const region of regions) {
        out.push(...(await listLightsail(fetch, creds, region)));
      }
    }
    return out;
  },
};
