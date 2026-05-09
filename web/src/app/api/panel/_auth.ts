/**
 * Una sola clave física suele estar en server/.env como ADMIN_SECRET.
 * En Next hace falta copiar ese valor aquí para que las rutas /api/panel/* funcionen.
 * Aceptamos varios nombres de variable por si sólo configuraste uno.
 */
export function normalizedPanelSecrets(): string[] {
  const raw = [
    process.env.PANEL_SECRET,
    process.env.GAME_ADMIN_SECRET,
    process.env.ADMIN_SECRET,
  ];
  const out = new Set<string>();
  for (const r of raw) {
    const t = typeof r === "string" ? r.trim() : "";
    if (t.length > 0) out.add(t);
  }
  return [...out];
}

export function authorizePanelSecret(req: Request): boolean {
  const candidates = normalizedPanelSecrets();
  if (candidates.length === 0) return false;
  const provided = req.headers.get("x-panel-secret")?.trim() ?? "";
  if (!provided) return false;
  return candidates.includes(provided);
}

/** Bearer que Next envía al daemon del juego (debe coincidir con ADMIN_SECRET del server). */
export function gameBackendAdminToken(): string | null {
  const t =
    process.env.GAME_ADMIN_SECRET?.trim() ||
    process.env.ADMIN_SECRET?.trim() ||
    process.env.PANEL_SECRET?.trim() ||
    null;
  return t && t.length > 0 ? t : null;
}

export function hasPanelSecretConfigured(): boolean {
  return normalizedPanelSecrets().length > 0;
}
