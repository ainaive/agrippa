import { SearchIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export function SearchInput({ className, ...props }: React.ComponentProps<typeof Input>) {
  return (
    <div className="relative">
      <SearchIcon className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input {...props} className={cn("w-56 pl-8", className)} />
    </div>
  );
}
