import type { Metadata, Viewport } from "next";
import { Fira_Code, Geist, Geist_Mono, Inter, JetBrains_Mono } from "next/font/google";
import { SettingsRuntime } from "@/components/claude/settings/SettingsRuntime";
import { PALETTES, prePaintScript } from "@/lib/settings-schema";
import "./globals.css";

const sans = Geist({ subsets: ["latin"], variable: "--font-sans-face" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono-face" });
/* picked in Settings > Appearance; not preloaded, so their files only download once a setting uses them */
const inter = Inter({ subsets: ["latin"], variable: "--font-inter-face", preload: false });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono-face", preload: false });
const fira = Fira_Code({ subsets: ["latin"], variable: "--font-fira-face", preload: false });

export const metadata: Metadata = {
  title: "agent-u",
  description: "Your coding agents, from any screen.",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/icon.svg", apple: "/apple-touch-icon.png" },
  appleWebApp: { capable: true, title: "agent-u", statusBarStyle: "black-translucent" },
  robots: { index: false, follow: false },
};

/* theme-color is rendered by hand (below) instead of through `viewport`, so it
 * follows the app's own theme choice rather than the OS color scheme. */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
};

/* Dark by default (or the OS scheme when set to System). The stored theme, palette, fonts, sizes and so on are put on
 * <html> before paint so there's no flash, and the browser chrome color is matched to the page (lib/settings-schema.ts). */
const themeScript = prePaintScript();

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta name="theme-color" content={PALETTES[0].dark.page} suppressHydrationWarning />
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className={`${sans.variable} ${mono.variable} ${inter.variable} ${geistMono.variable} ${fira.variable} font-sans`}>
        {children}
        <SettingsRuntime />
      </body>
    </html>
  );
}
