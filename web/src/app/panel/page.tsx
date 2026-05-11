"use client";

import { useCallback, useState } from "react";

type Row = {
  id: string;
  nickname: string;
  lives: number;
  shields: number;
  eliminated?: boolean;
  connected?: boolean;
};

type MusicPresetRow = {
  id: string;
  title: string;
  publicPath: string;
  durationMs: number;
};

type MusicCurrentRow = {
  musicPublicPath: string;
  musicTrackTitle: string;
  musicTrackDurationMs: number;
};

export default function PanelPage() {
  const [secret, setSecret] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyNick, setBusyNick] = useState<string | null>(null);
  const [busyKickId, setBusyKickId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const [presets, setPresets] = useState<MusicPresetRow[]>([]);
  const [currentMusic, setCurrentMusic] = useState<MusicCurrentRow | null>(null);
  const [presetId, setPresetId] = useState("");
  const [customPath, setCustomPath] = useState("/music/on-and-on-ncs.mp3");
  const [customTitle, setCustomTitle] = useState("");
  const [customDurationSec, setCustomDurationSec] = useState("208");
  const [musicBusy, setMusicBusy] = useState(false);
  const [musicErr, setMusicErr] = useState<string | null>(null);
  const [musicMsg, setMusicMsg] = useState<string | null>(null);

  const headers = (): HeadersInit =>
    ({
      "x-panel-secret": secret.trim(),
      "Content-Type": "application/json",
    }) as HeadersInit;

  const refresh = useCallback(async () => {
    setErr(null);
    setMsg(null);
    try {
      const res = await fetch("/api/panel/players", { headers: headers() });
      const data = (await res.json()) as {
        players?: Row[];
        error?: string;
      };
      if (!res.ok) {
        setRows(null);
        const msg = [
          typeof data?.error === "string" ? data.error : null,
          typeof (data as { hint?: unknown })?.hint === "string"
            ? (data as { hint?: string }).hint
            : null,
        ]
          .filter(Boolean)
          .join(" ");
        setErr(msg || data?.error || "Error al cargar.");
        return;
      }
      setRows(data.players ?? []);
    } catch {
      setErr("Sin conexión al servidor.");
    }
  }, [secret]);

  const loadMusicCatalog = useCallback(async () => {
    setMusicErr(null);
    setMusicMsg(null);
    try {
      const res = await fetch("/api/panel/music-presets", { headers: headers() });
      const data = (await res.json()) as {
        presets?: MusicPresetRow[];
        current?: MusicCurrentRow;
        error?: string;
      };
      if (!res.ok) {
        setPresets([]);
        setCurrentMusic(null);
        setMusicErr(data.error ?? "No se pudo cargar el catálogo.");
        return;
      }
      setPresets(data.presets ?? []);
      setCurrentMusic(data.current ?? null);
      setMusicMsg("Catálogo y tema actual cargados.");
    } catch {
      setMusicErr("Sin conexión al servidor.");
    }
  }, [secret]);

  const applyMusic = async (restartRound: boolean) => {
    setMusicBusy(true);
    setMusicErr(null);
    setMusicMsg(null);
    try {
      if (!presetId.trim()) {
        const secs = Number(customDurationSec);
        if (!Number.isFinite(secs) || secs < 20) {
          setMusicErr("Con tema manual necesitás una duración en segundos (mín. 20).");
          setMusicBusy(false);
          return;
        }
      }
      const body =
        presetId.trim().length > 0
          ? { presetId: presetId.trim(), restartRound }
          : {
              publicPath: customPath.trim(),
              title: customTitle.trim() || undefined,
              durationMs: Math.round(Number(customDurationSec) * 1000),
              restartRound,
            };
      const res = await fetch("/api/panel/set-music", {
        method: "POST",
        headers: { ...headers(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string; warn?: string };
      if (!res.ok) {
        setMusicErr(data?.error ?? "No se aplicó el tema.");
        return;
      }
      if (typeof data.warn === "string") {
        setMusicErr(data.warn);
        await loadMusicCatalog();
        return;
      }
      setMusicMsg(
        restartRound
          ? "Tema guardado y ronda reiniciada (mundos limpios, vidas stock)."
          : "Tema guardado. La cuenta regresiva actual sigue; para alinear música y timer usá «Guardar y reiniciar ronda».",
      );
      await loadMusicCatalog();
    } catch {
      setMusicErr("Sin conexión al servidor.");
    } finally {
      setMusicBusy(false);
    }
  };

  const restartRoundOnly = async () => {
    setMusicBusy(true);
    setMusicErr(null);
    setMusicMsg(null);
    try {
      const res = await fetch("/api/panel/restart-music-round", {
        method: "POST",
        headers: headers(),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) {
        setMusicErr(data?.error ?? "No se reinició.");
        return;
      }
      setMusicMsg("Ronda reiniciada (mismo tema configurado que tenías antes).");
    } catch {
      setMusicErr("Sin conexión al servidor.");
    } finally {
      setMusicBusy(false);
    }
  };

  const kick = async (playerId: string, nickname: string) => {
    if (!window.confirm(`¿Sacar de la sala a «${nickname}»? Pierde el personaje (vivo o fuera) y se libera una conexión.`))
      return;
    setBusyKickId(playerId);
    setErr(null);
    setMsg(null);
    try {
      const res = await fetch("/api/panel/kick-player", {
        method: "POST",
        headers: { ...headers(), "Content-Type": "application/json" },
        body: JSON.stringify({ playerId }),
      });
      const data = (await res.json()) as { ok?: boolean; player?: string; error?: string };
      if (!res.ok) {
        setErr(data?.error ?? "No se pudo sacar.");
        return;
      }
      setMsg(`Sacado de la sala: ${data.player ?? nickname}`);
      await refresh();
    } catch {
      setErr("Sin conexión al servidor.");
    } finally {
      setBusyKickId(null);
    }
  };

  const grant = async (nickname: string, action: "life" | "shield") => {
    setBusyNick(nickname);
    setErr(null);
    setMsg(null);
    try {
      const res = await fetch("/api/panel/action", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          nickname,
          action: action === "shield" ? "shield" : "life",
        }),
      });
      const data = (await res.json()) as { ok?: boolean; player?: string; error?: string };
      if (!res.ok) {
        setErr(data?.error ?? "No se aplicó.");
        return;
      }
      setMsg(
        action === "shield"
          ? `Escudo para ${data.player ?? nickname}`
          : `Vida extra para ${data.player ?? nickname}`,
      );
      await refresh();
    } catch {
      setErr("Sin conexión al servidor.");
    } finally {
      setBusyNick(null);
    }
  };

  return (
    <main className="mx-auto flex min-h-full max-w-xl flex-col gap-6 bg-zinc-950 px-4 py-10 text-white">
      <header>
        <h1 className="text-2xl font-semibold text-zinc-100">Panel del stream</h1>
        <p className="mt-2 text-sm text-zinc-500">
          TikTok lleva las donaciones: acá sólo aplicás vidas u escudos a quien ves en sala.
        </p>
      </header>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-4">
        <label className="block text-xs font-medium uppercase tracking-wide text-zinc-500">
          Clave del panel
        </label>
        <input
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          className="mt-2 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none ring-cyan-500/40 focus:ring-2"
          placeholder="Ej. cambia‑esto (la misma clave que ADMIN_SECRET en server/.env)"
          autoComplete="off"
        />
        <p className="mt-2 text-[11px] leading-relaxed text-zinc-600">
          Tenés dos lugares: en <code className="text-zinc-500">server/.env</code> va{" "}
          <code className="text-zinc-500">ADMIN_SECRET=cambia‑esto</code>. En{" "}
          <code className="text-zinc-500">web/.env.local</code> repetí el mismo valor con alguna variable (por ejemplo{" "}
          <code className="text-zinc-500">ADMIN_SECRET=…</code> o las del ejemplo): si ese archivo está vacío, el panel dará siempre error. Reiniciá el dev server tras cambiar .env.local.
        </p>
        <button
          type="button"
          onClick={() => void refresh()}
          className="mt-3 w-full rounded-lg bg-emerald-600 py-2.5 text-sm font-medium text-white transition hover:bg-emerald-500"
        >
          Ver jugadores en sala (máximo 5 conectados a la vez)
        </button>
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-4">
        <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Ronda y música</h2>
        <p className="mt-2 text-xs leading-relaxed text-zinc-500">
          Los jugadores en <code className="text-zinc-500">/play</code> ya no pueden reiniciar la ronda: solo desde acá.
          Los MP3 tienen que estar en el front en <code className="text-zinc-500">web/public/music/…</code> (ej.{" "}
          <code className="text-zinc-500">/music/mi-pista.mp3</code>). La duración en segundos tiene que coincidir
          bastante bien con la pista para el reloj de fin de canción.
        </p>
        <button
          type="button"
          disabled={musicBusy}
          onClick={() => void loadMusicCatalog()}
          className="mt-3 w-full rounded-lg border border-zinc-600 bg-zinc-950 py-2 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
        >
          Cargar tema actual + presets
        </button>
        {currentMusic ? (
          <p className="mt-3 text-[11px] text-zinc-400">
            Ahora mismo:{" "}
            <span className="text-zinc-200">{currentMusic.musicTrackTitle}</span> ·{" "}
            <span className="font-mono text-zinc-500">{currentMusic.musicPublicPath}</span> ·{" "}
            {Math.round(currentMusic.musicTrackDurationMs / 1000)} s
          </p>
        ) : null}
        <label className="mt-4 block text-xs font-medium uppercase tracking-wide text-zinc-500">Preset del servidor</label>
        <select
          value={presetId}
          onChange={(e) => setPresetId(e.target.value)}
          className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none ring-cyan-500/40 focus:ring-2"
        >
          <option value="">(manual: ruta y duración abajo)</option>
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
        <p className="mt-3 text-[11px] text-zinc-600">Opción manual (si preset vacío)</p>
        <input
          value={customPath}
          onChange={(e) => setCustomPath(e.target.value)}
          className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-200 outline-none"
          placeholder="/music/archivo.mp3"
        />
        <input
          value={customTitle}
          onChange={(e) => setCustomTitle(e.target.value)}
          className="mt-2 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none"
          placeholder="Título visible en play"
        />
        <label className="mt-3 block text-xs text-zinc-500">Duración (segundos)</label>
        <input
          type="number"
          min={20}
          value={customDurationSec}
          onChange={(e) => setCustomDurationSec(e.target.value)}
          className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none"
        />
        <div className="mt-4 flex flex-col gap-2">
          <button
            type="button"
            disabled={musicBusy}
            onClick={() => void applyMusic(false)}
            className="rounded-lg bg-sky-700 py-2.5 text-sm font-medium text-white hover:bg-sky-600 disabled:opacity-50"
          >
            Guardar tema ({presetId.trim() ? "preset" : "manual"}) sin reiniciar ronda
          </button>
          <button
            type="button"
            disabled={musicBusy}
            onClick={() => void applyMusic(true)}
            className="rounded-lg bg-violet-700 py-2.5 text-sm font-medium text-white hover:bg-violet-600 disabled:opacity-50"
          >
            Guardar tema y reiniciar ronda
          </button>
          <button
            type="button"
            disabled={musicBusy}
            onClick={() => void restartRoundOnly()}
            className="rounded-lg border border-zinc-500 py-2.5 text-sm font-medium text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
          >
            Solo reiniciar ronda (misma canción ya configurada)
          </button>
        </div>
        {musicErr ? (
          <p className="mt-3 rounded-lg border border-rose-500/40 bg-rose-950/50 px-3 py-2 text-sm text-rose-200">
            {musicErr}
          </p>
        ) : null}
        {musicMsg ? (
          <p className="mt-3 rounded-lg border border-cyan-600/35 bg-cyan-950/40 px-3 py-2 text-sm text-cyan-100">
            {musicMsg}
          </p>
        ) : null}
      </section>

      {err ? (
        <p className="rounded-lg border border-rose-500/40 bg-rose-950/50 px-3 py-2 text-sm text-rose-200">{err}</p>
      ) : null}
      {msg ? (
        <p className="rounded-lg border border-cyan-600/35 bg-cyan-950/40 px-3 py-2 text-sm text-cyan-100">{msg}</p>
      ) : null}

      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">En sala</h2>
        {!rows?.length ? (
          <p className="text-sm text-zinc-600">Todavía no hay jugadores o no pulsaste cargar.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {rows.map((p) => (
              <li
                key={p.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-3"
              >
                <div>
                  <p className="font-medium text-zinc-100">{p.nickname}</p>
                  <p className="text-xs text-zinc-500">
                    ♥ {p.lives} · escudos {p.shields}
                    {p.connected === false ? (
                      <span className="ml-2 rounded-md border border-amber-500/30 bg-amber-950/40 px-1.5 py-0.5 text-amber-100">
                        Pestaña cerrada · puede recuperar mismo nick
                      </span>
                    ) : null}
                    {p.eliminated ? (
                      <span className="ml-2 rounded-md border border-rose-500/35 bg-rose-950/50 px-1.5 py-0.5 text-rose-200">
                        Fuera · usa + vida
                      </span>
                    ) : null}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busyNick === p.nickname || busyKickId === p.id}
                    onClick={() => void grant(p.nickname, "life")}
                    className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                  >
                    + vida
                  </button>
                  <button
                    type="button"
                    disabled={busyNick === p.nickname || busyKickId === p.id}
                    onClick={() => void grant(p.nickname, "shield")}
                    className="rounded-lg border border-zinc-600 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
                  >
                    Escudo
                  </button>
                  <button
                    type="button"
                    disabled={busyKickId === p.id || busyNick === p.nickname}
                    onClick={() => void kick(p.id, p.nickname)}
                    className="rounded-lg border border-rose-500/55 bg-rose-950/50 px-3 py-1.5 text-xs font-medium text-rose-100 hover:bg-rose-900/55 disabled:opacity-50"
                  >
                    Sacar de la sala
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="text-xs text-zinc-600">
        Si dos nombres se parecen, pedí que uno cambie su nick en la entrada para no equivocarte. Máximo{" "}
        <strong className="text-zinc-500">5 pestañas conectadas</strong> a la vez: usá{" "}
        <strong className="text-zinc-500">Sacar de la sala</strong> para liberar plaza aunque sigan con vida, o que cierren ellos.
      </p>
    </main>
  );
}
