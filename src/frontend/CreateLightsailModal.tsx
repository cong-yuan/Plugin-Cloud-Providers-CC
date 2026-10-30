import React, { useEffect, useState } from "react";
import { Zap, Check, Loader2, Camera, FileCode, Network } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Checkbox,
  Textarea,
  cn,
} from "@termix-ssh/plugin-sdk/ui";
import { toast } from "sonner";
import {
  errorMessage,
  type Account,
  type CloudApi,
  type LightsailBlueprint,
  type LightsailBundle,
  type TermixSnippet,
} from "./api";

function cleanAwsRegion(raw: string | null | undefined): string {
  if (!raw) return "us-east-2";
  const first = raw.split(/[\s,]+/)[0].trim();
  const match = first.match(/^([a-z]{2}-[a-z]+-\d+)[a-z]?$/i);
  return match ? match[1].toLowerCase() : first.toLowerCase() || "us-east-2";
}

const DEFAULT_BLUEPRINTS: LightsailBlueprint[] = [
  { id: "debian_12", name: "Debian 12 (Bookworm) - 推荐", type: "os" },
  { id: "ubuntu_24_04", name: "Ubuntu 24.04 LTS", type: "os" },
  { id: "ubuntu_22_04", name: "Ubuntu 22.04 LTS", type: "os" },
  { id: "amazon_linux_2023", name: "Amazon Linux 2023", type: "os" },
  { id: "almalinux_9", name: "AlmaLinux 9", type: "os" },
];

const DEFAULT_DUAL_STACK: LightsailBundle[] = [
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

const DEFAULT_IPV6_ONLY: LightsailBundle[] = [
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

const SNAPSHOT_HOURS = [
  { value: "00:00", label: "00:00 UTC (北京时间 08:00)" },
  { value: "02:00", label: "02:00 UTC (北京时间 10:00)" },
  { value: "04:00", label: "04:00 UTC (北京时间 12:00)" },
  { value: "08:00", label: "08:00 UTC (北京时间 16:00)" },
  { value: "12:00", label: "12:00 UTC (北京时间 20:00)" },
  { value: "16:00", label: "16:00 UTC (北京时间 00:00)" },
  { value: "20:00", label: "20:00 UTC (北京时间 04:00)" },
];

interface CreateLightsailModalProps {
  account: Account;
  isOpen: boolean;
  onClose: () => void;
  api: CloudApi;
  onSuccess: () => void;
  formatZone: (zone: string) => string;
}

export function CreateLightsailModal({
  account,
  isOpen,
  onClose,
  api,
  onSuccess,
  formatZone,
}: CreateLightsailModalProps) {
  const defaultRegion = cleanAwsRegion(account.region);
  const [instanceName, setInstanceName] = useState("");
  const [zone, setZone] = useState(`${defaultRegion}a`);
  const [blueprintId, setBlueprintId] = useState("debian_12");

  // Networking classification: Dual-stack vs IPv6-only
  const [networkType, setNetworkType] = useState<"dual_stack" | "ipv6_only">(
    "dual_stack",
  );
  const [bundleId, setBundleId] = useState("micro_3_0");

  // Automatic Snapshots
  const [enableAutoSnapshot, setEnableAutoSnapshot] = useState(false);
  const [snapshotTime, setSnapshotTime] = useState("00:00");

  // User Data & Termix Snippets
  const [userData, setUserData] = useState("");
  const [showUserData, setShowUserData] = useState(false);
  const [snippets, setSnippets] = useState<TermixSnippet[]>([]);
  const [selectedSnippetId, setSelectedSnippetId] = useState<string>("");

  const [loading, setLoading] = useState(false);
  const [plansLoading, setPlansLoading] = useState(false);
  const [zones, setZones] = useState<string[]>([
    `${defaultRegion}a`,
    `${defaultRegion}b`,
    `${defaultRegion}c`,
  ]);
  const [blueprints, setBlueprints] =
    useState<LightsailBlueprint[]>(DEFAULT_BLUEPRINTS);
  const [dualStackBundles, setDualStackBundles] =
    useState<LightsailBundle[]>(DEFAULT_DUAL_STACK);
  const [ipv6OnlyBundles, setIpv6OnlyBundles] =
    useState<LightsailBundle[]>(DEFAULT_IPV6_ONLY);

  useEffect(() => {
    if (!isOpen) return;
    const randomSuffix = Math.random().toString(36).substring(2, 6);
    setInstanceName(`lightsail-${randomSuffix}`);
    setZone(`${defaultRegion}a`);
    setNetworkType("dual_stack");
    setBundleId("micro_3_0");
    setEnableAutoSnapshot(false);
    setUserData("");
    setShowUserData(false);
    setSelectedSnippetId("");

    let active = true;
    setPlansLoading(true);

    // Fetch live plans from AWS
    api
      .getLightsailPlans(account.id, defaultRegion)
      .then((res) => {
        if (!active) return;
        if (res.zones && res.zones.length > 0) {
          setZones(res.zones);
          setZone(res.zones[0]);
        }
        if (res.blueprints && res.blueprints.length > 0) {
          setBlueprints(res.blueprints);
        }
        if (res.dualStackBundles && res.dualStackBundles.length > 0) {
          setDualStackBundles(res.dualStackBundles);
        }
        if (res.ipv6OnlyBundles && res.ipv6OnlyBundles.length > 0) {
          setIpv6OnlyBundles(res.ipv6OnlyBundles);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (active) setPlansLoading(false);
      });

    // Fetch Termix snippets for user data selection
    api
      .getSnippets()
      .then((snips) => {
        if (active && Array.isArray(snips)) {
          setSnippets(snips);
        }
      })
      .catch(() => {});

    return () => {
      active = false;
    };
  }, [isOpen, account.id, defaultRegion, api]);

  // Handle switching network type
  function handleNetworkTypeChange(type: "dual_stack" | "ipv6_only") {
    setNetworkType(type);
    if (type === "dual_stack") {
      setBundleId(
        dualStackBundles[1]?.id || dualStackBundles[0]?.id || "micro_3_0",
      );
    } else {
      setBundleId(ipv6OnlyBundles[0]?.id || "nano_ipv6_3_0");
    }
  }

  // Handle choosing snippet
  function handleSnippetSelect(snippetId: string) {
    setSelectedSnippetId(snippetId);
    const snip = snippets.find((s) => String(s.id) === snippetId);
    if (snip) {
      setUserData(snip.content);
      setShowUserData(true);
      toast.success(`已载入代码片段: ${snip.name}`);
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const name = instanceName.trim();
    if (!name) {
      toast.error("请输入实例名称");
      return;
    }

    setLoading(true);
    try {
      toast.info(`正在通过 AWS Lightsail API 创建实例 ${name}...`);
      await api.createLightsail(account.id, {
        instanceName: name,
        region: defaultRegion,
        availabilityZone: zone,
        blueprintId,
        bundleId,
        enableAutoSnapshot,
        snapshotTimeOfDay: enableAutoSnapshot ? snapshotTime : undefined,
        userData: userData.trim() || undefined,
      });

      toast.success(`🎉 光帆实例 ${name} 创建成功！正在同步主机...`);
      onSuccess();
      onClose();
    } catch (err: unknown) {
      toast.error(errorMessage(err) || "创建光帆实例失败");
    } finally {
      setLoading(false);
    }
  }

  const currentBundles =
    networkType === "dual_stack" ? dualStackBundles : ipv6OnlyBundles;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-[95vw] sm:max-w-[800px] max-h-[92vh] overflow-y-auto">
        <DialogHeader className="pb-1">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Zap className="size-4.5 text-amber-500" />
            创建 AWS Lightsail 光帆服务器
          </DialogTitle>
          <DialogDescription className="text-xs">
            调用 AWS Lightsail 接口开机，开机完成后将自动同步并导入到 Termix。
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleCreate} className="space-y-3 py-1 text-xs">
          {/* 实例名称 */}
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-foreground">
              实例名称 (Instance Name)
            </label>
            <Input
              value={instanceName}
              onChange={(e) => setInstanceName(e.target.value)}
              placeholder="e.g. debian-prod-01"
              required
              className="h-7 w-full text-xs font-mono px-2.5 py-0.5"
            />
          </div>

          {/* 所在可用区 与 系统镜像 在同一行 */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* 所在可用区 */}
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-foreground flex items-center justify-between">
                <span>所在可用区 (Availability Zone)</span>
                {plansLoading && (
                  <span className="text-muted-foreground text-[10px] flex items-center gap-1">
                    <Loader2 className="size-2.5 animate-spin" /> 加载中...
                  </span>
                )}
              </label>
              <Select value={zone} onValueChange={setZone}>
                <SelectTrigger size="sm" className="h-7 w-full text-xs px-2.5">
                  <SelectValue placeholder="选择可用区" />
                </SelectTrigger>
                <SelectContent>
                  {zones.map((z) => (
                    <SelectItem key={z} value={z} className="text-xs">
                      {formatZone(z)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* 系统镜像 */}
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-foreground">
                系统镜像 (Blueprint / OS)
              </label>
              <Select value={blueprintId} onValueChange={setBlueprintId}>
                <SelectTrigger size="sm" className="h-7 w-full text-xs px-2.5">
                  <SelectValue placeholder="选择系统镜像" />
                </SelectTrigger>
                <SelectContent>
                  {blueprints.map((b) => (
                    <SelectItem key={b.id} value={b.id} className="text-xs">
                      {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* 网络类型 与 套餐规格 在同一行 */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* 网络类型：紧凑切换控制 */}
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-foreground flex items-center gap-1.5">
                <Network className="size-3 text-primary" />
                <span>网络类型 (Networking Type)</span>
              </label>
              <div className="grid grid-cols-2 p-0.5 rounded-md bg-muted/50 border border-border/60 h-7 items-center">
                <button
                  type="button"
                  onClick={() => handleNetworkTypeChange("dual_stack")}
                  className={cn(
                    "h-6 flex items-center justify-center gap-1 rounded text-[11px] font-medium transition-all select-none cursor-pointer",
                    networkType === "dual_stack"
                      ? "bg-background text-foreground shadow-xs font-semibold"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {networkType === "dual_stack" && (
                    <Check className="size-3 text-primary shrink-0" />
                  )}
                  <span>双栈 (IPv4 + IPv6)</span>
                </button>

                <button
                  type="button"
                  onClick={() => handleNetworkTypeChange("ipv6_only")}
                  className={cn(
                    "h-6 flex items-center justify-center gap-1 rounded text-[11px] font-medium transition-all select-none cursor-pointer",
                    networkType === "ipv6_only"
                      ? "bg-background text-foreground shadow-xs font-semibold"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {networkType === "ipv6_only" && (
                    <Check className="size-3 text-primary shrink-0" />
                  )}
                  <span>纯 IPv6 ($3.5/月起)</span>
                </button>
              </div>
            </div>

            {/* 套餐规格下拉框 */}
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-foreground flex items-center justify-between">
                <span>
                  {networkType === "dual_stack" ? "双栈" : "纯 IPv6"} 套餐规格
                  (Bundle)
                </span>
                {plansLoading && (
                  <span className="text-muted-foreground text-[10px] flex items-center gap-1">
                    <Loader2 className="size-2.5 animate-spin" /> 同步中...
                  </span>
                )}
              </label>
              <Select value={bundleId} onValueChange={setBundleId}>
                <SelectTrigger size="sm" className="h-7 w-full text-xs px-2.5">
                  <SelectValue placeholder="选择套餐规格" />
                </SelectTrigger>
                <SelectContent>
                  {currentBundles.map((b) => (
                    <SelectItem key={b.id} value={b.id} className="text-xs">
                      {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* 自动快照与初始化脚本 */}
          <div className="rounded-md border border-border/60 bg-muted/20 p-2.5 space-y-2">
            {/* 自动快照配置 */}
            <div className="flex items-center justify-between gap-2">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <Checkbox
                  checked={enableAutoSnapshot}
                  onCheckedChange={(checked) =>
                    setEnableAutoSnapshot(Boolean(checked))
                  }
                />
                <span className="font-medium text-foreground text-[11px] flex items-center gap-1">
                  <Camera className="size-3 text-muted-foreground" />
                  启用每日自动快照 (Automatic Snapshots)
                </span>
              </label>

              {enableAutoSnapshot && (
                <div className="flex items-center gap-1.5 shrink-0">
                  <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                    执行时间:
                  </span>
                  <Select value={snapshotTime} onValueChange={setSnapshotTime}>
                    <SelectTrigger
                      size="sm"
                      className="h-6 w-[170px] text-[10px] px-2"
                    >
                      <SelectValue placeholder="选择快照时间" />
                    </SelectTrigger>
                    <SelectContent>
                      {SNAPSHOT_HOURS.map((h) => (
                        <SelectItem
                          key={h.value}
                          value={h.value}
                          className="text-xs"
                        >
                          {h.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            <div className="border-t border-border/40" />

            {/* 初始化脚本与 Termix 代码片段导入 */}
            <div>
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setShowUserData(!showUserData)}
                  className="text-[11px] font-medium text-foreground hover:text-primary flex items-center gap-1 cursor-pointer select-none"
                >
                  <FileCode className="size-3 text-muted-foreground" />
                  <span>
                    {showUserData ? "收起" : "展开"} 启动脚本 (Cloud-init User
                    Data - 选填)
                  </span>
                </button>

                {snippets.length > 0 && (
                  <div className="flex items-center gap-1.5 shrink-0">
                    <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                      代码片段:
                    </span>
                    <Select
                      value={selectedSnippetId}
                      onValueChange={handleSnippetSelect}
                    >
                      <SelectTrigger
                        size="sm"
                        className="h-6 text-[10px] px-2 w-[160px]"
                      >
                        <SelectValue placeholder="选择 Termix 片段..." />
                      </SelectTrigger>
                      <SelectContent>
                        {snippets.map((s) => (
                          <SelectItem
                            key={s.id}
                            value={String(s.id)}
                            className="text-xs"
                          >
                            {s.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>

              {showUserData && (
                <div className="space-y-1 pt-2">
                  <Textarea
                    value={userData}
                    onChange={(e) => setUserData(e.target.value)}
                    placeholder="#!/bin/bash&#10;# 服务器首次开机自动执行的脚本&#10;apt update -y"
                    className="h-20 w-full text-[11px] font-mono resize-none py-1.5 px-2"
                  />
                  <p className="text-[10px] text-muted-foreground">
                    支持 Shell 脚本或 cloud-init 配置文件，首次开机自动以 root
                    权限执行。
                  </p>
                </div>
              )}
            </div>
          </div>

          <DialogFooter className="gap-2 pt-1 sm:justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onClose}
              disabled={loading}
              className="h-7 text-xs px-3"
            >
              取消
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={loading}
              className="h-7 text-xs px-3 gap-1.5 bg-amber-500 hover:bg-amber-600 text-white"
            >
              {loading ? (
                <>
                  <Loader2 className="size-3 animate-spin" />
                  正在开机...
                </>
              ) : (
                <>
                  <Zap className="size-3" />
                  立即创建
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
