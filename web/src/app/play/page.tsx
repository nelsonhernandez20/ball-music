"use client";

import { Suspense, useEffect, useRef, useState, type MutableRefObject } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { io, Socket } from "socket.io-client";

type MatchPhase = "running" | "finished";

/** Copia superficial de tipos del servidor (evitar dependencias cruzadas). */
type GameSnapshot = {
  worldW: number;
  worldH: number;
  /** px/s de la cinta en el servidor (0 = asteroides quietos). */
  worldScrollPs?: number;
  /** Solo telemetría/persistencia; las Y del snapshot son coords absolutas del lienzo (sin restar accum). */
  worldScrollAccum?: number;
  tick?: number;
  players: Array<{
    id: string;
    nickname: string;
    avatarUrl: string | null;
    x: number;
    y: number;
    vx: number;
    vy: number;
    lives: number;
    shieldCharges: number;
    trailEnergy?: number;
    score?: number;
    eliminated?: boolean;
    connected?: boolean;
    invulnTicks?: number;
  }>;
  platforms: Array<{ id: string; x: number; y: number; w: number; h: number }>;
  trailSegments?: Array<{
    id: string;
    x: number;
    y: number;
    w: number;
    h: number;
    ownerId: string;
    spawnTick: number;
  }>;
  trailPickups?: Array<{ id: string; x: number; y: number }>;
  musicMatchEndsAtUnixMs?: number;
  musicPhase?: MatchPhase;
  musicWinnerPlayerIds?: string[];
  musicTrackDurationMs?: number;
  musicPublicPath?: string;
  musicTrackTitle?: string;
};

/**
 * Dónde conecta Socket.IO en el navegador.
 * - En la misma máquina: podés usar `NEXT_PUBLIC_GAME_SERVER=http://127.0.0.1:3847` (directo al juego).
 * - Desde el celular/ngrok sólo contra Next (:3000): si el env sigue apuntando a localhost, usamos este mismo
 *   origen y el servidor Next proxea por `GET/POST /api/game-socket` → `GAME_SERVER_URL`/`socket.io`.
 */
function resolveGameSocketBaseUrl(): string {
  if (typeof window === "undefined") return "";
  const explicit = process.env.NEXT_PUBLIC_GAME_SERVER?.trim().replace(/\/+$/, "") ?? "";
  const h = window.location.hostname.toLowerCase();
  const pageIsLoopback = h === "localhost" || h === "127.0.0.1" || h === "[::1]";
  const pointsToMachineLoopback = (u: string) =>
    /(^|\/\/)(localhost|127\.0\.0\.1|\[::1\])/i.test(u);

  if (explicit) {
    if (!pageIsLoopback && pointsToMachineLoopback(explicit)) {
      return window.location.origin;
    }
    return explicit;
  }

  return window.location.origin;
}

function formatRemainClock(unixEndMs: number): string {
  const ms = Math.max(0, unixEndMs - Date.now());
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

/** Tamaño visible real (barra de URL de Safari, notch, etc.). */
function playViewportSize(): { w: number; h: number } {
  if (typeof window === "undefined") return { w: 390, h: 820 };
  const vv = window.visualViewport;
  if (vv != null && vv.width > 32 && vv.height > 80) {
    return { w: vv.width, h: vv.height };
  }
  return { w: window.innerWidth, h: window.innerHeight };
}

function hashHue(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = id.charCodeAt(i) + ((h << 5) - h);
  return Math.abs(h) % 360;
}

function drawSpaceship(
  ctx: CanvasRenderingContext2D,
  scale: number,
  x: number,
  y: number,
  hue: number,
  invulnTicks: number,
  nowMs: number,
) {
  const blink =
    invulnTicks > 0 ? 0.4 + 0.6 * (Math.floor(nowMs / 95) % 2) : 1;
  ctx.save();
  ctx.globalAlpha = blink;
  /** Frente fijo “arriba” (Y−); sin translate/rotate por velocidad. Coordenadas de mundo para evitar CTM extraño. */
  ctx.fillStyle = `hsl(${hue} 76% 54%)`;
  ctx.strokeStyle = `hsla(${hue} 100% 76% / 0.94)`;
  ctx.lineWidth = Math.max(1, 2 / scale);
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(x, y - 16);
  ctx.lineTo(x - 12, y + 12);
  ctx.lineTo(x + 12, y + 12);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "rgba(165,243,252,0.72)";
  ctx.beginPath();
  ctx.arc(x, y - 6, 2.8, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = `hsla(${hue} 90% 40% / 0.75)`;
  ctx.fillRect(x - 5, y + 8, 10, 3);
  ctx.restore();
}

type TouchInputRef = MutableRefObject<{
  left: boolean;
  right: boolean;
  jump: boolean;
  down: boolean;
  trail: boolean;
}>;

/** Joystick táctil: ↔ lateral; ↑/↓ empujan (sin gravedad: al soltar te frenás y podés quedar quieto). */
function MobileJoystick({
  inputRef,
  emitInput,
}: {
  inputRef: TouchInputRef;
  emitInput: () => void;
}) {
  const baseRef = useRef<HTMLDivElement>(null);
  const activeId = useRef<number | null>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const dead = 0.32;

  const apply = (clientX: number, clientY: number) => {
    const el = baseRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const radius = (Math.min(r.width, r.height) / 2) * 0.88;
    let nx = (clientX - cx) / radius;
    let ny = (clientY - cy) / radius;
    const len = Math.hypot(nx, ny);
    if (len > 1) {
      nx /= len;
      ny /= len;
    }
    const travel = radius * 0.42;
    setKnob({ x: nx * travel, y: ny * travel });

    inputRef.current.left = nx < -dead;
    inputRef.current.right = nx > dead;
    inputRef.current.jump = ny < -dead;
    inputRef.current.down = ny > dead;
    emitInput();
  };

  const release = () => {
    activeId.current = null;
    setKnob({ x: 0, y: 0 });
    inputRef.current.left = false;
    inputRef.current.right = false;
    inputRef.current.jump = false;
    inputRef.current.down = false;
    emitInput();
  };

  return (
    <div
      ref={baseRef}
      className="pointer-events-auto relative size-[7.5rem] touch-none select-none rounded-full border border-white/15 bg-black/50 shadow-lg shadow-black/40 backdrop-blur-sm"
      style={{ touchAction: "none" }}
      onPointerDown={(e) => {
        e.preventDefault();
        activeId.current = e.pointerId;
        e.currentTarget.setPointerCapture(e.pointerId);
        apply(e.clientX, e.clientY);
      }}
      onPointerMove={(e) => {
        if (activeId.current !== e.pointerId) return;
        e.preventDefault();
        apply(e.clientX, e.clientY);
      }}
      onPointerUp={(e) => {
        if (activeId.current !== e.pointerId) return;
        e.preventDefault();
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          release();
        }
      }}
      onPointerCancel={() => release()}
      onLostPointerCapture={() => release()}
      role="group"
      aria-label="Joystick: lateral y empuje arriba o abajo; al soltar se frena la deriva"
    >
      <div
        className="pointer-events-none absolute left-1/2 top-1/2 size-[2.85rem] rounded-full border border-cyan-400/35 bg-gradient-to-br from-zinc-600/95 to-zinc-900/95 shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]"
        style={{
          transform: `translate(calc(-50% + ${knob.x}px), calc(-50% + ${knob.y}px))`,
        }}
      />
      <div className="pointer-events-none absolute inset-2 rounded-full border border-dashed border-white/10" />
    </div>
  );
}

function InnerPlay() {
  const params = useSearchParams();
  const nickname = params.get("name") ?? "";
  const avatarUrl = params.get("avatar");

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const socketRef = useRef<Socket | null>(null);
  const snapshotRef = useRef<GameSnapshot | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const musicUserOnRef = useRef(false);

  const [status, setStatus] = useState<string>("Conectando…");
  const [deniedReason, setDeniedReason] = useState<string | null>(null);
  /** El streamer puede revivierte con "+ vida" en el panel si seguís conectado. */
  const [eliminated, setEliminated] = useState(false);
  const [hudPulse, setHudPulse] = useState(0);

  const inputRef = useRef({ left: false, right: false, jump: false, down: false, trail: false });
  const playerIdRef = useRef<string | null>(null);
  const eliminatedRef = useRef(false);
  const emitInputRef = useRef<() => void>(() => {});

  const syncLobbyAudioFromSnap = (snap: GameSnapshot | null) => {
    const el = audioRef.current;
    if (!el || !snap || !musicUserOnRef.current) return;

    const path = snap.musicPublicPath ?? "/music/on-and-on-ncs.mp3";
    const normalized = path.startsWith("/") ? path : `/${path}`;
    try {
      const cur =
        typeof window !== "undefined" && el.src
          ? new URL(el.src, window.location.href).pathname
          : "";
      if (cur !== normalized) el.src = normalized;
    } catch {
      el.src = normalized;
    }

    if (snap.musicPhase === "finished") {
      el.pause();
      return;
    }
    if (snap.musicPhase !== "running") return;

    const end = snap.musicMatchEndsAtUnixMs ?? 0;
    const durMs = snap.musicTrackDurationMs ?? 208_008;
    if (!end || !durMs) return;

    const remain = end - Date.now();
    const elapsedMs = durMs - Math.max(0, Math.min(durMs, remain));
    const t = elapsedMs / 1000;
    try {
      if (!Number.isFinite(el.currentTime) || Math.abs(el.currentTime - t) > 1.5) el.currentTime = t;
      void el.play();
    } catch {
      //
    }
  };

  useEffect(() => {
    const id = window.setInterval(() => setHudPulse((n) => n + 1), 300);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!nickname.trim()) {
      setStatus("Falta un nombre. Vuelve al inicio.");
      return;
    }

    let effectActive = true;

    const socketBase = resolveGameSocketBaseUrl();
    const viaNextProxy =
      typeof window !== "undefined" &&
      socketBase.replace(/\/$/, "") === window.location.origin.replace(/\/$/, "");
    const socketPath = viaNextProxy ? "/api/game-socket" : "/socket.io";

    const socket = io(socketBase, {
      /**
       * Tras el handshake, por defecto Engine.IO intenta «upgrade» a WebSocket.
       * Eso contra Next sólo llega como petición WS; `/api/game-socket` es HTTP proxy y no puede
       * hacer upgrade → fallos intermedios tipo `xhr poll error` / reconexiones. Con el proxy sólo polling.
       */
      transports: viaNextProxy ? ["polling"] : ["polling", "websocket"],
      upgrade: !viaNextProxy,
      path: socketPath,
      /** Con Next (trailingSlash false) `/api/game-socket/` redirige 308 sin esto → handshake frágil. */
      addTrailingSlash: !viaNextProxy,
      timeout: 20_000,
      reconnectionAttempts: 8,
      reconnectionDelay: 750,
      reconnectionDelayMax: 5_000,
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      if (!effectActive) return;
      setStatus("En sala…");
      socket.emit("join", {
        nickname: nickname.trim().slice(0, 24),
        avatarUrl: avatarUrl && avatarUrl.startsWith("https://") ? avatarUrl : null,
      });
    });

    socket.on("join_ok", (p: { playerId?: string }) => {
      if (!effectActive) return;
      if (p?.playerId) playerIdRef.current = p.playerId;
      setStatus("¡A jugar!");
    });

    socket.on("join_denied", (p: { reason?: string }) => {
      if (!effectActive) return;
      setDeniedReason(p?.reason ?? "No se pudo entrar.");
      setStatus("Rechazado");
    });

    socket.on("kicked_from_room", (payload: { message?: string }) => {
      if (!effectActive) return;
      effectActive = false;
      socket.io.reconnection(false);
      playerIdRef.current = null;
      setDeniedReason(payload?.message ?? "El streamer te quitó de la sala.");
      setStatus("Fuera de la sala");
      socket.disconnect();
    });

    socket.on("state", (snap: GameSnapshot) => {
      if (!effectActive) return;
      snapshotRef.current = snap;
      syncLobbyAudioFromSnap(snap);
      const id = playerIdRef.current;
      if (id) {
        const me = snap.players.find((x) => x.id === id);
        const isOut = Boolean(me?.eliminated);
        eliminatedRef.current = isOut;
        setEliminated(isOut);
      } else {
        eliminatedRef.current = false;
        setEliminated(false);
      }
    });

    socket.on("disconnect", () => {
      if (!effectActive) return;
      setStatus("Desconectado");
    });

    socket.on("connect_error", (err) => {
      if (!effectActive) return;
      console.warn("[socket] connect_error:", err.message);
      setStatus(
        `Sin conexión al juego (${err.message}). Reiniciá Next después de cambiar next.config; el proceso del juego en :3847 tiene que estar en marcha (GAME_SERVER_URL).`,
      );
    });

    socket.io.on("reconnect_attempt", (n: number) => {
      if (!effectActive) return;
      setStatus(`Reintentando sala… (${n})`);
    });

    socket.io.on("reconnect_failed", () => {
      if (!effectActive) return;
      setStatus(
        "Sin conexión: el servidor de juego no respondió tras varios intentos. ¿Está corrido `npm run dev` (u otro comando) del backend en el puerto 3847?",
      );
    });

    const sendInput = () => {
      if (!socket.connected || !playerIdRef.current) return;
      const phase = snapshotRef.current?.musicPhase;
      if (phase === "finished") {
        inputRef.current = { left: false, right: false, jump: false, down: false, trail: false };
        socket.emit("input", { left: false, right: false, jump: false, down: false, trail: false });
        return;
      }
      if (eliminatedRef.current) {
        inputRef.current = { left: false, right: false, jump: false, down: false, trail: false };
        socket.emit("input", { left: false, right: false, jump: false, down: false, trail: false });
        return;
      }
      socket.emit("input", { ...inputRef.current });
    };
    emitInputRef.current = sendInput;

    const clearHeldKeys = () => {
      inputRef.current = { left: false, right: false, jump: false, down: false, trail: false };
      if (socket.connected && playerIdRef.current) {
        socket.emit("input", { left: false, right: false, jump: false, down: false, trail: false });
      }
    };

    const onWinBlur = () => clearHeldKeys();
    const onVis = () => {
      if (document.visibilityState === "hidden") clearHeldKeys();
    };

    const keyDown = (e: KeyboardEvent) => {
      if (e.code === "ArrowLeft" || e.code === "KeyA") {
        e.preventDefault();
        inputRef.current.left = true;
      }
      if (e.code === "ArrowRight" || e.code === "KeyD") {
        e.preventDefault();
        inputRef.current.right = true;
      }
      if (e.code === "Space" || e.code === "ArrowUp" || e.code === "KeyW") {
        e.preventDefault();
        inputRef.current.jump = true;
      }
      if (e.code === "ArrowDown" || e.code === "KeyS") {
        e.preventDefault();
        inputRef.current.down = true;
      }
      if (e.code === "KeyE") {
        e.preventDefault();
        inputRef.current.trail = true;
      }
      sendInput();
    };

    const keyUp = (e: KeyboardEvent) => {
      if (e.code === "ArrowLeft" || e.code === "KeyA") inputRef.current.left = false;
      if (e.code === "ArrowRight" || e.code === "KeyD") inputRef.current.right = false;
      if (e.code === "Space" || e.code === "ArrowUp" || e.code === "KeyW") inputRef.current.jump = false;
      if (e.code === "ArrowDown" || e.code === "KeyS") inputRef.current.down = false;
      if (e.code === "KeyE") inputRef.current.trail = false;
      sendInput();
    };

    const loop = window.setInterval(sendInput, 1000 / 30);

    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    window.addEventListener("blur", onWinBlur);
    document.addEventListener("visibilitychange", onVis);

    let raf = 0;

    function render() {
      const canvasEl = canvasRef.current;
      if (!canvasEl) {
        raf = requestAnimationFrame(render);
        return;
      }
      const ctx = canvasEl.getContext("2d");
      const snap = snapshotRef.current;

      const dpr = Math.min(window.devicePixelRatio ?? 1, 2);
      const worldW = snap?.worldW ?? 480;
      const worldH = snap?.worldH ?? 860;

      /** Pantalla «tipo móvil» para escalado: angosto ó puntero grueso (tablet/TikTok incluso anchos). */
      const winOuterW = typeof window !== "undefined" ? window.innerWidth : 1280;
      const coarsePointer =
        typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
      const mobilePlay = winOuterW < 1280 || coarsePointer;
      const vp = typeof window !== "undefined" ? playViewportSize() : { w: worldW, h: worldH };

      let targetMaxW: number;
      let targetMaxH: number;
      if (mobilePlay) {
        targetMaxW = Math.max(280, vp.w - 6);
        /** ~14% o 120px como mucho para HUD y controles; antes ~33% achicaba demasiado el lienzo. */
        const uiReserve = Math.min(vp.h * 0.14, 120);
        targetMaxH = Math.max(340, vp.h - uiReserve);
      } else {
        targetMaxW = Math.max(320, vp.w - 96);
        targetMaxH = Math.min(vp.h * 0.76, window.innerHeight * 0.78, worldH * 1.05);
      }

      /** Encajar el mundo COMPLETO: si no cabe por ancho, bajamos la escala (evita solo ver un «cuadrado» recortado). */
      let scale =
        Math.min(Math.max(targetMaxW, 1) / worldW, Math.max(targetMaxH, 1) / worldH);

      scale = Number.isFinite(scale) && scale > 0 ? scale : 0.25;
      const vw = Math.max(8, Math.floor(worldW * scale));
      const vh = Math.max(8, Math.floor(worldH * scale));
      canvasEl.style.width = `${vw}px`;
      canvasEl.style.height = `${vh}px`;
      canvasEl.width = Math.floor(vw * dpr);
      canvasEl.height = Math.floor(vh * dpr);

      if (ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.scale(scale, scale);

        ctx.fillStyle = snap ? "#0c1020" : "#060812";
        ctx.fillRect(0, 0, worldW, worldH);

        if (!snap) {
          ctx.fillStyle = "rgba(148,163,253,0.35)";
          ctx.font = "14px system-ui,sans-serif";
          ctx.fillText("Sincronizando con la sala…", worldW / 2 - 120, worldH / 2);
        } else {
          const sy = (y: number) => y;

          ctx.fillStyle = "rgba(255,94,71,0.38)";
          ctx.strokeStyle = "rgba(255,150,124,0.22)";
          for (const plat of snap.platforms) {
            ctx.fillRect(plat.x - plat.w / 2, sy(plat.y) - plat.h / 2, plat.w, plat.h);
            ctx.strokeRect(plat.x - plat.w / 2, sy(plat.y) - plat.h / 2, plat.w, plat.h);
          }

          const segments = snap.trailSegments ?? [];
          for (const seg of segments) {
            const th = hashHue(seg.ownerId);
            ctx.save();
            ctx.shadowColor = `hsl(${th} 100% 45%)`;
            ctx.shadowBlur = 5 / scale;
            ctx.strokeStyle = `hsl(${th} 90% 62%)`;
            ctx.lineWidth = Math.max(1, 1.5 / scale);
            ctx.strokeRect(seg.x - seg.w / 2, sy(seg.y) - seg.h / 2, seg.w, seg.h);
            ctx.shadowBlur = 0;
            ctx.fillStyle = `hsla(${th} 100% 55% / 0.2)`;
            ctx.fillRect(seg.x - seg.w / 2, sy(seg.y) - seg.h / 2, seg.w, seg.h);
            ctx.restore();
          }

          for (const pk of snap.trailPickups ?? []) {
            ctx.save();
            ctx.fillStyle = "rgba(250, 204, 21, 0.88)";
            ctx.beginPath();
            ctx.arc(pk.x, sy(pk.y), 11, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = "rgba(254, 249, 195, 0.95)";
            ctx.lineWidth = 1 / scale;
            ctx.stroke();
            ctx.restore();
          }

          ctx.font = `${11 / scale}px system-ui,sans-serif`;

          const nowMs = performance.now();

          const myId = playerIdRef.current;
          for (const pl of snap.players) {
            if (pl.eliminated) continue;
            if (pl.connected === false && pl.id !== myId) continue;
            const hue = hashHue(pl.id);
            drawSpaceship(ctx, scale, pl.x, sy(pl.y), hue, pl.invulnTicks ?? 0, nowMs);

            if (myId && pl.id === myId) {
              const te = typeof pl.trailEnergy === "number" ? pl.trailEnergy : 1;
              const tcl = Math.max(0, Math.min(1, te));
              const bw = 44;
              const bh = 5;
              const bx = pl.x - bw / 2;
              const by = sy(pl.y) - 38;
              ctx.fillStyle = "rgba(15,23,42,0.72)";
              ctx.fillRect(bx, by, bw, bh);
              ctx.fillStyle =
                tcl > 0.12 ? "rgba(34,211,238,0.92)" : "rgba(248,113,113,0.88)";
              ctx.fillRect(bx, by, bw * tcl, bh);
              ctx.strokeStyle = "rgba(255,255,255,0.3)";
              ctx.lineWidth = 1 / scale;
              ctx.strokeRect(bx, by, bw, bh);
            }

            ctx.globalAlpha = 1;

            ctx.strokeStyle = "rgba(255,255,255,0.14)";
            ctx.lineWidth = 1 / scale;
            ctx.strokeText(pl.nickname, pl.x + 22, sy(pl.y) + 6);
            ctx.fillStyle = "rgba(246,246,246,0.95)";
            ctx.fillText(pl.nickname, pl.x + 22, sy(pl.y) + 6);

            const pts = typeof pl.score === "number" && Number.isFinite(pl.score) ? Math.round(pl.score) : 0;
            const hud = `${pts} pts · ${pl.lives}♥  ${pl.shieldCharges > 0 ? "🛡" + pl.shieldCharges + " " : ""}`;
            ctx.fillStyle = "rgba(246,246,246,0.55)";
            ctx.fillText(hud, pl.x + 22, sy(pl.y) + 20);
          }
        }
      }
      raf = requestAnimationFrame(render);
    }
    render();

    return () => {
      effectActive = false;
      cancelAnimationFrame(raf);
      window.clearInterval(loop);
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("blur", onWinBlur);
      document.removeEventListener("visibilitychange", onVis);
      socket.disconnect();
      socketRef.current = null;
    };
  }, [nickname, avatarUrl]);

  if (!nickname.trim()) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-8 text-center text-zinc-300">
        <p>Necesitás elegir nombre en la pantalla anterior.</p>
        <Link className="text-indigo-400 underline" href="/">
          Volver
        </Link>
      </div>
    );
  }

  void hudPulse;
  const liveHud = snapshotRef.current;
  const roundFinished = liveHud?.musicPhase === "finished";
  const roundRunning = liveHud?.musicPhase === "running";
  const endsAt = liveHud?.musicMatchEndsAtUnixMs ?? 0;
  const winnerNicknames =
    liveHud?.musicWinnerPlayerIds
      ?.map((wid) => liveHud.players.find((p) => p.id === wid)?.nickname?.trim() || "")
      .filter(Boolean) ?? [];

  return (
    <div className="flex min-h-[100dvh] max-w-[100vw] flex-col items-center gap-2 bg-[#090b14] px-2 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(2.5rem,calc(env(safe-area-inset-top,0px)+1.75rem))] text-white max-xl:pb-24 xl-mouse:gap-3 xl-mouse:px-4 xl-mouse:pb-28 xl-mouse:pt-10">
      <audio ref={audioRef} preload="auto" className="hidden" aria-hidden />

      <div className="flex w-full max-w-lg flex-wrap items-center justify-between gap-2 px-4 text-xs text-zinc-400">
        <span>Jugando como · {nickname}</span>
        <span>{status}</span>
      </div>

      {!deniedReason && liveHud?.musicPhase ? (
        <div className="flex w-full max-w-lg flex-col gap-2 rounded-xl border border-white/10 bg-zinc-900/65 px-4 py-3 text-xs text-zinc-200 backdrop-blur-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium text-cyan-200/95">
              {liveHud.musicTrackTitle ?? "Música de la sala"}
            </span>
            {roundRunning && endsAt > 0 ? (
              <span className="rounded-md bg-black/55 px-2 py-1 font-mono text-amber-200/95">
                {formatRemainClock(endsAt)}
              </span>
            ) : roundFinished ? (
              <span className="rounded-md bg-emerald-950/80 px-2 py-1 text-emerald-200">Ronda terminada</span>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="rounded-lg border border-cyan-500/35 bg-cyan-950/50 px-3 py-1.5 text-[11px] font-medium text-cyan-50 hover:bg-cyan-900/55"
              onClick={() => {
                musicUserOnRef.current = true;
                syncLobbyAudioFromSnap(snapshotRef.current);
              }}
            >
              Activar música (este dispositivo)
            </button>
            <span className="text-zinc-500">Sincroniza con el servidor al terminar el tema.</span>
          </div>
        </div>
      ) : null}

      {deniedReason ? (
        <div className="max-w-lg rounded-xl border border-rose-500/40 bg-rose-950/40 px-4 py-6 text-center text-rose-200">
          <p className="mb-4">{deniedReason}</p>
          <Link href="/" className="text-indigo-300 underline">
            Reintentar
          </Link>
        </div>
      ) : null}

      {/* Móvil: una línea estática antes del lienzo — no cubre el juego */}
      {!deniedReason && !(eliminated || roundFinished) ? (
        <p className="xl-mouse:hidden mx-auto max-w-lg min-h-[2.75rem] w-full shrink-0 px-2 text-center text-[10px] leading-snug text-zinc-500">
          <strong className="text-zinc-300">Sin gravedad</strong>: sin ↑/↓ no te movés en vertical. Los cuadrados rojos están{" "}
          <strong className="text-zinc-300">quietos</strong> (salvo que el servidor tenga modo cinta con{" "}
          <code className="text-zinc-400">BALL_WORLD_SCROLL_PS</code>).{" "}
          <strong className="text-zinc-300">Rojos + trazos ajenos</strong> quitan vida; violeta{" "}
          <strong className="text-zinc-300">Traza</strong>.
        </p>
      ) : null}

      {!deniedReason ? (
        <div className="relative z-10 flex w-full justify-center px-0.5">
          <canvas
            ref={canvasRef}
            className="block max-w-full rounded-lg shadow-lg shadow-black/60"
            aria-label="Mini arena: esquivar cuadrados destructores, sin gravedad"
          />
        </div>
      ) : null}

      {roundFinished && !deniedReason ? (
        <div className="z-[55] mx-4 flex w-full max-w-lg flex-col gap-4 rounded-2xl border border-amber-400/35 bg-black/82 px-4 py-5 text-center text-zinc-100 shadow-xl shadow-black/50 backdrop-blur-sm">
          <p className="text-sm font-semibold text-amber-200">¡Fin de la canción!</p>
          <p className="text-xs text-zinc-400">
            Ganan quienes llegaron con más puntaje: {winnerNicknames.length ? winnerNicknames.join(", ") : "nadie en sala"}
          </p>
          <p className="text-xs text-zinc-500">
            El streamer puede iniciar una ronda nueva desde el <strong className="text-zinc-400">panel del stream</strong> (no desde acá).
          </p>
        </div>
      ) : null}

      {eliminated && !deniedReason ? (
        <div
          role="status"
          className="fixed bottom-44 left-3 right-3 z-[60] mx-auto max-w-lg rounded-2xl border border-rose-600/35 bg-black/82 px-4 py-5 text-center text-sm text-zinc-100 backdrop-blur-sm md:left-auto md:right-auto"
        >
          <p className="font-medium text-rose-300">Eliminado</p>
          <p className="mt-2 leading-relaxed text-zinc-300">
            Mantené esta pestaña abierta. Cuando el stream te dé <strong className="text-emerald-300">+ vida</strong>, tu
            nave vuelve a aparecer sobre la corrida más segura.
          </p>
          <p className="mt-3 text-xs text-zinc-500">
            Podés recargar esta página con el mismo nick y volvés a tu mismo personaje unos minutos; si tardás más, el servidor lo borra sin base de datos.
          </p>
        </div>
      ) : null}

      {/* Escritorio: ayuda después del lienzo */}
      {!deniedReason ? (
        <p className="mx-auto hidden max-w-lg px-4 pb-8 text-center text-xs text-zinc-500 xl-mouse:block">
          <strong className="text-zinc-300">Sin gravedad</strong>: sin ↑/↓ la nave no se mueve sola en Y. Por defecto los obstáculos no bajan{" "}
          (modo tranquilo); el streamer puede poner{" "}
          <code className="text-zinc-400">BALL_WORLD_SCROLL_PS≈48</code> para reactivar el flujo vertical.{" "}
          <strong className="text-zinc-300">↑ / espacio / W</strong> y <strong className="text-zinc-300">↓ / S</strong> empujan arriba/abajo;{" "}
          <strong className="text-zinc-300">← →</strong> lateral.{" "}
          <strong className="text-zinc-300">E</strong> (mantener) pinta un{" "}
          <strong className="text-zinc-300">trazo destructor</strong> (barra cyan; orbes dorados recargan).
          Los cuadrados rojos se acercan con el escenario; chocarlos o caer abajo quita vida. Choques entre naves rebotan.
        </p>
      ) : null}

      <div
        className={`pointer-events-none fixed bottom-5 right-4 z-50 xl-mouse:hidden ${eliminated || roundFinished ? "hidden" : ""}`}
      >
        <button
          type="button"
          className="pointer-events-auto flex min-h-[4.25rem] w-[4.5rem] touch-manipulation flex-col items-center justify-center rounded-2xl border border-fuchsia-500/45 bg-fuchsia-950/55 text-[10px] font-semibold uppercase leading-tight tracking-wide text-fuchsia-100 shadow-lg shadow-black/30 active:bg-fuchsia-900/80"
          style={{ touchAction: "none" }}
          aria-label="Trazo destructor: mantener para pintar"
          onPointerDown={(e) => {
            e.preventDefault();
            inputRef.current.trail = true;
            emitInputRef.current();
          }}
          onPointerUp={(e) => {
            e.preventDefault();
            inputRef.current.trail = false;
            emitInputRef.current();
          }}
          onPointerCancel={(e) => {
            e.preventDefault();
            inputRef.current.trail = false;
            emitInputRef.current();
          }}
          onPointerLeave={(e) => {
            if (e.buttons === 0) {
              inputRef.current.trail = false;
              emitInputRef.current();
            }
          }}
        >
          Trazo
        </button>
      </div>

      <div
        className={`pointer-events-none fixed bottom-5 left-4 z-50 xl-mouse:hidden ${eliminated || roundFinished ? "hidden" : ""}`}
      >
        <MobileJoystick inputRef={inputRef} emitInput={() => emitInputRef.current()} />
      </div>
    </div>
  );
}

export default function PlayPage() {
  return (
    <Suspense fallback={<div className="p-12 text-center text-zinc-400">Cargando…</div>}>
      <InnerPlay />
    </Suspense>
  );
}
