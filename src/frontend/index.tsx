import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowDownUp,
  ChevronDown,
  ChevronRight,
  Cloud,
  Copy,
  Cpu,
  DownloadCloud,
  Folder,
  Info,
  Loader2,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Server,
  Shield,
  Terminal,
  Trash2,
  Wifi,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import {
  notifyHostsChanged,
  useHosts,
  usePluginApi,
  useTabs,
  useTranslation,
  type TabProps,
  type TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  ListBadge,
  ListRow,
  ListRowAction,
  cn,
  useConfirm,
} from "@termix-ssh/plugin-sdk/ui";
import {
  createApi,
  errorMessage,
  type Account,
  type AccountInput,
  type Instance,
  type PortRule,
  type ProviderInfo,
  type SavedCredential,
} from "./api";
import { CreateLightsailModal } from "./CreateLightsailModal";
import { AccountForm } from "./AccountForm";
import { DiscoverView } from "./DiscoverView";
import { CloudCard } from "./CloudCard";

const TAB_ID = "cc-cloud-providers";
const CACHE_PREFIX = "cc_cloud_instances_";

function loadCachedInstances(accountId: number): Instance[] {
  try {
    const raw = localStorage.getItem(`${CACHE_PREFIX}${accountId}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {}
  return [];
}

function saveCachedInstances(accountId: number, instances: Instance[]) {
  try {
    localStorage.setItem(
      `${CACHE_PREFIX}${accountId}`,
      JSON.stringify(instances),
    );
  } catch {}
}

const AWS_REGION_NAMES: Record<string, string> = {
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

function getInstancesFromHosts(account: Account, hosts: any[]): Instance[] {
  const folder = account.folder || account.name;
  const matchingHosts = (hosts || []).filter((h) => {
    const settings =
      h.pluginSettings?.["cc-cloud-providers"] ||
      h.pluginSettings?.["cloud-providers"];
    if (settings?.accountId === account.id) return true;
    return h.folder === folder;
  });

  return matchingHosts.map((h) => {
    const settings =
      h.pluginSettings?.["cc-cloud-providers"] ||
      h.pluginSettings?.["cloud-providers"];
    const tags: string[] = h.tags || [];
    const isHostLightsail =
      settings?.instanceId?.startsWith("lightsail/") ||
      tags.some((t: string) => t.includes("lightsail")) ||
      h.name?.toLowerCase().includes("lightsail") ||
      account.name.toLowerCase().includes("lightsail") ||
      account.name.toLowerCase().includes("光帆") ||
      (account.provider === "aws" &&
        !settings?.instanceId?.match(/(?:^|\/)i-[0-9a-f]+/i));

    const instanceId =
      settings?.instanceId ||
      (isHostLightsail ? `lightsail/${h.name}` : `host-${h.id}`);

    const detailsTag = tags.find((t: string) =>
      t.startsWith("cc-cloud:details:"),
    );
    let details: any = undefined;
    if (detailsTag) {
      try {
        details = JSON.parse(
          decodeURIComponent(detailsTag.replace("cc-cloud:details:", "")),
        );
      } catch {}
    }

    const regionTag = tags.find(
      (t: string) =>
        t.startsWith("cc-cloud:") &&
        !t.startsWith("cc-cloud:net:") &&
        !t.startsWith("cc-cloud:details:") &&
        ![
          "cc-cloud:aws",
          "cc-cloud:ecs",
          "cc-cloud:lightsail",
          "cc-cloud:stopped",
        ].includes(t),
    );
    const region =
      details?.availabilityZone ||
      (regionTag ? regionTag.replace("cc-cloud:", "") : account.region || "");
    const isStopped = tags.includes("cc-cloud:stopped");

    const netTag = tags.find((t: string) => t.startsWith("cc-cloud:net:"));
    let network: any = undefined;
    if (netTag) {
      try {
        const label = decodeURIComponent(netTag.replace("cc-cloud:net:", ""));
        network = {
          type: isHostLightsail ? "traffic_package" : "pay_as_you_go",
          label,
        };
      } catch {}
    } else if (isHostLightsail) {
      network = {
        type: "traffic_package",
        label: "1 TB/月",
      };
    } else if (account.provider === "aws") {
      network = {
        type: "pay_as_you_go",
        label: "按量计费 (最高 5 Gbps)",
      };
    }

    return {
      id: instanceId,
      name: h.name,
      address: h.ip,
      publicIp: h.ip,
      privateIp: null,
      region,
      state: isStopped ? "stopped" : "running",
      imported: true,
      port: h.port || 22,
      user: h.username,
      network,
      details,
      tags,
    };
  });
}

function toBaseAwsRegion(r: string | null | undefined): string {
  if (!r) return "";
  const trimmed = r.trim();
  const match = trimmed.match(/^([a-z]{2}-[a-z]+-\d+)[a-z]$/i);
  return match ? match[1].toLowerCase() : trimmed;
}

function formatInstanceSpec(instance: {
  details?: any;
  tags?: string[];
}): string | null {
  const details = instance.details;
  if (details) {
    const cpu = details.cpuCount;
    const ram = details.ramSizeGb;

    if (cpu && ram) {
      const ramStr = ram < 1 ? `${Math.round(ram * 1024)}M` : `${ram}G`;
      return `${cpu}H${ramStr}`;
    }

    if (details.bundleId) {
      const b = String(details.bundleId).toLowerCase();
      if (b.includes("nano")) return "1H512M";
      if (b.includes("micro")) return "1H1G";
      if (b.includes("small")) return "1H2G";
      if (b.includes("medium")) return "2H4G";
      if (b.includes("2xlarge")) return "8H32G";
      if (b.includes("4xlarge")) return "16H64G";
      if (b.includes("xlarge")) return "4H16G";
      if (b.includes("large")) return "2H8G";
      if (b.endsWith(".large")) return "2H4G";
    }
  }

  const tags = Array.isArray(instance.tags) ? instance.tags : [];
  for (const t of tags) {
    const lower = t.toLowerCase();
    if (lower.includes("nano")) return "1H512M";
    if (lower.includes("micro")) return "1H1G";
    if (lower.includes("small")) return "1H2G";
    if (lower.includes("medium")) return "2H4G";
    if (lower.includes("2xlarge")) return "8H32G";
    if (lower.includes("xlarge")) return "4H16G";
    if (lower.includes("large")) return "2H8G";
  }

  return null;
}

function getAccountRegions(
  account: Account,
  instances: Instance[] | undefined,
  hosts: any[],
): string[] {
  const set = new Set<string>();

  if (account.region) {
    account.region
      .split(/[,，\s]+/)
      .map((r) => r.trim())
      .filter((r) => r && r.toLowerCase() !== "all")
      .forEach((r) => {
        const base = toBaseAwsRegion(r);
        if (base) set.add(base);
      });
  }

  if (set.size === 0) {
    if (instances && instances.length > 0) {
      instances
        .map((i) => (i.details?.availabilityZone || i.region)?.trim())
        .filter((r): r is string => Boolean(r) && r.toLowerCase() !== "all")
        .forEach((r) => {
          const base = toBaseAwsRegion(r);
          if (base) set.add(base);
        });
    }

    const folder = account.folder || account.name;
    const matchingHosts = (hosts || []).filter((h) => {
      const settings =
        h.pluginSettings?.["cc-cloud-providers"] ||
        h.pluginSettings?.["cloud-providers"];
      return settings?.accountId === account.id || h.folder === folder;
    });
    for (const h of matchingHosts) {
      const tag = (h.tags || []).find(
        (t: string) =>
          t.startsWith("cc-cloud:") &&
          !t.startsWith("cc-cloud:net:") &&
          !t.startsWith("cc-cloud:details:") &&
          ![
            "cc-cloud:aws",
            "cc-cloud:ecs",
            "cc-cloud:lightsail",
            "cc-cloud:stopped",
          ].includes(t),
      );
      if (tag) {
        const base = toBaseAwsRegion(tag.replace("cc-cloud:", ""));
        if (base) set.add(base);
      }
    }
  }

  return Array.from(set);
}

function parseCredits(credits?: string | null) {
  if (!credits) {
    return {
      amount: "$200",
      remaining: "remaining 182 days (Apr 29, 2027)",
    };
  }

  // Match currency amount: e.g. "$200.00 USD" or "$200.00" or "$200" or "¥200" or "€200"
  const amountMatch =
    credits.match(/([$¥€£]\s*[\d,]+(?:\.\d+)?(?:\s*[A-Z]{3})?)/i) ||
    credits.match(/([$¥€£]\s*[\d,]+)/);
  const rawAmount = amountMatch ? amountMatch[1].trim() : "$200";

  // If rawAmount ends with ".00" or has "USD", clean it up: "$200.00 USD" -> "$200"
  const cleanAmount = rawAmount
    .replace(/\.00\b/, "")
    .replace(/\s*USD/i, "")
    .trim();

  let rest = credits;
  if (amountMatch) {
    rest = rest.replace(amountMatch[0], "");
  }

  rest = rest
    .replace(/[{}[\]]/g, "")
    .replace(/credits remaining/gi, "")
    .replace(/days remaining/gi, "")
    .replace(/remaining/gi, "")
    .trim();

  if (rest) {
    rest = `remaining ${rest}`;
  } else {
    rest = "remaining 182 days (Apr 29, 2027)";
  }

  return {
    amount: cleanAmount,
    remaining: rest,
  };
}

type View =
  | { kind: "list" }
  | { kind: "form"; account: Account | null }
  | { kind: "discover"; account: Account };

function CloudTab({ isVisible }: TabProps) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const pluginApi = usePluginApi();
  const api = useMemo(() => createApi(pluginApi), [pluginApi]);

  let hosts: any[] = [];
  try {
    const hostContext = useHosts();
    if (hostContext?.hosts) hosts = hostContext.hosts;
  } catch {
    // safe fallback in tests
  }

  let tabs: any = null;
  try {
    tabs = useTabs();
  } catch {
    // safe fallback in tests
  }

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [credentials, setCredentials] = useState<SavedCredential[]>([]);
  const [view, setView] = useState<View>({ kind: "list" });
  const [busy, setBusy] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Accordion expanded accounts
  const [expandedAccountIds, setExpandedAccountIds] = useState<Set<number>>(
    new Set(),
  );
  const [accountInstances, setAccountInstances] = useState<
    Record<number, Instance[]>
  >(() => {
    const initial: Record<number, Instance[]> = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith(CACHE_PREFIX)) {
          const accountId = Number(key.replace(CACHE_PREFIX, ""));
          if (accountId) {
            const parsed = JSON.parse(localStorage.getItem(key) || "[]");
            if (Array.isArray(parsed) && parsed.length > 0) {
              initial[accountId] = parsed;
            }
          }
        }
      }
    } catch {}
    return initial;
  });
  const [loadingInstances, setLoadingInstances] = useState<
    Record<number, boolean>
  >({});
  const [importingId, setImportingId] = useState<string | null>(null);
  const [lightsailAccount, setLightsailAccount] = useState<Account | null>(
    null,
  );
  const [expandedDetailIds, setExpandedDetailIds] = useState<Set<string>>(
    new Set(),
  );

  // Firewall rules state
  const [instanceRules, setInstanceRules] = useState<
    Record<string, PortRule[]>
  >({});
  const [loadingRules, setLoadingRules] = useState<Record<string, boolean>>({});
  const [addingRuleInstanceId, setAddingRuleInstanceId] = useState<
    string | null
  >(null);
  const [newRuleProtocol, setNewRuleProtocol] = useState<string>("tcp");
  const [newRuleFromPort, setNewRuleFromPort] = useState<string>("");
  const [newRuleToPort, setNewRuleToPort] = useState<string>("");
  const [newRuleCidr, setNewRuleCidr] = useState<string>("");
  const [ruleOperating, setRuleOperating] = useState<Record<string, boolean>>(
    {},
  );

  function getCommonPortName(
    fromPort: number,
    toPort: number,
    protocol: string,
  ): string | null {
    const proto = protocol.toLowerCase();
    if (proto === "tcp") {
      if (fromPort === 22 && toPort === 22) return "SSH (远程连接)";
      if (fromPort === 80 && toPort === 80) return "HTTP (Web)";
      if (fromPort === 443 && toPort === 443) return "HTTPS (Web 安全)";
      if (fromPort === 3306 && toPort === 3306) return "MySQL";
      if (fromPort === 5432 && toPort === 5432) return "PostgreSQL";
      if (fromPort === 6379 && toPort === 6379) return "Redis";
      if (fromPort === 8080 && toPort === 8080) return "HTTP-Alt (8080)";
      if (fromPort === 3000 && toPort === 3000) return "Web App (3000)";
      if (fromPort === 8888 && toPort === 8888) return "宝塔 / 面板 (8888)";
    }
    if (proto === "icmp") return "Ping (ICMP)";
    if (fromPort === 0 && toPort === 65535) return "全部端口开放";
    return null;
  }

  async function loadRules(accountId: number, instanceId: string) {
    setLoadingRules((prev) => ({ ...prev, [instanceId]: true }));
    try {
      const rules = await api.getInstanceRules(accountId, instanceId);
      setInstanceRules((prev) => ({ ...prev, [instanceId]: rules }));
    } catch (err) {
      console.error("Failed to load instance rules:", err);
    } finally {
      setLoadingRules((prev) => ({ ...prev, [instanceId]: false }));
    }
  }

  async function handleAddRule(account: Account, instance: Instance) {
    const from = parseInt(newRuleFromPort);
    if (isNaN(from) || from < 0 || from > 65535) {
      toast.error("请输入有效的起始端口号 (0-65535)");
      return;
    }
    const to = newRuleToPort ? parseInt(newRuleToPort) : from;
    if (isNaN(to) || to < from || to > 65535) {
      toast.error("结束端口号必须大于等于起始端口号 (0-65535)");
      return;
    }

    const opKey = `${instance.id}-add`;
    setRuleOperating((prev) => ({ ...prev, [opKey]: true }));
    try {
      await api.openInstanceRule(account.id, {
        instanceId: instance.id,
        fromPort: from,
        toPort: to,
        protocol: newRuleProtocol,
        cidrs: newRuleCidr.trim() ? [newRuleCidr.trim()] : ["0.0.0.0/0"],
      });
      toast.success(
        `成功开放端口规则 ${newRuleProtocol.toUpperCase()} ${from === to ? from : `${from}-${to}`}`,
      );
      setAddingRuleInstanceId(null);
      setNewRuleFromPort("");
      setNewRuleToPort("");
      setNewRuleCidr("");
      await loadRules(account.id, instance.id);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setRuleOperating((prev) => ({ ...prev, [opKey]: false }));
    }
  }

  async function handleDeleteRule(
    account: Account,
    instance: Instance,
    rule: PortRule,
  ) {
    const ruleDisplay = `${rule.protocol.toUpperCase()} ${rule.fromPort === rule.toPort ? rule.fromPort : `${rule.fromPort}-${rule.toPort}`}`;
    const opKey = `${instance.id}-del-${rule.protocol}-${rule.fromPort}-${rule.toPort}`;
    setRuleOperating((prev) => ({ ...prev, [opKey]: true }));
    try {
      await api.closeInstanceRule(account.id, {
        instanceId: instance.id,
        fromPort: rule.fromPort,
        toPort: rule.toPort,
        protocol: rule.protocol,
        cidrs: rule.cidrs,
      });
      toast.success(`已删除端口规则 ${ruleDisplay}`);
      await loadRules(account.id, instance.id);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setRuleOperating((prev) => ({ ...prev, [opKey]: false }));
    }
  }

  function toggleDetail(instance: Instance, account: Account) {
    setExpandedDetailIds((prev) => {
      const next = new Set(prev);
      if (next.has(instance.id)) {
        next.delete(instance.id);
      } else {
        next.add(instance.id);
        if (
          (account.provider === "aws" ||
            instance.id.startsWith("lightsail/")) &&
          !instanceRules[instance.id]
        ) {
          void loadRules(account.id, instance.id);
        }
      }
      return next;
    });
  }

  const reload = useCallback(async () => {
    try {
      const [list, known, saved] = await Promise.all([
        api.accounts(),
        api.providers(),
        api.credentials(),
      ]);
      setAccounts(list);
      setProviders(known);
      setCredentials(saved);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setLoaded(true);
    }
  }, [api]);

  useEffect(() => {
    if (isVisible) void reload();
  }, [isVisible, reload]);

  async function loadInstances(accountId: number) {
    setLoadingInstances((prev) => ({ ...prev, [accountId]: true }));
    try {
      const list = await api.discover(accountId);
      setAccountInstances((prev) => ({ ...prev, [accountId]: list }));
      saveCachedInstances(accountId, list);
      return list;
    } catch (error) {
      toast.error(errorMessage(error));
      return [];
    } finally {
      setLoadingInstances((prev) => ({ ...prev, [accountId]: false }));
    }
  }

  function toggleExpand(accountId: number) {
    setExpandedAccountIds((prev) => {
      const next = new Set(prev);
      if (next.has(accountId)) {
        next.delete(accountId);
      } else {
        next.add(accountId);
        // Read already existing list without querying cloud
        const current = accountInstances[accountId];
        if (!current || current.length === 0) {
          const cached = loadCachedInstances(accountId);
          if (cached.length > 0) {
            setAccountInstances((prev) => ({ ...prev, [accountId]: cached }));
          }
          // Fetch existing instances from local database mapped table (instant local query)
          void api
            .instances(accountId)
            .then((list) => {
              if (list && list.length > 0) {
                setAccountInstances((prev) => ({
                  ...prev,
                  [accountId]: list,
                }));
                saveCachedInstances(accountId, list);
              } else if (!cached.length) {
                const account = accounts.find((a) => a.id === accountId);
                if (account) {
                  const fromHosts = getInstancesFromHosts(account, hosts);
                  if (fromHosts.length > 0) {
                    setAccountInstances((prev) => ({
                      ...prev,
                      [accountId]: fromHosts,
                    }));
                    saveCachedInstances(accountId, fromHosts);
                  }
                }
              }
            })
            .catch(() => {});
        }
      }
      return next;
    });
  }

  async function handleConnect(account: Account, instance: Instance) {
    const ip = instance.address || instance.publicIp || instance.privateIp;
    const matchingHost = hosts.find(
      (h) => (ip && h.ip === ip) || h.name === instance.name,
    );

    if (matchingHost && tabs?.connectHost) {
      tabs.connectHost(matchingHost);
      return;
    }

    // Not yet imported or not found in host list: import and connect
    setImportingId(instance.id);
    try {
      toast.info(`正在连接 ${instance.name}...`);
      await api.importIds(account.id, [instance.id]);
      setAccountInstances((prev) => ({
        ...prev,
        [account.id]: (prev[account.id] || []).map((i) =>
          i.id === instance.id ? { ...i, imported: true } : i,
        ),
      }));

      setTimeout(() => {
        const newlyAdded = hosts.find(
          (h) => (ip && h.ip === ip) || h.name === instance.name,
        );
        if (newlyAdded && tabs?.connectHost) {
          tabs.connectHost(newlyAdded);
        } else if (ip && tabs?.openTab) {
          tabs.openTab(
            {
              id: `cloud-${instance.id}`,
              name: instance.name,
              ip,
              port: instance.port || 22,
              username: instance.user || account.defaultUser || "root",
            },
            "terminal",
          );
        } else {
          toast.success(`已导入主机 ${instance.name}，请在主机列表中查看`);
        }
      }, 600);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setImportingId(null);
    }
  }

  function handleSftp(instance: Instance) {
    const ip = instance.address || instance.publicIp || instance.privateIp;
    const matchingHost = hosts.find(
      (h) => (ip && h.ip === ip) || h.name === instance.name,
    );
    if (matchingHost && tabs?.openTab) {
      tabs.openTab(matchingHost, "sftp");
    } else {
      toast.error("该服务器尚未导入为主机，请先点击「连接」自动导入");
    }
  }

  async function handleImportOnly(account: Account, instance: Instance) {
    setImportingId(instance.id);
    try {
      await api.importIds(account.id, [instance.id]);
      toast.success(`已成功导入 ${instance.name}`);
      setAccountInstances((prev) => ({
        ...prev,
        [account.id]: (prev[account.id] || []).map((i) =>
          i.id === instance.id ? { ...i, imported: true } : i,
        ),
      }));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setImportingId(null);
    }
  }

  async function save(account: Account | null, input: AccountInput) {
    try {
      if (account) await api.update(account.id, input);
      else await api.create(input);
      toast.success(t("saved"));
      setView({ kind: "list" });
      await reload();
      return true;
    } catch (error) {
      toast.error(errorMessage(error));
      return false;
    }
  }

  async function test(account: Account) {
    setBusy(account.id);
    try {
      const result = await api.test(account.id);
      if (result.ok) toast.success(t("testOk", { count: result.count ?? 0 }));
      else toast.error(result.error ?? t("testFailed"));
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function syncNow(account: Account) {
    setBusy(account.id);
    try {
      const report = await api.sync(account.id);
      toast.success(
        t("syncDone", {
          created: report.created,
          updated: report.updated,
          removed: report.removed,
        }),
      );
      if (report.failed > 0)
        toast.error(t("syncFailed", { count: report.failed }));

      // Refresh latest server list after sync
      await loadInstances(account.id);
      setExpandedAccountIds((prev) => new Set(prev).add(account.id));
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
      await reload();
    }
  }

  async function remove(account: Account) {
    const ok = await confirm({
      title: t("deleteConfirm", { name: account.name }),
      confirmLabel: t("delete"),
    });
    if (!ok) return;
    try {
      await api.remove(account.id);
      await reload();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  if (view.kind === "form") {
    return (
      <AccountForm
        account={view.account}
        providers={providers}
        credentials={credentials}
        onBack={() => setView({ kind: "list" })}
        onSave={(input) => save(view.account, input)}
      />
    );
  }
  if (view.kind === "discover") {
    return (
      <DiscoverView
        account={view.account}
        api={api}
        onBack={() => setView({ kind: "list" })}
        onDone={() => {
          setView({ kind: "list" });
          void reload();
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t("tab.title")}</h2>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="border-accent-brand/40 text-accent-brand"
          onClick={() => setView({ kind: "form", account: null })}
        >
          <Plus className="mr-1 size-3" /> {t("add")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t("description")}</p>
      {loaded && accounts.length === 0 && (
        <p className="py-4 text-xs text-muted-foreground">{t("empty")}</p>
      )}
      {accounts.map((account, index) => {
        const isExpanded = expandedAccountIds.has(account.id);
        const instances = accountInstances[account.id] || [];
        const isLoading = loadingInstances[account.id];
        const creditInfo = parseCredits(account.credits);
        const accountRegions = getAccountRegions(account, instances, hosts);

        return (
          <div key={account.id} className="flex flex-col">
            <ListRow
              stripe={index}
              onClick={() => toggleExpand(account.id)}
              className="cursor-pointer select-none"
              icon={
                <div className="flex items-center gap-1.5">
                  {isExpanded ? (
                    <ChevronDown className="size-3.5 text-accent-brand" />
                  ) : (
                    <ChevronRight className="size-3.5 text-muted-foreground" />
                  )}
                  <Cloud className="size-4" />
                </div>
              }
              title={
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-foreground text-[13px]">
                    {account.name}
                  </span>
                  {accountRegions.map((region) => (
                    <span
                      key={region}
                      className="inline-flex items-center rounded bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-sky-600 dark:text-sky-400 border border-sky-500/25"
                    >
                      {region}
                    </span>
                  ))}
                  <span className="inline-flex items-center rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400 border border-emerald-500/30">
                    {creditInfo.amount}
                  </span>
                  <span className="text-[11px] text-muted-foreground/80 font-normal">
                    {creditInfo.remaining}
                  </span>
                </div>
              }
              meta={
                <span>
                  {t(`providers.${account.provider}`)} |{" "}
                  {t(`options.${account.syncMode}`)}
                  {" | "}
                  {account.status === "error"
                    ? (account.lastError ?? t("status.error"))
                    : account.lastSyncAt
                      ? t("lastSync", {
                          date: new Date(account.lastSyncAt).toLocaleString(),
                        })
                      : t("status.never")}
                </span>
              }
              trailing={
                <div
                  className="flex items-center gap-0.5"
                  onClick={(e) => e.stopPropagation()}
                >
                  {account.provider === "aws" && (
                    <Button
                      size="xs"
                      variant="outline"
                      className="h-6 gap-1 px-2 text-[11px] text-amber-500 border-amber-500/30 hover:bg-amber-500/10 mr-1"
                      onClick={() => setLightsailAccount(account)}
                    >
                      <Zap className="size-3 text-amber-500" />
                      创建光帆
                    </Button>
                  )}
                  <ListRowAction
                    label={t("test")}
                    disabled={busy === account.id}
                    onClick={() => void test(account)}
                  >
                    <Plug />
                  </ListRowAction>
                  <ListRowAction
                    label={t("discover.title")}
                    onClick={() => setView({ kind: "discover", account })}
                  >
                    <DownloadCloud />
                  </ListRowAction>
                  <ListRowAction
                    label={t("syncNow")}
                    disabled={busy === account.id}
                    onClick={() => void syncNow(account)}
                  >
                    <RefreshCw />
                  </ListRowAction>
                  <ListRowAction
                    label={t("edit")}
                    onClick={() => setView({ kind: "form", account })}
                  >
                    <Pencil />
                  </ListRowAction>
                  <ListRowAction
                    label={t("delete")}
                    tone="destructive"
                    onClick={() => void remove(account)}
                  >
                    <Trash2 />
                  </ListRowAction>
                </div>
              }
            />

            {/* Expanded Server / Instance List (Sub-list) */}
            {isExpanded && (
              <div className="ml-[27px] border-l border-border/40 bg-muted/[0.04] [&>*:last-child]:border-b-0 animate-in fade-in-50 duration-150">
                {isLoading ? (
                  <div className="flex items-center gap-2 py-3 px-3 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin text-accent-brand" />
                    <span>正在获取服务器列表...</span>
                  </div>
                ) : instances.length === 0 ? (
                  <div className="py-2.5 px-3 text-xs text-muted-foreground flex items-center justify-between">
                    <span>
                      暂未同步服务器列表，点击「立即同步」获取最新实例。
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-6 text-xs gap-1 border-accent-brand/40 text-accent-brand"
                      disabled={busy === account.id || isLoading}
                      onClick={(e) => {
                        e.stopPropagation();
                        void syncNow(account);
                      }}
                    >
                      <RefreshCw className="size-3" /> 立即同步
                    </Button>
                  </div>
                ) : (
                  instances.map((instance, instIndex) => {
                    const tagsList = Array.isArray(instance.tags)
                      ? instance.tags
                      : typeof instance.tags === "string"
                        ? (instance.tags as string).split(",")
                        : [];

                    const isLightsail =
                      instance.id.startsWith("lightsail/") ||
                      tagsList.some((t: string) => t.includes("lightsail")) ||
                      instance.keyName?.toLowerCase().includes("lightsail") ||
                      instance.name?.toLowerCase().includes("lightsail") ||
                      account.name.toLowerCase().includes("lightsail") ||
                      account.name.toLowerCase().includes("光帆") ||
                      (account.provider === "aws" &&
                        !instance.id.match(/(?:^|\/)i-[0-9a-f]+/i));
                    const tagLabel = isLightsail ? "光帆" : "ECS";
                    const tagTone = isLightsail ? "warning" : "brand";
                    const ip =
                      instance.address ||
                      instance.publicIp ||
                      instance.privateIp ||
                      "无公网 IP";
                    const isRunning = instance.state === "running";
                    const displayZone =
                      instance.details?.availabilityZone || instance.region;
                    const spec = formatInstanceSpec(instance);

                    let networkInfo: {
                      icon: React.ReactNode;
                      text: string;
                    } | null = null;
                    if (instance.network?.label) {
                      const isTraffic =
                        instance.network.type === "traffic_package";
                      const isBandwidth = instance.network.type === "bandwidth";
                      networkInfo = {
                        icon: isTraffic ? (
                          <ArrowDownUp className="size-2.5 text-amber-500 shrink-0" />
                        ) : isBandwidth ? (
                          <Wifi className="size-2.5 text-blue-500 shrink-0" />
                        ) : (
                          <Activity className="size-2.5 text-slate-400 shrink-0" />
                        ),
                        text: isTraffic
                          ? `流量: ${instance.network.label}`
                          : isBandwidth
                            ? `带宽: ${instance.network.label}`
                            : instance.network.label,
                      };
                    } else if (isLightsail) {
                      networkInfo = {
                        icon: (
                          <ArrowDownUp className="size-2.5 text-amber-500 shrink-0" />
                        ),
                        text: "流量: 1000 GB/月",
                      };
                    } else if (account.provider === "aws") {
                      networkInfo = {
                        icon: (
                          <Activity className="size-2.5 text-slate-400 shrink-0" />
                        ),
                        text: "按量计费 (最高 5 Gbps)",
                      };
                    }

                    return (
                      <div key={instance.id} className="flex flex-col">
                        <ListRow
                          stripe={instIndex}
                          className="select-none"
                          icon={
                            <span
                              className={cn(
                                "size-2 rounded-full shrink-0",
                                isRunning
                                  ? "bg-emerald-500"
                                  : "bg-muted-foreground/40",
                              )}
                              title={isRunning ? "运行中" : instance.state}
                            />
                          }
                          title={
                            <div className="flex items-center gap-2">
                              <ListBadge tone={tagTone}>{tagLabel}</ListBadge>
                              <span className="font-semibold text-foreground text-[13px] truncate">
                                {instance.name}
                              </span>
                              {spec && (
                                <span className="inline-flex items-center rounded bg-purple-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-purple-600 dark:text-purple-400 border border-purple-500/25 font-mono">
                                  {spec}
                                </span>
                              )}
                              {instance.imported && (
                                <ListBadge tone="success">已导入</ListBadge>
                              )}
                            </div>
                          }
                          meta={
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
                              <span>
                                IP:{" "}
                                <code className="font-mono text-foreground/80">
                                  {ip}
                                </code>
                              </span>
                              {spec && (
                                <span className="font-medium text-foreground font-mono">
                                  · {spec}
                                </span>
                              )}
                              {displayZone && (
                                <span>· {formatAwsZone(displayZone)}</span>
                              )}
                              <span>
                                ·{" "}
                                {isRunning
                                  ? "运行中"
                                  : instance.state || "已停止"}
                              </span>
                              {networkInfo && (
                                <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/90 bg-muted/50 px-1.5 py-0.5 rounded border border-border/40 font-mono">
                                  {networkInfo.icon}
                                  <span>{networkInfo.text}</span>
                                </span>
                              )}
                            </div>
                          }
                          trailing={
                            <div
                              className="flex items-center gap-0.5"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <ListRowAction
                                label={
                                  expandedDetailIds.has(instance.id)
                                    ? "收起详情"
                                    : "服务器详情"
                                }
                                onClick={() => toggleDetail(instance, account)}
                              >
                                <Info
                                  className={cn(
                                    "size-3.5",
                                    expandedDetailIds.has(instance.id) &&
                                      "text-primary font-bold",
                                  )}
                                />
                              </ListRowAction>
                              <ListRowAction
                                label="连接"
                                tone="brand"
                                disabled={importingId === instance.id}
                                onClick={() =>
                                  void handleConnect(account, instance)
                                }
                              >
                                <Terminal />
                              </ListRowAction>
                              <ListRowAction
                                label="SFTP"
                                onClick={() => handleSftp(instance)}
                              >
                                <Folder />
                              </ListRowAction>
                              <ListRowAction
                                label="复制 IP"
                                onClick={() => {
                                  if (ip && ip !== "无公网 IP") {
                                    void navigator.clipboard.writeText(ip);
                                    toast.success(`已复制 IP: ${ip}`);
                                  }
                                }}
                              >
                                <Copy />
                              </ListRowAction>
                              {!instance.imported && (
                                <ListRowAction
                                  label="导入为主机"
                                  disabled={importingId === instance.id}
                                  onClick={() =>
                                    void handleImportOnly(account, instance)
                                  }
                                >
                                  <DownloadCloud />
                                </ListRowAction>
                              )}
                            </div>
                          }
                        />
                        {expandedDetailIds.has(instance.id) && (
                          <div className="mx-2 mb-2 p-3 rounded-lg border border-border/60 bg-muted/20 space-y-3 text-xs animate-in fade-in-50 duration-150">
                            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/40 pb-2">
                              <div className="flex items-center gap-2">
                                <Server className="size-4 text-primary" />
                                <span className="font-semibold text-foreground">
                                  {instance.name}
                                </span>
                                <ListBadge tone={tagTone}>{tagLabel}</ListBadge>
                                <span className="text-[11px] text-muted-foreground">
                                  状态:{" "}
                                  <span
                                    className={
                                      isRunning
                                        ? "text-emerald-500 font-medium"
                                        : "text-amber-500 font-medium"
                                    }
                                  >
                                    {isRunning
                                      ? "运行中"
                                      : instance.state || "已停止"}
                                  </span>
                                </span>
                              </div>
                              <div className="flex items-center gap-1.5 text-muted-foreground text-[11px]">
                                <span>可用区:</span>
                                <code className="text-foreground font-mono bg-muted px-1.5 py-0.5 rounded border border-border/40">
                                  {formatAwsZone(displayZone) ||
                                    displayZone ||
                                    "未知"}
                                </code>
                              </div>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
                              {/* 1. SSH 登录配置 */}
                              <div className="p-2.5 rounded bg-background/80 border border-border/40 space-y-2">
                                <div className="font-medium text-foreground flex items-center justify-between">
                                  <span className="flex items-center gap-1.5">
                                    <Terminal className="size-3 text-muted-foreground" />
                                    SSH 登录配置
                                  </span>
                                </div>
                                <div className="space-y-1.5 text-[11px]">
                                  <div className="flex items-center justify-between">
                                    <span className="text-muted-foreground">
                                      SSH 端口:
                                    </span>
                                    <code className="font-mono text-foreground font-semibold">
                                      {instance.port || 22}
                                    </code>
                                  </div>
                                  <div className="flex items-center justify-between">
                                    <span className="text-muted-foreground">
                                      登录用户:
                                    </span>
                                    <code className="font-mono text-foreground">
                                      {instance.user ||
                                        account.defaultUser ||
                                        "root"}
                                    </code>
                                  </div>
                                  {instance.keyName && (
                                    <div className="flex items-center justify-between">
                                      <span className="text-muted-foreground">
                                        SSH 密钥对:
                                      </span>
                                      <span
                                        className="font-mono text-foreground truncate max-w-[130px]"
                                        title={instance.keyName}
                                      >
                                        {instance.keyName}
                                      </span>
                                    </div>
                                  )}
                                </div>
                              </div>

                              {/* 2. 网络与 IP */}
                              <div className="p-2.5 rounded bg-background/80 border border-border/40 space-y-2">
                                <div className="font-medium text-foreground flex items-center gap-1.5">
                                  <Wifi className="size-3 text-muted-foreground" />
                                  网络与 IP
                                </div>
                                <div className="space-y-1.5 text-[11px]">
                                  <div className="flex items-center justify-between">
                                    <span className="text-muted-foreground">
                                      公网 IP:
                                    </span>
                                    <div className="flex items-center gap-1">
                                      <code className="font-mono text-foreground">
                                        {instance.publicIp ||
                                          instance.address ||
                                          "无"}
                                      </code>
                                      {(instance.publicIp ||
                                        instance.address) && (
                                        <button
                                          type="button"
                                          onClick={() => {
                                            void navigator.clipboard.writeText(
                                              instance.publicIp ||
                                                instance.address ||
                                                "",
                                            );
                                            toast.success("已复制公网 IP");
                                          }}
                                          className="hover:text-primary text-muted-foreground"
                                          title="复制 IP"
                                        >
                                          <Copy className="size-2.5" />
                                        </button>
                                      )}
                                    </div>
                                  </div>
                                  <div className="flex items-center justify-between">
                                    <span className="text-muted-foreground">
                                      私网 IP:
                                    </span>
                                    <code className="font-mono text-foreground">
                                      {instance.privateIp || "无"}
                                    </code>
                                  </div>
                                  {instance.network && (
                                    <div className="flex items-center justify-between">
                                      <span className="text-muted-foreground">
                                        流量 / 带宽:
                                      </span>
                                      <span className="font-mono text-foreground">
                                        {instance.network.label}
                                      </span>
                                    </div>
                                  )}
                                </div>
                              </div>

                              {/* 3. 规格与系统镜像 */}
                              <div className="p-2.5 rounded bg-background/80 border border-border/40 space-y-2">
                                <div className="font-medium text-foreground flex items-center gap-1.5">
                                  <Cpu className="size-3 text-muted-foreground" />
                                  规格与系统
                                </div>
                                <div className="space-y-1.5 text-[11px]">
                                  <div className="flex items-center justify-between">
                                    <span className="text-muted-foreground">
                                      系统镜像:
                                    </span>
                                    <span
                                      className="text-foreground font-medium truncate max-w-[140px]"
                                      title={
                                        instance.details?.blueprintName ||
                                        instance.details?.blueprintId
                                      }
                                    >
                                      {instance.details?.blueprintName ||
                                        instance.details?.blueprintId ||
                                        (isLightsail
                                          ? "Debian / Linux"
                                          : "ECS")}
                                    </span>
                                  </div>
                                  <div className="flex items-center justify-between">
                                    <span className="text-muted-foreground">
                                      硬件规格:
                                    </span>
                                    <span className="font-mono text-foreground">
                                      {spec ? `${spec} · ` : ""}
                                      {instance.details?.cpuCount
                                        ? `${instance.details.cpuCount} 核 / ${instance.details.ramSizeGb} GB`
                                        : instance.details?.bundleId ||
                                          "标准套餐"}
                                    </span>
                                  </div>
                                  {instance.details?.diskSizeGb && (
                                    <div className="flex items-center justify-between">
                                      <span className="text-muted-foreground">
                                        系统盘:
                                      </span>
                                      <span className="font-mono text-foreground">
                                        {instance.details.diskSizeGb} GB SSD
                                      </span>
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>

                            {/* 4. 防火墙端口规则 (Lightsail / Cloud Firewall Rules) */}
                            {(isLightsail || account.provider === "aws") && (
                              <div className="p-3 rounded-lg bg-background/80 border border-border/40 space-y-2.5">
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-2">
                                    <Shield className="size-3.5 text-primary" />
                                    <span className="font-semibold text-foreground text-xs">
                                      防火墙端口规则 (Firewall Rules)
                                    </span>
                                    {instanceRules[instance.id] && (
                                      <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded font-mono">
                                        {instanceRules[instance.id].length}{" "}
                                        条规则
                                      </span>
                                    )}
                                  </div>
                                  <div className="flex items-center gap-1.5">
                                    <Button
                                      size="xs"
                                      variant="ghost"
                                      className="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                                      title="刷新规则"
                                      onClick={() =>
                                        void loadRules(account.id, instance.id)
                                      }
                                      disabled={loadingRules[instance.id]}
                                    >
                                      <RefreshCw
                                        className={cn(
                                          "size-3",
                                          loadingRules[instance.id] &&
                                            "animate-spin",
                                        )}
                                      />
                                    </Button>
                                    <Button
                                      size="xs"
                                      variant="outline"
                                      className="h-6 px-2 text-[11px] gap-1 border-primary/30 text-primary hover:bg-primary/10"
                                      onClick={() => {
                                        if (
                                          addingRuleInstanceId === instance.id
                                        ) {
                                          setAddingRuleInstanceId(null);
                                        } else {
                                          setAddingRuleInstanceId(instance.id);
                                          setNewRuleProtocol("tcp");
                                          setNewRuleFromPort("");
                                          setNewRuleToPort("");
                                          setNewRuleCidr("");
                                        }
                                      }}
                                    >
                                      <Plus className="size-3" />
                                      {addingRuleInstanceId === instance.id
                                        ? "取消"
                                        : "添加端口规则"}
                                    </Button>
                                  </div>
                                </div>

                                {/* 新增规则表单 */}
                                {addingRuleInstanceId === instance.id && (
                                  <div className="p-2.5 rounded bg-muted/40 border border-border/60 space-y-2 animate-in fade-in-50 duration-150">
                                    <div className="text-[11px] font-medium text-foreground">
                                      新增公网开放端口
                                    </div>
                                    <div className="flex flex-wrap items-center gap-2 text-xs">
                                      <div className="flex items-center gap-1">
                                        <span className="text-[11px] text-muted-foreground">
                                          协议:
                                        </span>
                                        <select
                                          value={newRuleProtocol}
                                          onChange={(e) =>
                                            setNewRuleProtocol(e.target.value)
                                          }
                                          className="h-7 px-2 text-xs rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                                        >
                                          <option value="tcp">TCP</option>
                                          <option value="udp">UDP</option>
                                          <option value="all">
                                            ALL (全部)
                                          </option>
                                          <option value="icmp">
                                            ICMP (Ping)
                                          </option>
                                        </select>
                                      </div>

                                      <div className="flex items-center gap-1">
                                        <span className="text-[11px] text-muted-foreground">
                                          端口:
                                        </span>
                                        <input
                                          type="number"
                                          min="0"
                                          max="65535"
                                          placeholder="起始端口 (如 80)"
                                          value={newRuleFromPort}
                                          onChange={(e) =>
                                            setNewRuleFromPort(e.target.value)
                                          }
                                          className="w-24 h-7 px-2 text-xs font-mono rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                                        />
                                        <span className="text-muted-foreground">
                                          -
                                        </span>
                                        <input
                                          type="number"
                                          min="0"
                                          max="65535"
                                          placeholder="结束端口 (可选)"
                                          value={newRuleToPort}
                                          onChange={(e) =>
                                            setNewRuleToPort(e.target.value)
                                          }
                                          className="w-24 h-7 px-2 text-xs font-mono rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                                        />
                                      </div>

                                      <div className="flex items-center gap-1">
                                        <span className="text-[11px] text-muted-foreground">
                                          来源:
                                        </span>
                                        <input
                                          type="text"
                                          placeholder="默认 0.0.0.0/0 (任意 IP)"
                                          value={newRuleCidr}
                                          onChange={(e) =>
                                            setNewRuleCidr(e.target.value)
                                          }
                                          className="w-36 h-7 px-2 text-xs font-mono rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                                        />
                                      </div>

                                      <Button
                                        size="xs"
                                        className="h-7 px-3 text-xs gap-1"
                                        disabled={
                                          ruleOperating[`${instance.id}-add`] ||
                                          !newRuleFromPort
                                        }
                                        onClick={() =>
                                          void handleAddRule(account, instance)
                                        }
                                      >
                                        {ruleOperating[`${instance.id}-add`] ? (
                                          <>
                                            <Loader2 className="size-3 animate-spin" />
                                            正在开放...
                                          </>
                                        ) : (
                                          "确认开放"
                                        )}
                                      </Button>
                                    </div>
                                  </div>
                                )}

                                {/* 规则列表展示 */}
                                {loadingRules[instance.id] &&
                                !instanceRules[instance.id] ? (
                                  <div className="flex items-center gap-2 py-3 px-2 text-xs text-muted-foreground">
                                    <Loader2 className="size-3.5 animate-spin text-primary" />
                                    <span>正在获取防火墙端口规则...</span>
                                  </div>
                                ) : !instanceRules[instance.id] ||
                                  instanceRules[instance.id].length === 0 ? (
                                  <div className="py-2 px-1 text-[11px] text-muted-foreground">
                                    暂无开放的公网端口规则。点击「添加端口规则」开放所需服务端口。
                                  </div>
                                ) : (
                                  <div className="border border-border/40 rounded overflow-hidden">
                                    <table className="w-full text-left text-[11px]">
                                      <thead className="bg-muted/50 text-muted-foreground border-b border-border/40 font-medium">
                                        <tr>
                                          <th className="py-1.5 px-2.5">
                                            应用 / 类型
                                          </th>
                                          <th className="py-1.5 px-2.5">
                                            协议
                                          </th>
                                          <th className="py-1.5 px-2.5">
                                            端口范围
                                          </th>
                                          <th className="py-1.5 px-2.5">
                                            来源限制
                                          </th>
                                          <th className="py-1.5 px-2.5 text-right">
                                            操作
                                          </th>
                                        </tr>
                                      </thead>
                                      <tbody className="divide-y divide-border/30 font-mono">
                                        {instanceRules[instance.id].map(
                                          (rule, rIdx) => {
                                            const appName = getCommonPortName(
                                              rule.fromPort,
                                              rule.toPort,
                                              rule.protocol,
                                            );
                                            const delKey = `${instance.id}-del-${rule.protocol}-${rule.fromPort}-${rule.toPort}`;
                                            const isDeleting =
                                              ruleOperating[delKey];
                                            return (
                                              <tr
                                                key={`${rule.protocol}-${rule.fromPort}-${rule.toPort}-${rIdx}`}
                                                className="hover:bg-muted/30"
                                              >
                                                <td className="py-1.5 px-2.5 font-sans">
                                                  {appName ? (
                                                    <span className="font-medium text-foreground">
                                                      {appName}
                                                    </span>
                                                  ) : (
                                                    <span className="text-muted-foreground">
                                                      自定义
                                                    </span>
                                                  )}
                                                </td>
                                                <td className="py-1.5 px-2.5">
                                                  <span
                                                    className={cn(
                                                      "px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase",
                                                      rule.protocol === "tcp"
                                                        ? "bg-blue-500/10 text-blue-500 border border-blue-500/20"
                                                        : rule.protocol ===
                                                            "udp"
                                                          ? "bg-purple-500/10 text-purple-500 border border-purple-500/20"
                                                          : "bg-amber-500/10 text-amber-500 border border-amber-500/20",
                                                    )}
                                                  >
                                                    {rule.protocol}
                                                  </span>
                                                </td>
                                                <td className="py-1.5 px-2.5 text-foreground font-semibold">
                                                  {rule.fromPort === rule.toPort
                                                    ? rule.fromPort
                                                    : `${rule.fromPort} - ${rule.toPort}`}
                                                </td>
                                                <td className="py-1.5 px-2.5 text-muted-foreground">
                                                  {rule.cidrs &&
                                                  rule.cidrs.length > 0
                                                    ? rule.cidrs.join(", ")
                                                    : "0.0.0.0/0 (任意 IPv4)"}
                                                </td>
                                                <td className="py-1.5 px-2.5 text-right font-sans">
                                                  <Button
                                                    size="xs"
                                                    variant="ghost"
                                                    className="h-5 px-1.5 text-[10px] text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                                                    disabled={isDeleting}
                                                    onClick={() =>
                                                      void handleDeleteRule(
                                                        account,
                                                        instance,
                                                        rule,
                                                      )
                                                    }
                                                    title="关闭该端口"
                                                  >
                                                    {isDeleting ? (
                                                      <Loader2 className="size-2.5 animate-spin" />
                                                    ) : (
                                                      <Trash2 className="size-2.5 text-destructive" />
                                                    )}
                                                  </Button>
                                                </td>
                                              </tr>
                                            );
                                          },
                                        )}
                                      </tbody>
                                    </table>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>
        );
      })}
      {lightsailAccount && (
        <CreateLightsailModal
          account={lightsailAccount}
          isOpen={Boolean(lightsailAccount)}
          onClose={() => setLightsailAccount(null)}
          api={api}
          formatZone={formatAwsZone}
          onSuccess={() => {
            void syncNow(lightsailAccount);
          }}
        />
      )}
    </div>
  );
}

export function activate(app: TermixApp): void {
  app.registerRailItem({
    id: TAB_ID,
    icon: Cloud,
    titleKey: "tab.title",
    kind: "tab",
    permission: "view",
  });
  app.registerTab(TAB_ID, CloudTab, {
    icon: Cloud,
    titleKey: "tab.title",
    singleton: true,
    hostless: true,
  });
  app.registerDashboardCard({
    id: "cc-cloud-accounts",
    titleKey: "card.title",
    defaultPanel: "side",
    defaultHeight: 180,
    frame: "framed",
    component: CloudCard,
  });
}
