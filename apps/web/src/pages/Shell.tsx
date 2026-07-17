import { Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { Loader2Icon } from "lucide-react";
import { AppSidebar } from "@/components/shell/AppSidebar";
import { Topbar } from "@/components/shell/Topbar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { MeContext, useMeQuery } from "../features/me";

export function Shell() {
  const { data: me, isLoading, isError } = useMeQuery();
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { projectId?: string };

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (isError || !me) {
    void navigate({ to: "/login" });
    return null;
  }

  return (
    <MeContext.Provider value={me}>
      <SidebarProvider>
        <AppSidebar currentProjectId={params.projectId ?? null} />
        <SidebarInset>
          <Topbar />
          <main className="flex-1 px-4 py-6 md:px-6">
            <div className="mx-auto w-full max-w-7xl">
              <Outlet />
            </div>
          </main>
        </SidebarInset>
        <Toaster richColors position="bottom-right" />
      </SidebarProvider>
    </MeContext.Provider>
  );
}
