import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  ArchiveIcon,
  FolderCogIcon,
  GaugeIcon,
  GitBranchIcon,
  type LucideIcon,
  ShieldCheckIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Textarea } from "@/components/ui/textarea";
import { api } from "../lib/api";
import { lt } from "../lib/format";
import { toastApiError } from "../lib/toast";
import type { Faber, Grant, McpServerRow, Member, ModelRow, Quota, SkillRow } from "../lib/types";
import { cn } from "../lib/utils";

function GeneralSection({ projectId }: { projectId: string }) {
  const { t } = useTranslation(["settings", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const project = useQuery({
    queryKey: ["project", projectId],
    queryFn: () =>
      api<{ id: string; name: string; description: string | null; status: string }>(
        `/projects/${projectId}`,
      ),
  });
  const [name, setName] = useState<string | null>(null);
  const [description, setDescription] = useState<string | null>(null);
  const nameValue = name ?? project.data?.name ?? "";
  const descriptionValue = description ?? project.data?.description ?? "";

  const save = useMutation({
    mutationFn: () =>
      api(`/projects/${projectId}`, {
        method: "PATCH",
        json: { name: nameValue, description: descriptionValue || null },
      }),
    onSuccess: () => {
      toast.success(t("common:feedback.saved"));
      void queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      void queryClient.invalidateQueries({ queryKey: ["me"] });
    },
    onError: toastApiError,
  });

  const archive = useMutation({
    mutationFn: () => api(`/projects/${projectId}`, { method: "DELETE" }),
    onSuccess: async () => {
      toast.success(t("settings:general.archived"));
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      void navigate({ to: "/" });
    },
    onError: toastApiError,
  });

  return (
    <div className="space-y-6">
      <div className="max-w-md space-y-4">
        <div className="space-y-1">
          <Label htmlFor="project-name">{t("settings:general.name")}</Label>
          <Input id="project-name" value={nameValue} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="project-desc">{t("settings:general.description")}</Label>
          <Textarea
            id="project-desc"
            value={descriptionValue}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
          />
        </div>
        <Button disabled={!nameValue || save.isPending} onClick={() => save.mutate()}>
          {t("common:actions.save")}
        </Button>
      </div>

      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="text-sm text-destructive">
            {t("settings:general.dangerZone")}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">{t("settings:general.archiveHint")}</p>
          <ConfirmDialog
            trigger={
              <Button variant="destructive" disabled={archive.isPending}>
                <ArchiveIcon />
                {t("settings:general.archive")}
              </Button>
            }
            title={t("settings:general.archiveConfirm", { name: project.data?.name ?? "" })}
            description={t("settings:general.archiveHint")}
            confirmLabel={t("settings:general.archive")}
            destructive
            onConfirm={() => archive.mutate()}
          />
        </CardContent>
      </Card>
    </div>
  );
}

function MembersSection({ projectId }: { projectId: string }) {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const members = useQuery({
    queryKey: ["members", projectId],
    queryFn: () => api<Member[]>(`/projects/${projectId}/members`),
  });
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [removing, setRemoving] = useState<Member | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["members", projectId] });
  const add = useMutation({
    mutationFn: () =>
      api(`/projects/${projectId}/members`, { method: "POST", json: { email, role } }),
    onSuccess: () => {
      setEmail("");
      void refresh();
    },
    onError: toastApiError,
  });
  const setMemberRole = useMutation({
    mutationFn: (input: { userId: string; role: string }) =>
      api(`/projects/${projectId}/members/${input.userId}`, {
        method: "PATCH",
        json: { role: input.role },
      }),
    onSuccess: () => void refresh(),
    onError: toastApiError,
  });
  const remove = useMutation({
    mutationFn: (userId: string) =>
      api(`/projects/${projectId}/members/${userId}`, { method: "DELETE" }),
    onSuccess: () => void refresh(),
    onError: toastApiError,
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
        <Button variant="outline" disabled={!email || add.isPending} onClick={() => add.mutate()}>
          {t("members.add")}
        </Button>
      </div>
      <ul className="space-y-0.5">
        {(members.data ?? []).map((member) => (
          <li
            key={member.userId}
            className="-mx-2 flex items-center justify-between gap-3 rounded-md px-2 py-2 text-sm transition-colors hover:bg-muted/40"
          >
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
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t("members.remove")}
                onClick={() => setRemoving(member)}
              >
                <XIcon />
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={t("members.removeConfirm", { name: removing?.name ?? "" })}
        confirmLabel={t("members.remove")}
        destructive
        onConfirm={() => {
          if (removing) remove.mutate(removing.userId);
          setRemoving(null);
        }}
      />
    </div>
  );
}

function GrantsSection({ projectId }: { projectId: string }) {
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
    onError: toastApiError,
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
            className="flex items-center justify-between rounded-md border px-3 py-2 text-sm transition-colors hover:bg-muted/40"
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

type RepoRow = { id: string; url: string; defaultBranch: string; hasCredential: boolean };

function ReposSection({ projectId }: { projectId: string }) {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const repos = useQuery({
    queryKey: ["repos", projectId],
    queryFn: () => api<RepoRow[]>(`/projects/${projectId}/repos`),
  });
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [token, setToken] = useState("");
  const [removing, setRemoving] = useState<RepoRow | null>(null);

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
      void queryClient.invalidateQueries({ queryKey: ["repos", projectId] });
    },
    onError: toastApiError,
  });
  const remove = useMutation({
    mutationFn: (repoId: string) =>
      api(`/projects/${projectId}/repos/${repoId}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["repos", projectId] }),
    onError: toastApiError,
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
        <Button variant="outline" disabled={!url || add.isPending} onClick={() => add.mutate()}>
          {t("repos.add")}
        </Button>
      </div>
      {repos.data?.length === 0 ? (
        <EmptyState icon={GitBranchIcon} title={t("repos.empty")} />
      ) : null}
      <ul className="space-y-0.5">
        {(repos.data ?? []).map((repo) => (
          <li
            key={repo.id}
            className="-mx-2 flex items-center justify-between rounded-md px-2 py-2 text-sm transition-colors hover:bg-muted/40"
          >
            <div>
              <p className="font-medium">{repo.url}</p>
              <p className="text-xs text-muted-foreground">
                {repo.defaultBranch} · {repo.hasCredential ? t("repos.private") : t("repos.public")}
              </p>
            </div>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t("repos.remove")}
              onClick={() => setRemoving(repo)}
            >
              <XIcon />
            </Button>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={t("repos.removeConfirm", { url: removing?.url ?? "" })}
        confirmLabel={t("repos.remove")}
        destructive
        onConfirm={() => {
          if (removing) remove.mutate(removing.id);
          setRemoving(null);
        }}
      />
    </div>
  );
}

function QuotaSection({ projectId }: { projectId: string }) {
  const { t } = useTranslation(["settings", "common"]);
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
    onSuccess: () => {
      toast.success(t("settings:quota.saved"));
      void queryClient.invalidateQueries({ queryKey: ["quota", projectId] });
    },
    onError: toastApiError,
  });

  return (
    <div className="max-w-md space-y-4">
      <div className="space-y-1">
        <Label htmlFor="quota-cost">{t("settings:quota.costLimit")}</Label>
        <Input
          id="quota-cost"
          type="number"
          value={costValue}
          onChange={(e) => setCostLimit(e.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="quota-tokens">{t("settings:quota.tokenLimit")}</Label>
        <Input
          id="quota-tokens"
          type="number"
          value={tokenValue}
          onChange={(e) => setTokenLimit(e.target.value)}
        />
      </div>
      <div className="flex items-center justify-between">
        <Label htmlFor="quota-hard">{t("settings:quota.hardStop")}</Label>
        <Switch id="quota-hard" checked={hardStopValue} onCheckedChange={setHardStop} />
      </div>
      <Button disabled={save.isPending} onClick={() => save.mutate()}>
        {t("settings:quota.save")}
      </Button>
    </div>
  );
}

const SECTIONS: Array<{ key: string; icon: LucideIcon }> = [
  { key: "general", icon: FolderCogIcon },
  { key: "members", icon: UsersIcon },
  { key: "grants", icon: ShieldCheckIcon },
  { key: "repos", icon: GitBranchIcon },
  { key: "quota", icon: GaugeIcon },
];

export function SettingsPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { projectId } = useParams({ strict: false }) as { projectId: string };
  const [section, setSection] = useState("general");

  return (
    <div className="space-y-6">
      <PageHeader title={t("common:nav.settings")} />
      <div className="grid items-start gap-6 md:grid-cols-[200px_1fr]">
        <nav className="flex gap-1 overflow-x-auto md:flex-col">
          {SECTIONS.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setSection(item.key)}
              className={cn(
                "flex shrink-0 items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm",
                section === item.key
                  ? "bg-muted font-medium"
                  : "text-muted-foreground hover:bg-muted/60",
              )}
            >
              <item.icon className="size-4" />
              {t(`settings:tabs.${item.key}`)}
            </button>
          ))}
        </nav>
        <Card>
          <CardContent>
            {section === "general" && <GeneralSection projectId={projectId} />}
            {section === "members" && <MembersSection projectId={projectId} />}
            {section === "grants" && <GrantsSection projectId={projectId} />}
            {section === "repos" && <ReposSection projectId={projectId} />}
            {section === "quota" && <QuotaSection projectId={projectId} />}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
