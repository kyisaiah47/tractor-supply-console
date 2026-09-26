import type { Metadata } from "next";
import { IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import { Shell } from "@/components/Shell";
import { api } from "@/lib/api";
import type { Overview } from "@/lib/types";
import "./globals.css";

const sans = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-plex-sans" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-plex-mono" });

export const metadata: Metadata = {
  title: "Tractor Supply Console",
  description: "Customer orders, demand forecasts, supplier delays, component failures and supply ordering for a tractor manufacturer.",
};

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const o = await api<Overview>("/api/overview");
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <Shell asOf={o.asOf} modelsRanAt={o.modelsRanAt}>
          {children}
        </Shell>
      </body>
    </html>
  );
}
