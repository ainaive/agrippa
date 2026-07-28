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
// after which every click in the app is a silent no-op. Clear any stale lock
// once a navigation settles.
router.subscribe("onResolved", () => {
  if (document.body.style.pointerEvents === "none") {
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
