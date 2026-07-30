import { cookies } from "next/headers";
import { LOCALE_COOKIE_KEY, type Locale } from "./locale";

export async function getLocaleServer(): Promise<Locale> {
  const store = await cookies();
  return store.get(LOCALE_COOKIE_KEY)?.value === "en" ? "en" : "pt";
}
