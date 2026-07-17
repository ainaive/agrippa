import { useQuery } from "@tanstack/react-query";
import { createContext, useContext } from "react";
import { api } from "../lib/api";
import type { Me } from "../lib/types";

export function useMeQuery() {
  return useQuery({
    queryKey: ["me"],
    queryFn: () => api<Me>("/me"),
    retry: false,
  });
}

export const MeContext = createContext<Me | null>(null);

export function useMe(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error("useMe outside MeContext");
  return me;
}
