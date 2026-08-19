import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "PiHub Server",
  description: "Tailnet-only Pi agent service for PiHub",
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#1a1a1a" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" translate="no">
      <body translate="no" className="notranslate" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
