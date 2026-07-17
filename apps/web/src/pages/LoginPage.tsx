import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { HammerIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authApi } from "../lib/api";

export function LoginPage() {
  const { t } = useTranslation("auth");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"signIn" | "signUp">("signIn");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode === "signUp") {
        await authApi.signUp({ name, email, password });
      } else {
        await authApi.signIn({ email, password });
      }
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      void navigate({ to: "/" });
    } catch (err) {
      setError((err as Error).message || t("failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-muted/40 p-4">
      <div className="flex items-center gap-2.5">
        <div className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
          <HammerIcon className="size-5" />
        </div>
        <span className="text-lg font-semibold tracking-tight">{t("title")}</span>
      </div>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{mode === "signUp" ? t("signUp") : t("signIn")}</CardTitle>
          <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            {mode === "signUp" && (
              <div className="space-y-2">
                <Label htmlFor="name">{t("name")}</Label>
                <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="email">{t("email")}</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">{t("password")}</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={busy}>
              {mode === "signUp" ? t("signUp") : t("signIn")}
            </Button>
          </form>
          <button
            type="button"
            className="mt-4 w-full text-center text-sm text-muted-foreground hover:underline"
            onClick={() => setMode(mode === "signIn" ? "signUp" : "signIn")}
          >
            {mode === "signIn" ? t("switchToSignUp") : t("switchToSignIn")}
          </button>
        </CardContent>
      </Card>
    </div>
  );
}
