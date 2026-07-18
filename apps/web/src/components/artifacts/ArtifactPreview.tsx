import { useQuery } from "@tanstack/react-query";
import { ExternalLinkIcon, Loader2Icon } from "lucide-react";
import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { PatchView } from "@/components/artifacts/PatchView";

const MarkdownContent = lazy(() => import("@/components/artifacts/MarkdownContent"));

import type { Artifact } from "@/lib/types";

const MAX_PREVIEW_BYTES = 256 * 1024;
const PREVIEWABLE_KINDS = ["markdown", "patch", "json", "link"];

export function isPreviewable(artifact: Artifact): boolean {
  return PREVIEWABLE_KINDS.includes(artifact.kind) && (artifact.size ?? 0) <= MAX_PREVIEW_BYTES;
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export function ArtifactPreview({ artifact }: { artifact: Artifact }) {
  const { t } = useTranslation("runs");
  const previewable = isPreviewable(artifact);

  const content = useQuery({
    queryKey: ["artifact-content", artifact.id],
    queryFn: async () => {
      const res = await fetch(`/api/v1/artifacts/${artifact.id}/download`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`download failed (${res.status})`);
      return res.text();
    },
    enabled: previewable,
    staleTime: Number.POSITIVE_INFINITY,
  });

  if (!previewable) {
    return <p className="py-2 text-sm text-muted-foreground">{t("artifact.tooLarge")}</p>;
  }
  if (content.isLoading) {
    return (
      <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
        <Loader2Icon className="size-4 animate-spin" />
      </div>
    );
  }
  if (content.isError || content.data === undefined) {
    return <p className="py-2 text-sm text-destructive">{String(content.error)}</p>;
  }

  const text = content.data;
  switch (artifact.kind) {
    case "markdown":
      return (
        <Suspense
          fallback={<Loader2Icon className="my-3 size-4 animate-spin text-muted-foreground" />}
        >
          <MarkdownContent text={text} />
        </Suspense>
      );
    case "patch":
      return <PatchView text={text} />;
    case "json":
      return (
        <pre className="max-h-96 overflow-auto rounded-md bg-muted/40 p-3 font-mono text-xs">
          {prettyJson(text)}
        </pre>
      );
    case "link": {
      const href = text.trim();
      return (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 py-1 text-sm text-primary hover:underline"
        >
          <ExternalLinkIcon className="size-3.5" />
          {href}
        </a>
      );
    }
    default:
      return null;
  }
}
