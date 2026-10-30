import React, { useEffect, useState } from "react";
import { Server, Zap, Check, Loader2, Globe } from "lucide-react";
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
} from "@termix-ssh/plugin-sdk/ui";
import { toast } from "sonner";
import type {
  Account,
  CloudApi,
  LightsailBlueprint,
  LightsailBundle,
} from "./api";

const DEFAULT_BLUEPRINTS: LightsailBlueprint[] = [
  { id: "debian_12", name: "Debian 12 (Bookworm) - 推荐", type: "os" },
  { id: "ubuntu_24_04", name: "Ubuntu 24.04 LTS", type: "os" },
  { id: "ubuntu_22_04", name: "Ubuntu 22.04 LTS", type: "os" },
  { id: "amazon_linux_2023", name: "Amazon Linux 2023", type: "os" },
  { id: "almalinux_9", name: "AlmaLinux 9", type: "os" },
];

const DEFAULT_BUNDLES: LightsailBundle[] = [
  {
    id: "nano_3_0",
    name: "$3.50/月 · 512 MB 内存 / 1 核 / 20 GB SSD / 1 TB 流量",
    price: 3.5,
    ramGb: 0.5,
    vCpu: 1,
    diskGb: 20,
    transferGb: 1000,
  },
  {
    id: "micro_3_0",
    name: "$5.00/月 · 1 GB 内存 / 1 核 / 40 GB SSD / 2 TB 流量 (推荐)",
    price: 5.0,
    ramGb: 1.0,
    vCpu: 1,
    diskGb: 40,
    transferGb: 2000,
  },
  {
    id: "small_3_0",
    name: "$10.00/月 · 2 GB 内存 / 1 核 / 60 GB SSD / 3 TB 流量 (畅销)",
    price: 10.0,
    ramGb: 2.0,
    vCpu: 1,
    diskGb: 60,
    transferGb: 3000,
  },
  {
    id: "medium_3_0",
    name: "$20.00/月 · 4 GB 内存 / 2 核 / 80 GB SSD / 4 TB 流量",
    price: 20.0,
    ramGb: 4.0,
    vCpu: 2,
    diskGb: 80,
    transferGb: 4000,
  },
  {
    id: "large_3_0",
    name: "$40.00/月 · 8 GB 内存 / 2 核 / 160 GB SSD / 5 TB 流量",
    price: 40.0,
    ramGb: 8.0,
    vCpu: 2,
    diskGb: 160,
    transferGb: 5000,
  },
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
  const defaultRegion = (account.region || "us-east-2").split(",")[0].trim();
  const [instanceName, setInstanceName] = useState("");
  const [zone, setZone] = useState(`${defaultRegion}a`);
  const [blueprintId, setBlueprintId] = useState("debian_12");
  const [bundleId, setBundleId] = useState("micro_3_0");
  const [allocateStaticIp, setAllocateStaticIp] = useState(true);
  const [userData, setUserData] = useState("");
  const [showUserData, setShowUserData] = useState(false);

  const [loading, setLoading] = useState(false);
  const [plansLoading, setPlansLoading] = useState(false);
  const [zones, setZones] = useState<string[]>([
    `${defaultRegion}a`,
    `${defaultRegion}b`,
    `${defaultRegion}c`,
  ]);
  const [blueprints, setBlueprints] =
    useState<LightsailBlueprint[]>(DEFAULT_BLUEPRINTS);
  const [bundles, setBundles] = useState<LightsailBundle[]>(DEFAULT_BUNDLES);

  useEffect(() => {
    if (!isOpen) return;
    const randomSuffix = Math.random().toString(36).substring(2, 6);
    setInstanceName(`lightsail-${randomSuffix}`);
    setZone(`${defaultRegion}a`);

    let active = true;
    setPlansLoading(true);
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
        if (res.bundles && res.bundles.length > 0) {
          setBundles(res.bundles);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (active) setPlansLoading(false);
      });

    return () => {
      active = false;
    };
  }, [isOpen, account.id, defaultRegion, api]);

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
        allocateStaticIp,
        userData: userData.trim() || undefined,
      });

      toast.success(`🎉 光帆实例 ${name} 创建成功！正在同步主机...`);
      onSuccess();
      onClose();
    } catch (err: any) {
      toast.error(err?.message || "创建光帆实例失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="size-5 text-amber-500" />
            创建 AWS Lightsail 光帆服务器
          </DialogTitle>
          <DialogDescription>
            直接调用 AWS Lightsail 接口开机，开机完成后将自动同步并导入到
            Termix。
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleCreate} className="space-y-4 py-2 text-xs">
          {/* 实例名称 */}
          <div className="space-y-1.5">
            <label className="text-[11px] font-semibold text-foreground">
              实例名称 (Instance Name)
            </label>
            <Input
              value={instanceName}
              onChange={(e) => setInstanceName(e.target.value)}
              placeholder="e.g. debian-prod-01"
              required
              className="h-8 text-xs font-mono"
            />
          </div>

          {/* 可用区选择 */}
          <div className="space-y-1.5">
            <label className="text-[11px] font-semibold text-foreground flex items-center justify-between">
              <span>所在可用区 (Availability Zone)</span>
              {plansLoading && (
                <span className="text-muted-foreground text-[10px] flex items-center gap-1">
                  <Loader2 className="size-2.5 animate-spin" /> 加载可用区...
                </span>
              )}
            </label>
            <Select value={zone} onValueChange={setZone}>
              <SelectTrigger className="h-8 text-xs">
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
          <div className="space-y-1.5">
            <label className="text-[11px] font-semibold text-foreground">
              系统镜像 (Blueprint / OS)
            </label>
            <Select value={blueprintId} onValueChange={setBlueprintId}>
              <SelectTrigger className="h-8 text-xs">
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

          {/* 套餐配置 */}
          <div className="space-y-1.5">
            <label className="text-[11px] font-semibold text-foreground">
              套餐规格 (Bundle / Specs)
            </label>
            <Select value={bundleId} onValueChange={setBundleId}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="选择套餐规格" />
              </SelectTrigger>
              <SelectContent>
                {bundles.map((b) => (
                  <SelectItem key={b.id} value={b.id} className="text-xs">
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* 静态公网 IP */}
          <div className="rounded-md border border-border/50 bg-muted/30 p-2.5 space-y-1">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <Checkbox
                checked={allocateStaticIp}
                onCheckedChange={(checked) =>
                  setAllocateStaticIp(Boolean(checked))
                }
              />
              <span className="font-semibold text-foreground text-[11px]">
                自动分配并绑定静态公网 IP (推荐)
              </span>
            </label>
            <p className="text-[10px] text-muted-foreground pl-6">
              Lightsail 提供免费的静态公网 IP，绑定后可避免实例关机或重启后公网
              IP 发生变更。
            </p>
          </div>

          {/* 启动脚本 (选填) */}
          <div className="space-y-1">
            <button
              type="button"
              onClick={() => setShowUserData(!showUserData)}
              className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1 underline underline-offset-2"
            >
              {showUserData ? "收起" : "展开"} 初始化脚本 (Cloud-init User Data
              - 选填)
            </button>
            {showUserData && (
              <Textarea
                value={userData}
                onChange={(e) => setUserData(e.target.value)}
                placeholder="#!/bin/bash&#10;echo 'Hello Lightsail' > /root/init.log"
                className="h-20 text-[11px] font-mono mt-1"
              />
            )}
          </div>

          <DialogFooter className="gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onClose}
              disabled={loading}
            >
              取消
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={loading}
              className="gap-1.5 bg-amber-500 hover:bg-amber-600 text-white"
            >
              {loading ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  正在开机...
                </>
              ) : (
                <>
                  <Zap className="size-3.5" />
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
