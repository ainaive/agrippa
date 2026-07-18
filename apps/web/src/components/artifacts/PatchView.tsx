import { cn } from "@/lib/utils";

function lineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "font-semibold text-foreground";
  if (line.startsWith("@@")) return "text-status-info";
  if (line.startsWith("+")) return "bg-status-success/10 text-status-success";
  if (line.startsWith("-")) return "bg-status-danger/10 text-status-danger";
  if (line.startsWith("diff ") || line.startsWith("index ")) return "text-muted-foreground";
  return "";
}

/** Colorized unified-diff view. Also used by the template editor's version compare. */
export function PatchView({ text, className }: { text: string; className?: string }) {
  return (
    <pre
      className={cn(
        "max-h-96 overflow-auto rounded-md bg-muted/40 p-3 font-mono text-xs leading-5",
        className,
      )}
    >
      {text.split("\n").map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: immutable text lines, render-only
        <div key={index} className={lineClass(line)}>
          {line || " "}
        </div>
      ))}
    </pre>
  );
}
