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
          ? "Falta clave en web/.env.local: PANEL_SECRET / GAME_ADMIN_SECRET / ADMIN_SECRET."
          : "Clave incorrecta.",
      },
      { status: 401 },
    );
  }
  const token = gameBackendAdminToken();
  if (!token) {
    return NextResponse.json({ error: "Falta token de admin del juego en web/.env.local." }, { status: 500 });
  }

  const r = await fetch(`${gameUrl()}/admin/restart-music-round`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });
  const body = await r.json();
  return NextResponse.json(body, { status: r.status });
}
