import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "rhwp — HWP 뷰어",
  description: "브라우저에서 HWP/HWPX 파일을 열어보세요",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko" className="h-full antialiased">
      <head>
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;700&family=Noto+Serif+KR:wght@400;700&family=Nanum+Gothic&family=Nanum+Myeongjo&display=swap"
        />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
