export type PublicPlayer = {
  id: string;
  nickname: string;
  avatarUrl: string | null;
  x: number;
  y: number;
  vx: number;
  vy: number;
  lives: number;
  shieldCharges: number;
  /**
   * Energía del trazo destructivo estilo TRON (0–1). Se gasta al dibujar; recarga sola o con ítems.
   */
  trailEnergy: number;
  /** Puntos en la canción actual (mientras seguís en juego ganás más). */
  score: number;
  /** Frames de invulnerabilidad restantes tras respawn (parpadeo en cliente). */
  invulnTicks?: number;
  /** Sin vidas: sigue conectado pero no juega hasta que el streamer dé vida o cierre. */
  eliminated: boolean;
  /** En snapshots de red: si sigue con una pestaña abierta. */
  connected?: boolean;
};

export type PublicPlatform = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

/** Trozo de “pared” de trazo: misma colisión que plataformas; dueño tiene gracia anti-autokill. */
export type PublicTrailSegment = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  ownerId: string;
  spawnTick: number;
};

/** Ítem que restaura energía de trazo al recogerlo. */
export type TrailEnergyPickup = {
  id: string;
  x: number;
  y: number;
};

export type MatchPhase = "running" | "finished";

export type GameSnapshot = {
  worldW: number;
  worldH: number;
  tick: number;
  players: PublicPlayer[];
  platforms: PublicPlatform[];
  trailSegments: PublicTrailSegment[];
  trailPickups: TrailEnergyPickup[];
  musicMatchEndsAtUnixMs: number;
  musicPhase: MatchPhase;
  musicWinnerPlayerIds: string[];
  musicTrackDurationMs: number;
  musicPublicPath: string;
  musicTrackTitle: string;
};

export type ClientInput = {
  left: boolean;
  right: boolean;
  jump: boolean;
  /** Freno vertical: menos ascenso; mantener sólo frenado permite bajar despacio). */
  down: boolean;
  /** Mantener: dibuja trazo destructivo mientras haya energía. */
  trail: boolean;
};
