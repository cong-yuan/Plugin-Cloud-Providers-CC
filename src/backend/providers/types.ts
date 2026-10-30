import type { PluginFetch } from "@termix-ssh/plugin-sdk/backend";

export type InstanceState = "running" | "stopped" | "other";

export interface NetworkPlan {
  // "traffic_package" (固定月流量包), "bandwidth" (固定带宽), "pay_as_you_go" (按量计费)
  type: "traffic_package" | "bandwidth" | "pay_as_you_go";
  monthlyTransferGb?: number;
  usedTransferGb?: number;
  bandwidthMbps?: number;
  label?: string;
}

export interface InstanceDetails {
  blueprintId?: string;
  blueprintName?: string;
  bundleId?: string;
  cpuCount?: number;
  ramSizeGb?: number;
  diskSizeGb?: number;
  isStaticIp?: boolean;
  availabilityZone?: string;
  regionName?: string;
  createdAt?: string;
  arn?: string;
}

export interface CloudInstance {
  id: string;
  name: string;
  publicIp: string | null;
  privateIp: string | null;
  region: string;
  state: InstanceState;
  // Plain labels or "key:value" pairs from the cloud.
  tags: string[];
  // Login name the cloud knows about, when it does.
  user?: string;
  // SSH port if detected (defaults to 22).
  port?: number;
  // Key pair name in the cloud.
  keyName?: string;
  // Network / bandwidth / traffic information.
  network?: NetworkPlan;
  // Hardware, OS, blueprint, and location details.
  details?: InstanceDetails;
  // Auto-downloaded key pair (e.g. Lightsail default key pair).
  autoKey?: {
    name: string;
    privateKey: string;
    publicKey: string;
    keyType?: string;
  };
}

export interface CredentialField {
  key: string;
  type: "text" | "secret" | "textarea" | "select";
  required: boolean;
  placeholder?: string;
  options?: string[];
}

export type Credentials = Record<string, string>;

export interface Provider {
  id: string;
  fields: CredentialField[];
  defaultUser: string;
  list: (creds: Credentials, fetch: PluginFetch) => Promise<CloudInstance[]>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
