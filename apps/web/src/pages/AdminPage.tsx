import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "../lib/api";
import { lt } from "../lib/format";
import type { Faber, McpServerRow, ModelRow, SkillRow, TemplateRow } from "../lib/types";

export function AdminPage() {
  const { t } = useTranslation("admin");
  const fabri = useQuery({ queryKey: ["fabri"], queryFn: () => api<Faber[]>("/fabri") });
  const models = useQuery({ queryKey: ["models"], queryFn: () => api<ModelRow[]>("/models") });
  const skills = useQuery({ queryKey: ["skills"], queryFn: () => api<SkillRow[]>("/skills") });
  const mcp = useQuery({
    queryKey: ["mcp-servers"],
    queryFn: () => api<McpServerRow[]>("/mcp-servers"),
  });
  const templates = useQuery({
    queryKey: ["templates"],
    queryFn: () => api<TemplateRow[]>("/templates"),
  });

  return (
    <Card>
      <CardContent className="pt-4">
        <Tabs defaultValue="templates">
          <TabsList>
            <TabsTrigger value="templates">{t("tabs.templates")}</TabsTrigger>
            <TabsTrigger value="fabri">{t("tabs.fabri")}</TabsTrigger>
            <TabsTrigger value="models">{t("tabs.models")}</TabsTrigger>
            <TabsTrigger value="skills">{t("tabs.skills")}</TabsTrigger>
            <TabsTrigger value="mcp">{t("tabs.mcp")}</TabsTrigger>
          </TabsList>

          <TabsContent value="templates" className="pt-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns.name")}</TableHead>
                  <TableHead>{t("columns.slug")}</TableHead>
                  <TableHead>{t("columns.scenario")}</TableHead>
                  <TableHead>{t("columns.status")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(templates.data ?? []).map((template) => (
                  <TableRow key={template.id}>
                    <TableCell>
                      <Link
                        to="/admin/templates/$templateId"
                        params={{ templateId: template.id }}
                        className="font-medium hover:underline"
                      >
                        {lt(template.nameI18n)}
                      </Link>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{template.slug}</TableCell>
                    <TableCell className="text-muted-foreground">{template.scenarioSlug}</TableCell>
                    <TableCell>
                      <Badge variant={template.latestPublishedVersionId ? "secondary" : "outline"}>
                        {template.latestPublishedVersionId
                          ? t("template.published")
                          : t("template.draft")}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TabsContent>

          <TabsContent value="fabri" className="pt-4">
            <ul className="grid gap-3 sm:grid-cols-3">
              {(fabri.data ?? []).map((faber) => (
                <li key={faber.id} className="rounded-md border p-3">
                  <p className="font-medium">
                    {faber.avatar} {lt(faber.nameI18n)}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">{lt(faber.personaI18n)}</p>
                </li>
              ))}
            </ul>
          </TabsContent>

          <TabsContent value="models" className="pt-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns.name")}</TableHead>
                  <TableHead>{t("columns.tier")}</TableHead>
                  <TableHead>{t("columns.pricing")}</TableHead>
                  <TableHead>{t("columns.status")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(models.data ?? []).map((model) => (
                  <TableRow key={model.id}>
                    <TableCell>
                      <span className="font-medium">{model.displayName}</span>
                      <span className="ml-2 font-mono text-xs text-muted-foreground">
                        {model.providerModelId}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{model.tier}</Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      ${model.inputCostPerMtok}/M in · ${model.outputCostPerMtok}/M out
                    </TableCell>
                    <TableCell>{model.status}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TabsContent>

          <TabsContent value="skills" className="pt-4">
            <ul className="space-y-2">
              {(skills.data ?? []).map((skill) => (
                <li key={skill.id} className="rounded-md border p-3 text-sm">
                  <p className="font-medium">
                    {lt(skill.nameI18n)}{" "}
                    <span className="font-mono text-xs text-muted-foreground">{skill.slug}</span>
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {skill.versions.map((v) => v.version).join(", ") || t("skills.noVersions")}
                  </p>
                </li>
              ))}
            </ul>
          </TabsContent>

          <TabsContent value="mcp" className="pt-4">
            {(mcp.data ?? []).length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">{t("mcp.empty")}</p>
            ) : (
              <ul className="space-y-2">
                {(mcp.data ?? []).map((server) => (
                  <li
                    key={server.id}
                    className="flex items-center justify-between rounded-md border p-3 text-sm"
                  >
                    <div>
                      <p className="font-medium">{lt(server.nameI18n)}</p>
                      <p className="text-xs text-muted-foreground">
                        {server.slug} · {server.transport}
                      </p>
                    </div>
                    <Badge variant={server.hasAuth ? "secondary" : "outline"}>
                      {server.hasAuth ? t("mcp.authed") : t("mcp.noAuth")}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
