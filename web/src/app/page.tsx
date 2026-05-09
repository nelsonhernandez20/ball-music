"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

export default function Home() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState("");

  const go = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim().slice(0, 24);
    if (!n) return;
    const q = new URLSearchParams({ name: n });
    const a = avatar.trim();
    if (a.startsWith("https://")) q.set("avatar", a);
    router.push(`/play?${q.toString()}`);
  };

  return (
    <div className="flex min-h-full flex-col bg-gradient-to-b from-[#0b0d18] to-[#05060c] px-4 py-16 text-zinc-100">
      <div className="mx-auto w-full max-w-md">
        <p className="text-center text-xs uppercase tracking-[0.35em] text-cyan-500/80">ball-music</p>
        <h1 className="mt-3 text-center text-3xl font-semibold leading-tight text-white">
          Ritmo orbital
        </h1>
        <p className="mt-3 text-center text-sm text-zinc-400">
          Ritmo orbital tipo vertical shooter: gravedad + empuje arriba/abajo; nave siempre mirando al frente (↑ en pantalla).
          Hasta 5 en sala; ideal desde el móvil con música de fondo.
        </p>

        {/* action + method GET: si mandan antes de hidratar React, igual va a /play con ?name=… */}
        <form
          action="/play"
          method="get"
          onSubmit={go}
          className="mt-10 space-y-4 rounded-2xl border border-zinc-800/80 bg-zinc-900/40 p-6 shadow-xl shadow-black/40"
        >
          <div>
            <label htmlFor="name" className="text-xs font-medium text-zinc-500">
              Nombre en pantalla
            </label>
            <input
              id="name"
              name="name"
              value={name}
              maxLength={24}
              required
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded-xl border border-zinc-700 bg-zinc-950 px-4 py-3 text-base outline-none ring-cyan-500/25 focus:border-cyan-700 focus:ring-2"
              placeholder="ej. Alek"
              autoComplete="nickname"
            />
          </div>
          <div>
            <label htmlFor="avatar" className="text-xs font-medium text-zinc-500">
              Avatar (opcional, URL https)
            </label>
            <input
              id="avatar"
              name="avatar"
              value={avatar}
              onChange={(e) => setAvatar(e.target.value)}
              type="url"
              className="mt-1 w-full rounded-xl border border-zinc-700 bg-zinc-950 px-4 py-3 text-base outline-none ring-cyan-500/25 focus:border-cyan-700 focus:ring-2"
              placeholder="https://..."
            />
            <p className="mt-2 text-[11px] text-zinc-600">
              En esta versión el avatar se guarda en el servidor pero aún no se pinta en el canvas.
            </p>
          </div>
          <button
            type="submit"
            className="w-full rounded-xl bg-cyan-600 py-3.5 text-sm font-semibold text-white shadow-lg shadow-cyan-950/60 transition hover:bg-cyan-500"
          >
            Entrar si hay lugar
          </button>
        </form>

        <div className="mt-12 flex justify-center gap-6 text-xs text-zinc-500">
          <Link href="/panel" className="text-emerald-500/90 underline decoration-emerald-600/50 hover:text-emerald-400">
            Panel del streamer
          </Link>
          <span className="max-w-[12rem] text-center text-[11px] leading-snug text-zinc-600">
            El botón «Entrar…» abre el juego con tu nombre; no hace falta otro enlace.
          </span>
        </div>
      </div>
    </div>
  );
}
