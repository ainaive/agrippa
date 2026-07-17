import type { Locale } from "@agrippa/core";
import { resources } from "@agrippa/i18n";
import { useState } from "react";

export function App() {
  const [locale, setLocale] = useState<Locale>("en");
  const t = resources[locale].common;

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-50">
      <h1 className="text-3xl font-semibold text-slate-900">{t.appName}</h1>
      <p className="text-slate-500">Agrippa — M1 scaffold</p>
      <button
        type="button"
        className="rounded-md border border-slate-300 bg-white px-3 py-1 text-sm text-slate-700 hover:bg-slate-100"
        onClick={() => setLocale(locale === "en" ? "zh-CN" : "en")}
      >
        {t.language}: {locale}
      </button>
    </main>
  );
}
