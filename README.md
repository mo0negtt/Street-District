# 🐺 sd-host

Bot/host de sala de [HaxBall](https://www.haxball.com/) para modo futsal, sobre
[`node-haxball`](https://github.com/wxyz-abcd/node-haxball). Todo en un solo
archivo (`sd-host.js`), sin build step ni framework.

## Qué trae

- **Gana sigue**: el equipo que gana se queda, entra el siguiente de la cola.
- **Mecánicas de tiro**: curva, lob-shot y power recto, cada una con su barra
  de carga.
- **Sprint / slide**, travesaño real, detección de palo y de atajadas.
- **Stats persistentes por cuenta** (goles, asistencias, ID de jugador
  permanente) que sobreviven a un reinicio del bot.
- **Clanes**: fundalos al llegar a cierto puntaje, con invitación, chat propio
  (`tc <mensaje>`) y ranking (`!top clan`).
- **Admins y roles por auth**, editables en un `.json` mientras el bot corre
  (sin reiniciar la sala).
- **Webhooks de Discord**: aviso al abrir la sala, resultado de cada partido
  con el replay `.hbr2` adjunto, y llamado de admin desde el chat.
- Anti-spam, anti-AFK, bloqueo de cambio de equipo manual, banner de fin de
  partido con posesión y goleadores.

## Requisitos

- Node.js **20.6 o superior** (usa `--env-file`, nativo desde esa versión —
  no hace falta instalar `dotenv`).
- Un [headless token](https://www.haxball.com/headlesstoken) de HaxBall.

## Instalación

```bash
git clone <este-repo>
cd sd-host
npm install
cp .env.example .env      # completá lo que quieras usar (todo es opcional)
cp admins.json.example admins.json   # opcional, para arrancar con un admin ya cargado
```

## Correrlo

```bash
node --env-file=.env sd-host.js TU_HEADLESS_TOKEN
```

Sin `.env` también arranca — los webhooks de Discord simplemente no mandan
nada si no están seteados, y el código de `!claim` se genera al azar y se
muestra en la consola.

Para producción, con [`pm2`](https://pm2.keymetrics.io/) así se reinicia solo
si se cae:

```bash
pm2 start sd-host.js --name sd-room --node-args="--env-file=.env" -- TU_TOKEN
```

## Configuración

Todo lo importante está como variable de entorno (`.env`, ver `.env.example`)
o como archivo `.json` en la misma carpeta:

| Archivo | Qué es | Se edita |
|---|---|---|
| `admins.json` | Auths con admin real de HaxBall | A mano, se recarga solo |
| `roles.json` | Auths con rol VIP/VIP_PLUS/MOD/MASTER | A mano, se recarga solo |
| `stats.json` | Goles/asistencias/ID por jugador | Lo escribe el bot |
| `clans.json` | Clanes y sus miembros | Lo escribe el bot |
| `fx4.hbs` | Mapa del estadio | — |

Ninguno de estos cuatro `.json` de datos se sube al repo (están en
`.gitignore`) — cada instancia del bot tiene los suyos.

## Comandos

Escribí `!help` en el chat de la sala para la lista completa (jugadores) y
`!helpadmin` para los de administración. Algunos destacados:

- `t <mensaje>` — chat de equipo. `tc <mensaje>` — chat de clan.
- `!me` / `!stats` / `!top` — tus stats. `!top clan` — ranking de clanes.
- `!clan crear <TAG> <#COLOR> <EMOJI> <Nombre>` — fundar un clan.
- `!llamaradmin <razón>` — avisa en la sala y manda un webhook a Discord.
- `!mover`, `!kick`, `!ban`, etc. (admin) — aceptan nombre o `[ID]` del chat.

## Cambiar de mapa

Si usás un `.hbs` distinto a `fx4.hbs`, hay varios IDs que están hardcodeados
para ESE mapa específico y hay que recalcular:

- `currentStartDisc` / `currentStartDiscL` — discos de la barra de carga de
  curva/lob-shot.
- Los índices de segmento del travesaño (buscar `"_comment": "travesano"` en
  el `.hbs`, contar la posición en el array `segments`, no el ID de vértice).
- `POST_DISCS` — discos de los postes, para la detección de "¡AL PALO!".

## Licencia

[GPL-3.0](./LICENSE) — copyleft. Podés usar, modificar y redistribuir este
código libremente, pero cualquier trabajo derivado que distribuyas tiene que
mantenerse bajo la misma licencia y con el código fuente disponible.

Basado en un script original de BUGGYRAZ.
