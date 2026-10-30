import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
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
  ListRow,
  ListRowAction,
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
const DEFAULT_CREDITS_LABEL =
  "{Credits remaining [$200.00 USD] Days remaining 182 days (Apr 29, 2027)}";

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
  >({});
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
    } catch (error) {
      toast.error(errorMessage(error));
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
        if (!accountInstances[accountId]) {
          void loadInstances(accountId);
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
        const creditsText = account.credits || DEFAULT_CREDITS_LABEL;

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
                  <span className="font-semibold text-foreground text-sm">
                    {account.name}
                  </span>
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                    <span className="size-1.5 rounded-full bg-emerald-500 shrink-0" />
                    <span>{creditsText}</span>
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
              actions={
                <div onClick={(e) => e.stopPropagation()}>
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

            {/* Expanded Server / Instance List */}
            {isExpanded && (
              <div className="ml-7 -mt-1 mb-3 rounded-lg border border-border/70 bg-card/60 p-2.5 flex flex-col gap-1.5 shadow-sm animate-in fade-in-50 duration-200">
                {isLoading ? (
                  <div className="flex items-center gap-2 py-3 px-3 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin text-accent-brand" />
                    <span>正在获取服务器列表...</span>
                  </div>
                ) : instances.length === 0 ? (
                  <div className="py-2.5 px-3 text-xs text-muted-foreground flex items-center justify-between">
                    <span>该账户下暂未找到可用服务器实例。</span>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs"
                      onClick={(e) => {
                        e.stopPropagation();
                        void loadInstances(account.id);
                      }}
                    >
                      <RefreshCw className="mr-1 size-3" /> 重新检测
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center justify-between px-2.5 py-1 text-[11px] text-muted-foreground font-medium border-b border-border/40 pb-1.5 mb-0.5">
                      <span>所属服务器 ({instances.length})</span>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                        onClick={(e) => {
                          e.stopPropagation();
                          void loadInstances(account.id);
                        }}
                      >
                        <RefreshCw className="mr-1 size-3" /> 刷新列表
                      </Button>
                    </div>

                    {instances.map((instance) => {
                      const isLightsail = instance.id.startsWith("lightsail/");
                      const tagLabel = isLightsail ? "光帆" : "ECS";
                      const tagClass = isLightsail
                        ? "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30"
                        : "bg-sky-500/15 text-sky-600 dark:text-sky-400 border-sky-500/30";
                      const ip =
                        instance.address ||
                        instance.publicIp ||
                        instance.privateIp ||
                        "无公网 IP";
                      const isRunning = instance.state === "running";

                      return (
                        <div
                          key={instance.id}
                          className="group relative flex items-center justify-between rounded-md px-3 py-2 text-xs transition-colors hover:bg-muted/50 border border-transparent hover:border-border/60"
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            <span
                              className={`size-2 rounded-full shrink-0 ${isRunning ? "bg-emerald-500" : "bg-muted-foreground/40"}`}
                              title={isRunning ? "运行中" : instance.state}
                            />
                            <span
                              className={`inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-semibold border ${tagClass}`}
                            >
                              {tagLabel}
                            </span>
                            <span className="font-medium text-foreground truncate max-w-[150px] sm:max-w-[200px]">
                              {instance.name}
                            </span>
                            <span className="text-muted-foreground font-mono text-[11px] shrink-0">
                              {ip}
                            </span>
                            {instance.region && (
                              <span className="hidden sm:inline-block text-[10px] text-muted-foreground/70 bg-muted/40 px-1.5 py-0.5 rounded">
                                {instance.region}
                              </span>
                            )}
                            {instance.imported && (
                              <span className="inline-flex items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5 text-[10px] text-muted-foreground border border-border/40">
                                <Check className="size-2.5 text-emerald-500" />{" "}
                                已导入
                              </span>
                            )}
                          </div>

                          {/* Hover action toolbar */}
                          <div className="flex items-center gap-1 opacity-90 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity shrink-0 ml-2">
                            <Button
                              type="button"
                              size="sm"
                              variant="default"
                              className="h-6 px-2 text-[11px] gap-1 shadow-sm bg-accent-brand text-accent-brand-foreground hover:bg-accent-brand/90"
                              disabled={importingId === instance.id}
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleConnect(account, instance);
                              }}
                              title="连接此服务器"
                            >
                              <Terminal className="size-3" />
                              <span>连接</span>
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleSftp(instance);
                              }}
                              title="SFTP 文件管理器"
                            >
                              <Folder className="size-3" />
                              <span className="hidden md:inline ml-1">
                                SFTP
                              </span>
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (ip && ip !== "无公网 IP") {
                                  void navigator.clipboard.writeText(ip);
                                  toast.success(`已复制 IP: ${ip}`);
                                }
                              }}
                              title="复制 IP"
                            >
                              <Copy className="size-3" />
                            </Button>
                            {!instance.imported && (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="h-6 px-2 text-[11px] gap-1 border-dashed"
                                disabled={importingId === instance.id}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void handleImportOnly(account, instance);
                                }}
                                title="仅导入为 Termix 主机"
                              >
                                <DownloadCloud className="size-3" />
                                <span>导入</span>
                              </Button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
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
