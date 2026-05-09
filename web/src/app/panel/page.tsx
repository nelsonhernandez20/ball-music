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

export default function PanelPage() {
  const [secret, setSecret] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyNick, setBusyNick] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

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
          Ver jugadores activos (máx 5)
        </button>
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
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={busyNick === p.nickname}
                    onClick={() => void grant(p.nickname, "life")}
                    className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                  >
                    + vida
                  </button>
                  <button
                    type="button"
                    disabled={busyNick === p.nickname}
                    onClick={() => void grant(p.nickname, "shield")}
                    className="rounded-lg border border-zinc-600 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
                  >
                    Escudo
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="text-xs text-zinc-600">
        Si dos nombres se parecen, pedí que uno cambie su nick en la entrada para no equivocarte.
      </p>
    </main>
  );
}
