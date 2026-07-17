import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useMe } from "../features/me";
import { api } from "../lib/api";

export function HomeRedirect() {
  const me = useMe();
  const navigate = useNavigate();
  const { t } = useTranslation("common");
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");

  const first = me.projects[0];
  useEffect(() => {
    if (first) {
      void navigate({ to: "/projects/$projectId", params: { projectId: first.projectId } });
    }
  }, [first, navigate]);

  const create = useMutation({
    mutationFn: () => api<{ id: string }>("/projects", { method: "POST", json: { name, slug } }),
    onSuccess: async (project) => {
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      void navigate({ to: "/projects/$projectId", params: { projectId: project.id } });
    },
  });

  if (first) return null;

  return (
    <div className="mx-auto mt-16 max-w-md">
      <Card>
        <CardHeader>
          <CardTitle>{t("firstProject.title")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">{t("firstProject.hint")}</p>
          <div className="space-y-2">
            <Label htmlFor="pname">{t("firstProject.name")}</Label>
            <Input id="pname" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pslug">{t("firstProject.slug")}</Label>
            <Input
              id="pslug"
              value={slug}
              placeholder="my-project"
              onChange={(e) => setSlug(e.target.value)}
            />
          </div>
          {create.isError && (
            <p className="text-sm text-destructive">{(create.error as Error).message}</p>
          )}
          <Button
            disabled={!name || !slug || create.isPending}
            onClick={() => create.mutate()}
            className="w-full"
          >
            {t("firstProject.create")}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
