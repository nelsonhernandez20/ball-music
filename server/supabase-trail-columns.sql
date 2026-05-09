-- Ejecutar en Supabase SQL (tabla ball_music_room_state) para persistir trazos e ítems.
-- Sin estas columnas, el juego funciona igual; sólo fallará el upsert/lectura opcional.

alter table ball_music_room_state
  add column if not exists trail_segments jsonb not null default '[]'::jsonb;

alter table ball_music_room_state
  add column if not exists trail_pickups jsonb not null default '[]'::jsonb;
