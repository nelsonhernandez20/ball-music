import { nanoid } from "nanoid";
import type {
  ClientInput,
  GameSnapshot,
  MatchPhase,
  PublicPlatform,
  PublicPlayer,
  PublicTrailSegment,
  TrailEnergyPickup,
} from "./types.js";
import { MUSIC_PRESETS } from "./musicCatalog.js";
import { persistRoomNow, scheduleRoomPersist } from "./persistHooks.js";

/** Velocidad Y del mundo (coords Y hacia abajo). Por defecto 0: asteroides quietos → la nave queda donde la soltás. `BALL_WORLD_SCROLL_PS≈48` reactiva la cinta. */
function parseWorldScrollPsFromEnv(): number {
  const raw = process.env.BALL_WORLD_SCROLL_PS?.trim();
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

const MAX_PLAYERS = 5;
const WORLD_W = 480;
const WORLD_H = 860;
const PLAYER_R = 14;
/** Obstáculos cuadrados destructores (lado aleatorio entre min y max). */
const OBSTACLE_SIDE_MIN = 22;
const OBSTACLE_SIDE_MAX = 32;
/** Sin gravedad: sin ↑/↓ la nave no deriva en Y; solo ↑/↓ aplican empuje ese tick. */
const SHIP_THRUST_UP = 1780;
/** Con ↓ empuja hacia abajo (solo a propósito). */
const SHIP_THRUST_DOWN = 1150;
const SHIP_VY_CAP_UP = -520;
const SHIP_VY_CAP_DN = 580;
const SHIP_SIDE_ACCEL = 1620;
const SHIP_VX_MAX = 360;
/** Cuánto «frena» vx al segundo cuando soltás izq/der (exp −drag·Δt). */
const SHIP_VX_DRAG = 7.8;
const WALL_BOUNCE_RETAIN = 0.86;
/** Techo del área jugable — rebota al chocar hacia arriba. */
const WORLD_CEILING_MARGIN = PLAYER_R + 10;
/** Rebote entre naves como dos pelotas (1 = elástico puro); <1 amortigua un poco. */
const PLAYER_SHIP_RESTITUTION = 0.92;
/** No aplicar rebote si se acercan muy despacio (evita jitter al reposar pegados). */
const PLAYER_SHIP_COLLISION_SLOP_PS = -10;

/** Distancia objetivo entre plataformas consecutivas hacia arriba. */
const VERT_GAP = 96;
/** Pequeña variación simétrica para que no se vea una cuadrícula rígida. */
const VERT_GAP_JITTER = 10;
/**
 * Nueva plataforma dentro de ±PLATFORM_SPAWN_MAX_DX respecto de referencia
 * (esquivable moviendo vos izq/der).
 */
const PLATFORM_SPAWN_MAX_DX_FROM_REF = 172;
/** Trazo destructivo (cuadraditos tipo paint / TRON). */
const TRAIL_SEG_SIZE = 12;
/** Cuadrados por metro de recorrido: más alto ⇒ menos teselas por carga. */
const TRAIL_SAMPLE_DIST = 32;
/** Uso rápido de la barra mientras mantienen pintar (~1/leak = duración efectiva máx.). */
const TRAIL_ENERGY_DRAIN_PER_S = 2.45;
const TRAIL_ENERGY_RECHARGE_PER_S = 0.055;
/** Costo extra cada vez que deposita un segmento además del drenado por segundo. */
const TRAIL_ENERGY_PER_SEGMENT = 0.016;
/** Umbral por debajo del cual ya no puede colocar el siguiente cuadro de trazo. */
const TRAIL_ENERGY_DRAW_FLOOR = 0.068;
const TRAIL_PICKUP_BONUS = 0.38;
/** Límite global de teselas vivas para no tapar todo el nivel. */
const TRAIL_MAX_SEGMENTS = 160;
const PICKUP_RADIUS = 11;
const PICKUP_SPAWN_EVERY_TICKS = 95;
const MATCH_SCORE_PER_SECOND = 11;
const SCORE_FOR_TRAIL_PICKUP = 55;

const FIRST_MUSIC = MUSIC_PRESETS[0]!;

const TICK_HZ = 25;
export const TICK_MS = 1000 / TICK_HZ;
/** Cuánto conservar el mismo personaje tras cerrar/recargar (misma memoria sin base de datos). */
const RECONNECT_WINDOW_MS = 15 * 60 * 1000;

type Platform = PublicPlatform;

type PhysPlayer = PublicPlayer & {
  socketIds: Set<string>;
  input: ClientInput;
  grounded: boolean;
  coyote: number;
  /** Ticks de invulnerabilidad tras respawn / impacto (obstáculos). */
  invulnTicks: number;
  /** Marca momento en que se fueron todas las pestañas; null si hay (o hubo recién) sesión activa. */
  disconnectedAt: number | null;
  /** Último punto donde se depositó un segmento de trazo (null = empezar tanda nueva). */
  trailLastX: number | null;
  trailLastY: number | null;
};

type TrailSeg = PublicTrailSegment;

/** Máximo 5 conexiones Socket.IO a la vez = 5 jugadores interactuando simultáneamente. */
function countConnectedPlayers(players: Map<string, PhysPlayer>) {
  return [...players.values()].filter((p) => p.socketIds.size > 0).length;
}

function rndRange(a: number, b: number) {
  return a + Math.random() * (b - a);
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function circleRectOverlap(
  cx: number,
  cy: number,
  r: number,
  px: number,
  py: number,
  hw: number,
  hh: number,
) {
  const nx = clamp(cx, px - hw, px + hw);
  const ny = clamp(cy, py - hh, py + hh);
  const dx = cx - nx;
  const dy = cy - ny;
  return dx * dx + dy * dy < r * r;
}

/** Colisión círculo‑rect: hitbox de la nave algo más generosa que el radio visual. */
function shipHitsObstacle(p: PhysPlayer, platforms: Platform[]): boolean {
  if (p.invulnTicks > 0) return false;
  const r = PLAYER_R - 2;
  for (const plat of platforms) {
    const hw = plat.w / 2;
    const hh = plat.h / 2;
    if (circleRectOverlap(p.x, p.y, r, plat.x, plat.y, hw, hh)) return true;
  }
  return false;
}

/** Colisión con trazos de otros jugadores (los propios nunca dañan). */
function shipHitsTrailSegments(p: PhysPlayer, segs: TrailSeg[]): boolean {
  if (p.invulnTicks > 0) return false;
  const r = PLAYER_R - 2;
  for (const seg of segs) {
    if (seg.ownerId === p.id) continue;
    const hw = seg.w / 2;
    const hh = seg.h / 2;
    if (circleRectOverlap(p.x, p.y, r, seg.x, seg.y, hw, hh)) return true;
  }
  return false;
}

function circleCircleHit(
  ax: number,
  ay: number,
  ar: number,
  bx: number,
  by: number,
  br: number,
) {
  const dx = ax - bx;
  const dy = ay - by;
  const rr = ar + br;
  return dx * dx + dy * dy < rr * rr;
}

/** Impulso elástico 1D igual que dos bolas del mismo tamaño masas iguales. */
function applyShipElasticImpulse(a: PhysPlayer, b: PhysPlayer, nx: number, ny: number) {
  const rvx = b.vx - a.vx;
  const rvy = b.vy - a.vy;
  const vnRel = rvx * nx + rvy * ny;
  if (vnRel >= PLAYER_SHIP_COLLISION_SLOP_PS) return;

  const j = -(1 + PLAYER_SHIP_RESTITUTION) * vnRel / 2;
  a.vx -= j * nx;
  a.vy -= j * ny;
  b.vx += j * nx;
  b.vy += j * ny;
}

/** Colisión nave–nave: separar penetración + rebote tipo pelota en la normal común (sin daño). */
function separatePlayers(players: PhysPlayer[]) {
  const minD = PLAYER_R * 2;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        const a = players[i];
        const b = players[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 0.001;
        if (dist >= minD) continue;

        const nx = dx / dist;
        const ny = dy / dist;
        const penetration = minD - dist;
        /** Primera pasada corrige más; segunda estabiliza cadenas de 3+. */
        const split = penetration / ((pass === 0 ? 1 : 1.6) * 2);
        a.x -= nx * split;
        a.y -= ny * split;
        b.x += nx * split;
        b.y += ny * split;

        applyShipElasticImpulse(a, b, nx, ny);
      }
    }
  }
}

/** Plataforma visualmente más baja (mayor `y` de su borde superior). */
function lowestPlatform(platforms: Platform[]): Platform | null {
  if (platforms.length === 0) return null;
  let best = platforms[0];
  let bestTop = best.y - best.h / 2;
  for (const pl of platforms) {
    const top = pl.y - pl.h / 2;
    if (top > bestTop) {
      bestTop = top;
      best = pl;
    }
  }
  return best;
}

/** Plataforma cuyo centro vertical está más cerca de `targetY` (p. ej. mitad del mundo). */
function nearestPlatformNearY(platforms: Platform[], targetY: number): Platform | null {
  if (platforms.length === 0) return null;
  let best = platforms[0];
  let bestD = Math.abs(best.y - targetY);
  for (const pl of platforms) {
    const d = Math.abs(pl.y - targetY);
    if (d < bestD) {
      bestD = d;
      best = pl;
    }
  }
  return best;
}

/** Fila guardada en Supabase (sin sockets ni input en vivo). */
export type PersistedPlayerBlob = Pick<
  PublicPlayer,
  | "id"
  | "nickname"
  | "avatarUrl"
  | "x"
  | "y"
  | "vx"
  | "vy"
  | "lives"
  | "shieldCharges"
  | "eliminated"
> & {
  disconnectedAt: number | null;
  /** Opcional por filas viejas sin el campo. */
  trailEnergy?: number;
  score?: number;
};

export class GameRoom {
  readonly players = new Map<string, PhysPlayer>();

  platforms: Platform[] = [];
  /** Trazos destructivos (autoritativos; mismas reglas de scroll que plataformas). */
  trailSegments: TrailSeg[] = [];
  trailPickups: TrailEnergyPickup[] = [];
  /** PX/s del scroll mundial (`BALL_WORLD_SCROLL_PS`; 0 = asteroides quietos, nave fija al soltar ↑/↓). */
  private readonly worldScrollPs = parseWorldScrollPsFromEnv();
  private pickupSpawnCooldown = PICKUP_SPAWN_EVERY_TICKS;
  /** Integral del scroll (vacío / techo / encuadre cliente). Con scroll 0 no crece. */
  private worldScrollAccum = 0;

  tick = 0;

  musicPhase: MatchPhase = "running";
  /** `Date.now()` cuando termina la ronda musical (servidor autoritativo). */
  musicMatchEndsAtMs = Date.now() + FIRST_MUSIC.durationMs;
  musicWinnerIds: string[] = [];

  /** Ruta pública que el cliente usa como `src` (estático `/music/...` en Next). */
  musicPublicPath = FIRST_MUSIC.publicPath;
  musicTrackTitle = FIRST_MUSIC.title;
  musicTrackDurationMs = FIRST_MUSIC.durationMs;

  timer: ReturnType<typeof setInterval> | null = null;

  constructor(public readonly slug: string) {
    this.resetWorld();
  }

  snapshot(): GameSnapshot {
    const playersArr = [...this.players.values()].map(
      ({
        socketIds: sids,
        input: _i,
        grounded: _g,
        coyote: _c,
        disconnectedAt: _d,
        ...rest
      }) => ({
        ...rest,
        connected: sids.size > 0,
      }),
    );

    const platformsSorted = [...this.platforms];

    return {
      worldW: WORLD_W,
      worldH: WORLD_H,
      worldScrollPs: this.worldScrollPs,
      worldScrollAccum: this.worldScrollAccum,
      tick: this.tick,
      players: playersArr,
      platforms: platformsSorted,
      trailSegments: [...this.trailSegments],
      trailPickups: [...this.trailPickups],
      musicMatchEndsAtUnixMs: this.musicMatchEndsAtMs,
      musicPhase: this.musicPhase,
      musicWinnerPlayerIds: [...this.musicWinnerIds],
      musicTrackDurationMs: this.musicTrackDurationMs,
      musicPublicPath: this.musicPublicPath,
      musicTrackTitle: this.musicTrackTitle,
    };
  }

  /** Inicia cuenta regresiva y puntajes de la canción (todos empiezan en 0). */
  beginMusicRound(): void {
    this.musicPhase = "running";
    this.musicWinnerIds = [];
    this.musicMatchEndsAtMs = Date.now() + this.musicTrackDurationMs;
    for (const p of this.players.values()) {
      p.score = 0;
    }
  }

  private finishMusicRound(): void {
    if (this.musicPhase !== "running") return;
    this.musicPhase = "finished";

    let max = -Infinity;
    for (const p of this.players.values()) {
      if (!Number.isFinite(p.score)) continue;
      max = Math.max(max, p.score);
    }

    const eps = 1e-4;
    if (!Number.isFinite(max) || this.players.size === 0) {
      this.musicWinnerIds = [];
      return;
    }

    this.musicWinnerIds = [...this.players.values()]
      .filter((p) => Number.isFinite(p.score) && p.score >= max - eps)
      .map((p) => p.id);
  }

  /** Nueva partida: mundo limpio, vidas/restock, nueva canción. */
  resetMusicRound(): void {
    this.musicPhase = "running";
    this.musicWinnerIds = [];
    this.tick = 0;
    this.platforms = [];
    this.trailSegments = [];
    this.trailPickups = [];
    this.pickupSpawnCooldown = PICKUP_SPAWN_EVERY_TICKS;
    this.worldScrollAccum = 0;
    this.spawnInitialPlatforms();
    for (const p of this.players.values()) {
      p.lives = 3;
      p.shieldCharges = 0;
      p.eliminated = false;
      p.score = 0;
      p.trailEnergy = 1;
      p.vx = 0;
      p.vy = 0;
      p.input = { left: false, right: false, jump: false, down: false, trail: false };
      p.trailLastX = null;
      p.trailLastY = null;
      p.invulnTicks = Math.ceil(3.2 * TICK_HZ);
      this.respawnPlayer(p, { onMidPlatform: true });
    }
    this.beginMusicRound();
    this.broadcastStateNow();
  }

  /**
   * Cambia archivo/título/duración que el cliente reproducirá (estático en `/public/music` del front).
   * No reinicia la ronda: usá `resetMusicRound` desde el panel para alinear duración y temporizador.
   */
  setMusicFromAdmin(opts: {
    presetId?: string;
    publicPath?: string;
    title?: string;
    durationMs?: number;
  }): { ok: true } | { ok: false; error: string } {
    let publicPath = "";
    let title = "";
    let durationMs = 0;

    const pid = typeof opts.presetId === "string" ? opts.presetId.trim() : "";
    if (pid) {
      const pre = MUSIC_PRESETS.find((m) => m.id === pid);
      if (!pre) return { ok: false, error: "presetId no reconocido." };
      publicPath = pre.publicPath;
      title = pre.title;
      durationMs = pre.durationMs;
    } else {
      publicPath = String(opts.publicPath ?? "").trim();
      title = String(opts.title ?? "").trim().slice(0, 200);
      durationMs = Math.round(Number(opts.durationMs));
      if (
        !publicPath.startsWith("/music/") ||
        publicPath.includes("..") ||
        !/^\/music\/[\w\-./]+\.[a-zA-Z0-9]+$/i.test(publicPath)
      ) {
        return {
          ok: false,
          error: "publicPath debe ser como /music/tema.mp3 (letras, números, -, _ y subcarpetas).",
        };
      }
      if (!Number.isFinite(durationMs) || durationMs < 20_000 || durationMs > 30 * 60_000) {
        return { ok: false, error: "durationMs debe estar entre 20000 y 1800000 (20s–30min)." };
      }
      if (!title) title = publicPath.split("/").pop() ?? publicPath;
    }

    this.musicPublicPath = publicPath;
    this.musicTrackTitle = title;
    this.musicTrackDurationMs = durationMs;
    this.broadcastStateNow();
    scheduleRoomPersist(this);
    return { ok: true };
  }

  resetWorld() {
    this.tick = 0;
    this.worldScrollAccum = 0;
    this.platforms = [];
    this.trailSegments = [];
    this.trailPickups = [];
    this.pickupSpawnCooldown = PICKUP_SPAWN_EVERY_TICKS;
    this.spawnInitialPlatforms();
    for (const p of this.players.values()) this.respawnPlayer(p);
  }

  detachSocket(playerId: string, socketId: string) {
    const p = this.players.get(playerId);
    if (!p) return;
    p.socketIds.delete(socketId);
  }

  tryJoin(socketId: string, nicknameRaw: string, avatarUrlRaw: string | null) {
    const nicknameTrim = nicknameRaw.trim().slice(0, 24) || `jugador_${this.players.size}`;
    const nickLower = nicknameTrim.toLowerCase();

    const resume = [...this.players.values()].find(
      (p) =>
        p.nickname.toLowerCase() === nickLower &&
        p.socketIds.size === 0 &&
        p.disconnectedAt != null &&
        Date.now() - p.disconnectedAt < RECONNECT_WINDOW_MS,
    );
    if (resume) {
      resume.socketIds.add(socketId);
      resume.disconnectedAt = null;
      if (typeof resume.trailEnergy !== "number" || !Number.isFinite(resume.trailEnergy)) {
        resume.trailEnergy = 1;
      }
      resume.trailEnergy = clamp(resume.trailEnergy, 0, 1);
      if (typeof resume.score !== "number" || !Number.isFinite(resume.score)) {
        resume.score = 0;
      }
      resume.trailLastX ??= null;
      resume.trailLastY ??= null;
      resume.input = {
        left: resume.input.left,
        right: resume.input.right,
        jump: resume.input.jump,
        down: resume.input.down,
        trail: Boolean(resume.input.trail),
      };
      persistRoomNow(this);
      return { ok: true as const, playerId: resume.id };
    }

    const nameTakenOnline = [...this.players.values()].some(
      (p) => p.nickname.toLowerCase() === nickLower && p.socketIds.size > 0,
    );
    if (nameTakenOnline) {
      return {
        ok: false as const,
        reason: "Ese nombre ya está en uso con otra pestaña abierta.",
      };
    }

    if (countConnectedPlayers(this.players) >= MAX_PLAYERS) {
      return {
        ok: false as const,
        reason: "Ya hay 5 jugadores con la partida abierta. Que alguien salga o esperá.",
      };
    }

    const avatarUrl = avatarUrlRaw && /^https:\/\/.+/i.test(avatarUrlRaw) ? avatarUrlRaw.slice(0, 512) : null;

    const id = nanoid(10);

    const p: PhysPlayer = {
      id,
      nickname: nicknameTrim,
      avatarUrl,
      x: WORLD_W / 2 + rndRange(-36, 36),
      y: WORLD_H / 2,
      vx: 0,
      vy: 0,
      lives: 3,
      shieldCharges: 0,
      trailEnergy: 1,
      score: 0,
      eliminated: false,
      socketIds: new Set([socketId]),
      input: { left: false, right: false, jump: false, down: false, trail: false },
      grounded: false,
      coyote: 0,
      invulnTicks: 0,
      disconnectedAt: null,
      trailLastX: null,
      trailLastY: null,
    };

    this.players.set(id, p);
    this.respawnPlayer(p, { onMidPlatform: true });
    persistRoomNow(this);
    return { ok: true as const, playerId: id };
  }

  leavePlayer(playerId: string) {
    this.players.delete(playerId);
  }

  /**
   * Saca al jugador por id (vivo o eliminado): quita personaje y sus trazos.
   * El endpoint HTTP debe desconectar los `socketIds` devueltos.
   */
  kickPlayerById(playerIdRaw: string):
    | { ok: true; kickedNick: string; socketIds: string[] }
    | { ok: false; error: string } {
    const playerId = playerIdRaw.trim();
    if (!playerId) return { ok: false, error: "Falta id de jugador." };
    const p = this.players.get(playerId);
    if (!p) return { ok: false, error: "No hay jugador con ese id." };
    const socketIds = [...p.socketIds];
    const kickedNick = p.nickname;
    this.players.delete(playerId);
    this.trailSegments = this.trailSegments.filter((s) => s.ownerId !== playerId);
    this.broadcastFn?.(this.snapshot());
    persistRoomNow(this);
    return { ok: true, kickedNick, socketIds };
  }

  setInput(playerId: string, input: ClientInput) {
    const p = this.players.get(playerId);
    if (!p || p.eliminated) return;
    if (this.musicPhase !== "running") return;
    p.input = { ...input };
  }

  giveExtraLifeByNickname(nickname: string) {
    const apply = (p: PhysPlayer) => {
      if (p.eliminated) {
        p.lives += 1;
        this.respawnPlayer(p, { onMidPlatform: true });
      } else {
        p.lives += 1;
      }
      return { ok: true as const, player: p.nickname };
    };

    const key = nickname.trim().toLowerCase();
    const matches = [...this.players.values()].filter((p) => p.nickname.toLowerCase() === key);
    if (matches.length === 1) {
      const r = apply(matches[0]);
      this.broadcastStateNow();
      persistRoomNow(this);
      return r;
    }
    const partial = [...this.players.values()].filter((p) => p.nickname.toLowerCase().includes(key));
    if (partial.length === 1) {
      const r = apply(partial[0]);
      this.broadcastStateNow();
      persistRoomNow(this);
      return r;
    }
    return { ok: false as const, error: "No se encontró un único jugador con ese nombre." };
  }

  grantShieldByNickname(nickname: string) {
    const key = nickname.trim().toLowerCase();
    const matches = [...this.players.values()].filter((p) => p.nickname.toLowerCase() === key);
    if (matches.length === 1) {
      matches[0].shieldCharges += 1;
      this.broadcastStateNow();
      persistRoomNow(this);
      return { ok: true as const, player: matches[0].nickname };
    }
    const partial = [...this.players.values()].filter((p) => p.nickname.toLowerCase().includes(key));
    if (partial.length === 1) {
      partial[0].shieldCharges += 1;
      this.broadcastStateNow();
      persistRoomNow(this);
      return { ok: true as const, player: partial[0].nickname };
    }
    return { ok: false as const, error: "No se encontró un único jugador con ese nombre." };
  }

  listAdminPlayers() {
    return [...this.players.values()].map((p) => ({
      id: p.id,
      nickname: p.nickname,
      lives: p.lives,
      shields: p.shieldCharges,
      eliminated: p.eliminated,
      connected: p.socketIds.size > 0,
    }));
  }

  broadcastFn: ((snap: GameSnapshot) => void) | null = null;

  /** Estado al instante (p. ej. tras donación desde el panel sin esperar al siguiente tick). */
  broadcastStateNow() {
    this.broadcastFn?.(this.snapshot());
    scheduleRoomPersist(this);
  }

  getPersistenceBlobs(): {
    players: PersistedPlayerBlob[];
    platforms: PublicPlatform[];
    trailSegments: TrailSeg[];
    trailPickups: TrailEnergyPickup[];
    worldScrollAccum: number;
  } {
    const players: PersistedPlayerBlob[] = [...this.players.values()].map((p) => ({
      id: p.id,
      nickname: p.nickname,
      avatarUrl: p.avatarUrl,
      x: p.x,
      y: p.y,
      vx: p.vx,
      vy: p.vy,
      lives: p.lives,
      shieldCharges: p.shieldCharges,
      eliminated: p.eliminated,
      disconnectedAt: p.disconnectedAt,
      trailEnergy: p.trailEnergy,
      score: p.score,
    }));
    return {
      players,
      platforms: this.platforms.map((pl) => ({ ...pl })),
      trailSegments: this.trailSegments.map((t) => ({ ...t })),
      trailPickups: this.trailPickups.map((t) => ({ ...t })),
      worldScrollAccum: this.worldScrollAccum,
    };
  }

  /** Restaura memoria tras reinicio del proceso (payload desde Supabase). */
  applyPersistenceBlobs(
    rawPlayers: PersistedPlayerBlob[],
    rawPlatforms: PublicPlatform[],
    rawTrailSegments?: unknown,
    rawTrailPickups?: unknown,
    persistedScrollAccum?: number,
  ): void {
    this.players.clear();

    for (const row of rawPlayers) {
      if (!row?.id || typeof row.nickname !== "string") continue;
      const teRaw = Number((row as PersistedPlayerBlob).trailEnergy);
      const trailEnergy =
        typeof (row as PersistedPlayerBlob).trailEnergy === "number" && Number.isFinite(teRaw)
          ? clamp(teRaw, 0, 1)
          : 1;
      const scoreRaw = Number((row as PersistedPlayerBlob).score);
      const scoreInit =
        typeof (row as PersistedPlayerBlob).score === "number" && Number.isFinite(scoreRaw)
          ? scoreRaw
          : 0;
      const p: PhysPlayer = {
        id: String(row.id),
        nickname: String(row.nickname).slice(0, 24),
        avatarUrl: row.avatarUrl && typeof row.avatarUrl === "string" ? row.avatarUrl : null,
        x: Number(row.x),
        y: Number(row.y),
        vx: Number(row.vx),
        vy: Number(row.vy),
        lives: Math.max(0, Math.floor(Number(row.lives))),
        shieldCharges: Math.max(0, Math.floor(Number(row.shieldCharges))),
        trailEnergy,
        score: scoreInit,
        eliminated: Boolean(row.eliminated),
        socketIds: new Set<string>(),
        input: { left: false, right: false, jump: false, down: false, trail: false },
        grounded: false,
        coyote: 0,
        invulnTicks: 55,
        disconnectedAt: typeof row.disconnectedAt === "number" ? row.disconnectedAt : Date.now(),
        trailLastX: null,
        trailLastY: null,
      };
      if (!Number.isFinite(p.x)) p.x = WORLD_W / 2;
      if (!Number.isFinite(p.y)) p.y = WORLD_H / 2;
      this.players.set(p.id, p);
    }

    const plats = rawPlatforms.filter(
      (pl): pl is PublicPlatform =>
        Boolean(pl) &&
        typeof pl.id === "string" &&
        Number.isFinite(pl.x) &&
        Number.isFinite(pl.y) &&
        Number.isFinite(pl.w) &&
        Number.isFinite(pl.h),
    );
    if (plats.length > 0) {
      this.platforms = plats.map((pl) => ({ ...pl }));
    } else {
      this.platforms = [];
      this.spawnInitialPlatforms();
    }

    const parseTrails = (raw: unknown): TrailSeg[] => {
      if (!Array.isArray(raw)) return [];
      const out: TrailSeg[] = [];
      for (const s of raw) {
        if (!s || typeof s !== "object") continue;
        const o = s as Record<string, unknown>;
        if (
          typeof o.id === "string" &&
          typeof o.ownerId === "string" &&
          Number.isFinite(o.x) &&
          Number.isFinite(o.y) &&
          Number.isFinite(o.w) &&
          Number.isFinite(o.h) &&
          Number.isFinite(o.spawnTick)
        ) {
          out.push({
            id: o.id,
            x: Number(o.x),
            y: Number(o.y),
            w: Number(o.w),
            h: Number(o.h),
            ownerId: o.ownerId,
            spawnTick: Number(o.spawnTick),
          });
        }
      }
      return out;
    };
    const parsePickups = (raw: unknown): TrailEnergyPickup[] => {
      if (!Array.isArray(raw)) return [];
      const out: TrailEnergyPickup[] = [];
      for (const s of raw) {
        if (!s || typeof s !== "object") continue;
        const o = s as Record<string, unknown>;
        if (typeof o.id === "string" && Number.isFinite(o.x) && Number.isFinite(o.y)) {
          out.push({ id: o.id, x: Number(o.x), y: Number(o.y) });
        }
      }
      return out;
    };
    this.trailSegments = parseTrails(rawTrailSegments);
    this.trailPickups = parsePickups(rawTrailPickups);
    if (this.trailSegments.length > TRAIL_MAX_SEGMENTS) {
      this.trailSegments = this.trailSegments.slice(-TRAIL_MAX_SEGMENTS);
    }
    const accum =
      typeof persistedScrollAccum === "number" && Number.isFinite(persistedScrollAccum)
        ? persistedScrollAccum
        : 0;

    /** Modo sin cinta pero BD con scroll alto: el cliente dibuja y-accum; si accum es viejo y scroll=0, todo queda corrido hasta restar ese offset de las coords. */
    if (this.worldScrollPs === 0 && accum !== 0) {
      for (const p of this.players.values()) {
        if (Number.isFinite(p.y)) p.y -= accum;
      }
      for (const pl of this.platforms) {
        if (Number.isFinite(pl.y)) pl.y -= accum;
      }
      for (const s of this.trailSegments) {
        if (Number.isFinite(s.y)) s.y -= accum;
      }
      for (const pk of this.trailPickups) {
        if (Number.isFinite(pk.y)) pk.y -= accum;
      }
      console.info(
        `[persist] BALL_WORLD_SCROLL_PS=0 y accum guardado ${Math.round(accum)} → normalizado Y y accum=0`,
      );
      this.worldScrollAccum = 0;
    } else {
      this.worldScrollAccum = accum;
    }
  }

  /** Devuelve px/s del scroll mundial (0 = campo quieto). Útil para /health y depuración. */
  getWorldScrollPs(): number {
    return this.worldScrollPs;
  }

  getWorldScrollAccum(): number {
    return this.worldScrollAccum;
  }

  /** Elimina fantasmas que llevan demasiado desconectados (sin BD). */
  private pruneStaleDisconnected(now: number) {
    for (const [id, p] of [...this.players]) {
      if (
        p.socketIds.size === 0 &&
        p.disconnectedAt != null &&
        now - p.disconnectedAt >= RECONNECT_WINDOW_MS
      ) {
        this.players.delete(id);
      }
    }
  }

  startLoop() {
    if (this.timer) return;
    this.timer = setInterval(() => this.step(), TICK_MS);
  }

  stopLoop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Obstáculos iniciales y generación continua (no son suelo; chocar = daño). */
  private spawnInitialPlatforms() {
    let yCursor = WORLD_H - 140;
    let prevCenterX: number | null = null;
    while (yCursor > 60) {
      this.pushPlatformAround(yCursor, prevCenterX);
      const last = this.platforms[this.platforms.length - 1];
      if (last) prevCenterX = last.x;
      yCursor -= VERT_GAP + rndRange(-VERT_GAP_JITTER, VERT_GAP_JITTER);
    }
  }

  /** Si `preferNearX` es el centro‑X de otra hilera, esta queda dentro de alcance horizontal. */
  private pushPlatformAround(centerY: number, preferNearX?: number | null) {
    const s = rndRange(OBSTACLE_SIDE_MIN, OBSTACLE_SIDE_MAX);
    const margin = s / 2 + 14;

    let x: number;
    if (preferNearX != null && Number.isFinite(preferNearX)) {
      let lo = preferNearX - PLATFORM_SPAWN_MAX_DX_FROM_REF;
      let hi = preferNearX + PLATFORM_SPAWN_MAX_DX_FROM_REF;
      lo = clamp(lo, margin, WORLD_W - margin);
      hi = clamp(hi, margin, WORLD_W - margin);
      if (hi <= lo) x = clamp(preferNearX, margin, WORLD_W - margin);
      else x = rndRange(lo, hi);
    } else {
      x = rndRange(margin, WORLD_W - margin);
    }

    this.platforms.push({ id: nanoid(8), x, y: centerY, w: s, h: s });
  }

  private pushTrailSegment(ownerId: string, cx: number, cy: number) {
    const s = TRAIL_SEG_SIZE;
    this.trailSegments.push({
      id: nanoid(8),
      x: cx,
      y: cy,
      w: s,
      h: s,
      ownerId,
      spawnTick: this.tick,
    });
    if (this.trailSegments.length > TRAIL_MAX_SEGMENTS) {
      this.trailSegments.splice(0, this.trailSegments.length - TRAIL_MAX_SEGMENTS);
    }
  }

  private respawnPlayer(p: PhysPlayer, opts?: { onMidPlatform?: boolean }) {
    const midY = WORLD_H / 2;
    let plat: Platform | null = null;
    if (opts?.onMidPlatform) {
      plat = nearestPlatformNearY(this.platforms, midY);
    }
    if (!plat) {
      plat = lowestPlatform(this.platforms);
    }
    if (plat) {
      p.x = clamp(plat.x + rndRange(-18, 18), PLAYER_R + 8, WORLD_W - PLAYER_R - 8);
      const top = plat.y - plat.h / 2;
      /** Por encima del destructor para no chocarlo al mismo frame del respawn. */
      p.y = top - PLAYER_R - 56;
    } else {
      p.x = WORLD_W / 2;
      p.y = WORLD_H * 0.38;
    }
    p.vx = 0;
    p.vy = 0;
    p.grounded = false;
    p.coyote = 0;
    p.eliminated = false;
    p.invulnTicks = Math.ceil(3.2 * TICK_HZ);
    p.trailLastX = null;
    p.trailLastY = null;
  }

  /** Caída al vacío o choque con bloque destructivo. */
  private loseLifeFromHazard(p: PhysPlayer, source: "pit" | "obstacle") {
    if (this.musicPhase !== "running") return;
    if (p.eliminated) return;
    /** Caídas y obstáculos respetan el mismo grace period tras respawn. */
    if (p.invulnTicks > 0) return;

    const midSpawn = source === "obstacle";

    if (p.shieldCharges > 0) {
      p.shieldCharges -= 1;
      this.respawnPlayer(p, { onMidPlatform: midSpawn });
      return;
    }

    p.lives -= 1;
    if (p.lives <= 0) {
      p.lives = 0;
      p.eliminated = true;
      p.grounded = false;
      p.vx = 0;
      p.vy = 0;
      p.input = { left: false, right: false, jump: false, down: false, trail: false };
      p.y = WORLD_H + 120;
      return;
    }
    this.respawnPlayer(p, { onMidPlatform: midSpawn });
  }

  private failFall(p: PhysPlayer) {
    this.loseLifeFromHazard(p, "pit");
  }

  private step() {
    const dt = TICK_MS / 1000;
    const now = Date.now();
    this.pruneStaleDisconnected(now);

    if (this.musicPhase === "running" && now >= this.musicMatchEndsAtMs) {
      this.finishMusicRound();
    }

    if (this.musicPhase === "finished") {
      this.broadcastFn?.(this.snapshot());
      scheduleRoomPersist(this);
      return;
    }

    this.tick += 1;

    for (const plat of this.platforms) {
      plat.y += this.worldScrollPs * dt;
    }
    this.worldScrollAccum += this.worldScrollPs * dt;

    this.platforms = this.platforms.filter((pl) => pl.y - pl.h / 2 < WORLD_H + 120);

    for (const seg of this.trailSegments) {
      seg.y += this.worldScrollPs * dt;
    }
    this.trailSegments = this.trailSegments.filter((s) => s.y - s.h / 2 < WORLD_H + 120);

    for (const pk of this.trailPickups) {
      pk.y += this.worldScrollPs * dt;
    }
    this.trailPickups = this.trailPickups.filter((pk) => pk.y - PICKUP_RADIUS < WORLD_H + 100);

    this.pickupSpawnCooldown -= 1;
    if (this.pickupSpawnCooldown <= 0) {
      this.pickupSpawnCooldown = PICKUP_SPAWN_EVERY_TICKS;
      if (this.trailPickups.length < 4 && Math.random() < 0.5) {
        const ySpawn =
          this.worldScrollPs > 0 ? -PICKUP_RADIUS - 6 : rndRange(120, WORLD_H - 130);
        this.trailPickups.push({
          id: nanoid(8),
          x: rndRange(PICKUP_RADIUS + 10, WORLD_W - PICKUP_RADIUS - 10),
          y: ySpawn,
        });
      }
    }

    if (this.platforms.length === 0) {
      this.pushPlatformAround(WORLD_H - 140);
    } else {
      const minTop = Math.min(...this.platforms.map((pl) => pl.y - pl.h / 2));
      if (minTop > 56 || this.platforms.length < 9) {
        const eps = 2;
        const refPlats = this.platforms.filter((pl) => Math.abs(pl.y - pl.h / 2 - minTop) <= eps);
        const refX =
          refPlats.length === 0
            ? WORLD_W / 2
            : refPlats[Math.floor(rndRange(0, refPlats.length))]!.x;
        this.pushPlatformAround(
          minTop - VERT_GAP + rndRange(-VERT_GAP_JITTER, VERT_GAP_JITTER),
          refX,
        );
      }
    }

    const physList = [...this.players.values()];
    const activeList = physList.filter((p) => !p.eliminated && p.socketIds.size > 0);

    for (const p of activeList) {
      if (p.invulnTicks > 0) p.invulnTicks -= 1;

      p.score += MATCH_SCORE_PER_SECOND * dt;

      const lateralInput =
        (p.input.left ? -1 : 0) + (p.input.right ? 1 : 0);
      if (lateralInput < 0) p.vx -= SHIP_SIDE_ACCEL * dt;
      if (lateralInput > 0) p.vx += SHIP_SIDE_ACCEL * dt;
      if (lateralInput === 0) p.vx *= Math.exp(-SHIP_VX_DRAG * dt);
      p.vx = clamp(p.vx, -SHIP_VX_MAX, SHIP_VX_MAX);

      if (!p.input.jump && !p.input.down) {
        /** ↑/↓ relativo al flujo que baja: sin tecla, no acumulás vy (pero el mundo sigue en cinta). */
        p.vy = 0;
      } else {
        if (p.input.jump) p.vy -= SHIP_THRUST_UP * dt;
        if (p.input.down) p.vy += SHIP_THRUST_DOWN * dt;
      }
      p.vy = clamp(p.vy, SHIP_VY_CAP_UP, SHIP_VY_CAP_DN);

      p.x += p.vx * dt;
      p.y += p.vy * dt;

      const xmin = PLAYER_R + 4;
      const xmax = WORLD_W - PLAYER_R - 4;
      if (p.x < xmin) {
        p.x = xmin;
        if (p.vx < 0) p.vx *= -WALL_BOUNCE_RETAIN;
      } else if (p.x > xmax) {
        p.x = xmax;
        if (p.vx > 0) p.vx *= -WALL_BOUNCE_RETAIN;
      }

      const ceilingAbs = WORLD_CEILING_MARGIN;
      if (p.y < ceilingAbs) {
        p.y = ceilingAbs;
        if (p.vy < 0) p.vy *= -WALL_BOUNCE_RETAIN * 0.94;
      }
    }

    separatePlayers(activeList);

    for (const p of activeList) {
      for (let i = this.trailPickups.length - 1; i >= 0; i--) {
        const pk = this.trailPickups[i]!;
        if (circleCircleHit(p.x, p.y, PLAYER_R, pk.x, pk.y, PICKUP_RADIUS + 5)) {
          p.trailEnergy = clamp(p.trailEnergy + TRAIL_PICKUP_BONUS, 0, 1);
          p.score += SCORE_FOR_TRAIL_PICKUP;
          this.trailPickups.splice(i, 1);
        }
      }

      if (!p.input.trail) {
        p.trailLastX = null;
        p.trailLastY = null;
        p.trailEnergy = Math.min(1, p.trailEnergy + TRAIL_ENERGY_RECHARGE_PER_S * dt);
      } else if (p.trailEnergy > 0) {
        p.trailEnergy = Math.max(0, p.trailEnergy - TRAIL_ENERGY_DRAIN_PER_S * dt);
        if (p.trailEnergy > TRAIL_ENERGY_DRAW_FLOOR) {
          const lx = p.trailLastX;
          const ly = p.trailLastY;
          if (
            lx == null ||
            ly == null ||
            Math.hypot(p.x - lx, p.y - ly) >= TRAIL_SAMPLE_DIST
          ) {
            const nextEnergy = p.trailEnergy - TRAIL_ENERGY_PER_SEGMENT;
            if (nextEnergy >= TRAIL_ENERGY_DRAW_FLOOR) {
              p.trailEnergy = nextEnergy;
              this.pushTrailSegment(p.id, p.x, p.y);
              p.trailLastX = p.x;
              p.trailLastY = p.y;
            }
          }
        }
      }
    }

    for (const p of activeList) {
      if (shipHitsObstacle(p, this.platforms)) {
        this.loseLifeFromHazard(p, "obstacle");
      } else if (shipHitsTrailSegments(p, this.trailSegments)) {
        this.loseLifeFromHazard(p, "obstacle");
      }
    }

    for (const p of activeList) {
      if (this.players.has(p.id) && p.y - PLAYER_R > WORLD_H + 40) {
        this.failFall(p);
      }
    }

    this.broadcastFn?.(this.snapshot());
    scheduleRoomPersist(this);
  }
}

export { MAX_PLAYERS, WORLD_H, WORLD_W };
