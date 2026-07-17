import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, ChevronsUpDownIcon, FolderKanbanIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SidebarMenuButton, useSidebar } from "@/components/ui/sidebar";
import { useMe } from "@/features/me";
import { api } from "@/lib/api";
import type { Me } from "@/lib/types";
import { cn } from "@/lib/utils";

type Membership = Me["projects"][number];

export function ProjectSwitcher({ current }: { current: Membership | null }) {
  const { t } = useTranslation("common");
  const me = useMe();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const select = (projectId: string) => {
    setOpen(false);
    if (isMobile) setOpenMobile(false);
    void navigate({ to: "/projects/$projectId", params: { projectId } });
  };

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <SidebarMenuButton
            size="lg"
            className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
          >
            <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-accent text-sidebar-accent-foreground">
              <FolderKanbanIcon className="size-4" />
            </div>
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{current?.name ?? t("selectProject")}</span>
              {current ? (
                <span className="truncate text-xs text-muted-foreground">{current.slug}</span>
              ) : null}
            </div>
            <ChevronsUpDownIcon className="ml-auto size-4 text-muted-foreground" />
          </SidebarMenuButton>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-0" align="start">
          <Command>
            <CommandInput placeholder={t("switcher.search")} />
            <CommandList>
              <CommandEmpty>{t("switcher.empty")}</CommandEmpty>
              <CommandGroup heading={t("switcher.projects")}>
                {me.projects.map((p) => (
                  <CommandItem
                    key={p.projectId}
                    value={p.name}
                    onSelect={() => select(p.projectId)}
                  >
                    <span className="truncate">{p.name}</span>
                    {p.status !== "active" ? (
                      <Badge variant="outline" className="ml-1">
                        {t("switcher.archived")}
                      </Badge>
                    ) : null}
                    <CheckIcon
                      className={cn(
                        "ml-auto",
                        p.projectId === current?.projectId ? "opacity-100" : "opacity-0",
                      )}
                    />
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandSeparator />
              <CommandGroup>
                <CommandItem
                  onSelect={() => {
                    setOpen(false);
                    setCreateOpen(true);
                  }}
                >
                  <PlusIcon />
                  {t("switcher.create")}
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <CreateProjectDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}

export function CreateProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation("common");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");

  const create = useMutation({
    mutationFn: () => api<{ id: string }>("/projects", { method: "POST", json: { name, slug } }),
    onSuccess: async (project) => {
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      onOpenChange(false);
      setName("");
      setSlug("");
      void navigate({ to: "/projects/$projectId", params: { projectId: project.id } });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("switcher.create")}</DialogTitle>
          <DialogDescription>{t("firstProject.hint")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="new-project-name">{t("firstProject.name")}</Label>
            <Input id="new-project-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-project-slug">{t("firstProject.slug")}</Label>
            <Input
              id="new-project-slug"
              value={slug}
              placeholder="my-project"
              onChange={(e) => setSlug(e.target.value)}
            />
          </div>
          {create.isError ? (
            <p className="text-sm text-destructive">{(create.error as Error).message}</p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("actions.cancel")}
          </Button>
          <Button disabled={!name || !slug || create.isPending} onClick={() => create.mutate()}>
            {t("firstProject.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
