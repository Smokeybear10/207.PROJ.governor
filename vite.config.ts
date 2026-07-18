import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const baseSecurityHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy":
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY"
};

const developmentSecurityHeaders = {
  ...baseSecurityHeaders,
  "Content-Security-Policy":
    "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; " +
    "form-action 'self'; object-src 'none'; img-src 'self' data:; " +
    "style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; " +
    "connect-src 'self' ws://127.0.0.1:*"
};

const previewSecurityHeaders = {
  ...baseSecurityHeaders,
  "Content-Security-Policy":
    "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; " +
    "form-action 'self'; object-src 'none'; img-src 'self' data:; " +
    "style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'"
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
    headers: developmentSecurityHeaders,
    proxy: {
      "/api": "http://127.0.0.1:8787"
    }
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    headers: previewSecurityHeaders
  }
});
