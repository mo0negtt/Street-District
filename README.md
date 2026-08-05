<div align="center">
<img width="400" height="300" alt="Logo-SD" src="https://github.com/user-attachments/assets/ed6f27c1-a5d7-4c97-abbe-69cdb4a4b29b" />
<div align="center">
<div align="center">
<h1>🐺 Street District</h1>
Host headless y comunidad de HaxBall Futsal (Chile 🇨🇱)
<p align="center">
  
---

<h2><a id="agradecimientos"></a>Créditos y Fork</h2>

Street District utiliza como base y fuente de inspiración la arquitectura y mecánicas físicas avanzadas de **haxball-curve-bot-v2** creado por Bugra Murat.

[![GitHub Fork](https://img.shields.io/badge/Fork%20de-bugramurat%2Fhaxball--curve--bot--v2-24292e?style=for-the-badge&logo=github&logoColor=white&labelColor=0d1117)](https://github.com/bugramurat/haxball-curve-bot-v2)

---

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
> **Street District** corre sobre un único script (`sd-host.js`) que levanta la sala headless usando la librería `node-haxball`. Fiel a nuestro estilo **Gana Sigue 4v4** y con la estética de **La Manada (🐺)**. No requiere un proceso de build ni frameworks adicionales[cite: 1].

---

<div align="center">

<h2><a id="acerca"></a>🐺 ¿Qué es Street District?</h2>

Es el bot y host oficial de **Street District**, sala chilena de HaxBall configurada para el clásico modo **futsal 4v4 (a 4 goles)**[cite: 1]. Diseñado para mantener vivo al rey de la pista con un sistema ágil de **"gana sigue"**[cite: 1]. Implementa mecánicas avanzadas (efecto, lob-shot, power), un sistema robusto de clanes y estadísticas persistentes[cite: 1]. Todo bajo nuestra emblemática temática de **Lobo** heredada del servidor de Discord.

</div>

---

<h2><a id="arquitectura"></a>🏗️ Arquitectura y Funciones</h2>

El proyecto está contenido en un script plano de aproximadamente 4900 líneas y se divide en los siguientes sistemas base[cite: 1]:

### 🛡️ Identidad, Persistencia y Clanes
- **ID Permanente (`stats.json`):** Cada cuenta (`player.auth`) recibe un ID único de por vida y guarda sus goles/asistencias totales[cite: 1].
- **Sistema de Clanes (`clans.json`):** Los jugadores pueden fundar clanes únicos (Tag, Color, Emoji). Requiere mínimo 30 goles+asistencias históricos para crearlo[cite: 1].
- **Admins y Roles:** Gestión de admin real de HaxBall en caliente (`admins.json`) y jerarquías del bot (VIP, VIP_PLUS, MOD, MASTER) en `roles.json`[cite: 1].

### ⚽ Mecánicas de Juego y "Gana Sigue"
- **Rotación Automática:** El equipo ganador (mejor de 4 goles) se queda. Los perdedores pasan a espectador y entra la siguiente escuadra respetando el tamaño del equipo (nunca a la fuerza 4v4 si hay menos)[cite: 1].
- **Mecánicas Físicas Custom:** 
  - **Habilidades:** Curva (`c`), Lob-shot elevado (`l`), Power recto (`p`/`s`). Representados con una barra de carga visual (joints)[cite: 1].
  - **Travesaño Real:** Colisión dinámica. La pelota atraviesa normalmente los segmentos 125 y 126 (`fx4.hbs`), pero en un lob-shot cambia a `cGroup: cf.c3` y colisiona[cite: 1].
- **Detecciones Avanzadas:** 
  - Goles de media cancha (20m+), ¡AL PALO! (con cooldown de 5s por bug visual de HaxBall), ¡ATAJADA! 🧤 (defensas in-extremis), asistencias (2/3 últimos toques) y autogoles[cite: 1].

### 💬 Avatares Dinámicos y Chat Inteligente
- **Avatares por Acción:** Destellan y vuelven a la normalidad: Asistencia (👟), Atajada (🧤), Gol (⚽/🏆/🎉)[cite: 1].
- **Líder de la Manada 🐺:** Quien tenga más Goles+Asistencias en la sesión conectada, lleva prioridad en su avatar[cite: 1]. Jugadores nuevos reciben (🆕)[cite: 1].
- **Anti-Spam y Anti-AFK:** Bloqueo de chat (4 msj en 5s -> mute por 5 min). Expulsión por 15s inactivo **solo** si el jugador está en cancha durante una partida activa[cite: 1].

---

<h2><a id="comandos"></a>⌨️ Comandos y Atajos</h2>

El bot soporta prefijos para hablar en privado y comandos de gestión completos.

#### 🗣️ Chat y Comunicación
| Prefijo | Acción |
| :--- | :--- |
| `t <mensaje>` | **Chat de Equipo:** Solo lo lee tu equipo actual (los specs no tienen acceso)[cite: 1]. |
| `tc <mensaje>` | **Chat de Clan:** Solo lo leen tus compañeros de clan conectados en la sala[cite: 1]. |

#### 🛡️ Comandos de Clan
| Comando | Descripción |
| :--- | :--- |
| `!clan crear <TAG> <#HEX> <EMOJI> <Nombre>` | Crea un clan (Ej: `!clan crear SD #ff0000 🐺 Street District`). Requiere 30 stats[cite: 1]. |
| `!clan invitar <Nick o [ID]>` | Invita a un jugador a tu clan (Exclusivo del fundador)[cite: 1]. |
| `!clan aceptar` / `!clan rechazar` | Responde a una invitación pendiente (Expira en 2 minutos)[cite: 1]. |
| `!clan salir` | Abandonas tu clan. Si eres el último, el clan se disuelve automáticamente[cite: 1]. |
| `!clan [TAG]` | Muestra la información de un clan (O el tuyo si omites el TAG)[cite: 1]. |
| `!top clan` | Muestra el ranking de clanes sumando Goles+Asistencias de sus miembros[cite: 1]. |

---

<h2><a id="instalacion"></a>🔁 Flujo de Instalación</h2>

1. **Dependencias:** Ejecuta `npm install` (solo instala `node-haxball`)[cite: 1].
2. **Mapa:** Asegúrate de que tu estadio (`fx4.hbs`) esté en la misma carpeta[cite: 1].
3. **Arranque Básico:** `node sd-host.js TU_HEADLESS_TOKEN`[cite: 1]
4. **Producción (Recomendado):** Usa PM2 para que el bot reviva si se cae[cite: 1]: 
   ```bash
   pm2 start sd-host.js --name street-district -- TU_TOKEN

<div align="center">
<br/>

**🇵🇸❤️**

</div>   
