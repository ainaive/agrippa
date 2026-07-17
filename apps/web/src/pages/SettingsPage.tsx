import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiError, api } from "../lib/api";
import { lt } from "../lib/format";
import type { Faber, Grant, McpServerRow, Member, ModelRow, Quota, SkillRow } from "../lib/types";

function MembersTab({ projectId }: { projectId: string }) {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const members = useQuery({
    queryKey: ["members", projectId],
    queryFn: () => api<Member[]>(`/projects/${projectId}/members`),
  });
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [error, setError] = useState<string | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["members", projectId] });
  const add = useMutation({
    mutationFn: () =>
      api(`/projects/${projectId}/members`, { method: "POST", json: { email, role } }),
    onSuccess: () => {
      setEmail("");
      setError(null);
      void refresh();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });
  const setMemberRole = useMutation({
    mutationFn: (input: { userId: string; role: string }) =>
      api(`/projects/${projectId}/members/${input.userId}`, {
        method: "PATCH",
        json: { role: input.role },
      }),
    onSuccess: () => void refresh(),
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });
  const remove = useMutation({
    mutationFn: (userId: string) =>
      api(`/projects/${projectId}/members/${userId}`, { method: "DELETE" }),
    onSuccess: () => void refresh(),
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-2">
        <div className="flex-1 space-y-1">
          <Label htmlFor="invite-email">{t("members.email")}</Label>
          <Input
            id="invite-email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="teammate@example.com"
          />
        </div>
        <Select value={role} onValueChange={setRole}>
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="admin">{t("roles.admin")}</SelectItem>
            <SelectItem value="member">{t("roles.member")}</SelectItem>
            <SelectItem value="viewer">{t("roles.viewer")}</SelectItem>
          </SelectContent>
        </Select>
        <Button disabled={!email || add.isPending} onClick={() => add.mutate()}>
          {t("members.add")}
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <ul className="divide-y">
        {(members.data ?? []).map((member) => (
          <li key={member.userId} className="flex items-center justify-between gap-3 py-2 text-sm">
            <div>
              <p className="font-medium">{member.name}</p>
              <p className="text-xs text-muted-foreground">{member.email}</p>
            </div>
            <div className="flex items-center gap-2">
              <Select
                value={member.role}
                onValueChange={(value) =>
                  setMemberRole.mutate({ userId: member.userId, role: value })
                }
              >
                <SelectTrigger className="w-28" size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">{t("roles.admin")}</SelectItem>
                  <SelectItem value="member">{t("roles.member")}</SelectItem>
                  <SelectItem value="viewer">{t("roles.viewer")}</SelectItem>
                </SelectContent>
              </Select>
              <Button size="sm" variant="ghost" onClick={() => remove.mutate(member.userId)}>
                ✕
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function GrantsTab({ projectId }: { projectId: string }) {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const grants = useQuery({
    queryKey: ["grants", projectId],
    queryFn: () => api<Grant[]>(`/projects/${projectId}/grants`),
  });
  const modelRows = useQuery({ queryKey: ["models"], queryFn: () => api<ModelRow[]>("/models") });
  const skillRows = useQuery({ queryKey: ["skills"], queryFn: () => api<SkillRow[]>("/skills") });
  const mcpRows = useQuery({
    queryKey: ["mcp-servers"],
    queryFn: () => api<McpServerRow[]>("/mcp-servers"),
  });
  const faberRows = useQuery({ queryKey: ["fabri"], queryFn: () => api<Faber[]>("/fabri") });

  const granted = new Set((grants.data ?? []).map((g) => `${g.resourceType}:${g.resourceId}`));

  const put = useMutation({
    mutationFn: (next: Array<{ resourceType: string; resourceId: string }>) =>
      api(`/projects/${projectId}/grants`, { method: "PUT", json: next }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["grants", projectId] }),
  });

  const toggle = (resourceType: string, resourceId: string) => {
    const key = `${resourceType}:${resourceId}`;
    const next = (grants.data ?? [])
      .map((g) => ({ resourceType: g.resourceType, resourceId: g.resourceId }))
      .filter((g) => `${g.resourceType}:${g.resourceId}` !== key);
    if (!granted.has(key)) next.push({ resourceType, resourceId });
    put.mutate(next);
  };

  const section = (
    title: string,
    type: string,
    rows: Array<{ id: string; label: string; detail?: string }>,
  ) => (
    <div>
      <h3 className="mb-2 text-sm font-semibold">{title}</h3>
      <ul className="space-y-1">
        {rows.map((row) => (
          <li
            key={row.id}
            className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
          >
            <div>
              <span className="font-medium">{row.label}</span>
              {row.detail && (
                <span className="ml-2 text-xs text-muted-foreground">{row.detail}</span>
              )}
            </div>
            <Switch
              checked={granted.has(`${type}:${row.id}`)}
              onCheckedChange={() => toggle(type, row.id)}
            />
          </li>
        ))}
        {rows.length === 0 && <p className="text-xs text-muted-foreground">—</p>}
      </ul>
    </div>
  );

  return (
    <div className="grid gap-6 sm:grid-cols-2">
      {section(
        t("grants.models"),
        "model",
        (modelRows.data ?? []).map((m) => ({ id: m.id, label: m.displayName, detail: m.tier })),
      )}
      {section(
        t("grants.skills"),
        "skill",
        (skillRows.data ?? []).map((s) => ({ id: s.id, label: lt(s.nameI18n), detail: s.slug })),
      )}
      {section(
        t("grants.mcp"),
        "mcp_server",
        (mcpRows.data ?? []).map((m) => ({ id: m.id, label: lt(m.nameI18n), detail: m.transport })),
      )}
      {section(
        t("grants.fabri"),
        "faber",
        (faberRows.data ?? []).map((f) => ({
          id: f.id,
          label: `${f.avatar ?? ""} ${lt(f.nameI18n)}`.trim(),
          detail: f.slug,
        })),
      )}
    </div>
  );
}

function ReposTab({ projectId }: { projectId: string }) {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const repos = useQuery({
    queryKey: ["repos", projectId],
    queryFn: () =>
      api<Array<{ id: string; url: string; defaultBranch: string; hasCredential: boolean }>>(
        `/projects/${projectId}/repos`,
      ),
  });
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: () =>
      api(`/projects/${projectId}/repos`, {
        method: "POST",
        json: {
          provider: "github",
          url,
          defaultBranch: branch,
          token: token || undefined,
        },
      }),
    onSuccess: () => {
      setUrl("");
      setToken("");
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["repos", projectId] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });
  const remove = useMutation({
    mutationFn: (repoId: string) =>
      api(`/projects/${projectId}/repos/${repoId}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["repos", projectId] }),
  });

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-[1fr_140px_1fr_auto] sm:items-end">
        <div className="space-y-1">
          <Label htmlFor="repo-url">{t("repos.url")}</Label>
          <Input
            id="repo-url"
            value={url}
            placeholder="https://github.com/org/repo"
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="repo-branch">{t("repos.branch")}</Label>
          <Input id="repo-branch" value={branch} onChange={(e) => setBranch(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="repo-token">{t("repos.token")}</Label>
          <Input
            id="repo-token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </div>
        <Button disabled={!url || add.isPending} onClick={() => add.mutate()}>
          {t("repos.add")}
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <ul className="divide-y">
        {(repos.data ?? []).map((repo) => (
          <li key={repo.id} className="flex items-center justify-between py-2 text-sm">
            <div>
              <p className="font-medium">{repo.url}</p>
              <p className="text-xs text-muted-foreground">
                {repo.defaultBranch} · {repo.hasCredential ? t("repos.private") : t("repos.public")}
              </p>
            </div>
            <Button size="sm" variant="ghost" onClick={() => remove.mutate(repo.id)}>
              ✕
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function QuotaTab({ projectId }: { projectId: string }) {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const quota = useQuery({
    queryKey: ["quota", projectId],
    queryFn: () => api<Quota>(`/projects/${projectId}/quota`),
  });
  const [costLimit, setCostLimit] = useState<string | null>(null);
  const [tokenLimit, setTokenLimit] = useState<string | null>(null);
  const [hardStop, setHardStop] = useState<boolean | null>(null);

  const costValue = costLimit ?? (quota.data?.costLimitUsd ? String(quota.data.costLimitUsd) : "");
  const tokenValue = tokenLimit ?? (quota.data?.tokenLimit ? String(quota.data.tokenLimit) : "");
  const hardStopValue = hardStop ?? quota.data?.hardStop ?? true;

  const save = useMutation({
    mutationFn: () =>
      api(`/projects/${projectId}/quota`, {
        method: "PUT",
        json: {
          costLimitUsd: costValue ? Number(costValue) : null,
          tokenLimit: tokenValue ? Number(tokenValue) : null,
          hardStop: hardStopValue,
        },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["quota", projectId] }),
  });

  return (
    <div className="max-w-md space-y-4">
      <div className="space-y-1">
        <Label htmlFor="quota-cost">{t("quota.costLimit")}</Label>
        <Input
          id="quota-cost"
          type="number"
          value={costValue}
          onChange={(e) => setCostLimit(e.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="quota-tokens">{t("quota.tokenLimit")}</Label>
        <Input
          id="quota-tokens"
          type="number"
          value={tokenValue}
          onChange={(e) => setTokenLimit(e.target.value)}
        />
      </div>
      <div className="flex items-center justify-between">
        <Label htmlFor="quota-hard">{t("quota.hardStop")}</Label>
        <Switch id="quota-hard" checked={hardStopValue} onCheckedChange={setHardStop} />
      </div>
      <Button disabled={save.isPending} onClick={() => save.mutate()}>
        {t("quota.save")}
      </Button>
      {save.isSuccess && <p className="text-sm text-muted-foreground">{t("quota.saved")}</p>}
    </div>
  );
}

export function SettingsPage() {
  const { t } = useTranslation("settings");
  const { projectId } = useParams({ strict: false }) as { projectId: string };

  return (
    <Card>
      <CardContent className="pt-4">
        <Tabs defaultValue="members">
          <TabsList>
            <TabsTrigger value="members">{t("tabs.members")}</TabsTrigger>
            <TabsTrigger value="grants">{t("tabs.grants")}</TabsTrigger>
            <TabsTrigger value="repos">{t("tabs.repos")}</TabsTrigger>
            <TabsTrigger value="quota">{t("tabs.quota")}</TabsTrigger>
          </TabsList>
          <TabsContent value="members" className="pt-4">
            <MembersTab projectId={projectId} />
          </TabsContent>
          <TabsContent value="grants" className="pt-4">
            <GrantsTab projectId={projectId} />
          </TabsContent>
          <TabsContent value="repos" className="pt-4">
            <ReposTab projectId={projectId} />
          </TabsContent>
          <TabsContent value="quota" className="pt-4">
            <QuotaTab projectId={projectId} />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
