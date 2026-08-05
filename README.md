<div align="center">

<h1>🐺 Street District</h1>
### Host headless y comunidad de HaxBall Futsal (Chile 🇨🇱)

<p align="center">
  🇪🇸 Español
</p>

<br/>

[![Version](https://img.shields.io/badge/version-1.0.0-00d4ff?style=for-the-badge&labelColor=0d1117)]()
[![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white&labelColor=0d1117)]()
[![Chile](https://img.shields.io/badge/Host-Chile_🇨🇱-CE1126?style=for-the-badge&labelColor=0d1117)]()
[![License](https://img.shields.io/badge/license-MIT-00d4ff?style=for-the-badge&labelColor=0d1117)]()

[**Acerca de**](#acerca) · [**Arquitectura y Funciones**](#arquitectura) · [**Comandos**](#comandos) · [**Instalación**](#instalacion) · [**Guía de Desarrollo**](#dev)

</div>

> [!TIP]
> **Street District** corre sobre un único script (`sd-host.js`) que levanta la sala headless usando la librería `node-haxball`. Fiel a nuestro estilo **Gana Sigue 4v4** y con la estética de **La Manada (🐺)**. No requiere un proceso de build ni frameworks adicionales.

---

<div align="center">

<h2><a id="acerca"></a>🐺 ¿Qué es Street District?</h2>

Es el bot y host oficial de **Street District**, sala chilena de HaxBall configurada para el clásico modo **futsal 4v4 (a 4 goles)**. Diseñado para mantener vivo al rey de la pista con un sistema ágil de **"gana sigue"**. Implementa mecánicas avanzadas (efecto, lob-shot, power), un sistema robusto de clanes y estadísticas persistentes. Todo bajo nuestra emblemática temática de **Lobo** heredada del servidor de Discord.

</div>

---

<h2><a id="arquitectura"></a>🏗️ Arquitectura y Funciones</h2>

El proyecto está contenido en ~4900 líneas de código y se divide en los siguientes sistemas base:

### 🛡️ Identidad, Persistencia y Clanes
- **ID Permanente (`stats.json`):** Cada cuenta (`player.auth`) recibe un ID único de por vida y guarda sus goles/asistencias totales.
- **Sistema de Clanes (`clans.json`):** Los jugadores pueden fundar clanes únicos (Tag, Color, Emoji). Requiere mínimo 30 goles+asistencias históricos para crearlo.
- **Admins y Roles:** Gestión de admin real de HaxBall en caliente (`admins.json`) y jerarquías del bot (VIP, VIP_PLUS, MOD, MASTER) en `roles.json`.

### ⚽ Mecánicas de Juego y "Gana Sigue"
- **Rotación Automática:** El equipo ganador (mejor de 4 goles) se queda. Los perdedores pasan a espectador y entra la siguiente escuadra respetando el tamaño del equipo (nunca a la fuerza 4v4 si hay menos).
- **Mecánicas Físicas Custom:** 
  - **Habilidades:** Curva (`c`), Lob-shot elevado (`l`), Power recto (`p`/`s`). Representados con una barra de carga visual (joints).
  - **Travesaño Real:** Colisión dinámica. La pelota atraviesa normalmente los segmentos 125 y 126 (`fx4.hbs`), pero en un lob-shot cambia a `cGroup: cf.c3` y colisiona.
- **Detecciones Avanzadas:** 
  - Goles de media cancha (20m+), ¡AL PALO! (con cooldown de 5s por bug visual de HaxBall), ¡ATAJADA! 🧤 (defensas in-extremis), asistencias (2/3 últimos toques) y autogoles.

### 💬 Avatares Dinámicos y Chat Inteligente
- **Avatares por Acción:** Destellan y vuelven a la normalidad: Asistencia (👟), Atajada (🧤), Gol (⚽/🏆/🎉).
- **Líder de la Manada 🐺:** Quien tenga más Goles+Asistencias en la sesión conectada, lleva prioridad en su avatar. Jugadores nuevos reciben (🆕).
- **Anti-Spam y Anti-AFK:** Bloqueo de chat (4 msj en 5s -> mute por 5 min). Expulsión por 15s inactivo **solo** si el jugador está en cancha durante una partida activa.

---

<h2><a id="comandos"></a>⌨️ Comandos y Atajos</h2>

El bot soporta prefijos para hablar en privado y comandos de gestión completos.

#### 🗣️ Chat y Comunicación
| Prefijo | Acción |
| :--- | :--- |
| `t <mensaje>` | **Chat de Equipo:** Solo lo lee tu equipo actual (los specs no tienen acceso). |
| `tc <mensaje>` | **Chat de Clan:** Solo lo leen tus compañeros de clan conectados en la sala. |

#### 🛡️ Comandos de Clan
| Comando | Descripción |
| :--- | :--- |
| `!clan crear <TAG> <#HEX> <EMOJI> <Nombre>` | Crea un clan (Ej: `!clan crear SD #ff0000 🐺 Street District`). Requiere 30 stats. |
| `!clan invitar <Nick o [ID]>` | Invita a un jugador a tu clan (Exclusivo del fundador). |
| `!clan aceptar` / `!clan rechazar` | Responde a una invitación pendiente (Expira en 2 minutos). |
| `!clan salir` | Abandonas tu clan. Si eres el último, el clan se disuelve automáticamente. |
| `!clan [TAG]` | Muestra la información de un clan (O el tuyo si omites el TAG). |
| `!top clan` | Muestra el ranking de clanes sumando Goles+Asistencias de sus miembros. |

---

<h2><a id="instalacion"></a>🔁 Flujo de Instalación</h2>

1. **Dependencias:** Ejecuta `npm install` (solo instala `node-haxball`).
2. **Mapa:** Asegúrate de que tu estadio (ej. `fx4.hbs`) esté en la misma carpeta.
3. **Arranque Básico:** `node sd-host.js TU_HEADLESS_TOKEN`
4. **Producción (Recomendado):** Usa PM2 para que el bot reviva si se cae: 
   ```bash
   pm2 start sd-host.js --name street-district -- TU_TOKEN

5. **Orden de Declaraciones:** Cuidado con el hoisting[cite: 1]. `const` y `let` a nivel de módulo deben declararse **antes** de ser usados en lógicas de inicialización (`ReferenceError: Cannot access 'X' before initialization`)[cite: 1].

### 🎨 Convenciones de Estilo (Street District)
- **Idioma:** Todo el código, variables mixtas y avisos en **Español**[cite: 1].
- **Tipografías:** Usamos unicode generado por funciones (`mono()` y `fraktur()`) para estética matemática/elegante en el chat[cite: 1]. No transcribir a mano[cite: 1].
- **Colores HaxBall:** Blanco (`0xffffff`) para principal, `colorMuted` (`0xB0B0B0`, estilo small) para separadores `- • • •`[cite: 1].
- **Identidad de Marca:** El emoji **🐺** está reservado para cosas del core de la sala (Anuncios de fin de partido, Bienvenida, Líder de Manada)[cite: 1]. No lo uses para mensajes genéricos[cite: 1].
</details>

---

<div align="center">
<br/>

**Hecho con 🐺❤️ para Street District y la comunidad chilena de HaxBall**

</div>   
