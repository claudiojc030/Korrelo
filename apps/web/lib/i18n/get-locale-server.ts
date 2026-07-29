import { cookies } from "next/headers";
import { LOCALE_COOKIE_KEY, type Locale } from "./locale";

export function getLocaleServer(): Locale {
  return cookies().get(LOCALE_COOKIE_KEY)?.value === "en" ? "en" : "pt";
}
