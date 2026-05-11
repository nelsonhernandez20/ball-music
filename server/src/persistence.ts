import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import ws from "ws";

import type { PublicPlatform } from "./types.js";
import type { GameRoom, PersistedPlayerBlob } from "./room.js";

const TABLE = "ball_music_room_state";
const DEBOUNCE_MS = 2500;

export function persistenceEnabled(): boolean {
  return Boolean(
    process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_SERVICE_ROLE_KEY?.trim(),
  );
}

let client: SupabaseClient | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function getClient(): SupabaseClient {
  if (!client) {
    const url = process.env.SUPABASE_URL!.trim();
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY!.trim();
    client = createClient(url, key, {
      auth: { persistSession: false },
      /** Node.js < 22 sin WebSocket global; Realtime se crea igual aunque sólo usemos `.from()`. */
      realtime: { transport: ws as never },
    });
  }
  return client;
}

export async function hydrateRoomFromSupabase(room: GameRoom): Promise<void> {
  if (!persistenceEnabled()) return;
  try {
    const sb = getClient();
    const { data, error } = await sb
      .from(TABLE)
      .select("players, platforms, trail_segments, trail_pickups, world_scroll_accum")
      .eq("slug", room.slug)
      .maybeSingle();
    if (error) {
      console.warn("[persist] Supabase read:", error.message);
      return;
    }
    if (!data?.players || !Array.isArray(data.players) || data.players.length === 0) {
      return;
    }
    const plats = Array.isArray(data.platforms) ? (data.platforms as PublicPlatform[]) : [];
    const scrollAccumRaw = Number(
      (data as { world_scroll_accum?: unknown }).world_scroll_accum,
    );
    const persistedScrollAccum =
      Number.isFinite(scrollAccumRaw) ? scrollAccumRaw : undefined;
    room.applyPersistenceBlobs(
      data.players as PersistedPlayerBlob[],
      plats,
      data.trail_segments,
      data.trail_pickups,
      persistedScrollAccum,
    );
    console.log(`[persist] Sala «${room.slug}» restaurada (${data.players.length} jugadores).`);
  } catch (e) {
    console.warn("[persist] hydrate error", e);
  }
}

async function upsertRoom(room: GameRoom): Promise<void> {
  if (!persistenceEnabled()) return;
  const { players, platforms, trailSegments, trailPickups, worldScrollAccum } =
    room.getPersistenceBlobs();
  try {
    const sb = getClient();
    const { error } = await sb.from(TABLE).upsert(
      {
        slug: room.slug,
        players,
        platforms,
        trail_segments: trailSegments,
        trail_pickups: trailPickups,
        world_scroll_accum: worldScrollAccum,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "slug" },
    );
    if (error) console.warn("[persist] Supabase write:", error.message);
  } catch (e) {
    console.warn("[persist] upsert error", e);
  }
}

export function schedulePersistRoom(room: GameRoom): void {
  if (!persistenceEnabled()) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void upsertRoom(room);
  }, DEBOUNCE_MS);
}

export async function persistRoomImmediate(room: GameRoom): Promise<void> {
  if (!persistenceEnabled()) return;
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  await upsertRoom(room);
}
