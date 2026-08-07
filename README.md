<div align="center">

<img width="300" height="200" alt="Logo-SD" src="https://github.com/user-attachments/assets/4c115b98-6ae8-4376-af66-6010458a139e" />

# Street District

### HaxBall Host

**Un host de HaxBall competitivo para futsal, construido sobre Node.js y `node-haxball`, basado originalmente en `haxball-curve-bot-v2`.**

Sistema de partidas · Mecánicas avanzadas · Estadísticas · Clanes · Roles · Discord

<br/>

<p>
  🇪🇸 Español
</p>

[![Node.js](https://img.shields.io/badge/Node.js-20.6%2B-339933?style=for-the-badge\&logo=node.js\&logoColor=white\&labelColor=0d1117)](https://nodejs.org/)
[![HaxBall](https://img.shields.io/badge/HaxBall-Headless-ffffff?style=for-the-badge\&logoColor=white\&labelColor=0d1117)](https://www.haxball.com/)
[![node-haxball](https://img.shields.io/badge/node--haxball-2.x-7289da?style=for-the-badge\&labelColor=0d1117)](https://github.com/wxyz-abcd/node-haxball)
[![License](https://img.shields.io/badge/license-GPL--3.0-blue?style=for-the-badge\&labelColor=0d1117)](LICENSE)

<br/>

**[⚽ Características](#-características)** ·
**[📊 Estadísticas](#-estadísticas)** ·
**[🐺 Clanes](#-clanes)** ·
**[👑 Roles](#-roles-y-administración)** ·
**[💬 Discord](#-discord)** ·
**[🚀 Instalación](#-instalación)**

</div>

---

## 🧬 Código base y atribuciones

**Street District** utiliza como base el proyecto **[`haxball-curve-bot-v2`](https://github.com/bugramurat/haxball-curve-bot-v2)**, desarrollado originalmente por **[@bugramurat](https://github.com/bugramurat)**.

A partir de esta base, el proyecto ha sido **ampliado, modificado y adaptado** para Street District, incorporando sistemas propios de gameplay, estadísticas, clanes, roles, administración, protección de sala, integración con Discord y otras funcionalidades específicas del host.

> [!NOTE]
> El código original y sus respectivos créditos pertenecen a sus autores. Street District mantiene esta atribución como reconocimiento a la base sobre la que se construyó el proyecto.
>
> **Código base:** [`bugramurat/haxball-curve-bot-v2`](https://github.com/bugramurat/haxball-curve-bot-v2)


## 🐺 ¿Qué es Street District?

**sd-host** (*Street District*) es un host headless de [HaxBall](https://www.haxball.com/) orientado a partidas de **futsal 4v4**, desarrollado en Node.js sobre [`node-haxball`](https://github.com/wxyz-abcd/node-haxball).

El proyecto funciona como un único script:

```text
sd-host.js
```

No utiliza:

* ❌ Framework
* ❌ Build step
* ❌ Frontend
* ❌ Base de datos externa

En su lugar, utiliza archivos JSON locales para mantener los datos persistentes de los jugadores, clanes, roles y administradores.

---

# ✨ Características

<table>
<tr>
<td width="50%" valign="top">

### ⚽ Gameplay

* 🏆 **Gana Sigue**
* 🌀 Curva
* 🏹 Lob-shot
* 💥 Power recto
* 🏃 Sprint / slide
* 🥅 Travesaño dinámico
* 🪵 Detección de palo
* 🧤 Detección de atajadas
* 🎯 Gol de media cancha
* 🔥 Doblete / hat-trick
* ⚽ Autogoles
* 👟 Asistencias

</td>
<td width="50%" valign="top">

### 🛡️ Sistema

* 🆔 ID permanente por `auth`
* 📊 Estadísticas persistentes
* 🐺 Sistema de clanes
* 👑 Roles por `auth`
* 🔐 Administración dinámica
* 🔒 Team Lock
* 🚫 Anti-AFK
* 🛑 Anti-spam
* 💬 Chat de equipo
* 🐺 Chat de clan
* 📡 Webhooks de Discord
* 🎥 Replays `.hbr2`

</td>
</tr>
</table>

---

# 🏆 Gana Sigue

El sistema principal de competición de la sala.

```text
                    🏆 GANADOR
                        │
                        ▼
                 ┌─────────────┐
                 │   CANCHA    │
                 └─────────────┘
                        │
                   permanece
                        │
                        ▼
                 ┌─────────────┐
                 │  SIGUIENTE  │
                 │    COLA     │
                 └─────────────┘
```

Cuando termina un partido:

1. 🏆 El ganador permanece.
2. 👥 El equipo derrotado pasa a espectadores.
3. ⏭️ Entran los siguientes jugadores.
4. 🎲 Se prepara la nueva alineación.
5. 📊 Se genera el resumen del partido.
6. ▶️ Comienza automáticamente la siguiente ronda.

El tamaño de los equipos se adapta a los jugadores disponibles en lugar de forzar siempre un 4v4.

---

# 🎯 Mecánicas

Las habilidades utilizan letras individuales para mantener el sistema rápido durante el partido:

|   Input   | Mecánica       |
| :-------: | :------------- |
|    `c`    | 🌀 Curva       |
|    `l`    | 🏹 Lob-shot    |
| `p` / `s` | 💥 Power recto |
|    `n`    | ⚽ Normal       |

Las habilidades disponen de un sistema visual de carga basado en elementos del mapa y estados internos del jugador.

### 🥅 Travesaño

Los segmentos especiales del mapa permiten que el balón atraviese normalmente el travesaño, pero interactúe con él durante un **lob-shot elevado**.

Esto permite simular una diferencia entre un balón normal y un disparo elevado.

---

# 📊 Estadísticas

Una de las partes centrales de sd-host es su sistema de persistencia.

En lugar de identificar a un jugador únicamente por su nickname, el host utiliza:

```js
player.auth
```

como identidad principal.

Esto permite conservar la información aunque el jugador:

* cambie de nombre;
* se desconecte;
* vuelva a entrar;
* reinicie la sala.

### 🆔 Player ID

Cada cuenta recibe un ID permanente:

```text
[001] Player
[002] Player
[003] Player
```

Ese ID también puede utilizarse en comandos administrativos:

```text
!kick 42
```

en lugar de:

```text
!kick NombreDelJugador
```

### 📈 Datos persistentes

```text
stats.json
│
├── player ID
├── goals
└── assists
```

Las estadísticas se guardan automáticamente y sobreviven a los reinicios del host.

---

# 🐺 Clanes

Los jugadores pueden crear sus propios clanes y competir mediante un ranking global.

### Crear

```text
!clan crear <TAG> <#COLOR> <EMOJI> <Nombre>
```

Actualmente se requieren **30 goles + asistencias históricas** para poder fundar un clan.

### Comandos

```text
!clan crear <TAG> <#COLOR> <EMOJI> <Nombre>

!clan invitar <jugador | [ID]>

!clan aceptar

!clan rechazar

!clan salir

!clan [TAG]

!top clan
```

Las invitaciones tienen una duración de **2 minutos** y únicamente el fundador puede enviar invitaciones.

Si un clan queda sin miembros, se disuelve automáticamente.

### 🏅 Ranking

```text
!top clan
```

El ranking utiliza los **goles + asistencias** acumulados por los miembros.

---

# 👑 Roles y administración

sd-host separa los privilegios internos del bot de la administración real de HaxBall.

## 🛡️ Administradores

```text
admins.json
```

Contiene las `auth` con administración real de HaxBall.

Los cambios se detectan automáticamente sin necesidad de reiniciar la sala.

## ⭐ Roles

```text
roles.json
```

Roles disponibles:

```text
VIP
VIP_PLUS
MOD
MASTER
```

Los roles internos son independientes de la administración real.

Esto permite tener, por ejemplo:

```text
👑 Admin HaxBall
⭐ MASTER
⭐ MOD
⭐ VIP_PLUS
⭐ VIP
```

sin mezclar los dos sistemas de permisos.

---

# 🔒 Seguridad de la sala

### Team Lock

Los jugadores no pueden modificar manualmente sus equipos.

El sistema combina:

```js
room.lockTeams()
```

con comprobaciones en:

```text
onPlayerTeamChange
onTeamsLockChange
```

Si un administrador desbloquea los equipos manualmente, el host vuelve a bloquearlos.

### 🚫 Anti-AFK

Durante una partida:

```text
15s sin cambiar input
        ↓
      KICK
```

Solo afecta a jugadores dentro de la cancha.

Los espectadores y administradores están excluidos.

### 🛑 Anti-spam

```text
4 mensajes / 5 segundos
            ↓
        SLOW MODE
            ↓
1 mensaje / minuto durante 5 minutos
```

Los administradores están exentos.

---

# 💬 Chat

El sistema de chat utiliza una identidad centralizada:

```text
[ID] {emoji} Nombre: mensaje
```

Los jugadores sin clan utilizan el emoji de su camiseta.

Los jugadores con clan utilizan:

```text
{emoji}[TAG]
```

con el color correspondiente al clan.

### 💬 Chat de equipo

```text
t <mensaje>
```

### 🐺 Chat de clan

```text
tc <mensaje>
```

El chat de clan únicamente se muestra a los miembros conectados del mismo clan.

---

# ⚽ Sistema de goles

Cada gol es procesado para obtener información adicional:

```text
⚽ Goleador
👟 Asistencia
🚫 Autogol
🚀 Velocidad
📏 Distancia
🪵 Palo
🧤 Atajada
🔥 Doblete
🏆 Hat-trick
```

El sistema también mantiene estadísticas independientes para:

```text
Sesión
   │
   ├── Goles
   └── Asistencias

Partido
   │
   ├── Goles
   └── Asistencias

Equipo
   │
   └── Toques / posesión
```

---

# 🐺 Avatares dinámicos

El avatar del jugador puede cambiar temporalmente dependiendo de la acción realizada.

```text
💬 Chat
   ↓
⚽ Gol
   ↓
👟 Asistencia
   ↓
🧤 Atajada
   ↓
🏆 Celebración
```

También existe una jerarquía de prioridad:

```text
🐺 Líder de la Manada
        ↓
🆕 Primera vez en el host
        ↓
🙂 Avatar normal
```

El 🐺 es el símbolo principal de identidad del host.

---

# 🏆 Match Summary

Al finalizar cada partido se genera un banner compacto con información del encuentro.

```text
🏆 Ganó 🔴 Rojo (3-1)

🐺 🔥3 ・ ⏱️07:42 ・ ⚽4 ・
🥇P1 2⚽1🅰️ - 🥈P2 1⚽

🐺 📊 🔴62% [██████░░░░] 38%🔵

🐺 🔲P1, P2 𝔳𝔰 🦉P3, P4
```

Puede incluir:

* Resultado.
* Duración.
* Goles.
* Asistencias.
* Jugadores destacados.
* Posesión.
* Próxima alineación.

El sistema genera las camisetas del siguiente partido antes de construir el banner para mostrar la identidad correcta de cada jugador.

---

# 💬 Comandos

### 👤 Player

```text
!help
!me
!stats
!top
!top clan
```

### 🐺 Clan

```text
!clan crear ...
!clan invitar ...
!clan aceptar
!clan rechazar
!clan salir
!clan [TAG]
```

### 🛡️ Admin

```text
!helpadmin

!mover
!kick
!ban
...
```

Los comandos administrativos aceptan tanto nombres como IDs permanentes.

---

# 📡 Discord

sd-host puede conectarse con Discord mediante **webhooks**.

### 🚀 Sala abierta

Envía una notificación cuando la sala comienza.

### 🏆 Resultado

Al terminar un partido puede enviar:

```text
Resultado
Estadísticas
Información del partido
Replay .hbr2
```

### 🆘 Llamar administrador

Desde HaxBall:

```text
!llamaradmin <razón>
```

El aviso aparece en la sala y puede enviarse automáticamente a Discord.

---

# 📁 Estructura

```text
sd-host/
│
├── 🐺 sd-host.js
│
├── 🗺️ fx4.hbs
│
├── ⚙️ package.json
├── 🔐 .env
├── 📄 .env.example
│
├── 👑 admins.json
├── ⭐ roles.json
│
├── 📊 stats.json
├── 🐺 clans.json
│
├── 📜 LICENSE
└── 📖 README.md
```

### Archivos

| Archivo       | Descripción                   | Se modifica |
| :------------ | :---------------------------- | :---------: |
| `sd-host.js`  | Núcleo completo del host      |      👤     |
| `fx4.hbs`     | Estadio utilizado por la sala |      👤     |
| `admins.json` | Auths con admin real          |      👤     |
| `roles.json`  | Roles internos                |      👤     |
| `stats.json`  | Stats e IDs permanentes       |      🤖     |
| `clans.json`  | Clanes y miembros             |      🤖     |
| `.env`        | Configuración sensible        |      👤     |

Los archivos de datos generados por el bot no deberían subirse al repositorio público.

---

# 🚀 Instalación

### 1. Clonar

```bash
git clone https://github.com/mo0negtt/Street-District
cd Street-District-main
```

### 2. Instalar dependencias

```bash
npm install
```

### 3. Configurar entorno

```bash
cp .env.example .env
```

### 4. Añadir Headless Token

Obtén tu token desde:

```text
https://www.haxball.com/headlesstoken
```

### 5. Iniciar

```bash
node --env-file=.env sd-host.js TU_HEADLESS_TOKEN
```

Node.js **20.6+** es requerido para utilizar `--env-file` de forma nativa.

---

# ⚡ Producción

Para mantener la sala activa se recomienda **PM2**.

```bash
pm2 start sd-host.js \
  --name sd-room \
  --node-args="--env-file=.env" \
  -- TU_HEADLESS_TOKEN
```

Guardar el proceso:

```bash
pm2 save
```

Ver estado:

```bash
pm2 status
```

Ver logs:

```bash
pm2 logs sd-room
```

PM2 permite que el proceso vuelva a levantarse automáticamente si el host se cae.

---

# 🗺️ Mapas

El mapa utilizado actualmente es:

```text
fx4.hbs
```

Al cambiar el estadio es necesario revisar determinados índices específicos del mapa.

Entre ellos:

```text
currentStartDisc
currentStartDiscL
POST_DISCS
```

y los segmentos correspondientes al travesaño.

Estos valores dependen de la estructura interna del `.hbs`, por lo que **no deben copiarse directamente de `fx4.hbs` a otro mapa**.

---

# 🧠 Arquitectura

Aunque el proyecto utiliza un único archivo principal, internamente está dividido por sistemas:

```text
                         ┌──────────────────┐
                         │    sd-host.js    │
                         └────────┬─────────┘
                                  │
          ┌───────────────────────┼───────────────────────┐
          │                       │                       │
          ▼                       ▼                       ▼
     GAMEPLAY                 PLAYERS                  SOCIAL
          │                       │                       │
   ┌──────┼──────┐          ┌─────┼─────┐          ┌─────┼─────┐
   │      │      │          │     │     │          │     │     │
  Goals  Skills Teams      Stats Auth Roles       Clan Discord Chat
   │      │      │          │     │     │          │     │     │
   └──────┴──────┘          └─────┴─────┘          └─────┴─────┘
                                  │
                                  ▼
                         ┌─────────────────┐
                         │ Persistent JSON │
                         └─────────────────┘
```

El proyecto mantiene toda la lógica en `sd-host.js`, actualmente con varios miles de líneas, mientras los datos persistentes se separan en archivos JSON.

---

# ⚠️ Notas para desarrolladores

`node-haxball` tiene diferencias importantes respecto a la API Headless oficial del navegador.

### Estado asíncrono

Operaciones como:

```js
room.setPlayerTeam(...)
```

no necesariamente actualizan el estado inmediatamente dentro del mismo tick.

Por eso el proyecto utiliza snapshots y planes de cambios antes de aplicar modificaciones.

### `fs.watch`

Los archivos editados manualmente utilizan `fs.watchFile` debido a cómo algunos editores reemplazan el archivo original al guardar.

### Resultado del partido

`onGameStop` puede resetear información del partido.

Por eso el resultado final debe capturarse antes de llamar a `stopGame()`.

---

# 🗺️ Roadmap

* [x] 🏆 Gana Sigue
* [x] ⚽ Sistema de goles
* [x] 👟 Asistencias
* [x] 📊 Estadísticas persistentes
* [x] 🆔 IDs permanentes
* [x] 🐺 Clanes
* [x] 👑 Roles
* [x] 🔒 Team Lock
* [x] 🚫 Anti-AFK
* [x] 🛑 Anti-spam
* [x] 💬 Chat de equipo
* [x] 🐺 Chat de clan
* [x] 📡 Webhooks de Discord
* [x] 🎥 Replays `.hbr2`
* [x] 🧤 Detección de atajadas
* [x] 🪵 Detección de palo
* [x] 🎨 Avatares dinámicos
* [ ] 🌐 Panel web

---

# 📜 Licencia

Este proyecto está distribuido bajo la licencia **GPL-3.0**.

Puedes utilizar, modificar y redistribuir el código siempre que las obras derivadas distribuidas mantengan la misma licencia y el código fuente correspondiente.

---

<div align="center">

# ❤️ Credits

Street District está construido a partir del código base de:

**[`haxball-curve-bot-v2`](https://github.com/bugramurat/haxball-curve-bot-v2)**
by **[@bugramurat](https://github.com/bugramurat)**

El proyecto ha sido posteriormente modificado y extendido para crear la experiencia de **Street District**.

<br/>

> **Original project:** `bugramurat/haxball-curve-bot-v2`
> **Current project:** `Street District`

<br/>

🇵🇸❤️🇪🇭

<br/>

</div>
