import {
  API_KEY_SCOPES,
  PROVIDER_CATALOG,
  SCHEDULE_CONCURRENCY_POLICIES,
  type ScheduleConcurrencyPolicy,
} from "@agrippa/core";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import {
  ArchiveIcon,
  BellIcon,
  CalendarClockIcon,
  CopyIcon,
  FolderCogIcon,
  GaugeIcon,
  GitBranchIcon,
  KeyRoundIcon,
  type LucideIcon,
  ShieldCheckIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { RunStatusBadge } from "@/components/RunStatusBadge";
import { Badge } from "@/components/ui/badge";
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
import { clearLastProjectId } from "../features/lastProject";
import { api } from "../lib/api";
import { formatTime, lt } from "../lib/format";
import { toastApiError } from "../lib/toast";
import type {
  ApiKeyCreated,
  ApiKeyRow,
  Faber,
  Grant,
  McpServerRow,
  Member,
  ModelRow,
  NotificationDeliveryRow,
  NotificationEndpointRow,
  ProviderCatalogRow,
  ProviderCredentialRow,
  Quota,
  ScheduleRow,
  SkillRow,
  TaskTypeSummary,
} from "../lib/types";
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
      clearLastProjectId(); // or HomeRedirect bounces straight back here
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

function ResourcesSection({ projectId }: { projectId: string }) {
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
  const credentials = useQuery({
    queryKey: ["providerCredentials", projectId],
    queryFn: () => api<ProviderCredentialRow[]>(`/projects/${projectId}/providers`),
  });
  const catalog = useQuery({
    queryKey: ["provider-catalog"],
    queryFn: () => api<ProviderCatalogRow[]>("/provider-catalog"),
  });

  const granted = new Set((grants.data ?? []).map((g) => `${g.resourceType}:${g.resourceId}`));
  const credByProvider = new Map((credentials.data ?? []).map((c) => [c.provider, c]));
  const catalogByProvider = new Map((catalog.data ?? []).map((c) => [c.providerId, c]));

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

  const invalidateCreds = () =>
    queryClient.invalidateQueries({ queryKey: ["providerCredentials", projectId] });
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [addingProvider, setAddingProvider] = useState<string | null>(null);
  const [rotating, setRotating] = useState<ProviderCredentialRow | null>(null);
  const [rotateKey, setRotateKey] = useState("");
  const [removing, setRemoving] = useState<ProviderCredentialRow | null>(null);

  const addCred = useMutation({
    mutationFn: (provider: string) =>
      api(`/projects/${projectId}/providers`, {
        method: "POST",
        json: { provider, apiKey, baseUrl: baseUrl || undefined },
      }),
    onSuccess: (_data, provider) => {
      toast.success(t("providers.added", { provider: providerLabel(provider) }));
      setApiKey("");
      setBaseUrl("");
      setAddingProvider(null);
      void invalidateCreds();
    },
    onError: toastApiError,
  });
  const rotate = useMutation({
    mutationFn: (target: string) =>
      api(`/projects/${projectId}/providers/${target}`, {
        method: "PATCH",
        json: { apiKey: rotateKey },
      }),
    onSuccess: () => {
      setRotating(null);
      setRotateKey("");
      toast.success(t("providers.rotated"));
      void invalidateCreds();
    },
    onError: toastApiError,
  });
  const removeCred = useMutation({
    mutationFn: (target: string) =>
      api(`/projects/${projectId}/providers/${target}`, { method: "DELETE" }),
    onSuccess: () => invalidateCreds(),
    onError: toastApiError,
  });

  // providers seen via models, credentials, or the catalog (active) — the union
  // a project could configure. Each renders its credential state + model toggles.
  const modelsByProvider = new Map<string, ModelRow[]>();
  for (const m of modelRows.data ?? []) {
    const list = modelsByProvider.get(m.provider) ?? [];
    list.push(m);
    modelsByProvider.set(m.provider, list);
  }
  const providerIds = [
    ...new Set<string>([
      ...(modelRows.data ?? []).map((m) => m.provider),
      ...(credentials.data ?? []).map((c) => c.provider),
      ...(catalog.data ?? []).filter((c) => c.status === "active").map((c) => c.providerId),
    ]),
  ].sort();

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
    <div className="space-y-6">
      <div>
        <h3 className="mb-2 text-sm font-semibold">{t("resources.providersTitle")}</h3>
        <p className="mb-3 text-xs text-muted-foreground">{t("resources.providersHint")}</p>
        <div className="space-y-3">
          {providerIds.map((providerId) => {
            const cat = catalogByProvider.get(providerId);
            const cred = credByProvider.get(providerId);
            const models = modelsByProvider.get(providerId) ?? [];
            const authPolicy = cat?.auth ?? "env";
            const needsKey = authPolicy === "project";
            return (
              <div key={providerId} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <span className="font-medium">{cat?.label ?? providerId}</span>
                    <span className="ml-2 font-mono text-xs text-muted-foreground">
                      {providerId}
                    </span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {cred
                        ? t("providers.keySet")
                        : needsKey
                          ? t("providers.keyNeeded")
                          : t("providers.envAuth")}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {rotating?.provider === providerId ? (
                      <>
                        <Input
                          type="password"
                          autoFocus
                          className="h-8 w-40"
                          value={rotateKey}
                          onChange={(e) => setRotateKey(e.target.value)}
                        />
                        <Button
                          size="sm"
                          disabled={!rotateKey || rotate.isPending}
                          onClick={() => rotate.mutate(providerId)}
                        >
                          {t("providers.save")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setRotating(null);
                            setRotateKey("");
                          }}
                        >
                          {t("providers.cancel")}
                        </Button>
                      </>
                    ) : addingProvider === providerId ? (
                      <>
                        <Input
                          type="password"
                          autoFocus
                          className="h-8 w-40"
                          placeholder={t("providers.apiKey")}
                          value={apiKey}
                          onChange={(e) => setApiKey(e.target.value)}
                        />
                        <Input
                          className="h-8 w-48"
                          placeholder={t("providers.baseUrlHint")}
                          value={baseUrl}
                          onChange={(e) => setBaseUrl(e.target.value)}
                        />
                        <Button
                          size="sm"
                          disabled={!apiKey || addCred.isPending}
                          onClick={() => addCred.mutate(providerId)}
                        >
                          {t("providers.save")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setAddingProvider(null);
                            setApiKey("");
                            setBaseUrl("");
                          }}
                        >
                          {t("providers.cancel")}
                        </Button>
                      </>
                    ) : cred ? (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => setRotating(cred)}>
                          {t("providers.rotate")}
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={t("providers.remove")}
                          onClick={() => setRemoving(cred)}
                        >
                          <XIcon />
                        </Button>
                      </>
                    ) : needsKey ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setAddingProvider(providerId)}
                      >
                        {t("providers.addKey")}
                      </Button>
                    ) : null}
                  </div>
                </div>
                {models.length > 0 ? (
                  <ul className="mt-2 space-y-1">
                    {models.map((m) => (
                      <li
                        key={m.id}
                        className="flex items-center justify-between rounded-md border px-3 py-1.5 text-sm"
                      >
                        <div>
                          <span className="font-medium">{m.displayName}</span>
                          <span className="ml-2 text-xs text-muted-foreground">{m.tier}</span>
                        </div>
                        <Switch
                          checked={granted.has(`model:${m.id}`)}
                          onCheckedChange={() => toggle("model", m.id)}
                        />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-xs text-muted-foreground">{t("resources.noModels")}</p>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="grid gap-6 sm:grid-cols-2">
        {section(
          t("grants.skills"),
          "skill",
          (skillRows.data ?? []).map((s) => ({ id: s.id, label: lt(s.nameI18n), detail: s.slug })),
        )}
        {section(
          t("grants.mcp"),
          "mcp_server",
          (mcpRows.data ?? []).map((m) => ({
            id: m.id,
            label: lt(m.nameI18n),
            detail: m.transport,
          })),
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
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={t("providers.removeConfirm", { provider: providerLabel(removing?.provider ?? "") })}
        confirmLabel={t("providers.remove")}
        destructive
        onConfirm={() => {
          if (removing) removeCred.mutate(removing.provider);
          setRemoving(null);
        }}
      />
    </div>
  );
}

type RepoProvider = "github" | "gitlab" | "gitcode" | "generic-git";
type RepoRow = {
  id: string;
  url: string;
  provider: RepoProvider;
  defaultBranch: string;
  hasCredential: boolean;
};

// pr.open can create the pull request on the first three; generic-git is push-only
const REPO_PROVIDERS: RepoProvider[] = ["github", "gitlab", "gitcode", "generic-git"];

function ReposSection({ projectId }: { projectId: string }) {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const repos = useQuery({
    queryKey: ["repos", projectId],
    queryFn: () => api<RepoRow[]>(`/projects/${projectId}/repos`),
  });
  const [provider, setProvider] = useState<RepoProvider>("github");
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [token, setToken] = useState("");
  const [removing, setRemoving] = useState<RepoRow | null>(null);

  const add = useMutation({
    mutationFn: () =>
      api(`/projects/${projectId}/repos`, {
        method: "POST",
        json: {
          provider,
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
      <div className="grid gap-2 sm:grid-cols-[150px_1fr_140px_1fr_auto] sm:items-end">
        <div className="space-y-1">
          <Label htmlFor="repo-provider">{t("repos.provider")}</Label>
          <Select value={provider} onValueChange={(next) => setProvider(next as RepoProvider)}>
            <SelectTrigger id="repo-provider" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {REPO_PROVIDERS.map((id) => (
                <SelectItem key={id} value={id}>
                  {t(`repos.providers.${id}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
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
                {t(`repos.providers.${repo.provider}`, { defaultValue: repo.provider })} ·{" "}
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

function providerLabel(id: string): string {
  return id in PROVIDER_CATALOG ? PROVIDER_CATALOG[id as keyof typeof PROVIDER_CATALOG].label : id;
}

function QuotaSection({ projectId }: { projectId: string }) {
  const { t } = useTranslation(["settings", "common"]);
  const queryClient = useQueryClient();
  const quota = useQuery({
    queryKey: ["quota", projectId],
    queryFn: () => api<Quota>(`/projects/${projectId}/quota`),
  });
  const [tokenLimit, setTokenLimit] = useState<string | null>(null);
  const [hardStop, setHardStop] = useState<boolean | null>(null);

  const tokenValue = tokenLimit ?? (quota.data?.tokenLimit ? String(quota.data.tokenLimit) : "");
  const hardStopValue = hardStop ?? quota.data?.hardStop ?? true;

  const save = useMutation({
    mutationFn: () =>
      api(`/projects/${projectId}/quota`, {
        method: "PUT",
        json: {
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

const NOTIFY_EVENT_TYPES = [
  "checkpoint.required",
  "checkpoint.expired",
  "run.succeeded",
  "run.failed",
  "run.cancelled",
  "run.timed_out",
  "schedule.disabled",
  "schedule.failed",
] as const;

const eventTypeKey = (type: string) => type.replaceAll(".", "_");

function NotificationsSection({ projectId }: { projectId: string }) {
  const { t, i18n } = useTranslation(["settings", "common"]);
  const queryClient = useQueryClient();
  const endpoints = useQuery({
    queryKey: ["notification-endpoints", projectId],
    queryFn: () => api<NotificationEndpointRow[]>(`/projects/${projectId}/notifications/endpoints`),
  });
  const deliveries = useQuery({
    queryKey: ["notification-deliveries", projectId],
    queryFn: () =>
      api<NotificationDeliveryRow[]>(`/projects/${projectId}/notifications/deliveries?limit=30`),
    refetchInterval: 10_000,
  });
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["notification-endpoints", projectId] });
    void queryClient.invalidateQueries({ queryKey: ["notification-deliveries", projectId] });
  };

  const [kind, setKind] = useState<NotificationEndpointRow["kind"]>("feishu");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [events, setEvents] = useState<string[]>([]);
  const [locale, setLocale] = useState(i18n.language.startsWith("zh") ? "zh-CN" : "en");

  const add = useMutation({
    mutationFn: () =>
      api(`/projects/${projectId}/notifications/endpoints`, {
        method: "POST",
        json: { kind, name, url, secret: secret || undefined, events, locale },
      }),
    onSuccess: () => {
      toast.success(t("settings:notifications.added"));
      setName("");
      setUrl("");
      setSecret("");
      setEvents([]);
      invalidate();
    },
    onError: toastApiError,
  });
  const toggle = useMutation({
    mutationFn: (endpoint: NotificationEndpointRow) =>
      api(`/projects/${projectId}/notifications/endpoints/${endpoint.id}`, {
        method: "PATCH",
        json: { enabled: !endpoint.enabled },
      }),
    onSuccess: invalidate,
    onError: toastApiError,
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/projects/${projectId}/notifications/endpoints/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(t("settings:notifications.removed"));
      invalidate();
    },
    onError: toastApiError,
  });
  const test = useMutation({
    mutationFn: (id: string) =>
      api(`/projects/${projectId}/notifications/endpoints/${id}/test`, { method: "POST" }),
    onSuccess: () => {
      toast.success(t("settings:notifications.testQueued"));
      invalidate();
    },
    onError: toastApiError,
  });
  const retry = useMutation({
    mutationFn: (id: string) =>
      api(`/projects/${projectId}/notifications/deliveries/${id}/retry`, { method: "POST" }),
    onSuccess: () => {
      toast.success(t("settings:notifications.retried"));
      invalidate();
    },
    onError: toastApiError,
  });

  const canAdd = name.trim() !== "" && url.trim() !== "" && (kind !== "generic" || secret !== "");

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">{t("settings:notifications.endpointsTitle")}</h3>
          <p className="text-sm text-muted-foreground">
            {t("settings:notifications.endpointsHint")}
          </p>
        </div>
        {endpoints.data?.length === 0 && (
          <EmptyState title={t("settings:notifications.empty")} icon={BellIcon} />
        )}
        <div className="space-y-2">
          {endpoints.data?.map((endpoint) => (
            <div
              key={endpoint.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-medium">
                  {endpoint.name}
                  <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                    {t(`settings:notifications.kinds.${endpoint.kind}`)}
                  </span>
                  <span className="text-xs text-muted-foreground">{endpoint.locale}</span>
                </div>
                <p className="truncate text-xs text-muted-foreground">{endpoint.url}</p>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  checked={endpoint.enabled}
                  onCheckedChange={() => toggle.mutate(endpoint)}
                  aria-label={endpoint.name}
                />
                <Button size="sm" variant="outline" onClick={() => test.mutate(endpoint.id)}>
                  {t("settings:notifications.test")}
                </Button>
                <ConfirmDialog
                  trigger={
                    <Button size="sm" variant="ghost" aria-label={t("common:actions.remove")}>
                      <XIcon />
                    </Button>
                  }
                  title={t("settings:notifications.removeConfirm", { name: endpoint.name })}
                  description={t("settings:notifications.removeHint")}
                  confirmLabel={t("common:actions.remove")}
                  destructive
                  onConfirm={() => remove.mutate(endpoint.id)}
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="max-w-md space-y-4">
        <h3 className="text-sm font-medium">{t("settings:notifications.addTitle")}</h3>
        <div className="space-y-1">
          <Label>{t("settings:notifications.kind")}</Label>
          <Select value={kind} onValueChange={(v) => setKind(v as NotificationEndpointRow["kind"])}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(["feishu", "dingtalk", "generic"] as const).map((k) => (
                <SelectItem key={k} value={k}>
                  {t(`settings:notifications.kinds.${k}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="notify-name">{t("settings:notifications.name")}</Label>
          <Input id="notify-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="notify-url">{t("settings:notifications.url")}</Label>
          <Input
            id="notify-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://"
          />
          <p className="text-xs text-muted-foreground">
            {t(`settings:notifications.urlHint.${kind}`)}
          </p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="notify-secret">{t("settings:notifications.secret")}</Label>
          <Input
            id="notify-secret"
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            autoComplete="off"
          />
          <p className="text-xs text-muted-foreground">
            {t(`settings:notifications.secretHint.${kind}`)}
          </p>
        </div>
        <div className="space-y-1">
          <Label>{t("settings:notifications.locale")}</Label>
          <Select value={locale} onValueChange={setLocale}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="en">English</SelectItem>
              <SelectItem value="zh-CN">中文</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>{t("settings:notifications.events")}</Label>
          <div className="flex flex-wrap gap-2">
            {NOTIFY_EVENT_TYPES.map((type) => {
              const active = events.includes(type);
              return (
                <button
                  key={type}
                  type="button"
                  onClick={() =>
                    setEvents((prev) => (active ? prev.filter((e) => e !== type) : [...prev, type]))
                  }
                  className={cn(
                    "rounded-full border px-2.5 py-0.5 text-xs",
                    active
                      ? "border-primary bg-primary/10 font-medium"
                      : "text-muted-foreground hover:bg-muted/60",
                  )}
                >
                  {t(`settings:notifications.eventTypes.${eventTypeKey(type)}`)}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">{t("settings:notifications.eventsHint")}</p>
        </div>
        <Button disabled={!canAdd || add.isPending} onClick={() => add.mutate()}>
          {t("settings:notifications.add")}
        </Button>
      </div>

      <div className="space-y-3">
        <h3 className="text-sm font-medium">{t("settings:notifications.deliveriesTitle")}</h3>
        {deliveries.data?.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {t("settings:notifications.deliveriesEmpty")}
          </p>
        )}
        <div className="space-y-1.5">
          {deliveries.data?.map((delivery) => (
            <div
              key={delivery.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
            >
              <div className="flex min-w-0 items-center gap-2">
                <RunStatusBadge status={delivery.status} />
                <span>
                  {t(`settings:notifications.eventTypes.${eventTypeKey(delivery.eventType)}`, {
                    defaultValue: delivery.eventType,
                  })}
                </span>
                <span className="text-muted-foreground">{delivery.endpointName}</span>
                {delivery.runNumber !== null && (
                  <span className="text-xs text-muted-foreground">#{delivery.runNumber}</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {delivery.lastError && (
                  <span
                    className="max-w-64 truncate text-xs text-destructive"
                    title={delivery.responseSnippet ?? delivery.lastError}
                  >
                    {delivery.lastError}
                  </span>
                )}
                <span className="text-xs text-muted-foreground">×{delivery.attempts}</span>
                {delivery.status === "failed" && (
                  <Button size="sm" variant="outline" onClick={() => retry.mutate(delivery.id)}>
                    {t("settings:notifications.retry")}
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ApiKeysSection({ projectId }: { projectId: string }) {
  const { t } = useTranslation(["settings", "common"]);
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["tasks:write", "runs:read"]);
  // the plaintext exists only in this component's state, only until navigation
  const [lastKey, setLastKey] = useState<ApiKeyCreated | null>(null);

  const keys = useQuery({
    queryKey: ["api-keys", projectId],
    queryFn: () => api<ApiKeyRow[]>(`/projects/${projectId}/api-keys`),
  });

  const create = useMutation({
    mutationFn: () =>
      api<ApiKeyCreated>(`/projects/${projectId}/api-keys`, {
        method: "POST",
        json: { name: name.trim(), scopes },
      }),
    onSuccess: (created) => {
      setLastKey(created);
      setName("");
      toast.success(t("settings:apiKeys.created"));
      void queryClient.invalidateQueries({ queryKey: ["api-keys", projectId] });
    },
    onError: toastApiError,
  });

  const revoke = useMutation({
    mutationFn: (id: string) =>
      api(`/projects/${projectId}/api-keys/${id}/revoke`, { method: "POST" }),
    onSuccess: () => {
      toast.success(t("settings:apiKeys.revoked"));
      void queryClient.invalidateQueries({ queryKey: ["api-keys", projectId] });
    },
    onError: toastApiError,
  });

  const toggleScope = (scope: string, on: boolean) =>
    setScopes((prev) => (on ? [...new Set([...prev, scope])] : prev.filter((s) => s !== scope)));

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">{t("settings:apiKeys.title")}</h3>
        <p className="text-xs text-muted-foreground">{t("settings:apiKeys.hint")}</p>
      </div>

      {keys.data && keys.data.length > 0 ? (
        <div className="divide-y rounded-lg border">
          {keys.data.map((row) => (
            <div key={row.id} className="flex items-center gap-3 px-4 py-3 text-sm">
              <div className="min-w-0 flex-1">
                <p className="truncate">
                  <span className="font-medium">{row.name}</span>
                  <span className="ml-2 font-mono text-xs text-muted-foreground">
                    {row.prefix}…
                  </span>
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {row.scopes.join(", ")}
                  {" · "}
                  {row.lastUsedAt
                    ? t("settings:apiKeys.lastUsed", { time: formatTime(row.lastUsedAt) })
                    : t("settings:apiKeys.neverUsed")}
                </p>
              </div>
              {row.revokedAt ? (
                <Badge variant="outline">{t("settings:apiKeys.revokedBadge")}</Badge>
              ) : (
                <ConfirmDialog
                  trigger={
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t("settings:apiKeys.revoke")}
                    >
                      <XIcon />
                    </Button>
                  }
                  title={t("settings:apiKeys.revokeConfirm", { name: row.name })}
                  description={t("settings:apiKeys.revokeHint")}
                  onConfirm={() => revoke.mutate(row.id)}
                />
              )}
            </div>
          ))}
        </div>
      ) : (
        <EmptyState title={t("settings:apiKeys.empty")} icon={KeyRoundIcon} />
      )}

      {lastKey ? (
        <div className="max-w-xl rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
          <p className="font-medium">{t("settings:apiKeys.keyOnce", { name: lastKey.name })}</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 truncate rounded bg-muted/60 px-2 py-1 font-mono text-xs">
              {lastKey.key}
            </code>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t("settings:apiKeys.copy")}
              onClick={() => {
                void navigator.clipboard
                  .writeText(lastKey.key)
                  .then(() => toast.success(t("settings:apiKeys.copied")));
              }}
            >
              <CopyIcon />
            </Button>
          </div>
        </div>
      ) : null}

      <div className="max-w-md space-y-3">
        <h3 className="text-sm font-medium">{t("settings:apiKeys.addTitle")}</h3>
        <div className="space-y-1">
          <Label htmlFor="apikey-name">{t("settings:apiKeys.name")}</Label>
          <Input id="apikey-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label>{t("settings:apiKeys.scopes")}</Label>
          <div className="flex flex-wrap gap-2">
            {API_KEY_SCOPES.map((scope) => {
              const active = scopes.includes(scope);
              return (
                <button
                  key={scope}
                  type="button"
                  title={t(`settings:apiKeys.scopeHints.${scope.replace(":", "_")}`)}
                  onClick={() => toggleScope(scope, !active)}
                  className={cn(
                    "rounded-full border px-2.5 py-0.5 font-mono text-xs",
                    active
                      ? "border-primary bg-primary/10 font-medium"
                      : "text-muted-foreground hover:bg-muted/60",
                  )}
                >
                  {scope}
                </button>
              );
            })}
          </div>
        </div>
        <Button
          disabled={create.isPending || !name.trim() || scopes.length === 0}
          onClick={() => create.mutate()}
        >
          {t("settings:apiKeys.create")}
        </Button>
      </div>
    </div>
  );
}

function SchedulesSection({ projectId }: { projectId: string }) {
  const { t } = useTranslation(["settings", "common"]);
  const queryClient = useQueryClient();

  const schedules = useQuery({
    queryKey: ["schedules", projectId],
    queryFn: () => api<ScheduleRow[]>(`/projects/${projectId}/schedules`),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["schedules", projectId] });
  const update = useMutation({
    mutationFn: (input: { id: string; body: Record<string, unknown> }) =>
      api(`/projects/${projectId}/schedules/${input.id}`, { method: "PATCH", json: input.body }),
    onSuccess: () => void refresh(),
    onError: toastApiError,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/projects/${projectId}/schedules/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(t("settings:schedules.removed"));
      void refresh();
    },
    onError: toastApiError,
  });

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">{t("settings:schedules.title")}</h3>
        <p className="text-xs text-muted-foreground">{t("settings:schedules.hint")}</p>
      </div>

      {schedules.data && schedules.data.length > 0 ? (
        <div className="divide-y rounded-lg border">
          {schedules.data.map((row) => (
            <div key={row.id} className="flex items-center gap-3 px-4 py-3 text-sm">
              <div className="min-w-0 flex-1">
                <p className="truncate">
                  <span className="font-medium">{row.name}</span>
                  <span className="ml-2 font-mono text-xs text-muted-foreground">
                    {row.cron} · {row.timezone}
                  </span>
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {row.lastFiredAt
                    ? t("settings:schedules.lastFired", { time: formatTime(row.lastFiredAt) })
                    : t("settings:schedules.neverFired")}
                </p>
                {/* why it stopped is the point of disabling rather than skipping */}
                {row.disabledReason ? (
                  <p className="truncate text-xs text-destructive">
                    {t(`settings:schedules.reasons.${row.disabledReason}`)}
                  </p>
                ) : null}
                {row.lastError ? (
                  <p className="truncate text-xs text-amber-600" title={row.lastError}>
                    {t("settings:schedules.lastError", { error: row.lastError })}
                  </p>
                ) : null}
              </div>
              <Badge variant="outline">
                {t(`settings:schedules.policies.${row.concurrencyPolicy}`)}
              </Badge>
              <Switch
                checked={row.enabled}
                aria-label={t("settings:schedules.toggle")}
                onCheckedChange={(on) => update.mutate({ id: row.id, body: { enabled: on } })}
              />
              <ConfirmDialog
                trigger={
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t("settings:schedules.remove")}
                  >
                    <XIcon />
                  </Button>
                }
                title={t("settings:schedules.removeConfirm", { name: row.name })}
                description={t("settings:schedules.removeHint")}
                destructive
                onConfirm={() => remove.mutate(row.id)}
              />
            </div>
          ))}
        </div>
      ) : (
        <EmptyState title={t("settings:schedules.empty")} icon={CalendarClockIcon} />
      )}

      {/* Creating a schedule needs the task's own parameter form, which lives
          on the submit page — offering a form here that cannot fill it in is
          how you get a schedule that fails its first firing a week later. */}
      <p className="text-xs text-muted-foreground">
        <Trans
          i18nKey="settings:schedules.createElsewhere"
          components={{
            catalog: (
              <Link
                to="/projects/$projectId/catalog"
                params={{ projectId }}
                className="underline underline-offset-2"
              />
            ),
          }}
        />
      </p>
    </div>
  );
}

const SECTIONS: Array<{ key: string; icon: LucideIcon }> = [
  { key: "general", icon: FolderCogIcon },
  { key: "members", icon: UsersIcon },
  { key: "resources", icon: ShieldCheckIcon },
  { key: "repos", icon: GitBranchIcon },
  { key: "notifications", icon: BellIcon },
  { key: "schedules", icon: CalendarClockIcon },
  { key: "apiKeys", icon: KeyRoundIcon },
  { key: "quota", icon: GaugeIcon },
];

export function SettingsPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { projectId } = useParams({ strict: false }) as { projectId: string };
  const { tab } = useSearch({ strict: false }) as { tab?: string };
  const validTabs = SECTIONS.map((s) => s.key);
  const [section, setSection] = useState(tab && validTabs.includes(tab) ? tab : "general");
  // a preflight "go configure" link may change ?tab while this page is mounted
  useEffect(() => {
    if (tab && validTabs.includes(tab) && tab !== section) setSection(tab);
  }, [tab, validTabs, section]);

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
            {section === "resources" && <ResourcesSection projectId={projectId} />}
            {section === "repos" && <ReposSection projectId={projectId} />}
            {section === "notifications" && <NotificationsSection projectId={projectId} />}
            {section === "schedules" && <SchedulesSection projectId={projectId} />}
            {section === "apiKeys" && <ApiKeysSection projectId={projectId} />}
            {section === "quota" && <QuotaSection projectId={projectId} />}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
