-- Supabase → SQL Editor. La clave SERVICE_ROLE solo en el proceso Node del juego (nunca en Next público).

create table if not exists public.ball_music_room_state (
  slug text primary key,
  players jsonb not null default '[]'::jsonb,
  platforms jsonb not null default '[]'::jsonb,
  world_scroll_accum double precision not null default 0,
  updated_at timestamptz not null default now()
);

comment on table public.ball_music_room_state is 'Opcional: persistir sala ball-music. Sin RLS: no expongas la service_role al cliente.';
