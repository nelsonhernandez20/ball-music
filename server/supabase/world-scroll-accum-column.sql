-- Ejecutar en Supabase si la tabla ya existía sin esta columna (persistencia opcional).
alter table ball_music_room_state
  add column if not exists world_scroll_accum double precision not null default 0;
