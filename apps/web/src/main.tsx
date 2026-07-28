import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./lib/i18n";
import "./index.css";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "./features/theme";
import { ApiError } from "./lib/api";
import { router } from "./router";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status < 500) return false;
        return failureCount < 2;
      },
      staleTime: 5_000,
    },
  },
});

// Radix modal layers (the retry confirm dialog, dropdown menus…) set
// `pointer-events: none` on <body> while open; a navigation that unmounts one
// mid-exit-animation can leave that lock behind (radix-ui unmount-during-close),
// after which every click in the app is a silent no-op. Clear the lock once a
// navigation settles — but only when no layer remains open: the shell persists
// across routes, so browser back/forward can resolve with e.g. the user menu
// still up, and its lock is legitimate (Radix won't reapply a cleared one).
// Open Radix layers render portal content with these roles and unmount on
// close, so an empty query is a reliable staleness signal.
router.subscribe("onResolved", () => {
  const openLayer = document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]');
  if (!openLayer && document.body.style.pointerEvents === "none") {
    document.body.style.pointerEvents = "";
  }
});

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");

createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        {/* radix Tooltip requires a provider; the sidebar's rail tooltips render one per button */}
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
