import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "Link Lens — URL intelligence for agents", description: "Turn any public URL into structured, useful data." };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body>{children}</body></html>; }
