import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ForgeDesk",
  description: "Web OS para desenvolvedores gerenciarem VPS sem SSH.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body className="bg-neutral-950 text-neutral-100 min-h-screen">{children}</body>
    </html>
  );
}
