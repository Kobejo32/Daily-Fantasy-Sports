import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Outfit, Russo_One } from "next/font/google";
import "./globals.css";
import { Nav } from "@/components/nav";

const outfit = Outfit({
  variable: "--font-outfit",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700", "800"],
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const russoOne = Russo_One({
  variable: "--font-logo",
  subsets: ["latin"],
  weight: "400",
});

const jetbrains = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "Holman Street",
  description: "DFS Engine — Automated Lineups & Analytics",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${outfit.variable} ${inter.variable} ${jetbrains.variable} ${russoOne.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        <Nav />
        <main className="md:ml-60 mt-14 md:mt-0 min-h-screen p-5 md:p-8">{children}</main>
      </body>
    </html>
  );
}
