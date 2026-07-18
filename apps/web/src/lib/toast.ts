import { toast } from "sonner";
import { ApiError } from "@/lib/api";

/** The one place mutation errors become user-visible toasts. */
export function toastApiError(error: unknown) {
  toast.error(error instanceof ApiError ? error.message : String(error));
}
