import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Cloud,
  Copy,
  DownloadCloud,
  Folder,
  Loader2,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Terminal,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import {
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
  type ProviderInfo,
  type SavedCredential,
} from "./api";
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
    const instanceId = settings?.instanceId || `host-${h.id}`;
    const regionTag = (h.tags || []).find(
      (t: string) =>
        t.startsWith("cc-cloud:") &&
        ![
          "cc-cloud:aws",
          "cc-cloud:ecs",
          "cc-cloud:lightsail",
          "cc-cloud:stopped",
        ].includes(t),
    );
    const region = regionTag
      ? regionTag.replace("cc-cloud:", "")
      : account.region || "";
    const isStopped = (h.tags || []).includes("cc-cloud:stopped");

    return {
      id: instanceId,
      name: h.name,
      address: h.ip,
      publicIp: h.ip,
      privateIp: null,
      region,
      state: isStopped ? "stopped" : "running",
      imported: true,
    };
  });
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
      .forEach((r) => set.add(r));
  }

  if (instances && instances.length > 0) {
    instances
      .map((i) => i.region?.trim())
      .filter((r): r is string => Boolean(r) && r.toLowerCase() !== "all")
      .forEach((r) => set.add(r));
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
        ![
          "cc-cloud:aws",
          "cc-cloud:ecs",
          "cc-cloud:lightsail",
          "cc-cloud:stopped",
        ].includes(t),
    );
    if (tag) set.add(tag.replace("cc-cloud:", ""));
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
          } else {
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
                    const isLightsail = instance.id.startsWith("lightsail/");
                    const tagLabel = isLightsail ? "光帆" : "ECS";
                    const tagTone = isLightsail ? "warning" : "brand";
                    const ip =
                      instance.address ||
                      instance.publicIp ||
                      instance.privateIp ||
                      "无公网 IP";
                    const isRunning = instance.state === "running";

                    return (
                      <ListRow
                        key={instance.id}
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
                            {instance.imported && (
                              <ListBadge tone="success">已导入</ListBadge>
                            )}
                          </div>
                        }
                        meta={
                          <span className="flex items-center gap-2 text-[11px]">
                            <span>
                              IP:{" "}
                              <code className="font-mono text-foreground/80">
                                {ip}
                              </code>
                            </span>
                            {instance.region && (
                              <span>· {instance.region}</span>
                            )}
                            <span>
                              ·{" "}
                              {isRunning
                                ? "运行中"
                                : instance.state || "已停止"}
                            </span>
                          </span>
                        }
                        trailing={
                          <div
                            className="flex items-center gap-0.5"
                            onClick={(e) => e.stopPropagation()}
                          >
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
                    );
                  })
                )}
              </div>
            )}
          </div>
        );
      })}
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
