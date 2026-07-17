import { resources } from "@agrippa/i18n";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";

export const STORAGE_KEY = "agrippa.locale";

void i18next.use(initReactI18next).init({
  resources,
  lng: localStorage.getItem(STORAGE_KEY) ?? "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

export function setLocale(locale: string): void {
  localStorage.setItem(STORAGE_KEY, locale);
  void i18next.changeLanguage(locale);
}

export default i18next;
