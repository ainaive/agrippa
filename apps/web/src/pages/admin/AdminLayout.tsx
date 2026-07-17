import { Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useMe } from "../../features/me";

export function AdminLayout() {
  const { t } = useTranslation("common");
  const me = useMe();
  const navigate = useNavigate();
  const allowed = me.orgRole === "org_admin";

  useEffect(() => {
    if (!allowed) {
      toast.error(t("adminOnly"));
      void navigate({ to: "/" });
    }
  }, [allowed, navigate, t]);

  if (!allowed) return null;
  return <Outlet />;
}
