import { Link, useMatchRoute } from "@tanstack/react-router";
import {
  BotIcon,
  CircleCheckBigIcon,
  CpuIcon,
  FileCode2Icon,
  HammerIcon,
  PlugIcon,
  ScrollTextIcon,
  WrenchIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { projectNav } from "@/components/shell/nav";
import { ProjectSwitcher } from "@/components/shell/ProjectSwitcher";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { getLastProjectId } from "@/features/lastProject";
import { useMe } from "@/features/me";
import { usePendingApprovals } from "@/features/usePendingApprovals";

export function AppSidebar({ currentProjectId }: { currentProjectId: string | null }) {
  const { t } = useTranslation("common");
  const me = useMe();
  const matchRoute = useMatchRoute();
  const pendingApprovals = usePendingApprovals().data?.length ?? 0;
  const { isMobile, setOpenMobile } = useSidebar();
  const closeMobile = () => {
    if (isMobile) setOpenMobile(false);
  };

  // Keep project navigation visible while on org-level pages (approvals, admin)
  // by falling back to the last-visited project, GitLab-context style.
  const active = me.projects.filter((p) => p.status === "active");
  const membership =
    me.projects.find((p) => p.projectId === currentProjectId) ?? // even archived: it's on screen
    active.find((p) => p.projectId === getLastProjectId()) ??
    active[0] ??
    null;

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild size="lg" tooltip={t("appName")}>
              <Link to="/" onClick={closeMobile}>
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                  <HammerIcon className="size-4" />
                </div>
                <span className="truncate font-semibold">{t("appName")}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <ProjectSwitcher current={membership} />
      </SidebarHeader>
      <SidebarContent>
        {membership ? (
          <SidebarGroup>
            <SidebarGroupLabel>{t("nav.project")}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {projectNav
                  .filter((item) => !item.projectAdminOnly || membership.role === "admin")
                  .map((item) => (
                    <SidebarMenuItem key={item.key}>
                      <SidebarMenuButton
                        asChild
                        tooltip={t(`nav.${item.key}`)}
                        isActive={Boolean(
                          matchRoute({
                            to: item.to,
                            params: { projectId: membership.projectId },
                            fuzzy: !item.exact,
                          }),
                        )}
                      >
                        <Link
                          to={item.to}
                          params={{ projectId: membership.projectId }}
                          onClick={closeMobile}
                        >
                          <item.icon />
                          <span>{t(`nav.${item.key}`)}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ) : null}
        <SidebarGroup>
          <SidebarGroupLabel>{t("nav.organization")}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  tooltip={t("nav.approvals")}
                  isActive={Boolean(matchRoute({ to: "/approvals" }))}
                >
                  <Link to="/approvals" onClick={closeMobile}>
                    <CircleCheckBigIcon />
                    <span>{t("nav.approvals")}</span>
                  </Link>
                </SidebarMenuButton>
                {pendingApprovals > 0 ? (
                  <SidebarMenuBadge className="bg-status-warning/15 text-status-warning">
                    {pendingApprovals}
                  </SidebarMenuBadge>
                ) : null}
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        {me.orgRole === "org_admin" ? (
          <SidebarGroup>
            <SidebarGroupLabel>{t("nav.admin")}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {adminNav.map((item) => (
                  <SidebarMenuItem key={item.key}>
                    <SidebarMenuButton
                      asChild
                      tooltip={t(`nav.${item.key}`)}
                      isActive={Boolean(matchRoute({ to: item.to, fuzzy: true }))}
                    >
                      <Link to={item.to} onClick={closeMobile}>
                        <item.icon />
                        <span>{t(`nav.${item.key}`)}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ) : null}
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}

const adminNav = [
  { key: "templates", icon: FileCode2Icon, to: "/admin/templates" },
  { key: "fabri", icon: BotIcon, to: "/admin/fabri" },
  { key: "models", icon: CpuIcon, to: "/admin/models" },
  { key: "skills", icon: WrenchIcon, to: "/admin/skills" },
  { key: "mcp", icon: PlugIcon, to: "/admin/mcp-servers" },
  { key: "audit", icon: ScrollTextIcon, to: "/admin/audit" },
];
