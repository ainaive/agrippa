import { Outlet, useParams } from "@tanstack/react-router";
import { FolderXIcon } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { EmptyState } from "@/components/EmptyState";
import { setLastProjectId } from "@/features/lastProject";
import { useMe } from "../features/me";

export function ProjectLayout() {
  const { t } = useTranslation("common");
  const { projectId } = useParams({ strict: false }) as { projectId: string };
  const me = useMe();
  const membership = me.projects.find((p) => p.projectId === projectId);

  useEffect(() => {
    if (membership) setLastProjectId(membership.projectId);
  }, [membership]);

  if (!membership) {
    return (
      <EmptyState
        icon={FolderXIcon}
        title={t("projectNotFound.title")}
        description={t("projectNotFound.hint")}
      />
    );
  }

  return <Outlet />;
}
