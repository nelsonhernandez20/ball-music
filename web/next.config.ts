import type { NextConfig } from "next";

const extraAllowedOrigins =
  process.env.NEXT_ALLOWED_DEV_ORIGINS?.split(/[\s,|]+/).map((o) => o.trim()).filter(Boolean) ?? [];

/** En dev Next bloquea orígenes ajenos a localhost → HMR y dev-only assets desde ngrok/LAN. */
const allowedDevOrigins = [
  "*.ngrok-free.app",
  "*.ngrok.app",
  "*.ngrok.io",
  "*.loca.lt",
  "*.trycloudflare.com",
  ...extraAllowedOrigins,
];

const nextConfig: NextConfig = {
  allowedDevOrigins,
};

export default nextConfig;
