import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";

import { loadEnv } from "./loadEnv.js";
import type { ClientInput } from "./types.js";
import { GameRoom } from "./room.js";
import {
  hydrateRoomFromSupabase,
  persistenceEnabled,
  persistRoomImmediate,
  schedulePersistRoom,
} from "./persistence.js";
import { registerPersistenceHooks, scheduleRoomPersist } from "./persistHooks.js";
import { MUSIC_PRESETS } from "./musicCatalog.js";

async function bootstrap() {
  loadEnv();

  registerPersistenceHooks(schedulePersistRoom, persistRoomImmediate);

  const PORT = Number(process.env.PORT ?? 3847);
  const ADMIN_SECRET = process.env.ADMIN_SECRET ?? "cambia-esto-en-directo";

  const app = express();
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json());

  const room = new GameRoom("live");
  console.info(`[ball-music] sala creada: scroll vertical ${room.getWorldScrollPs()} px/s (0=mundo quieto)`);
  await hydrateRoomFromSupabase(room);
  if (persistenceEnabled()) {
    await persistRoomImmediate(room);
  }
  room.beginMusicRound();

  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: { origin: true, credentials: true },
  });

  room.broadcastFn = (snap) => {
    io.emit("state", snap);
  };

  room.startLoop();

  function requireAdmin(authHeader: string | undefined): boolean {
    if (!authHeader?.startsWith("Bearer ")) return false;
    return authHeader.slice(7).trim() === ADMIN_SECRET;
  }

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      players: room.players.size,
      max: 5,
      worldScrollPs: room.getWorldScrollPs(),
      worldScrollAccum: room.getWorldScrollAccum(),
    });
  });

  app.get("/admin/players", (req, res) => {
    if (!requireAdmin(req.headers.authorization)) {
      res.status(401).json({ error: "Sin autorización" });
      return;
    }
    res.json({ players: room.listAdminPlayers() });
  });

  app.post("/admin/give-life", (req, res) => {
    if (!requireAdmin(req.headers.authorization)) {
      res.status(401).json({ error: "Sin autorización" });
      return;
    }
    const nickname = String(req.body?.nickname ?? "").trim();
    if (!nickname) {
      res.status(400).json({ error: "Falta nickname" });
      return;
    }
    const result = room.giveExtraLifeByNickname(nickname);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ ok: true, player: result.player });
  });

  app.post("/admin/grant-shield", (req, res) => {
    if (!requireAdmin(req.headers.authorization)) {
      res.status(401).json({ error: "Sin autorización" });
      return;
    }
    const nickname = String(req.body?.nickname ?? "").trim();
    if (!nickname) {
      res.status(400).json({ error: "Falta nickname" });
      return;
    }
    const result = room.grantShieldByNickname(nickname);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ ok: true, player: result.player });
  });

  app.get("/admin/music-presets", (req, res) => {
    if (!requireAdmin(req.headers.authorization)) {
      res.status(401).json({ error: "Sin autorización" });
      return;
    }
    res.json({
      presets: MUSIC_PRESETS,
      current: {
        musicPublicPath: room.musicPublicPath,
        musicTrackTitle: room.musicTrackTitle,
        musicTrackDurationMs: room.musicTrackDurationMs,
      },
    });
  });

  /** Reinicia sólo desde el panel HTTP (los jugadores en /play no pueden). */
  app.post("/admin/restart-music-round", (_req, res) => {
    if (!requireAdmin(_req.headers.authorization)) {
      res.status(401).json({ error: "Sin autorización" });
      return;
    }
    room.resetMusicRound();
    res.json({ ok: true });
  });

  app.post("/admin/set-music", (req, res) => {
    if (!requireAdmin(req.headers.authorization)) {
      res.status(401).json({ error: "Sin autorización" });
      return;
    }
    const body = req.body as Record<string, unknown> | undefined;
    const presetId =
      typeof body?.presetId === "string" ? body.presetId : undefined;
    const publicPath =
      typeof body?.publicPath === "string" ? body.publicPath : undefined;
    const title = typeof body?.title === "string" ? body.title : undefined;
    const durationMs = body?.durationMs;
    const r = room.setMusicFromAdmin({
      presetId,
      publicPath,
      title,
      durationMs:
        typeof durationMs === "number"
          ? durationMs
          : typeof durationMs === "string"
            ? Number(durationMs)
            : undefined,
    });
    if (!r.ok) {
      res.status(400).json({ error: r.error });
      return;
    }
    res.json({ ok: true });
  });

  app.post("/admin/kick-player", (req, res) => {
    if (!requireAdmin(req.headers.authorization)) {
      res.status(401).json({ error: "Sin autorización" });
      return;
    }
    const playerId = String(req.body?.playerId ?? "").trim();
    if (!playerId) {
      res.status(400).json({ error: "Falta playerId" });
      return;
    }
    const result = room.kickPlayerById(playerId);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    for (const sid of result.socketIds) {
      const s = io.sockets.sockets.get(sid);
      if (s) {
        s.emit("kicked_from_room", {
          message: "El streamer te quitó de la sala.",
        });
        s.disconnect(true);
      }
    }
    res.json({ ok: true, player: result.kickedNick });
  });

  io.on("connection", (socket) => {
    let playerId: string | null = null;

    socket.on("join", (payload: { nickname?: string; avatarUrl?: string | null }) => {
      const nick = typeof payload?.nickname === "string" ? payload.nickname : "";
      const avatarUrl =
        payload?.avatarUrl === null || payload?.avatarUrl === undefined
          ? null
          : String(payload.avatarUrl);
      const result = room.tryJoin(socket.id, nick, avatarUrl);
      if (!result.ok) {
        socket.emit("join_denied", { reason: result.reason });
        return;
      }
      playerId = result.playerId;
      socket.emit("join_ok", { playerId: result.playerId });
      socket.emit("state", room.snapshot());
    });

    socket.on("input", (input: Partial<ClientInput>) => {
      if (!playerId) return;
      const full: ClientInput = {
        left: Boolean(input?.left),
        right: Boolean(input?.right),
        jump: Boolean(input?.jump),
        down: Boolean(input?.down),
        trail: Boolean(input?.trail),
      };
      room.setInput(playerId, full);
    });

    socket.on("disconnect", () => {
      if (!playerId) return;
      room.detachSocket(playerId, socket.id);
      const p = room.players.get(playerId);
      if (p && p.socketIds.size === 0) {
        p.disconnectedAt = Date.now();
      }
      scheduleRoomPersist(room);
      playerId = null;
    });
  });

  httpServer.listen(PORT, () => {
    console.log(`[game] http+ws en :${PORT}  admin secret: ${ADMIN_SECRET.slice(0, 4)}…`);
    console.log(
      persistenceEnabled()
        ? "[persist] Supabase encendido: la sala sobrevive a reinicios del servidor."
        : "[persist] Sin Supabase: solo estado en RAM (vacío después de cortar el proceso).",
    );
  });
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
