import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Proxea Socket.IO al proceso del juego en :3847.
 * Vivimos en /api/game-socket (sin carpeta «socket.io» en app/) porque Turbopack/Next suele responder 404
 * con rutas bajo segmentos que contienen punto.
 */
function upstreamBase(): URL {
  const raw =
    process.env.GAME_SERVER_URL?.trim() ||
    process.env.NEXT_PUBLIC_GAME_SERVER?.trim() ||
    "http://127.0.0.1:3847";
  const normalized = raw.replace(/\/+$/, "");
  return new URL(normalized);
}

function forwardedHeaders(from: Headers): Headers {
  const h = new Headers(from);
  h.delete("host");
  h.delete("connection");
  h.delete("keep-alive");
  h.delete("proxy-connection");
  h.delete("transfer-encoding");
  return h;
}

function buildUpstreamSocketIoUrl(req: NextRequest): URL {
  const base = upstreamBase();
  /** Barra final obligatoria; sin ella Express responde "Cannot GET /socket.io". */
  const u = new URL("/socket.io/", `${base.origin}/`);
  u.search = req.nextUrl.search;
  return u;
}

async function proxyEngineIo(req: NextRequest) {
  const url = buildUpstreamSocketIoUrl(req);

  const headers = forwardedHeaders(req.headers);
  /** `req.body` + `duplex` hacia upstream rompe payloads de polling en Route Handlers; bufferizar es fiable. */
  let upstreamBody: BodyInit | undefined;
  if (
    req.method !== "GET" &&
    req.method !== "HEAD" &&
    req.method !== "OPTIONS" &&
    req.method !== "TRACE"
  ) {
    const buf = await req.arrayBuffer();
    upstreamBody = buf.byteLength === 0 ? undefined : buf;
    headers.delete("content-length");
    headers.delete("transfer-encoding");
    headers.delete("content-encoding");
  }

  const res = await fetch(url, {
    method: req.method,
    headers,
    body: upstreamBody,
    redirect: "manual",
  });
  /** Releer todo el body evita inconsistencias cliente↔upstream con streams en Turbopack. */
  const bodyBuf = await res.arrayBuffer();

  const outHeaders = new Headers(res.headers);
  for (const strip of [
    "transfer-encoding",
    "connection",
    "keep-alive",
    "proxy-connection",
    "content-encoding",
    "content-length",
  ]) {
    outHeaders.delete(strip);
  }
  outHeaders.set("content-length", String(bodyBuf.byteLength));

  return new Response(bodyBuf, {
    status: res.status,
    statusText: res.statusText,
    headers: outHeaders,
  });
}

export async function GET(req: NextRequest) {
  return proxyEngineIo(req);
}

export async function POST(req: NextRequest) {
  return proxyEngineIo(req);
}

export async function OPTIONS(req: NextRequest) {
  return proxyEngineIo(req);
}
