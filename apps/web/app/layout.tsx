import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import Script from "next/script";
import { THEME_STORAGE_KEY } from "../lib/theme";
import { getLocaleServer } from "../lib/i18n/get-locale-server";
import { LocaleProvider } from "../lib/i18n/locale-provider";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const jetbrainsMono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "Korrelo",
  description: "Web OS para desenvolvedores gerenciarem VPS sem SSH.",
};

// O locale vem de um cookie lido em cada request (ver get-locale-server.ts),
// então o app inteiro precisa ser renderizado dinamicamente, sem export estático.
export const dynamic = "force-dynamic";

// Roda antes do hidrate pra aplicar o tema salvo (ou a preferência do SO) sem
// piscar a tela no tema errado por uma fração de segundo.
const THEME_INIT_SCRIPT = `
(function () {
  try {
    var stored = localStorage.getItem("${THEME_STORAGE_KEY}");
    var theme = stored === "light" || stored === "dark"
      ? stored
      : (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    document.documentElement.setAttribute("data-theme", theme);
  } catch (e) {}
})();
`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocaleServer();
  return (
    <html
      lang={locale === "en" ? "en" : "pt-BR"}
      className={`${inter.variable} ${jetbrainsMono.variable}`}
      // O script beforeInteractive abaixo seta data-theme antes do hydrate,
      // de propósito (evita flash do tema errado). O mismatch é esperado.
      suppressHydrationWarning
    >
      <head>
        <Script id="theme-init" strategy="beforeInteractive">
          {THEME_INIT_SCRIPT}
        </Script>
      </head>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <LocaleProvider initialLocale={locale}>{children}</LocaleProvider>
      </body>
    </html>
  );
}
