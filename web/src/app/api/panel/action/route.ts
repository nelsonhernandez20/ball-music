import { NextResponse } from "next/server";

import {
  authorizePanelSecret,
  gameBackendAdminToken,
  hasPanelSecretConfigured,
} from "../_auth";

const gameUrl = () => process.env.GAME_SERVER_URL ?? "http://127.0.0.1:3847";

export async function POST(req: Request) {
  if (!authorizePanelSecret(req)) {
    return NextResponse.json(
      {
        error: !hasPanelSecretConfigured()
          ? "Falta clave en web/.env.local: copiá el mismo valor que ADMIN_SECRET del server en PANEL_SECRET, GAME_ADMIN_SECRET o ADMIN_SECRET."
          : "Clave incorrecta.",
      },
      { status: 401 },
    );
  }
  const token = gameBackendAdminToken();
  if (!token) {
    return NextResponse.json(
      { error: "Falta token de admin del juego en web/.env.local (GAME_ADMIN_SECRET, ADMIN_SECRET o PANEL_SECRET)." },
      { status: 500 },
    );
  }

  const payload = (await req.json()) as { action?: string; nickname?: string };
  const action = payload?.action;
  const nickname = String(payload?.nickname ?? "").trim();

  if (!nickname) {
    return NextResponse.json({ error: "Falta nickname." }, { status: 400 });
  }

  const path = action === "shield" ? "/admin/grant-shield" : "/admin/give-life";
  const r = await fetch(`${gameUrl()}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ nickname }),
  });
  const body = await r.json();
  return NextResponse.json(body, { status: r.status });
}
