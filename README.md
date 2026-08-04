<div align="center">

# SD-Host
### Bot y host headless para salas de futsal de HaxBall

<p align="center">
  🇪🇸 Español
</p>

<br/>

[![Version](https://img.shields.io/badge/version-1.0.0-00d4ff?style=for-the-badge&labelColor=0d1117)]()
[![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white&labelColor=0d1117)]()
[![License](https://img.shields.io/badge/license-MIT-00d4ff?style=for-the-badge&labelColor=0d1117)]()

[**Acerca de**](#acerca) · [**Funciones**](#funciones) · [**Instalación**](#instalacion) · [**Comandos**](#comandos) · [**Gotchas**](#gotchas)

</div>

> [!TIP]
> **SD-Host** es un único archivo (`sd-host.js`) que levanta una sala headless de HaxBall usando la librería `node-haxball`. No requiere un proceso de build ni frameworks; es un script plano que se ejecuta directamente con Node.

---

<div align="center">

<h2><a id="acerca"></a>🖥️ ¿Qué es SD-Host?</h2>

Es un bot y host de sala de HaxBall configurado para el modo futsal (actualmente 4v4 a 4 goles). Implementa mecánicas adicionales avanzadas como efecto (curva), tiros elevados (lob-shot), tiros potentes (power recto), sprint/slide y colisiones con el travesaño. Además, cuenta con un robusto sistema de persistencia y clanes.

</div>

---

<h2><a id="funciones"></a>✨ Funciones Principales</h2>

<table>
<tr>
<td width="50%" valign="top">

#### 🛡️ Identidad y Persistencia
- **ID Permanente** — Se asigna un identificador único la primera vez que la cuenta ingresa, guardando estadísticas en `stats.json`.
- **Admins y Roles** — Gestión de permisos reales de HaxBall y roles internos (VIP, MOD, MASTER) editables en caliente vía `admins.json` y `roles.json`.
- **Avatares Dinámicos** — Destellan emojis específicos según las acciones en partida (goles, asistencias, atajadas) y distinguen al "Líder de la Manada".

</td>
<td width="50%" valign="top">

#### ⚽ Mecánicas de Juego y Chat
- **Sistema Gana-Sigue** — El equipo ganador permanece en la cancha; el perdedor pasa a espectadores y entran los siguientes en la cola.
- **Físicas Extra** — Barra de carga de habilidades usando discos unidos por *joints* (curva, lob-shot, power) y detección precisa de colisiones con los postes.
- **Chat Avanzado** — Incluye chat global con prefijos de clan, chat de equipo (`t`), chat de clan (`tc`), anti-spam y bloqueo post-partido.

</td>
</tr>
</table>

---

<h2><a id="instalacion"></a>🔁 Flujo de Instalación</h2>

1. **Instala** las dependencias corriendo `npm install` (solo requiere `node-haxball`).
2. **Asegúrate** de que el archivo del estadio (`fx4.hbs`) esté en el mismo directorio que el script.
3. **Ejecuta** el servidor con el token obtenido desde la web de HaxBall: `node sd-host.js TU_HEADLESS_TOKEN`.
4. **Producción:** Se recomienda usar PM2 en lugar de Node directo para reiniciar automáticamente ante caídas (`pm2 start sd-host.js --name sd-room -- TU_TOKEN`).

---

<h2><a id="comandos"></a>⌨️ Comandos y Atajos (Chat)</h2>

| Comando | Acción |
| :--- | :--- |
| `!clan crear <TAG> <#COLOR> <EMOJI> <Nombre>` | Crea un clan nuevo. Requiere un mínimo de 30 goles/asistencias. |
| `!clan invitar <jugador o [ID]>` | Invita a un jugador (solo el fundador puede hacerlo). |
| `!clan aceptar` / `!clan rechazar` | Responde a una invitación de clan (expira en 2 minutos). |
| `t <mensaje>` / `tc <mensaje>` | Envía un mensaje exclusivo al equipo (`t`) o a los miembros del clan (`tc`). |

---

<h2><a id="gotchas"></a>🔒 Decisiones de Diseño y "Gotchas"</h2>

| Decisión / Problema | Razón y Solución |
| :--- | :--- |
| **Asincronía de `node-haxball`** | Funciones como `room.setPlayerTeam` no actualizan el estado en el mismo tick. **Solución:** Tomar un snapshot al inicio y aplicar todos los cambios al final de la función. |
| **Detección de Postes/Travesaño** | La pelota aumenta su radio a 31 durante la celebración de gol. **Solución:** Aplicar un *cooldown* post-gol para evitar colisiones falsas al inflarse la pelota. |
| **Edición manual de JSONs** | Editores como VSCode cambian el inodo del archivo al guardar, rompiendo `fs.watch`. **Solución:** Se implementó `fs.watchFile` para hacer polling por ruta en `admins.json` y `roles.json`. |
| **Límites Visuales (Joints)** | Es imposible recolorear un *joint* de forma dinámica en una sala real fuera del modo sandbox. **Solución:** La habilidad "power recto" colorea directamente el disco principal de la pelota. |

---

<div align="center">
<br/>

**Hecho con ❤️ para la comunidad de HaxBall**

</div>
