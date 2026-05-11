/** Presets de música; el mismo MP3 debe existir como estático público del front (ej. web/public/music/…). */
export type MusicPreset = {
  id: string;
  title: string;
  publicPath: string;
  durationMs: number;
};

export const MUSIC_PRESETS: MusicPreset[] = [
  {
    id: "onandon",
    title: "Cartoon, Jéja — On & On (feat. Daniel Levi) · NCS",
    publicPath: "/music/on-and-on-ncs.mp3",
    durationMs: Math.round(208.008 * 1000),
  },
  {
    id: "mortals",
    title: "Warriyo — Mortals (feat. Laura Brehm) · NCS",
    publicPath: "/music/warriyo-mortals-ncs.mp3",
    durationMs: Math.round(230.016 * 1000),
  },
];
