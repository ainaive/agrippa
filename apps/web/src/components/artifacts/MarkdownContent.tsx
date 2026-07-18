import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Split out so react-markdown + remark-gfm load only when a preview opens. */
export default function MarkdownContent({ text }: { text: string }) {
  return (
    <div className="markdown-body max-h-96 overflow-auto rounded-md border bg-card p-4">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}
