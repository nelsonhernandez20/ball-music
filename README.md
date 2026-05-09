# ball-music

Juego 2D multijugador (hasta 5) en el navegador: servidor de juego en Node + web en Next.js. El estado puede vivir sólo en RAM o persistirse con **Supabase** (opcional).

## Opcional: Supabase (persistir vidas/sala tras reinicios)

1. Creá un proyecto en [Supabase](https://supabase.com), ejecutá `server/supabase/schema.sql` en **SQL Editor**.  
2. En **Project Settings → API** copiá la URL y la clave **`service_role`** (secreta).  
3. Ponelas en **`server/.env`** como `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY`. **No pongas esa clave en Next ni la subas al repo.**

Al arrancar el daemon del juego verás `[persist] Supabase encendido…`. Sin esas variables, el juego sigue igual que antes (solo memoria).

## Estructura

- `web/` — Next.js: lobby, pantalla de juego (teclado + táctil), panel para el stream.
- `server/` — Express + Socket.IO: física autoritaria y API de admin.

## Desarrollo local

1. Variables de entorno (misma clave en servidor y en Next para desarrollo):

```bash
cp server/.env.example server/.env
cp web/.env.local.example web/.env.local
```

Editá `ADMIN_SECRET` en `server/.env` y la misma cadena en `GAME_ADMIN_SECRET` y `PANEL_SECRET` en `web/.env.local`.

2. Instalar dependencias (raíz del repo):

```bash
npm install
```

3. Levantar todo:

```bash
npm run dev
```

- Web: http://localhost:3000  
- Juego (WebSocket + API): http://localhost:3847  

## Jugar desde el móvil en la misma Wi-Fi

En `web/.env.local`, `NEXT_PUBLIC_GAME_SERVER` debe ser la IP de tu máquina en la LAN (ej. `http://192.168.1.10:3847`), no `127.0.0.1`.

## Panel del stream

1. Abrí http://localhost:3000/panel  
2. Poné la misma clave que `PANEL_SECRET` y cargá la lista.  
3. Donaciones y regalos siguen en TikTok; vos aplicás vidas o escudos desde acá.

Quienes se **quedan sin vidas** quedan en estado **Eliminado** (siguen conectados y aparecen así en la lista): al tocar **+ vida** revive a esa persona en la plataforma baja sin que tenga que recargar. Si cerró la página, ese nombre puede volver a estar libre y puede entrar otra persona desde la pantalla inicial.

## Producción

Ideas: un VPS o Railway con **Node** ejecutando `server` (`npm run build -w server && npm run start -w server`) y Next en `web` (`next build && next start`), o **solo** el servidor de juego público y Next en Vercel configurando `GAME_SERVER_URL` a la URL HTTPS del juego (CORS ya está abierto; en producción podrías restringir `origin`).
