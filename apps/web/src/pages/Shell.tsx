import { useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MeContext, useMeQuery } from "../features/me";
import { authApi } from "../lib/api";
import { setLocale } from "../lib/i18n";

export function Shell() {
  const { t, i18n } = useTranslation("common");
  const { data: me, isLoading, isError } = useMeQuery();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const params = useParams({ strict: false }) as { projectId?: string };

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-muted-foreground">
        {t("loading")}
      </div>
    );
  }
  if (isError || !me) {
    void navigate({ to: "/login" });
    return null;
  }

  const signOut = async () => {
    await authApi.signOut();
    await queryClient.invalidateQueries();
    void navigate({ to: "/login" });
  };

  return (
    <MeContext.Provider value={me}>
      <div className="min-h-screen bg-background">
        <header className="border-b">
          <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
            <Link to="/" className="flex items-center gap-2 font-semibold">
              <span aria-hidden>⚒️</span>
              {t("appName")}
            </Link>

            {me.projects.length > 0 && (
              <Select
                value={params.projectId ?? ""}
                onValueChange={(value) => {
                  void navigate({ to: "/projects/$projectId", params: { projectId: value } });
                }}
              >
                <SelectTrigger className="w-52" size="sm">
                  <SelectValue placeholder={t("selectProject")} />
                </SelectTrigger>
                <SelectContent>
                  {me.projects.map((p) => (
                    <SelectItem key={p.projectId} value={p.projectId}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            <nav className="ml-auto flex items-center gap-1">
              <Button variant="ghost" size="sm" asChild>
                <Link to="/approvals">{t("nav.approvals")}</Link>
              </Button>
              {me.orgRole === "org_admin" && (
                <Button variant="ghost" size="sm" asChild>
                  <Link to="/admin">{t("nav.admin")}</Link>
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setLocale(i18n.language === "en" ? "zh-CN" : "en")}
              >
                {i18n.language === "en" ? "中文" : "EN"}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void signOut()}>
                {t("signOut")}
              </Button>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-6">
          <Outlet />
        </main>
      </div>
    </MeContext.Provider>
  );
}
