import crypto from "node:crypto";
import type { PluginFetch } from "@termix-ssh/plugin-sdk/backend";
import { FetchHttpHandler } from "@smithy/fetch-http-handler";
import {
  EC2Client,
  DescribeRegionsCommand,
  DescribeInstancesCommand,
} from "@aws-sdk/client-ec2";
import {
  LightsailClient,
  GetInstancesCommand,
  DownloadDefaultKeyPairCommand,
  GetInstanceMetricDataCommand,
  CreateInstancesCommand,
  GetInstancePortStatesCommand,
  OpenInstancePublicPortsCommand,
  CloseInstancePublicPortsCommand,
  GetRegionsCommand,
  GetBundlesCommand,
} from "@aws-sdk/client-lightsail";
import { splitList } from "./http.js";
import type { CloudInstance, Credentials, Provider } from "./types.js";

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

function createRequestHandler(fetch?: PluginFetch) {
  if (fetch) {
    return new FetchHttpHandler({
      customFetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        if (input instanceof Request) {
          const headers: Record<string, string> = {};
          input.headers.forEach((v, k) => {
            headers[k.toLowerCase()] = v;
          });
          let body: string | undefined = undefined;
          if (input.method !== "GET" && input.method !== "HEAD") {
            body = await input.text();
          }
          return fetch(input.url, {
            method: input.method,
            headers,
            body: body || undefined,
          });
        }
        return fetch(
          typeof input === "string" ? input : input.toString(),
          init as any,
        );
      },
    });
  }
  return new FetchHttpHandler();
}

function getEc2Client(
  creds: Credentials,
  region: string,
  fetch?: PluginFetch,
): EC2Client {
  return new EC2Client({
    region,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken || undefined,
    },
    requestHandler: createRequestHandler(fetch),
  });
}

function getLightsailClient(
  creds: Credentials,
  region: string,
  fetch?: PluginFetch,
): LightsailClient {
  return new LightsailClient({
    region,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken || undefined,
    },
    requestHandler: createRequestHandler(fetch),
  });
}

async function regionsFor(
  fetch: PluginFetch | undefined,
  creds: Credentials,
): Promise<string[]> {
  const chosen = splitList(creds.regions);
  if (chosen.length && !chosen.includes("all")) return chosen;
  try {
    const client = getEc2Client(creds, "us-east-1", fetch);
    const res = await client.send(new DescribeRegionsCommand({}));
    const names = (res.Regions ?? [])
      .map((r) => r.RegionName)
      .filter((n): n is string => Boolean(n));
    return names.length ? names : ["us-east-1"];
  } catch {
    return ["us-east-1"];
  }
}

async function listEc2(
  fetch: PluginFetch | undefined,
  creds: Credentials,
  region: string,
): Promise<CloudInstance[]> {
  const out: CloudInstance[] = [];
  const client = getEc2Client(creds, region, fetch);
  let token: string | undefined;

  for (let page = 0; page < 200; page += 1) {
    const res = await client.send(
      new DescribeInstancesCommand({
        NextToken: token,
      }),
    );

    for (const reservation of res.Reservations ?? []) {
      for (const node of reservation.Instances ?? []) {
        const state = node.State?.Name;
        if (state === "terminated" || state === "shutting-down") continue;
        const tags = (node.Tags ?? []).map((t) => ({
          key: t.Key ?? "",
          value: t.Value ?? "",
        }));
        const id = node.InstanceId ?? "";
        const keyName = node.KeyName;
        const platform = node.Platform;
        const az = node.Placement?.AvailabilityZone;
        const inst: CloudInstance = {
          id: `${region}/${id}`,
          name: tags.find((t) => t.key === "Name")?.value || id,
          publicIp: node.PublicIpAddress ?? null,
          privateIp: node.PrivateIpAddress ?? null,
          region: az || region,
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
        if (platform?.toLowerCase() === "windows") inst.user = "Administrator";
        inst.network = {
          type: "pay_as_you_go",
          label: "按量计费 (最高 5 Gbps)",
        };
        out.push(inst);
      }
    }
    token = res.NextToken;
    if (!token) break;
  }
  return out;
}

interface LightsailPort {
  fromPort: number;
  toPort: number;
  protocol: string;
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

function detectLightsailPort(i: {
  tags?: Array<{ key?: string; value?: string }>;
}): number {
  for (const t of i.tags ?? []) {
    if (t.key?.toLowerCase() === "termix-port" && t.value) {
      const p = Number(t.value);
      if (p > 0 && p <= 65535) return p;
    }
    const match = /^termix-port[:=](\d+)$/i.exec(t.key || "");
    if (match) {
      const p = Number(match[1]);
      if (p > 0 && p <= 65535) return p;
    }
  }
  return 22;
}

async function getLightsailMetric(
  fetch: PluginFetch | undefined,
  creds: Credentials,
  region: string,
  instanceName: string,
): Promise<number | null> {
  try {
    const client = getLightsailClient(creds, region, fetch);
    const now = new Date();
    const startTime = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    const endTime = now;

    const res = await client.send(
      new GetInstanceMetricDataCommand({
        instanceName,
        metricName: "NetworkOut",
        period: 86400,
        startTime,
        endTime,
        unit: "Bytes",
        statistics: ["Sum"],
      }),
    );

    if (res.metricData && res.metricData.length > 0) {
      const totalBytes = res.metricData.reduce(
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

async function downloadLightsailDefaultKeyPair(
  fetch: PluginFetch | undefined,
  creds: Credentials,
  region: string,
): Promise<{
  name: string;
  privateKey: string;
  publicKey: string;
  keyType: string;
} | null> {
  try {
    const client = getLightsailClient(creds, region, fetch);
    const res = await client.send(new DownloadDefaultKeyPairCommand({}));
    if (!res.privateKeyBase64) return null;
    const privateKey = toRsaPrivateKeyPem(res.privateKeyBase64);
    const publicKey = rsaToOpenSshPublicKey(privateKey, res.publicKeyBase64);
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

async function listLightsail(
  fetch: PluginFetch | undefined,
  creds: Credentials,
  region: string,
): Promise<CloudInstance[]> {
  const out: CloudInstance[] = [];
  const client = getLightsailClient(creds, region, fetch);
  let pageToken: string | undefined;
  let defaultKeyPromise: Promise<{
    name: string;
    privateKey: string;
    publicKey: string;
    keyType: string;
  } | null> | null = null;

  for (let page = 0; page < 200; page += 1) {
    const res = await client.send(
      new GetInstancesCommand({
        pageToken,
      }),
    );

    for (const i of res.instances ?? []) {
      const port = detectLightsailPort(i);
      const zone = i.location?.availabilityZone || region;
      const inst: CloudInstance = {
        id: `lightsail/${region}/${i.name}`,
        name: i.name ?? "",
        publicIp: i.publicIpAddress ?? null,
        privateIp: i.privateIpAddress ?? null,
        region: zone,
        state:
          i.state?.name === "running"
            ? "running"
            : i.state?.name === "stopped"
              ? "stopped"
              : "other",
        tags: (i.tags ?? []).map((t) =>
          t.value ? `${t.key}:${t.value}` : (t.key ?? ""),
        ),
        details: {
          blueprintId: i.blueprintId,
          blueprintName: i.blueprintName,
          bundleId: i.bundleId,
          cpuCount: i.hardware?.cpuCount,
          ramSizeGb: i.hardware?.ramSizeInGb,
          diskSizeGb: i.hardware?.disks?.[0]?.sizeInGb,
          isStaticIp: i.isStaticIp,
          availabilityZone: i.location?.availabilityZone,
          regionName: i.location?.regionName,
          createdAt:
            typeof i.createdAt === "string"
              ? i.createdAt
              : (i.createdAt as Date)?.toISOString?.(),
          arn: i.arn,
        },
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

        if (inst.state === "running" && i.name) {
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
    pageToken = res.nextPageToken;
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

export const AWS_REGION_NAMES: Record<string, string> = {
  "us-east-1": "N. Virginia",
  "us-east-2": "Ohio",
  "us-west-1": "N. California",
  "us-west-2": "Oregon",
  "af-south-1": "Cape Town",
  "ap-east-1": "Hong Kong",
  "ap-south-1": "Mumbai",
  "ap-northeast-3": "Osaka",
  "ap-northeast-2": "Seoul",
  "ap-southeast-1": "Singapore",
  "ap-southeast-2": "Sydney",
  "ap-northeast-1": "Tokyo",
  "ca-central-1": "Central",
  "eu-central-1": "Frankfurt",
  "eu-west-1": "Ireland",
  "eu-west-2": "London",
  "eu-south-1": "Milan",
  "eu-west-3": "Paris",
  "eu-north-1": "Stockholm",
  "me-south-1": "Bahrain",
  "sa-east-1": "São Paulo",
};

export function cleanAwsRegion(raw: string | null | undefined): string {
  if (!raw) return "us-east-2";
  const first = raw.split(/[\s,]+/)[0].trim();
  const match = first.match(/^([a-z]{2}-[a-z]+-\d+)[a-z]?$/i);
  return match ? match[1].toLowerCase() : first.toLowerCase() || "us-east-2";
}

export function toBaseAwsRegion(r: string | null | undefined): string {
  if (!r) return "";
  const trimmed = r.trim();
  const match = trimmed.match(/^([a-z]{2}-[a-z]+-\d+)[a-z]$/i);
  return match ? match[1].toLowerCase() : trimmed;
}

export function formatAwsZone(raw: string | null | undefined): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (trimmed.includes("Zone") || trimmed.includes(",")) return trimmed;
  const match = trimmed.match(/^([a-z]{2}-[a-z]+-\d+)([a-z])$/i);
  if (match) {
    const region = match[1].toLowerCase();
    const letter = match[2].toUpperCase();
    const regionName = AWS_REGION_NAMES[region];
    if (regionName) {
      return `${regionName}, Zone ${letter} (${trimmed})`;
    }
    return `Zone ${letter} (${trimmed})`;
  }
  const regName = AWS_REGION_NAMES[trimmed.toLowerCase()];
  if (regName) {
    return `${regName} (${trimmed})`;
  }
  return trimmed;
}

export const DEFAULT_LIGHTSAIL_BLUEPRINTS = [
  {
    id: "debian_12",
    name: "Debian 12 (Bookworm)",
    type: "os",
    defaultUser: "admin",
  },
  {
    id: "ubuntu_24_04",
    name: "Ubuntu 24.04 LTS",
    type: "os",
    defaultUser: "ubuntu",
  },
  {
    id: "ubuntu_22_04",
    name: "Ubuntu 22.04 LTS",
    type: "os",
    defaultUser: "ubuntu",
  },
  {
    id: "amazon_linux_2023",
    name: "Amazon Linux 2023",
    type: "os",
    defaultUser: "ec2-user",
  },
  {
    id: "almalinux_9",
    name: "AlmaLinux 9",
    type: "os",
    defaultUser: "ec2-user",
  },
  {
    id: "debian_11",
    name: "Debian 11 (Bullseye)",
    type: "os",
    defaultUser: "admin",
  },
  {
    id: "ubuntu_20_04",
    name: "Ubuntu 20.04 LTS",
    type: "os",
    defaultUser: "ubuntu",
  },
];

export const DEFAULT_DUAL_STACK_BUNDLES = [
  {
    id: "nano_3_0",
    name: "$5.00/月 · 512 MB 内存 / 1 核 / 20 GB SSD / 1 TB 流量",
    price: 5.0,
    ramGb: 0.5,
    vCpu: 1,
    diskGb: 20,
    transferGb: 1000,
  },
  {
    id: "micro_3_0",
    name: "$7.00/月 · 1 GB 内存 / 1 核 / 40 GB SSD / 2 TB 流量 (推荐)",
    price: 7.0,
    ramGb: 1.0,
    vCpu: 1,
    diskGb: 40,
    transferGb: 2000,
  },
  {
    id: "small_3_0",
    name: "$12.00/月 · 2 GB 内存 / 1 核 / 60 GB SSD / 3 TB 流量 (畅销)",
    price: 12.0,
    ramGb: 2.0,
    vCpu: 1,
    diskGb: 60,
    transferGb: 3000,
  },
  {
    id: "medium_3_0",
    name: "$24.00/月 · 4 GB 内存 / 2 核 / 80 GB SSD / 4 TB 流量",
    price: 24.0,
    ramGb: 4.0,
    vCpu: 2,
    diskGb: 80,
    transferGb: 4000,
  },
  {
    id: "large_3_0",
    name: "$44.00/月 · 8 GB 内存 / 2 核 / 160 GB SSD / 5 TB 流量",
    price: 44.0,
    ramGb: 8.0,
    vCpu: 2,
    diskGb: 160,
    transferGb: 5000,
  },
  {
    id: "xlarge_3_0",
    name: "$84.00/月 · 16 GB 内存 / 4 核 / 320 GB SSD / 6 TB 流量",
    price: 84.0,
    ramGb: 16.0,
    vCpu: 4,
    diskGb: 320,
    transferGb: 6000,
  },
];

export const DEFAULT_IPV6_ONLY_BUNDLES = [
  {
    id: "nano_ipv6_3_0",
    name: "$3.50/月 · 512 MB 内存 / 1 核 / 20 GB SSD / 1 TB 流量",
    price: 3.5,
    ramGb: 0.5,
    vCpu: 1,
    diskGb: 20,
    transferGb: 1000,
  },
  {
    id: "micro_ipv6_3_0",
    name: "$5.00/月 · 1 GB 内存 / 1 核 / 40 GB SSD / 2 TB 流量 (推荐)",
    price: 5.0,
    ramGb: 1.0,
    vCpu: 1,
    diskGb: 40,
    transferGb: 2000,
  },
  {
    id: "small_ipv6_3_0",
    name: "$10.00/月 · 2 GB 内存 / 1 核 / 60 GB SSD / 3 TB 流量 (畅销)",
    price: 10.0,
    ramGb: 2.0,
    vCpu: 1,
    diskGb: 60,
    transferGb: 3000,
  },
  {
    id: "medium_ipv6_3_0",
    name: "$20.00/月 · 4 GB 内存 / 2 核 / 80 GB SSD / 4 TB 流量",
    price: 20.0,
    ramGb: 4.0,
    vCpu: 2,
    diskGb: 80,
    transferGb: 4000,
  },
  {
    id: "large_ipv6_3_0",
    name: "$40.00/月 · 8 GB 内存 / 2 核 / 160 GB SSD / 5 TB 流量",
    price: 40.0,
    ramGb: 8.0,
    vCpu: 2,
    diskGb: 160,
    transferGb: 5000,
  },
  {
    id: "xlarge_ipv6_3_0",
    name: "$80.00/月 · 16 GB 内存 / 4 核 / 320 GB SSD / 6 TB 流量",
    price: 80.0,
    ramGb: 16.0,
    vCpu: 4,
    diskGb: 320,
    transferGb: 6000,
  },
];

export const DEFAULT_LIGHTSAIL_BUNDLES = DEFAULT_DUAL_STACK_BUNDLES;

export interface CreateLightsailInput {
  instanceName: string;
  region: string;
  availabilityZone?: string;
  blueprintId: string;
  bundleId: string;
  keyPairName?: string;
  userData?: string;
  enableAutoSnapshot?: boolean;
  snapshotTimeOfDay?: string;
}

export async function createLightsailInstance(
  fetch: PluginFetch | undefined,
  creds: Credentials,
  input: CreateLightsailInput,
): Promise<{ ok: boolean; instanceName: string }> {
  const region = cleanAwsRegion(
    input.region || input.availabilityZone || "us-east-2",
  );
  let zone = input.availabilityZone?.trim();
  if (!zone || !zone.startsWith(region)) {
    zone = `${region}a`;
  }

  const isIpv6Bundle = input.bundleId.includes("ipv6");
  const ipAddressType = isIpv6Bundle ? "ipv6" : "dualstack";

  const addOns: any[] = [];
  if (input.enableAutoSnapshot) {
    const addOnReq: { snapshotTimeOfDay?: string } = {};
    if (
      input.snapshotTimeOfDay &&
      /^[0-9]{2}:00$/.test(input.snapshotTimeOfDay.trim())
    ) {
      addOnReq.snapshotTimeOfDay = input.snapshotTimeOfDay.trim();
    }
    addOns.push({
      addOnType: "AutoSnapshot",
      autoSnapshotAddOnRequest: addOnReq,
    });
  }

  const client = getLightsailClient(creds, region, fetch);
  try {
    await client.send(
      new CreateInstancesCommand({
        instanceNames: [input.instanceName],
        availabilityZone: zone,
        blueprintId: input.blueprintId,
        bundleId: input.bundleId,
        ipAddressType: ipAddressType as any,
        keyPairName: input.keyPairName?.trim() || undefined,
        userData: input.userData?.trim() || undefined,
        addOns: addOns.length > 0 ? addOns : undefined,
      }),
    );
  } catch (err: any) {
    const msg = err?.message || String(err);
    throw new Error(msg);
  }

  return { ok: true, instanceName: input.instanceName };
}

export interface LightsailPortRule {
  fromPort: number;
  toPort: number;
  protocol: string;
  cidrs?: string[];
  ipv6Cidrs?: string[];
}

export async function getLightsailPortStates(
  fetch: PluginFetch | undefined,
  creds: Credentials,
  region: string,
  instanceName: string,
): Promise<LightsailPortRule[]> {
  try {
    const client = getLightsailClient(creds, region, fetch);
    const res = await client.send(
      new GetInstancePortStatesCommand({
        instanceName,
      }),
    );
    return (res.portStates ?? []).map((p) => ({
      fromPort: p.fromPort ?? 0,
      toPort: p.toPort ?? p.fromPort ?? 0,
      protocol: (p.protocol ?? "tcp").toLowerCase(),
      cidrs: p.cidrs,
      ipv6Cidrs: p.ipv6Cidrs,
    }));
  } catch {
    return [];
  }
}

export async function openLightsailPort(
  fetch: PluginFetch | undefined,
  creds: Credentials,
  region: string,
  instanceName: string,
  rule: {
    fromPort: number;
    toPort?: number;
    protocol: string;
    cidrs?: string[];
  },
): Promise<boolean> {
  const client = getLightsailClient(creds, region, fetch);
  try {
    await client.send(
      new OpenInstancePublicPortsCommand({
        instanceName,
        portInfo: {
          fromPort: rule.fromPort,
          toPort: rule.toPort ?? rule.fromPort,
          protocol: rule.protocol as any,
          cidrs:
            rule.cidrs && rule.cidrs.length > 0 ? rule.cidrs : ["0.0.0.0/0"],
        },
      }),
    );
    return true;
  } catch (err: any) {
    throw new Error(`Open port failed: ${err?.message || String(err)}`);
  }
}

export async function closeLightsailPort(
  fetch: PluginFetch | undefined,
  creds: Credentials,
  region: string,
  instanceName: string,
  rule: {
    fromPort: number;
    toPort?: number;
    protocol: string;
    cidrs?: string[];
  },
): Promise<boolean> {
  const client = getLightsailClient(creds, region, fetch);
  try {
    await client.send(
      new CloseInstancePublicPortsCommand({
        instanceName,
        portInfo: {
          fromPort: rule.fromPort,
          toPort: rule.toPort ?? rule.fromPort,
          protocol: rule.protocol as any,
          cidrs:
            rule.cidrs && rule.cidrs.length > 0 ? rule.cidrs : ["0.0.0.0/0"],
        },
      }),
    );
    return true;
  } catch (err: any) {
    throw new Error(`Close port failed: ${err?.message || String(err)}`);
  }
}

export async function getLightsailPlans(
  fetch: PluginFetch | undefined,
  creds: Credentials,
  regionRaw: string,
): Promise<{
  blueprints: typeof DEFAULT_LIGHTSAIL_BLUEPRINTS;
  dualStackBundles: typeof DEFAULT_DUAL_STACK_BUNDLES;
  ipv6OnlyBundles: typeof DEFAULT_IPV6_ONLY_BUNDLES;
  zones: string[];
}> {
  const region = cleanAwsRegion(regionRaw);
  const fallbackZones = [`${region}a`, `${region}b`, `${region}c`];
  try {
    const client = getLightsailClient(creds, region, fetch);
    let zones: string[] = fallbackZones;

    try {
      const regRes = await client.send(
        new GetRegionsCommand({
          includeAvailabilityZones: true,
        }),
      );
      const found = regRes.regions?.find((r) => r.name === region);
      const azs = found?.availabilityZones || (found as any)?.zones;
      if (azs && azs.length > 0) {
        zones = azs.map((z: any) => z.zoneName || z.name || "").filter(Boolean);
      }
    } catch {}

    let dualStackBundles = DEFAULT_DUAL_STACK_BUNDLES;
    let ipv6OnlyBundles = DEFAULT_IPV6_ONLY_BUNDLES;

    try {
      const bundleRes = await client.send(
        new GetBundlesCommand({
          includeInactive: false,
        }),
      );
      if (bundleRes.bundles && bundleRes.bundles.length > 0) {
        const linuxBundles = bundleRes.bundles.filter(
          (b) =>
            b.isActive !== false &&
            Array.isArray(b.supportedPlatforms) &&
            b.supportedPlatforms.includes("LINUX_UNIX") &&
            b.bundleId &&
            !b.bundleId.startsWith("m_") &&
            !b.bundleId.startsWith("c_"),
        );
        const dual: typeof DEFAULT_DUAL_STACK_BUNDLES = [];
        const ipv6: typeof DEFAULT_IPV6_ONLY_BUNDLES = [];

        for (const b of linuxBundles) {
          const bundleId = b.bundleId!;
          const isIpv6 = bundleId.includes("ipv6");
          const ram = b.ramSizeInGb || 0;
          const ramStr = ram >= 1 ? `${ram} GB` : `${ram * 1024} MB`;
          const tfGb = b.transferPerMonthInGb || 0;
          const tfStr =
            tfGb >= 1000
              ? `${(tfGb / 1000).toFixed(tfGb % 1000 === 0 ? 0 : 1)} TB`
              : `${tfGb} GB`;
          const item = {
            id: bundleId,
            name: `$${Number(b.price || 0).toFixed(2)}/月 · ${ramStr} 内存 / ${b.cpuCount || 1} 核 / ${b.diskSizeInGb || 0} GB SSD / ${tfStr} 流量`,
            price: b.price || 0,
            ramGb: ram,
            vCpu: b.cpuCount || 1,
            diskGb: b.diskSizeInGb || 0,
            transferGb: tfGb,
          };
          if (isIpv6) {
            ipv6.push(item);
          } else {
            dual.push(item);
          }
        }

        dual.sort((a, b) => a.price - b.price);
        ipv6.sort((a, b) => a.price - b.price);
        if (dual.length > 0) dualStackBundles = dual;
        if (ipv6.length > 0) ipv6OnlyBundles = ipv6;
      }
    } catch {}

    return {
      blueprints: DEFAULT_LIGHTSAIL_BLUEPRINTS,
      dualStackBundles,
      ipv6OnlyBundles,
      zones,
    };
  } catch {
    return {
      blueprints: DEFAULT_LIGHTSAIL_BLUEPRINTS,
      dualStackBundles: DEFAULT_DUAL_STACK_BUNDLES,
      ipv6OnlyBundles: DEFAULT_IPV6_ONLY_BUNDLES,
      zones: fallbackZones,
    };
  }
}
