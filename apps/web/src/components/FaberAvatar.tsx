import { cn } from "@/lib/utils";

const SIZES = {
  sm: "size-7 text-sm",
  md: "size-8 text-base",
  lg: "size-9 text-lg",
};

/** Emoji avatar tile for a Faber (avatars are emoji by design; one shared fallback). */
export function FaberAvatar({
  avatar,
  size = "md",
  className,
}: {
  avatar: string | null | undefined;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-lg bg-primary/10",
        SIZES[size],
        className,
      )}
    >
      {avatar ?? "🤖"}
    </span>
  );
}
