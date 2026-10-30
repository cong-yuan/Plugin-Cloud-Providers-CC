import type { PluginApiClient } from "@termix-ssh/plugin-sdk/frontend";

export interface CredentialField {
  key: string;
  type: "text" | "secret" | "textarea" | "select";
  required: boolean;
  placeholder?: string;
  options?: string[];
}

export interface ProviderInfo {
  id: string;
  defaultUser: string;
  fields: CredentialField[];
}

export interface Account {
  id: number;
  provider: string;
  name: string;
  folder: string | null;
  defaultUser: string | null;
  defaultCredentialId: number | null;
  addressPreference: "public" | "private" | "public-first";
  syncMode: "manual" | "auto";
  intervalMinutes: number;
  onRemoved: "keep" | "mark" | "delete";
  status: string;
  lastError: string | null;
  lastSyncAt: string | null;
  credits?: string | null;
  region?: string | null;
}

export interface AccountInput {
  provider?: string;
  name: string;
  folder: string;
  defaultUser: string;
  defaultCredentialId: number | null;
  addressPreference: Account["addressPreference"];
  syncMode: Account["syncMode"];
  intervalMinutes: number;
  onRemoved: Account["onRemoved"];
  credentials?: Record<string, string>;
  credits?: string | null;
}

export interface NetworkPlan {
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

export interface Instance {
  id: string;
  name: string;
  region: string;
  state: "running" | "stopped" | "other";
  address: string | null;
  publicIp?: string | null;
  privateIp?: string | null;
  imported: boolean;
  user?: string;
  keyName?: string;
  port?: number;
  tags?: string[];
  network?: NetworkPlan;
  details?: InstanceDetails;
}

export interface CreateLightsailInput {
  instanceName: string;
  region?: string;
  availabilityZone?: string;
  blueprintId: string;
  bundleId: string;
  keyPairName?: string;
  userData?: string;
  allocateStaticIp?: boolean;
}

export interface LightsailBlueprint {
  id: string;
  name: string;
  type: string;
  defaultUser?: string;
}

export interface LightsailBundle {
  id: string;
  name: string;
  price: number;
  ramGb: number;
  vCpu: number;
  diskGb: number;
  transferGb: number;
}

export interface LightsailPlansResponse {
  blueprints: LightsailBlueprint[];
  bundles: LightsailBundle[];
  zones: string[];
}

export interface Report {
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  removed: number;
  failed: number;
}

export interface SavedCredential {
  id: number;
  name: string;
  username: string | null;
}

export function errorMessage(error: unknown): string {
  const data = (error as { response?: { data?: { error?: string } } })?.response
    ?.data;
  if (data?.error) return data.error;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }
  return String(error);
}

/** The cloud-providers routes, through the plugin's own client. */
export function createApi(api: PluginApiClient) {
  const data = async <T>(request: Promise<{ data: T }>) => (await request).data;
  return {
    providers: () =>
      data(api.get<{ providers: ProviderInfo[] }>("/providers")).then(
        (r) => r.providers,
      ),
    credentials: () =>
      data(api.get<{ credentials: SavedCredential[] }>("/credentials")).then(
        (r) => r.credentials,
      ),
    accounts: () =>
      data(api.get<{ accounts: Account[] }>("/accounts")).then(
        (r) => r.accounts,
      ),
    create: (body: AccountInput) => data(api.post("/accounts", body)),
    update: (id: number, body: AccountInput) =>
      data(api.put(`/accounts/${id}`, body)),
    remove: (id: number) => data(api.delete(`/accounts/${id}`)),
    test: (id: number) =>
      data(
        api.post<{ ok: boolean; count?: number; error?: string }>(
          `/accounts/${id}/test`,
        ),
      ),
    instances: (id: number) =>
      data(
        api.get<{ instances: Instance[] }>(`/accounts/${id}/instances`),
      ).then((r) => r.instances),
    discover: (id: number) =>
      data(
        api.post<{ instances: Instance[] }>(`/accounts/${id}/discover`),
      ).then((r) => r.instances),
    importIds: (id: number, ids: string[]) =>
      data(
        api.post<{ report: Report }>(`/accounts/${id}/import`, { ids }),
      ).then((r) => r.report),
    sync: (id: number) =>
      data(api.post<{ report: Report }>(`/accounts/${id}/sync`)).then(
        (r) => r.report,
      ),
    getLightsailPlans: (id: number, region?: string) =>
      data(
        api.get<LightsailPlansResponse>(
          `/accounts/${id}/lightsail/plans${region ? `?region=${encodeURIComponent(region)}` : ""}`,
        ),
      ),
    createLightsail: (id: number, body: CreateLightsailInput) =>
      data(
        api.post<{ ok: boolean; instanceName: string }>(
          `/accounts/${id}/lightsail/create`,
          body,
        ),
      ),
    updatePort: (id: number, instanceId: string, port: number) =>
      data(
        api.post<{ ok: boolean; port: number }>(
          `/accounts/${id}/instances/port`,
          { instanceId, port },
        ),
      ),
  };
}

export type CloudApi = ReturnType<typeof createApi>;
