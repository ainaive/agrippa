import { useNavigate } from "@tanstack/react-router";
import { HammerIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { inviteApi } from "../lib/api";
import { toastApiError } from "../lib/toast";

export function AcceptInvitePage() {
  const { t } = useTranslation("auth");
  const navigate = useNavigate();
  const token = new URLSearchParams(window.location.search).get("token") ?? "";

  const [email, setEmail] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [invalid, setInvalid] = useState(false);

  // Preview the invite once on mount.
  if (!loaded) {
    setLoaded(true);
    if (!token) {
      setInvalid(true);
    } else {
      inviteApi
        .preview(token)
        .then((r) => setEmail(r.email))
        .catch(() => setInvalid(true));
    }
  }

  const submit = async () => {
    setError(null);
    if (password !== confirm) {
      setError(t("acceptInvite.mismatch"));
      return;
    }
    setBusy(true);
    try {
      await inviteApi.accept({ token, name, password });
      toast.success(t("acceptInvite.success"));
      void navigate({ to: "/login" });
    } catch (err) {
      toastApiError(err);
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
          <CardTitle>{t("acceptInvite.title")}</CardTitle>
          <p className="text-sm text-muted-foreground">{t("acceptInvite.subtitle")}</p>
        </CardHeader>
        <CardContent>
          {invalid ? (
            <p className="text-sm text-destructive">{t("acceptInvite.invalidToken")}</p>
          ) : email === null ? (
            <p className="text-sm text-muted-foreground">{t("acceptInvite.loading")}</p>
          ) : (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <div className="space-y-2">
                <Label htmlFor="email">{t("acceptInvite.emailLabel")}</Label>
                <Input id="email" value={email} disabled />
              </div>
              <div className="space-y-2">
                <Label htmlFor="name">{t("acceptInvite.name")}</Label>
                <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">{t("acceptInvite.password")}</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirm">{t("acceptInvite.confirm")}</Label>
                <Input
                  id="confirm"
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                  minLength={8}
                />
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button type="submit" className="w-full" disabled={busy}>
                {t("acceptInvite.submit")}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
