import { NextResponse } from "next/server";

import {
  authorizePanelSecret,
  gameBackendAdminToken,
  hasPanelSecretConfigured,
} from "../_auth";

const gameUrl = () => process.env.GAME_SERVER_URL ?? "http://127.0.0.1:3847";

export async function GET(req: Request) {
  if (!authorizePanelSecret(req)) {
    return NextResponse.json(
      {
        error: !hasPanelSecretConfigured()
          ? "Falta clave en web/.env.local: copiá el mismo valor que ADMIN_SECRET del server en PANEL_SECRET, GAME_ADMIN_SECRET o ADMIN_SECRET (cualquiera de esos nombres sirve)."
          : "Clave incorrecta.",
      },
      { status: 401 },
    );
  }
  const token = gameBackendAdminToken();
  if (!token) {
    return NextResponse.json(
      { error: "Falta GAME_ADMIN_SECRET (o ADMIN_SECRET / PANEL_SECRET) en web/.env.local para hablar con el servidor del juego." },
      { status: 500 },
    );
  }

  const r = await fetch(`${gameUrl()}/admin/players`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const body = (await r.json()) as Record<string, unknown>;
  if (!r.ok) {
    return NextResponse.json(
      {
        ...body,
        ...(r.status === 401
          ? {
              hint: "Reiniciá el proceso del juego (puerto 3847) tras editar server/.env. ADMIN_SECRET del juego y GAME_ADMIN_SECRET en web/.env.local deben ser idénticos.",
            }
          : {}),
      },
      { status: r.status },
    );
  }
  return NextResponse.json(body, { status: r.status });
}
