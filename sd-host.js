// sd-host.js — bot/host de sala de HaxBall (node-haxball)
// Basado en un script original de BUGGYRAZ.
// Proyecto open source, licencia copyleft — ver LICENSE.
const {
  OperationType,
  VariableType,
  ConnectionState,
  AllowFlags,
  Direction,
  CollisionFlags,
  CameraFollow,
  BackgroundType,
  GamePlayState,
  BanEntryType,
  Callback,
  Utils,
  Room,
  Replay,
  Query,
  Library,
  RoomConfig,
  Plugin,
  Renderer,
  Errors,
  Language,
  EventFactory,
  Impl,
} = require("node-haxball")()
const fs = require("fs")
let room = null // declarada acá arriba: loadAdminAuths() la necesita al cargar el módulo, antes de que exista la sala
const Role = { PLAYER: 0, ADMIN: 5, VIP: 1, VIP_PLUS: 2, MOD: 3, MASTER: 4 } // ídem: roles.json la necesita al cargar

// ── Persistencia de stats (goles/asistencias) entre reinicios del bot ──────────
// Clave = player.auth (identifica a la cuenta, no cambia entre reconexiones).
const STATS_PATH = "stats.json"
let persistentStats = new Map()
function loadPersistentStats() {
  try {
    if (fs.existsSync(STATS_PATH)) {
      const raw = fs.readFileSync(STATS_PATH, "utf-8")
      persistentStats = new Map(Object.entries(JSON.parse(raw)))
    }
  } catch (err) {
    console.error("No se pudo leer stats.json, arranco en blanco:", err)
    persistentStats = new Map()
  }
}
loadPersistentStats()
let nextPlayerId = Math.max(0, ...[...persistentStats.values()].map((e) => e.id || 0)) + 1
function getOrAssignPlayerId(player) {
  if (!player || !player.auth || player.auth === "fake-auth-do-not-believe-it")
    return null
  const entry = persistentStats.get(player.auth)
  if (entry && entry.id) return entry.id
  const newEntry = entry || { name: player.name, goals: 0, assists: 0 }
  newEntry.id = nextPlayerId++
  persistentStats.set(player.auth, newEntry)
  scheduleStatsSave()
  return newEntry.id
}
let statsSaveTimer = null
function scheduleStatsSave() {
  clearTimeout(statsSaveTimer)
  statsSaveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(
        STATS_PATH,
        JSON.stringify(Object.fromEntries(persistentStats), null, 2),
      )
    } catch (err) {
      console.error("No se pudo guardar stats.json:", err)
    }
  }, 2000)
}
function recordPersistentStat(player, field, amount = 1) {
  if (!player || !player.auth || player.auth === "fake-auth-do-not-believe-it")
    return
  const entry = persistentStats.get(player.auth) || {
    name: player.name,
    goals: 0,
    assists: 0,
  }
  entry.name = player.name
  entry[field] = (entry[field] || 0) + amount
  persistentStats.set(player.auth, entry)
  scheduleStatsSave()
}

// ── Líder de la Manada ──────────────────────────────────────────────────────
// El jugador conectado con más goles+asistencias de la sesión (historial en
// stats.json) lleva el 🐺 de avatar. Se recalcula cada vez que alguien suma un gol o asistencia.
let packLeaderAuth = null
function recalculatePackLeader() {
  if (!room) return
  let best = null
  for (const p of room.players) {
    if (!p || !p.auth) continue
    const saved = persistentStats.get(p.auth)
    if (!saved) continue
    const score = (saved.goals || 0) * 2 + (saved.assists || 0)
    if (score > 0 && (!best || score > best.score)) {
      best = { player: p, score, auth: p.auth }
    }
  }
  const newLeaderAuth = best ? best.auth : null
  if (newLeaderAuth === packLeaderAuth) return // sin cambios, no hace falta tocar nada

  const prevLeader = room.players.find((p) => p && p.auth === packLeaderAuth)
  if (prevLeader) {
    prevLeader.isPackLeader = false
    restoreDefaultAvatarNow(prevLeader)
  }

  packLeaderAuth = newLeaderAuth
  if (best) {
    best.player.isPackLeader = true
    room.setPlayerAvatar(best.player.id, "🐺", true)
    room.sendAnnouncement(
      `🐺 ${mono(best.player.name)} ${fraktur('es el nuevo Lider de la Manada')}!`,
      null,
      colorInfo,
      "small",
      NotifSound.MENTION,
    )
  }
}

// ── Admins por auth ────────────────────
// Editá admins.json (un array de auths) mientras el bot está corriendo
const ADMINS_PATH = "admins.json"
let adminAuths = new Set()
function loadAdminAuths() {
  try {
    if (fs.existsSync(ADMINS_PATH)) {
      const raw = fs.readFileSync(ADMINS_PATH, "utf-8")
      const list = JSON.parse(raw)
      adminAuths = new Set(Array.isArray(list) ? list : [])
    } else {
      adminAuths = new Set()
      fs.writeFileSync(ADMINS_PATH, JSON.stringify([...adminAuths], null, 2))
      console.log(`[admins] Creé ${ADMINS_PATH} vacío — agregá tu auth ahí para tener el primer admin.`)
    }
    console.log(`[admins] ${adminAuths.size} auth(s) de admin cargados desde ${ADMINS_PATH}`)
    if (room) {
      room.players.forEach((p) => {
        if (!p || !p.auth) return
        const shouldBeAdmin = adminAuths.has(p.auth)
        if (shouldBeAdmin && !p.isAdmin) {
          room.setPlayerAdmin(p.id, true)
          p.isAutoAdmin = true
        } else if (!shouldBeAdmin && p.isAdmin && p.isAutoAdmin) {
          room.setPlayerAdmin(p.id, false)
          p.isAutoAdmin = false
        }
      })
    }
  } catch (err) {
    console.error(`No se pudo leer ${ADMINS_PATH}, sigo con la lista anterior:`, err)
  }
}
loadAdminAuths()

// ── Roles por auth (VIP / VIP_PLUS / MOD / MASTER), mismo mecanismo ────────────
// roles.json: { "auth": "VIP", "otroAuth": "MOD", ... }.
const ROLES_PATH = "roles.json"
const ROLE_NAME_TO_ID = { VIP: Role.VIP, VIP_PLUS: Role.VIP_PLUS, MOD: Role.MOD, MASTER: Role.MASTER }
let authRoles = new Map() // auth -> Role.*
function loadAuthRoles() {
  try {
    if (fs.existsSync(ROLES_PATH)) {
      const raw = fs.readFileSync(ROLES_PATH, "utf-8")
      const obj = JSON.parse(raw)
      authRoles = new Map()
      for (const [auth, roleName] of Object.entries(obj)) {
        const roleId = ROLE_NAME_TO_ID[String(roleName).toUpperCase()]
        if (roleId !== undefined) authRoles.set(auth, roleId)
      }
    } else {
      authRoles = new Map()
      fs.writeFileSync(ROLES_PATH, JSON.stringify({}, null, 2))
    }
    console.log(`[roles] ${authRoles.size} auth(s) con rol cargados desde ${ROLES_PATH}`)
  } catch (err) {
    console.error(`No se pudo leer ${ROLES_PATH}, sigo con la lista anterior:`, err)
  }
}
loadAuthRoles()
fs.watchFile(ADMINS_PATH, { interval: 2000 }, (curr, prev) => {
  if (curr.mtimeMs !== prev.mtimeMs) loadAdminAuths()
})
fs.watchFile(ROLES_PATH, { interval: 2000 }, (curr, prev) => {
  if (curr.mtimeMs !== prev.mtimeMs) loadAuthRoles()
})

// ── Clanes ───────────────────────────────────────────────────────────────────
// A diferencia de admins.json/roles.json (que edita un humano a mano), clans.json
// lo escribe el propio bot cuando alguien crea/edita un clan por comando — por
// eso no usa fs.watchFile, usa el mismo patrón de guardado con debounce que
// stats.json. clans.json: { "TAG": { tag, name, emoji, color, founderAuth, members: [auth,...] } }
const CLANS_PATH = "clans.json"
const CLAN_MIN_SCORE = 30 // goles+asistencias (historial) necesarios para poder fundar un clan
const CLAN_INVITE_TTL_MS = 2 * 60 * 1000 // las invitaciones expiran a los 2 minutos
const clanInvites = new Map() // auth del invitado -> { tag, invitedByName, expiresAt }
let clans = new Map() // tag -> { tag, name, emoji, color, founderAuth, members: Set<auth> }
let memberClanTag = new Map() // auth -> tag, se reconstruye cada vez que cambian los clanes
function rebuildMemberClanTag() {
  memberClanTag = new Map()
  for (const clan of clans.values()) {
    for (const auth of clan.members) memberClanTag.set(auth, clan.tag)
  }
}
function loadClans() {
  try {
    if (fs.existsSync(CLANS_PATH)) {
      const raw = fs.readFileSync(CLANS_PATH, "utf-8")
      const obj = JSON.parse(raw)
      clans = new Map(
        Object.entries(obj).map(([tag, c]) => [
          tag,
          { ...c, members: new Set(c.members || []) },
        ]),
      )
    } else {
      clans = new Map()
    }
  } catch (err) {
    console.error(`No se pudo leer ${CLANS_PATH}, arranco sin clanes:`, err)
    clans = new Map()
  }
  rebuildMemberClanTag()
}
loadClans()
let clansSaveTimer = null
function scheduleClansSave() {
  clearTimeout(clansSaveTimer)
  clansSaveTimer = setTimeout(() => {
    try {
      const obj = Object.fromEntries(
        [...clans.entries()].map(([tag, c]) => [
          tag,
          { ...c, members: [...c.members] },
        ]),
      )
      fs.writeFileSync(CLANS_PATH, JSON.stringify(obj, null, 2))
    } catch (err) {
      console.error(`No se pudo guardar ${CLANS_PATH}:`, err)
    }
  }, 1000)
}
function getPlayerScore(auth) {
  const saved = persistentStats.get(auth)
  return saved ? (saved.goals || 0) + (saved.assists || 0) : 0
}

/*
 ▄████▄   ▒█████   ███▄    █   █████▒██▓  ▄████
▒██▀ ▀█  ▒██▒  ██▒ ██ ▀█   █ ▓██   ▒▓██▒ ██▒ ▀█▒
▒▓█    ▄ ▒██░  ██▒▓██  ▀█ ██▒▒████ ░▒██▒▒██░▄▄▄░  
▒▓▓▄ ▄██▒▒██   ██░▓██▒  ▐▌██▒░▓█▒  ░░██░░▓█  ██▓
▒ ▓███▀ ░░ ████▓▒░▒██░   ▓██░░▒█░   ░██░░▒▓███▀▒
░ ░▒ ▒  ░░ ▒░▒░▒░ ░ ▒░   ▒ ▒  ▒ ░   ░▓   ░▒   ▒
  ░  ▒     ░ ▒ ▒░ ░ ░░   ░ ▒░ ░      ▒ ░  ░   ░
░        ░ ░ ░ ▒     ░   ░ ░  ░ ░    ▒ ░░ ░   ░
░ ░          ░ ░           ░         ░        ░
░

*/
//------------------------ ROOM CONFIG -----------------------------------------
const HEADLESS_TOKEN = process.argv[2] // 0 = node, 1 = index.js, 2 = token (https://www.haxball.com/headlesstoken)

const EMO = "🐺"
const ROOM_NAME = `░▒▓ ${EMO} [SD] 4v4 Futsal CURVE • LOB ▓▒░`

// ── Webhooks de Discord ─────────────────────────────────────────────────────
// Van SOLO por variable de entorno — nunca hardcodeados acá, este archivo es
// público. Correr el bot con `node --env-file=.env sd-host.js TOKEN` (Node
// 20.6+) usando .env como base .env.example, o exportar las variables antes
// de arrancar. Si falta alguna, ese webhook puntual simplemente no manda nada
// (sendDiscordEmbed ya contempla webhookUrl vacío).
const WEBHOOK_ROOM_OPEN = process.env.WEBHOOK_ROOM_OPEN || ""
const WEBHOOK_RECS = process.env.WEBHOOK_RECS || ""
const WEBHOOK_CALL_ADMIN = process.env.WEBHOOK_CALL_ADMIN || ""
const DISCORD_IMAGE_ROOM_OPEN =
  process.env.DISCORD_IMAGE_ROOM_OPEN ||
  "https://cdn.discordapp.com/attachments/1524879478831190181/1535056155213045811/host.png?ex=6a765ff3&is=6a750e73&hm=73c8117c12100b864eb25bdb20736f83ca2efb40a9d4c70e938f207c8738cd09&"
const DISCORD_IMAGE_RECS =
  process.env.DISCORD_IMAGE_RECS ||
  "https://cdn.discordapp.com/attachments/1524879478831190181/1535056154819039302/final.png?ex=6a765ff3&is=6a750e73&hm=21628daad8bb9901b2e5f4769b1ec41a0c69ee5c598660d52e47cd123c3073b2&"
const DISCORD_IMAGE_CALL_ADMIN =
  process.env.DISCORD_IMAGE_CALL_ADMIN ||
  "https://cdn.discordapp.com/attachments/1524879478831190181/1535056154420449340/admin.png?ex=6a765ff3&is=6a750e73&hm=3d8095f6945cd7dd4ff57fb70e744b6b5778ae400be879cdf5d024788f70cb79&"
async function sendDiscordEmbed(webhookUrl, embed, replayBuffer, content) {
  if (!webhookUrl) return
  try {
    let res
    const payload = {}
    if (content) payload.content = content
    if (embed) payload.embeds = [embed]
    if (replayBuffer && replayBuffer.length > 0) {
      const form = new FormData()
      form.append("payload_json", JSON.stringify(payload))
      form.append(
        "file",
        new Blob([replayBuffer], { type: "application/octet-stream" }),
        `replay-${Date.now()}.hbr2`,
      )
      res = await fetch(webhookUrl, { method: "POST", body: form })
    } else {
      res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
    }
    if (!res.ok) {
      console.error(`[webhook] Discord respondió ${res.status} al postear el embed`)
    }
  } catch (err) {
    console.error("[webhook] No se pudo postear el embed a Discord:", err)
  }
}
const ADMIN_CLAIM_CODE =
  process.env.ADMIN_CLAIM_CODE ||
  (() => {
    const generated = Math.random().toString(36).slice(2, 10)
    console.log(`[admin] No seteaste ADMIN_CLAIM_CODE por variable de entorno — código generado para esta sesión: ${generated}`)
    return generated
  })()
const MAX_PLAYER_NUMBER = 24

const IS_PUBLIC = false
const TIME_LIMIT = 0
const SCORE_LIMIT = 0

const testGE = true // Activa el efecto visual de gol
let GOAL_TEXT = "!!!" // !!! = Nada

//------------------------ ABILITY CONFIG -----------------------------------------
let ENABLE_SPRINT_AND_SLIDE = true // Habilita el sprint y el slide
let ENABLE_BANANA = true // Habilita el centro curvo para el lob-shot
let ENABLE_POW_AND_ULTI = true // Habilita el power-shot fuerte y el tiro controlable en el tiro con curva
let SPRINT_DUR = 1000 // Duración del sprint (1s)
let OP_DUR = 10000 // Duración del sprint en modo OP (10s)

const CURVED_SHOT_MULTIPLIER = 0.15 // Multiplica el efecto de curva de la pelota en el tiro con curva
const CURVED_SHOT_DURATION = 1 // Curved shot duration in seconds

//------------------------ STADIUM CONFIG -----------------------------------------
const STADIUM_PATH_F = "fx4.hbs" // El mapa debe tener suficientes discos y joints para la barra deslizante; ajustar los IDs de disco de abajo si se cambia de mapa
var currentStartDisc = 5 // ID del primer disco de la barra deslizante para el tiro con curva (ajustar según el mapa)
var currentStartDiscL = 100 // ID del primer disco de la barra deslizante para el lob-shot (ajustar según el mapa)

// Para usar en otro mapa: agregar 6 discos y conectarlos con 4 joints como se muestra abajo, ajustando los IDs de disco correspondientes
/*
		{ "radius" : 0, "pos" : [-1000,-1000 ], "cGroup" : ["c2" ] }, // 9
		{ "radius" : 0, "pos" : [-1000,-1000 ], "cGroup" : ["c2" ] }, // 10
		{ "radius" : 0, "pos" : [-1000,-1000 ], "cGroup" : ["c2" ] }, // 11
		{ "radius" : 0, "pos" : [-1000,-1000 ], "cGroup" : ["c2" ] }, // 104
		{ "radius" : 0, "pos" : [-1000,-1000 ], "cGroup" : ["c2" ] }, // 105
		{ "radius" : 0, "pos" : [-1000,-1000 ], "cGroup" : ["c2" ] }, // 106

		{ "d0" : 9, "d1" : 10, "strength" : 0.000002, "color" : "000000", "length" : null },
		{ "d0" : 9, "d1" : 11, "strength" : 0.000002, "color" : "ffffff", "length" : null },
		{ "d0" : 104, "d1" : 105, "strength" : 0.000002, "color" : "000000", "length" : null },
		{ "d0" : 104, "d1" : 106, "strength" : 0.000002, "color" : "FFFF00", "length" : null }
*/

const kitsInfo =
  "[0] Colo Colo, [1] U de Chile, [2] Católica, [3] Audax, [4] Cobresal, [5] Huachipato, [6] Limache, [7] Palestino, [8] Coquimbo , [9] Concepción, [10] Everton, [11] La Serena, [12] O'Higgins, [13] UdeC, [14] La Calera, [15] Ñublense, [16] Antofagasta, [17] Copiapó, [18] Magallanes, [19] Temuko, [20] Cúrico, [21] Iquique, [22] Rangers, [23] Santiago W, [24] Union Española, [25] Puerto Montt" // Los VIP pueden verlo con el comando !s o !shirts
function getKitName(index) {
  if (typeof index !== "number" || index < 0) return null
  const match = kitsInfo.match(new RegExp(`\\[${index}\\]\\s*([^,]+)`))
  return match ? match[1].trim() : null
}
const dbKits = [
  [{ t: "🔲CC" }, { a: 0, c0: 0x0E0E0E, c1: 0xFAFAFA }],
  [{ t: "🦉UCH" }, { a: 0, c0: 0xC62137, c1: 0x2C2E6E }],
  [
    { t: "🧊UC" },
    { a: 90, c0: 0xC62137, c1: 0xEBEBF5, c2: 0x588ca9, c3: 0xEBEBF5 },
  ],
  [
    { t: "🍕AUD" },
    { a: 0, c0: 0xF1F6F0, c1: 0x219F53 },
  ],
  [
    { t: "⛏️COB" },
    { a: 0, c0: 0x36BB5E, c1: 0xEBEBF5, c2: 0xD86737, c3: 0xEBEBF5 },
  ],
  [{ t: "🏐HUA" }, { a: 0, c0: 0xDADADA, c1: 0x2B2B5A, c2: 0xdb0030, c3: 0x2B2B5A }],
  [{ t: "🍅LIM" }, { a: 0, c0: 0xDADADA, c1: 0xA81D2F, c2: 0x1E1D25, c3: 0xA81D2F }],
  [
    { t: "🍉PAL" },
    { a: 0, c0: 0x1D1D1D, c1: 0xDEDEDE, c2: 0x3DA860, c3: 0xCC1010 },
  ],
  [
    { t: "🏴‍☠️COQ" },
    { a: 0, c0: 0x1D1D1D, c1: 0xD4BD2A },
  ],
  [{ t: "🟣CON" }, { a: 0, c0: 0xF0D5F4, c1: 0x6747A9 }],
  [{ t: "🌴EVE" }, { a: 90, c0: 0xF3F3F4, c1: 0x4536A9, c2: 0xBEAF4F, c3: 0x4536A9 }],
  [
    { t: "🤺SER" },
    { a: 0, c0: 0xF3F3F4, c1: 0x831E49 },
  ],
  [{ t: "🦅OHI" }, { a: 0, c0: 0xF3F3F4, c1: 0x0B94BD, c2: 0x299BBE }],
  [
    { t: "👨‍🎓UDC" },
    { a: 0, c0: 0x334D89, c1: 0xDCC811 },
  ],
  [{ t: "🔘CAL" }, { a: 0, c0: 0x334D89, c1: 0xDC1E2B, c2: 0xECECEC, c3: 0xDC1E2B }],
  [{ t: "👿ÑUB" }, { a: 45, c0: 0xF2F2F2, c1: 0xB3292D, c2: 0xAA272B }],
  [
    { t: "🐆ANT" },
    { a: 0, c0: 0xF23353, c1: 0xE5E4EB, c2: 0x4A1AAA },
  ],
  [{ t: "🏮COP" }, { a: 0, c0: 0xF23353, c1: 0xEDEBF3 }],
  [
    { t: "⚓MAG" },
    { a: 0, c0: 0x1F2027, c1: 0x3AA3F3, c2: 0xE7E7E7, c3: 0x3AA3F3 },
  ],
  [{ t: "🥀TEM" }, { a: 90, c0: 0x1F2027, c1: 0x239253, c2: 0xE7E7E7, c3: 0xE7E7E7 }],
  [{ t: "👑CUR" }, { a: 45, c0: 0x1F2027, c1: 0xFAFAFA, c2: 0xE7243E, c3: 0xFAFAFA }],
  [{ t: "🐲IQU" }, { a: 45, c0: 0x1F2027, c1: 0x1BA1FA, c2: 0x2198E7 }],
  [
    { t: "🌭RAN" },
    { a: 0, c0: 0xE6EDFB, c1: 0xD91A2D, c2: 0x1B191B, c3: 0xD91A2D },
  ],
  [
    { t: "🌳WAN" },
    { a: 0, c0: 0xE6EDFB, c1: 0x245F26 },
  ],
  [
    { t: "🥘UE" },
    { a: 0, c0: 0xFBCF22, c1: 0xCA1616 },
  ],
  [{ t: "🐬PMT" }, { a: 0, c0: 0x2DA040, c1: 0xE1E3E1 }],
]
let homeTeam = Math.floor(Math.random() * dbKits.length)
let awayTeam
do awayTeam = Math.floor(Math.random() * dbKits.length)
while (homeTeam === awayTeam)

/*
    ╔══════════════════════════════════════════════════════════════════════════════════════════════════════════╗
    ║                                          C O N F I G     E N D                                           ║
    ╚══════════════════════════════════════════════════════════════════════════════════════════════════════════╝
*/

const originalLog = console.log
console.log = function (...args) {
  const now = new Date()
  const timeString = now.toLocaleTimeString()
  originalLog.call(console, `[${timeString}]`, ...args)
}

/*
 ▒█████  ▄▄▄█████▓ ██░ ██ ▓█████  ██▀███
▒██▒  ██▒▓  ██▒ ▓▒▓██░ ██▒▓█   ▀ ▓██ ▒ ██▒
▒██░  ██▒▒ ▓██░ ▒░▒██▀▀██░▒███   ▓██ ░▄█ ▒
▒██   ██░░ ▓██▓ ░ ░▓█ ░██ ▒▓█  ▄ ▒██▀▀█▄
░ ████▓▒░  ▒██▒ ░ ░▓█▒░██▓░▒████▒░██▓ ▒██▒
░ ▒░▒░▒░   ▒ ░░    ▒ ░░▒░▒░░ ▒░ ░░ ▒▓ ░▒▓░
  ░ ▒ ▒░     ░     ▒ ░▒░ ░ ░ ░  ░  ░▒ ░ ▒░
░ ░ ░ ▒    ░       ░  ░░ ░   ░     ░░   ░
    ░ ░            ░  ░  ░   ░  ░   ░

*/
var stadiumF
fs.readFile(STADIUM_PATH_F, "utf8", (err, data) => {
  if (err) {
    console.error("Error reading the file:", err)
    return
  }
  const cleanData = data.replace(/\/\*[\s\S]*?\*\//g, '')
  stadiumF = JSON.parse(cleanData)
})
let stadiumWidth = 900
const emojiAtt = "⚠️"
const emojiQuest = "❓"
const emojiInfo = "ℹ️"
const emojiSucces = "✅"
const colorAtt = 0xd2ad78ff
const colorInfo = 0xd2ad78ff
const colorSucces = 0xd2ad78ff
const colorBlue = 0x4f99df
const colorRed = 0xf85651
const colorMuted = 0xB0B0B0
const colorDiscord = 0xd2ad78ff
const colorWhite = 0xfff2d6ff
const controlsString = `${EMO} 𝖱𝖾𝗀𝖺𝗍𝖾 𝗉𝖺𝗋𝖺 𝐂𝐔𝐑𝐕𝐀, 𝐓𝐈𝐑𝐎𝐒 𝐄𝐍 𝐀𝐋𝐓𝐎, 𝐓𝐈𝐑𝐎𝐒 𝐀𝐔𝐓𝐎𝐌𝐀́𝐓𝐈𝐂𝐎𝐒 𝗒 𝐏𝐎𝐖𝐄𝐑. 𝖠𝗃𝗎𝗌𝗍𝖺 𝗅𝖺 𝖼𝗎𝗋𝗏𝖺 𝖼𝗈𝗅𝗈𝖼𝖺́𝗇𝖽𝗈𝗍𝖾 𝖽𝖾 𝖼𝖺𝗋𝖺 𝖺𝗅 𝖻𝖺𝗅𝗈́𝗇. 𝖤𝗇 𝗆𝗈𝖽𝗈 𝖢𝗎𝗋𝗏𝖺, 𝖼𝗈𝗇 𝖻𝖺𝗋𝗋𝖺 𝗅𝗅𝖾𝗇𝖺 𝗁𝖺𝖼𝖾𝗌 𝗎𝗇 𝐓𝐈𝐑𝐎 𝐏𝐎𝐓𝐄𝐍𝐓𝐄, 𝗒 𝗌𝗂 𝖾𝗅 𝖻𝖺𝗅𝗈́𝗇 𝗌𝖾 𝗏𝗎𝖾𝗅𝗏𝖺 𝖺𝗓𝗎𝗅, 𝗎𝗇 𝐓𝐈𝐑𝐎 𝐂𝐎𝐍𝐓𝐑𝐎𝐋𝐀𝐃𝐎 (𝗆𝗎𝖾́𝗏𝖾𝗅𝗈 𝖼𝗈𝗇 𝗅𝖺𝗌 𝖿𝗅𝖾𝖼𝗁𝖺𝗌). 𝖤𝗇 𝖾𝗅 «𝐋𝐨𝐛», 𝖾𝗅 𝗀𝗈𝗅 𝗇𝗈 𝖼𝗎𝖾𝗇𝗍𝖺 𝗁𝖺𝗌𝗍𝖺 𝗊𝗎𝖾 𝖾𝗅 𝖻𝖺𝗅𝗈́𝗇 𝗍𝗈𝗊𝗎𝖾 𝖾𝗅 𝗌𝗎𝖾𝗅𝗈. 𝖯𝖺𝗋𝖺 «𝐒𝐋𝐈𝐃𝐄», 𝗆𝖺𝗇𝗍𝖾́𝗇 𝗉𝗎𝗅𝗌𝖺𝖽𝗈 X 𝗒 𝗌𝗎𝖾́𝗅𝗍𝖺𝗅𝗈 𝖺𝗅 𝗏𝖾𝗋 𝗅𝖺 𝗓𝖺𝗉𝖺𝗍𝗂𝗅𝗅𝖺; 𝗉𝖺𝗋𝖺 «𝐒𝐏𝐑𝐈𝐍𝐓», 𝗆𝖺𝗇𝗍𝖾́𝗇 𝗉𝗎𝗅𝗌𝖺𝖽𝗈 X 𝗌𝗂𝗇 𝗌𝗈𝗅𝗍𝖺𝗋𝗅𝗈.`
const helpString = `${EMO} !𝖼𝗈𝗇𝗍𝗋𝗈𝗅𝗌 ${EMO} 𝖼 - 𝗅 - 𝗉/𝗌 - 𝗇 (ᴄᴜʀᴠᴀ, lᴏʙ-sʜᴏᴛ, ᴘᴏᴡᴇʀ ʀᴇᴄᴛᴏ, ɴᴏʀᴍᴀʟ) ${EMO} 𝗍 <mensaje> (chat de equipo) ${EMO} 𝗍𝖼 <mensaje> (chat de clan) ${EMO} !𝖼𝗅𝖺𝗇 / !𝖼𝗅𝖺𝗇 𝖼𝗋𝖾𝖺𝗋 / !𝖼𝗅𝖺𝗇 𝗂𝗇𝗏𝗂𝗍𝖺𝗋 / !𝖼𝗅𝖺𝗇 𝖺𝖼𝖾𝗉𝗍𝖺𝗋 / !𝖼𝗅𝖺𝗇 𝗌𝖺𝗅𝗂𝗋 ${EMO} !𝗍𝗈𝗉 𝖼𝗅𝖺𝗇 ${EMO}  !𝗅𝗅𝖺𝗆𝖺𝗋𝖺𝖽𝗆𝗂𝗇 <ʀᴀᴢᴏ́ɴ> ${EMO} !𝗈𝗉 (ᴀᴄᴛɪᴠᴀʀ/ᴅᴇsᴀᴄᴛɪᴠᴀʀ ᴏᴘ ᴍᴏᴅᴇ) ${EMO} !𝗌𝗅 (ᴀᴄᴛɪᴠᴀʀ/ᴅᴇsᴀᴄᴛɪᴠᴀʀ sʟɪᴅᴇ) ${EMO} !𝗄𝗂𝗍𝗌 (ᴄᴀᴍʙɪᴀʀ ᴋɪᴛ) ${EMO} !𝗆𝖾𝗆𝗂𝖽𝖾/𝗆𝖾𝖽𝗂𝗋𝗆𝖾 ${EMO} !𝗏𝖾𝗋𝗌𝗎𝗌/𝗏𝗌 ${EMO} !𝖽𝖺𝖽𝗈/𝗋𝗈𝗅𝗅[𝗇*] ${EMO} !𝗅𝗎𝖼𝗄/𝗌𝗎𝖾𝗋𝗍𝖾/𝖿𝗈𝗋𝗍𝗎𝗇𝗂𝗈 ${EMO} !𝗁𝖾𝗅𝗉𝖺𝖽𝗆𝗂𝗇/𝖼𝗆𝖽𝖺𝖽𝗆𝗂𝗇/𝖼𝗈𝗆𝖺𝗇𝖽𝗈𝗌𝖺𝖽𝗆𝗂𝗇 (sᴏʟᴏ ᴀᴅᴍɪɴs)`
const adminHelpString = `${EMO} !helpadmin/!cmdadmin/!comandosadmin ${EMO} !kick <ᴊᴜɢᴀᴅᴏʀ> [ʀᴀᴢᴏ́ɴ] ${EMO}  !ban <ᴊᴜɢᴀᴅᴏʀ> [ʀᴀᴢᴏ́ɴ] ${EMO}  !tempban <ᴊᴜɢᴀᴅᴏʀ> <ᴅᴜʀᴀᴄɪᴏ́ɴ> [ʀᴀᴢᴏ́ɴ] ${EMO}  !unban <ᴊᴜɢᴀᴅᴏʀ> ${EMO}  !mute <ᴊᴜɢᴀᴅᴏʀ> ${EMO}  !unmute <ᴊᴜɢᴀᴅᴏʀ> ${EMO}  !clearbans ${EMO}  !mover <ᴊᴜɢᴀᴅᴏʀ> <ʀᴏᴊᴏ|ᴀᴢᴜʟ|ᴇsᴘ> ${EMO}  !kitsrand ${EMO}  (en <ᴊᴜɢᴀᴅᴏʀ> también sirve el [ID] del chat)`
const dobleteRelatoVariants = [
  "✌️ Relato: ¡{player} repite y ya lleva dos en el partido!",
  "✌️ Relato: ¡Segundo de {player} a los {time}, está on fire!",
  "✌️ Relato: ¡Otra vez {player}! Ya son dos en la cuenta.",
  "✌️ Relato: ¡No se conforma {player}, doblete a los {time}!",
  "✌️ Relato: ¡{player} le toma el gusto al arco, van dos!",
  "✌️ Relato: ¡Segundo grito de {player} en el minuto {time}!",
  "✌️ Relato: ¡{player} está imparable, doblete en el {time}!",
  "✌️ Relato: ¡De nuevo {player}! Doblete confirmado.",
  "✌️ Relato: ¡{player} se pone el partido al hombro, van dos goles!",
  "✌️ Relato: ¡Ya son dos para {player}, no se detiene!",
]
const hattrickRelatoVariants = [
  "🎩 Relato: ¡HAT-TRICK de {player} a los {time}! ¡Se pone el sombrero!",
  "🎩 Relato: ¡Tercero de {player}! Hat-trick completo en el minuto {time}.",
  "🎩 Relato: ¡No hay quien pare a {player}, hat-trick a los {time}!",
  "🎩 Relato: ¡{player} completa el hat-trick en el {time}, noche redonda!",
  "🎩 Relato: ¡Triplete de {player}! Se saca el sombrero en el minuto {time}.",
  "🎩 Relato: ¡Otra vez {player}! Tres goles y el partido en el bolsillo.",
  "🎩 Relato: ¡Hat-trick histórico de {player} a los {time}!",
  "🎩 Relato: ¡{player} se despacha con tres goles, hat-trick en el {time}!",
  "🎩 Relato: ¡Va por el póker! {player} lleva tres en el minuto {time}.",
  "🎩 Relato: ¡Noche mágica para {player}, hat-trick a los {time}!",
]
const goalRelatoVariants = [
  "🎙️ Relato: ¡Gol de {player} a los {time}!",
  "🎙️ Relato: ¡GOOOOL de {player} en el minuto {time}!",
  "🎙️ Relato: ¡La mandó a guardar {player} a los {time}!",
  "🎙️ Relato: ¡No perdona {player} en el {time}!",
  "🎙️ Relato: ¡Qué manera de definir de {player} a los {time}!",
  "🎙️ Relato: ¡Aparece {player} y castiga en el minuto {time}!",
  "🎙️ Relato: ¡La clavó {player} a los {time}!",
  "🎙️ Relato: ¡Golazo de {player} en el {time}!",
  "🎙️ Relato: ¡Imparable {player} a los {time}!",
  "🎙️ Relato: ¡Qué definición de {player} en el minuto {time}!",
  "🎙️ Relato: ¡Se hace presente {player} a los {time}!",
  "🎙️ Relato: ¡Gol y celebración para {player} en el {time}!",
  "🎙️ Relato: ¡Marca {player} a los {time} cuando más lo necesitaban!",
  "🎙️ Relato: ¡Tremendo remate de {player} en el minuto {time}!",
  "🎙️ Relato: ¡La puso junto al palo {player} a los {time}!",
  "🎙️ Relato: ¡Nada que hacer para el arquero, gol de {player} en el {time}!",
  "🎙️ Relato: ¡Qué aparición de {player} a los {time}!",
  "🎙️ Relato: ¡Gol convertido por {player} en el minuto {time}!",
  "🎙️ Relato: ¡La pelota termina adentro gracias a {player} a los {time}!",
  "🎙️ Relato: ¡Otra vez aparece {player} en el {time}!",
  "🎙️ Relato: ¡La empuja {player} a los {time} y es gol!",
  "🎙️ Relato: ¡Gol, señoras y señores! Convierte {player} en el minuto {time}.",
  "🎙️ Relato: ¡Se abre el marcador con {player} a los {time}!",
  "🎙️ Relato: ¡Pizarrón puro y gol de {player} a los {time}!",
  "🎙️ Relato: ¡Bombazo inatajable de {player} en el minuto {time}!",
  "🎙️ Relato: ¡Rompió el arco {player} a los {time}!",
  "🎙️ Relato: ¡Magia pura de {player} en el {time} para el gol!",
  "🎙️ Relato: ¡A los {time}, {player} levanta a toda la sala con este golazo!",
  "🎙️ Relato: ¡Qué zapatazo sacó {player} a los {time}!",
  "🎙️ Relato: ¡Se sacó a todos de encima {player} y anota en el minuto {time}!",
  "🎙️ Relato: ¡Soberbio remate de {player} a los {time} que infla la red!",
  "🎙️ Relato: ¡Grito de desahogo para {player} en el {time}!",
  "🎙️ Relato: ¡La pinchó {player} a los {time}, un gol de antología!",
  "🎙️ Relato: ¡No lo para nadie a {player}! Golazo en el minuto {time}.",
  "🎙️ Relato: ¡Le pegó con un fierro {player} a los {time}!",
  "🎙️ Relato: ¡Juegan todos y define {player} a los {time}!",
  "🎙️ Relato: ¡Punterazo letal de {player} en el {time}!",
  "🎙️ Relato: ¡A los {time}, {player} decreta un nuevo tanto en el marcador!",
  "🎙️ Relato: ¡Explota todo con el gol de {player} en el {time}!",
  "🎙️ Relato: ¡Qué sangre fría tuvo {player} a los {time}!",
  "🎙️ Relato: ¡Define {player} a los {time} y adentro!",
  "🎙️ Relato: ¡La dejó imposible {player} en el minuto {time}!",
  "🎙️ Relato: ¡A cobrar! Marca {player} a los {time}.",
  "🎙️ Relato: ¡Se enciende el partido gracias a {player} en el {time}!",
  "🎙️ Relato: ¡Gol que puede valer oro para {player} a los {time}!"
]
const assistRelatoVariants = [
  "🅰️ Relato: Asistencia de {assist} para {player} a los {time}.",
  "🅰️ Relato: Gran pase de {assist}, gol de {player} en el minuto {time}.",
  "🅰️ Relato: En el {time}, {assist} la dejó servida para {player}.",
  "🅰️ Relato: Tremenda habilitación de {assist} a los {time}.",
  "🅰️ Relato: La armó {assist} y la definió {player} en el minuto {time}.",
  "🅰️ Relato: A los {time}, todo nació en los pies de {assist}.",
  "🅰️ Relato: Excelente visión de juego de {assist} en el {time}.",
  "🅰️ Relato: Pase quirúrgico de {assist} para {player} a los {time}.",
  "🅰️ Relato: ¡Qué asistencia metió {assist} en el minuto {time}!",
  "🅰️ Relato: {assist} encontró el espacio y asistió a {player} a los {time}.",
  "🅰️ Relato: Buena combinación entre {assist} y {player} en el {time}.",
  "🅰️ Relato: {assist} pone medio gol con ese pase a los {time}.",
  "🅰️ Relato: ¡La hizo toda {assist} en el minuto {time}!",
  "🅰️ Relato: Magnífica asistencia de {assist} a los {time}.",
  "🅰️ Relato: {assist} ve el hueco y habilita a {player} en el {time}.",
  "🅰️ Relato: Pase perfecto de {assist} a los {time}.",
  "🅰️ Relato: Todo el mérito de la jugada a los {time} es para {assist}.",
  "🅰️ Relato: ¡Qué lectura tuvo {assist} en el minuto {time}!",
  "🅰️ Relato: A los {time}, {assist} frotó la lámpara para el gol de {player}.",
  "🅰️ Relato: ¡Toque sutil de {assist} y definición de {player} en el minuto {time}!",
  "🅰️ Relato: Dejó a todos pagando {assist} para asistir a {player} a los {time}.",
  "🅰️ Relato: Pase filtrado espectacular de {assist} en el {time}.",
  "🅰️ Relato: ¡Qué bocha le puso {assist} a {player} a los {time}!",
  "🅰️ Relato: {assist} se vistió de enganche a los {time} y habilitó a {player}.",
  "🅰️ Relato: Asistencia con tiralíneas de {assist} en el minuto {time}.",
  "🅰️ Relato: A los {time}, {assist} regala un pase que vale medio gol.",
  "🅰️ Relato: Conexión letal de futsal entre {assist} y {player} en el {time}.",
  "🅰️ Relato: Jugada de memoria armada por {assist} a los {time}.",
  "🅰️ Relato: {assist} pisó la pelota en el {time} y aclaró todo el panorama.",
  "🅰️ Relato: Pared perfecta iniciada por {assist} a los {time}.",
  "🅰️ Relato: ¡De billar! La asistencia de {assist} en el minuto {time}.",
  "🅰️ Relato: A los {time}, {assist} rompió líneas con ese pase frontal.",
  "🅰️ Relato: Cátedra de visión periférica de {assist} en el {time}.",
  "🅰️ Relato: {assist} mete un pase exquisito a los {time}.",
  "🅰️ Relato: En el {time}, {assist} deja solo a {player}."
]
const ownGoalRelatoVariants = [
  "🤡 Relato: Autogol de {player} a los {time}.",
  "🤡 Relato: Mala fortuna para {player} en el minuto {time}.",
  "🤡 Relato: Se equivoca {player} y es autogol a los {time}.",
  "🤡 Relato: Increíble, la manda a su propio arco {player} en el {time}.",
  "🤡 Relato: Gol en propia puerta de {player} a los {time}.",
  "🤡 Relato: Desafortunada acción de {player} en el minuto {time}.",
  "🤡 Relato: Error defensivo de {player} a los {time}, termina en gol.",
  "🤡 Relato: La pelota rebota en {player} y entra en el {time}.",
  "🤡 Relato: ¡Qué mala suerte para {player} a los {time}!",
  "🤡 Relato: ¡Trágame tierra! Autogol insólito de {player} a los {time}.",
  "🤡 Relato: A los {time}, {player} quiso despejar y la clavó en su propio arco.",
  "🤡 Relato: Un blooper monumental de {player} en el minuto {time}.",
  "🤡 Relato: En el {time}, la suerte le dio la espalda por completo a {player}.",
  "🤡 Relato: ¡Qué carambola de {player} a los {time}! Lamentablemente fue en contra.",
  "🤡 Relato: {player} se enredó con la pelota a los {time} y es autogol.",
  "🤡 Relato: Silencio total: {player} anota en propia puerta en el minuto {time}.",
  "🤡 Relato: A los {time}, un rebote traicionero condena a {player}.",
  "🤡 Relato: Quiso salir jugando {player} a los {time} y terminó en desastre.",
  "🤡 Relato: En el {time}, {player} le regala el grito al equipo rival.",
  "🤡 Relato: Se durmió en la salida {player} a los {time} y cuesta un autogol.",
  "🤡 Relato: Un cierre a destiempo de {player} en el minuto {time}.",
  "🤡 Relato: A los {time}, {player} empuja el balón al fondo de su propia red.",
  "🤡 Relato: Cortocircuito defensivo que termina en autogol de {player} en el {time}.",
  "🤡 Relato: ¡Para el olvido! La acción en contra de {player} a los {time}.",
  "🤡 Relato: No era la intención de {player}, pero cuenta igual en el minuto {time}.",
  "🤡 Relato: Se mueve el marcador por un autogol de {player} a los {time}.",
  "🤡 Relato: En el {time}, {player} termina siendo protagonista involuntario.",
  "🤡 Relato: Gol accidental de {player} en contra a los {time}.",
  "🤡 Relato: Nadie lo puede creer, autogol de {player} en el minuto {time}.",
  "🤡 Relato: {player} desvía la pelota hacia su propia red a los {time}.",
  "🤡 Relato: Una jugada desafortunada para {player} en el {time}.",
  "🤡 Relato: El balón acaba dentro y es autogol de {player} a los {time}.",
  "🤡 Relato: Error que cuesta caro para {player} en el minuto {time}.",
  "🤡 Relato: Mala coordinación y autogol de {player} a los {time}.",
  "🤡 Relato: Se lamenta {player} tras marcar en propia puerta en el {time}."
]
function randomVariant(list) {
  return list[Math.floor(Math.random() * list.length)]
}
function restoreDefaultAvatarNow(player) {
  if (!room || !player) return
  if (player.isPackLeader) {
    room.setPlayerAvatar(player.id, "🐺", true)
    return
  }
  if (player.isNewbie) {
    room.setPlayerAvatar(player.id, "🆕", true)
    return
  }
  if ((!player.vip || !player.ca) && player.pos != 0)
    room.setPlayerAvatar(player.id, String(player.pos), true)
  else if (player.ca) room.setPlayerAvatar(player.id, player.ca, true)
  else room.setPlayerAvatar(player.id, player.avatar, true)
}
// Destella un emoji en el avatar del jugador por una acción puntual (chat, gol, asistencia)
// y lo restaura solo, sin pisar si justo está en medio de un sprint/slide en curso.
function flashAvatar(player, emoji, durationMs = 1500) {
  if (!room || !player) return
  room.setPlayerAvatar(player.id, emoji, true)
  setTimeout(() => {
    if (player.isSprinting || player.isSliding) return
    restoreDefaultAvatarNow(player)
  }, durationMs)
}
// Emoji de la camiseta actual del jugador (o un ícono neutro si está en espectadores)
function getPlayerKitEmoji(player) {
  if (!player || !player.team || player.team.id === Team.SPECTATORS) return "⚪"
  const kitIndex = player.team.id === Team.RED ? homeTeam : awayTeam
  return (
    (dbKits[kitIndex]?.[0]?.t || "").replace(/[A-Za-z]{2,}$/u, "") ||
    (player.team.id === Team.RED ? "🔴" : "🔵")
  )
}
// Prefijo de chat de un jugador: si tiene clan, muestra su emoji+tag en el color
// del clan; si no, el emoji de la camiseta actual en blanco (comportamiento de siempre)
function getPlayerChatTag(player) {
  const tag = player?.auth ? memberClanTag.get(player.auth) : null
  const clan = tag ? clans.get(tag) : null
  if (clan) return { text: `${clan.emoji}[${clan.tag}]`, color: clan.color }
  return { text: getPlayerKitEmoji(player), color: colorWhite }
}
const CHAT_AVATAR = "💬"
const GOAL_AVATAR_VARIANTS = ["⚽", "🥅", "🏆", "🎉", "🔥"]
const ASSIST_AVATAR = "👟"
function formatRelato(template, data) {
  return template.replace(/\{(\w+)\}/g, (_, key) => data[key] || "")
}
const discordString = `Discord ${EMO} dsc.gg/streetdistrict`
const annoList = [
  { s: discordString, c: colorDiscord },
  { s: `${EMO} !𝖼𝗈𝗇𝗍𝗋𝗈𝗅𝗌 ${EMO} 𝖼 - 𝗅 - 𝖺 - p/s - 𝗇 (ᴄᴜʀᴠᴀ, lᴏʙ-sʜᴏᴛ, ᴀᴜᴛᴏ-ᴘᴏᴡᴇʀ, ᴘᴏᴡᴇʀ, ɴᴏʀᴍᴀʟ)`, c: colorWhite, border: false },
  { s: `${EMO} 𝖤𝗌𝖼𝗋𝗂𝖻𝖺 '!𝗁𝖾𝗅𝗉' 𝗉𝖺𝗋𝖺 𝗏𝖾𝗋 𝗅𝗈𝗌 𝖼𝗈𝗆𝖺𝗇𝖽𝗈𝗌.`, c: colorWhite, border: false },
]
let annoIndex = 0
const Team = { SPECTATORS: 0, RED: 1, BLUE: 2 }
// Marca el momento del último cambio de equipo autorizado por el bot, para distinguirlo de un cambio manual
let lastAuthTeamChange = 0
const AUTH_TEAM_CHANGE_WINDOW = 300 // ms - ventana para considerar autorizado un setPlayerTeam hecho por nosotros mismos
var AFKSet = new Set()
const mutedPlayers = new Set()
const tempBanTimeouts = new Map()
const NotifSound = { NONE: 0, CHAT: 1, MENTION: 2 }
let isPausedNow = false
const AFK_KICK_MS = 15000 // 15s sin cambiar de input = kick por AFK (solo jugadores en cancha, nunca espectadores)
setInterval(() => {
  if (!room || !room.gameState) return // solo durante partida activa: en el hueco entre rondas nadie se mueve y no es AFK real
  const now = Date.now()
  room.players.forEach((player) => {
    if (!player || !player.team || player.team.id === Team.SPECTATORS) return
    if (player.auth === "fake-auth-do-not-believe-it") return
    if (isAdmin(player)) return
    if (player.lastInputChangeTime === undefined) {
      player.lastInputChangeTime = now // primera vez que lo vemos en cancha, arranca el reloj recién ahora
      return
    }
    if (now - player.lastInputChangeTime > AFK_KICK_MS) {
      room.kickPlayer(player.id, "⏱️ Exᴘᴜʟsᴀᴅᴏ ᴘᴏʀ ɪɴᴀᴄᴛɪᴠɪᴅᴀᴅ (𝙰𝙵𝙺)", false)
    }
  })
}, 3000)
function isAdmin(player) {
  return Boolean(player?.isAdmin)
}
function getPlayerRoleList(player) {
  const roles = [Role.PLAYER]
  if (isAdmin(player)) roles.push(Role.ADMIN)
  if (player?.auth && authRoles.has(player.auth)) roles.push(authRoles.get(player.auth))
  return roles
}
function findPlayerByName(name) {
  if (!name) return null
  const normalized = name.trim().toLowerCase()
  if (!normalized) return null
  const players = room.players.filter((p) => p && p.name)
  const exactMatches = players.filter(
    (p) => p.name.trim().toLowerCase() === normalized,
  )
  if (exactMatches.length === 1) return exactMatches[0]
  if (exactMatches.length > 1) return exactMatches[0]
  const partialMatches = players.filter((p) =>
    p.name.trim().toLowerCase().includes(normalized),
  )
  return partialMatches.length === 1 ? partialMatches[0] : null
}
// Busca primero por el ID permanente, el que se muestra en el chat)
function findPlayerByNameOrId(query) {
  if (!query) return null
  const trimmed = query.trim()
  if (/^\d+$/.test(trimmed)) {
    const id = Number(trimmed)
    const byId = room.players.find((p) => p && p.playerId === id)
    if (byId) return byId
  }
  return findPlayerByName(query)
}
function findBanByName(name) {
  if (!name) return null
  const normalized = name.trim().toLowerCase()
  if (!normalized || !room.banList) return null
  const exactMatches = room.banList.filter(
    (ban) => (ban.name || "").trim().toLowerCase() === normalized,
  )
  if (exactMatches.length === 1) return exactMatches[0]
  if (exactMatches.length > 1) return exactMatches[0]
  const partialMatches = room.banList.filter((ban) =>
    (ban.name || "").trim().toLowerCase().includes(normalized),
  )
  return partialMatches.length === 1 ? partialMatches[0] : null
}
function parseDuration(durationText) {
  if (!durationText) return null
  const match = durationText.trim().match(/^(\d+)([smhSMH])?$/)
  if (!match) return null
  const value = Number(match[1])
  if (isNaN(value) || value <= 0) return null
  const unit = (match[2] || "s").toLowerCase()
  if (unit === "h") return value * 3600
  if (unit === "m") return value * 60
  return value
}
function getTeamCounts(room) {
  const players = room.players.filter((p) => !AFKSet.has(p.id))
  return {
    all: players,
    red: players.filter((p) => p.team.id === Team.RED),
    blue: players.filter((p) => p.team.id === Team.BLUE),
    specs: players.filter((p) => p.team.id === Team.SPECTATORS),
  }
}
function convertSecondsToTime(seconds) {
  const minutes = Math.floor(seconds / 60) // Cantidad de minutos
  const remainingSeconds = Math.floor(seconds % 60) // Segundos restantes, sin decimales
  const formattedTime = `${minutes}:${remainingSeconds < 10 ? "0" : ""}${remainingSeconds}` // Formato "MM:SS"
  return formattedTime
}
function sendAnnoOnJoin(playerId, room) {
  setTimeout(() => {
    room.sendAnnouncement(
      helpString,
      playerId,
      colorSucces,
      "bold",
      NotifSound.NONE,
    )
  }, 1200)
  room.sendAnnouncement(
    discordString,
    playerId,
    colorDiscord,
    "bold",
    NotifSound.NONE,
  )
}
// ── Racha + Gana Sigue ───────────────────────────────────────────────────────
let winningTeam = null
let winStreak   = 0
let matchScore  = { red: 0, blue: 0 }
const matchGoalsByPlayer = new Map() // playerId -> { name, goals } — se resetea en cada partido nuevo
const matchAssistsByPlayer = new Map() // playerId -> { name, assists } — ídem
let matchTouchesByTeam = { red: 0, blue: 0 } // toques a la pelota por equipo — proxy de posesión, se resetea en cada partido nuevo
const GOALS_TO_WIN = 4
const MIDFIELD_GOAL_DISTANCE = 20 // metros — a partir de acá se anuncia "golazo de media cancha"
const POST_DISCS = [104, 105, 106, 107] // discos de los postes en fx4.hbs
let lastPostHitAnnounce = 0
let lastGoalTime = 0
const POST_SUPPRESS_AFTER_GOAL_MS = 5000 // silenciar "¡AL PALO!" mientras la pelota sigue agrandada por la celebración
const SAVE_ZONE_X = 150 // distancia (en unidades de mapa) a la línea de gol para considerar "cerca del arco"
const SAVE_MIN_SPEED_X = 4 // velocidad mínima en x hacia el propio arco para contar como atajada (no un toque cualquiera)
let lastSaveFlash = 0
let chatLockedUntil = 0
let chatLockNotified = new Set()
// ── Anti-spam: ráfaga de mensajes → modo lento (1 msj/min) por 5 minutos ──────
const SPAM_WINDOW_MS = 5000 // ventana para contar la ráfaga
const SPAM_THRESHOLD = 4 // mensajes dentro de esa ventana para considerarlo spam
const SPAM_PENALTY_MS = 5 * 60 * 1000 // duración total de la penalización
const SPAM_COOLDOWN_MS = 60 * 1000 // tiempo mínimo entre mensajes mientras dura la penalización
const recentMessageTimes = new Map() // playerId -> timestamps recientes (para detectar la ráfaga)
const spamPenalties = new Map() // playerId -> { until, lastMessageTime }
const CALL_ADMIN_COOLDOWN_MS = 10 * 60 * 1000 // 10 min entre llamados de admin para todos los jugadores
let lastAdminCallAt = 0

function getSpecQueue() {
  if (!room) return []
  return room.players.filter((p) => p && p.team && p.team.id === Team.SPECTATORS)
}

function randomizeKits() {
  if (!room || !dbKits || dbKits.length < 2) return
  let a = Math.floor(Math.random() * dbKits.length)
  let b; do { b = Math.floor(Math.random() * dbKits.length) } while (b === a)
  homeTeam = a; awayTeam = b
  const applyKit = (team, idx) => {
    const k = dbKits[idx][1]; if (!k) return
    if      (k.c3 !== undefined) room.setTeamColors(team, k.a, k.c0, k.c1, k.c2, k.c3)
    else if (k.c2 !== undefined) room.setTeamColors(team, k.a, k.c0, k.c1, k.c2)
    else                         room.setTeamColors(team, k.a, k.c0, k.c1)
  }
  applyKit(Team.RED, homeTeam); applyKit(Team.BLUE, awayTeam)
}
// Mapa de equipo asignado por el servidor: playerId → teamId
// Se usa para revertir cambios manuales de equipo
const assignedTeams = new Map()

function shuffleArr(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

// Mathematical Monospace — para datos dinámicos (nombres, números, unidades)
function mono(s) {
  let out = ''
  for (const ch of String(s)) {
    if (ch >= 'A' && ch <= 'Z') out += String.fromCodePoint(0x1D670 + (ch.codePointAt(0) - 65))
    else if (ch >= 'a' && ch <= 'z') out += String.fromCodePoint(0x1D68A + (ch.codePointAt(0) - 97))
    else if (ch >= '0' && ch <= '9') out += String.fromCodePoint(0x1D7F6 + (ch.codePointAt(0) - 48))
    else out += ch
  }
  return out
}

// Mathematical Fraktur — para las frases descriptivas de los anuncios
const FRAKTUR_EXC = { C: '\u212D', H: '\u210C', I: '\u2111', R: '\u211C', Z: '\u2128' }
function fraktur(s) {
  let out = ''
  for (const ch of String(s)) {
    if (FRAKTUR_EXC[ch]) out += FRAKTUR_EXC[ch]
    else if (ch >= 'A' && ch <= 'Z') out += String.fromCodePoint(0x1D504 + (ch.codePointAt(0) - 65))
    else if (ch >= 'a' && ch <= 'z') out += String.fromCodePoint(0x1D51E + (ch.codePointAt(0) - 97))
    else out += ch
  }
  return out
}

// Interpola linealmente entre dos colores hex (0xRRGGBB) según t (0..1)
function lerpColor(colorA, colorB, t) {
  const ar = (colorA >> 16) & 0xff, ag = (colorA >> 8) & 0xff, ab = colorA & 0xff
  const br = (colorB >> 16) & 0xff, bg = (colorB >> 8) & 0xff, bb = colorB & 0xff
  const r = Math.round(ar + (br - ar) * t)
  const g = Math.round(ag + (bg - ag) * t)
  const b = Math.round(ab + (bb - ab) * t)
  return (r << 16) | (g << 8) | b
}

// Distribuye jugadores. keepTeam = equipo que se queda; null = mezcla total.
function assignTeams(keepTeam, leavingId) {
  if (!room) return
  lastAuthTeamChange = Date.now()
  const all = room.players.filter(
    (p) => p && p.id !== undefined && p.id !== leavingId
  )
  const pending = new Map()

  if (keepTeam !== null && keepTeam !== undefined) {
    const rotateTeam = keepTeam === Team.RED ? Team.BLUE : Team.RED
    const pool = shuffleArr(all.filter((p) => p.team && p.team.id !== keepTeam))
    pool.forEach((p) => { room.setPlayerTeam(p.id, Team.SPECTATORS); pending.set(p.id, Team.SPECTATORS) })
    let count = 0
    for (const p of pool) {
      if (count >= 4) break
      room.setPlayerTeam(p.id, rotateTeam)
      pending.set(p.id, rotateTeam)
      count++
    }
    all.filter((p) => p.team && p.team.id === keepTeam)
       .forEach((p) => pending.set(p.id, keepTeam))
  } else {
    const pool = shuffleArr([...all])
    let red = 0, blue = 0
    for (const p of pool) {
      if      (red < 4 && red <= blue) { room.setPlayerTeam(p.id, Team.RED);  pending.set(p.id, Team.RED);  red++ }
      else if (blue < 4)               { room.setPlayerTeam(p.id, Team.BLUE); pending.set(p.id, Team.BLUE); blue++ }
      else                             { room.setPlayerTeam(p.id, Team.SPECTATORS); pending.set(p.id, Team.SPECTATORS) }
    }
  }
  // Guardar usando pending (p.team.id aún no actualizó en este tick)
  pending.forEach((teamId, pid) => assignedTeams.set(pid, teamId))
}

function _rebalanceTeams(leavingId) {
  if (!room) return
  try {
    lastAuthTeamChange = Date.now()
    const active = room.players.filter((p) => p && p.id !== leavingId)
    const red  = active.filter((p) => p.team && p.team.id === Team.RED)
    const blue = active.filter((p) => p.team && p.team.id === Team.BLUE)
    if (red.length === 0 || blue.length === 0) {
      updateStadiumAndTeams({ leavingId })
      return
    }
    const specs = active.filter((p) => p.team && p.team.id === Team.SPECTATORS)
    let r = red.length, b = blue.length
    for (const p of specs) {
      if (r < b && r < 4)      { room.setPlayerTeam(p.id, Team.RED);  assignedTeams.set(p.id, Team.RED);  r++ }
      else if (b < r && b < 4) { room.setPlayerTeam(p.id, Team.BLUE); assignedTeams.set(p.id, Team.BLUE); b++ }
    }
  } catch(e) { console.error('_rebalanceTeams error:', e) }
}

function rotateTeamsAfterWin(winningTeamId, losingTeamId, finishedScore, finishedStreak, finishedDuration, finishedReplay) {
  if (!room) return

  try {
    // Estadísticas del partido que acaba de terminar (ya capturadas por el caller,
    // antes de que cualquier stopGame()/onGameStop resetee matchScore a 0-0)
    finishedScore = finishedScore || { red: 0, blue: 0 }
    finishedStreak = finishedStreak || 0
    const finishedTouches = { ...matchTouchesByTeam }
    // Ranking del partido: goles + asistencias combinados (la "posición" de cada uno)
    const statsMap = new Map()
    for (const [id, g] of matchGoalsByPlayer) statsMap.set(id, { name: g.name, goals: g.goals, assists: 0 })
    for (const [id, a] of matchAssistsByPlayer) {
      const e = statsMap.get(id) || { name: a.name, goals: 0, assists: 0 }
      e.assists = a.assists
      statsMap.set(id, e)
    }
    const ranked = [...statsMap.values()].sort((a, b) => (b.goals * 2 + b.assists) - (a.goals * 2 + a.assists))

    const activePlayers = room.players.filter(p => p && !AFKSet.has(p.id))
    const winners = activePlayers.filter(p => p.team && p.team.id === winningTeamId)
    const losers  = activePlayers.filter(p => p.team && p.team.id === losingTeamId)
    const queue   = activePlayers.filter(p => p.team && p.team.id === Team.SPECTATORS) // orden FIFO real

    if (room.gameState) room.stopGame()

    const targetSize = Math.min(4, winners.length)

    const pending = new Map()

    losers.forEach(p => pending.set(p.id, Team.SPECTATORS))

    const incoming = queue.slice(0, targetSize)
    incoming.forEach(p => pending.set(p.id, losingTeamId))

    let filled = incoming.length
    let backFromLosers = []
    if (filled < targetSize) {
      backFromLosers = losers.slice(0, targetSize - filled)
      backFromLosers.forEach(p => pending.set(p.id, losingTeamId))
    }

    winners.forEach(p => pending.set(p.id, winningTeamId))

    lastAuthTeamChange = Date.now()
    pending.forEach((teamId, pid) => {
      room.setPlayerTeam(pid, teamId)
      assignedTeams.set(pid, teamId)
    })

    const winnerKitIndex = winningTeamId === Team.RED ? homeTeam : awayTeam
    const winnerKitName = getKitName(winnerKitIndex) || (winningTeamId === Team.RED ? 'Rojo' : 'Azul')
    const winnerKitEmoji = (dbKits[winnerKitIndex]?.[0]?.t || '').replace(/[A-Za-z]{2,}$/u, '')
    const winnerColor = winningTeamId === Team.RED ? colorRed : colorBlue
    const winnerKitStyle = dbKits[winnerKitIndex]?.[1] || {}
    const winnerKitColor = winnerKitStyle.c1 ?? winnerKitStyle.c0 ?? winnerColor
    const totalGoals = finishedScore.red + finishedScore.blue

    randomizeKits()
    const nextHomeKitEmoji = (dbKits[homeTeam]?.[0]?.t || '').replace(/[A-Za-z]{2,}$/u, '') || '🔴'
    const nextAwayKitEmoji = (dbKits[awayTeam]?.[0]?.t || '').replace(/[A-Za-z]{2,}$/u, '') || '🔵'

    // Línea 1: resultado
    const line1 = `🏆 ${fraktur('Gano')} ${winnerKitEmoji} ${mono(winnerKitName)} (${mono(String(finishedScore.red))}-${mono(String(finishedScore.blue))})`

    // Línea 2: racha + duración + goles + goleadores, todo junto separado por ・
    const medals = ['🥇', '🥈', '🥉']
    const scorersText = ranked.length
      ? ranked.slice(0, 3).map((p, i) =>
          `${medals[i]}${mono(p.name)} ${mono(String(p.goals))}⚽${p.assists ? `${mono(String(p.assists))}🅰️` : ''}`
        ).join(' - ')
      : `${fraktur('Sin goles ni asistencias')}`
    const line2Parts = [
      finishedStreak >= 2 ? `🔥${mono(String(finishedStreak))}` : null,
      `⏱️${mono(finishedDuration || '00:00')}`,
      `⚽${mono(String(totalGoals))}`,
      scorersText,
    ].filter(Boolean)
    const line2 = `🐺 ${line2Parts.join(' ・ ')}`

    // Línea 3: barra de posesión (proxy por toques a la pelota), con %
    const totalTouches = finishedTouches.red + finishedTouches.blue
    const redPct = totalTouches > 0 ? Math.round((finishedTouches.red / totalTouches) * 100) : 50
    const bluePct = 100 - redPct
    const filledBlocks = Math.round(redPct / 10)
    const posBar = "█".repeat(filledBlocks) + "░".repeat(10 - filledBlocks)
    const line3 = `🐺 📊 🔴${redPct}% [${posBar}] ${bluePct}%🔵`

    // Línea 4: alineación del próximo partido, ya resuelta en `pending` de arriba
    const nextWinnerNames = winners.map(p => mono(p.name)).join(', ') || '—'
    const nextLoserNames  = incoming.concat(backFromLosers).map(p => mono(p.name)).join(', ') || '—'
    const nextRedNames  = winningTeamId === Team.RED ? nextWinnerNames : nextLoserNames
    const nextBlueNames = winningTeamId === Team.RED ? nextLoserNames  : nextWinnerNames
    const line4 = `🐺 ${nextHomeKitEmoji}${nextRedNames} 𝔳𝔰 ${nextAwayKitEmoji}${nextBlueNames}`

    const nextRedNamesPlain  = (winningTeamId === Team.RED ? winners : incoming.concat(backFromLosers)).map(p => p.name).join(', ') || '—'
    const nextBlueNamesPlain = (winningTeamId === Team.RED ? incoming.concat(backFromLosers) : winners).map(p => p.name).join(', ') || '—'
    sendDiscordEmbed(WEBHOOK_RECS, {
      author: { name: `🐺 ${ROOM_NAME}` },
      title: `${winnerKitEmoji} ${winnerKitName} ganó ${finishedScore.red}-${finishedScore.blue}`,
      description: finishedStreak >= 2
        ? `🔥 **${finishedStreak}** victorias seguidas`
        : `${fraktur('Ganador')}`,
      color: winnerKitColor,
      fields: [
        { name: "<:arrow:1524898169694064765> Duración", value: mono(finishedDuration || "00:00"), inline: true },
        { name: "<:connected:1524898158449262732> Goles totales", value: mono(String(totalGoals)), inline: true },
        { name: "\u200b", value: "\u200b", inline: true },
        {
          name: "🥇 Goleadores del partido",
          value: ranked.length
            ? ranked.slice(0, 3).map((p, i) => `${medals[i]} **${p.name}** — ${mono(String(p.goals))}⚽${p.assists ? ` ${mono(String(p.assists))}🅰️` : ""}`).join("\n")
            : fraktur('Sin goles ni asistencias'),
          inline: false,
        },
        {
          name: "<:connected:1524898158449262732> Posesión",
          value: `\`\`\`\n🔴 ${redPct}% [${"█".repeat(Math.round(redPct / 10))}${"░".repeat(10 - Math.round(redPct / 10))}] ${bluePct}% 🔵\n\`\`\``,
          inline: false,
        },
        { name: "<:connected:1524898158449262732> Próximo partido", value: `🔴 **${nextRedNamesPlain}**  𝔳𝔰  🔵 **${nextBlueNamesPlain}**`, inline: false },
      ],
      timestamp: new Date().toISOString(),
      footer: { text: "Resultado del partido" },
      image: { url: DISCORD_IMAGE_RECS },
      thumbnail: { url: "https://cdn.discordapp.com/attachments/1524879478831190181/1535056155632467990/Logo-SD.png?ex=6a765ff3&is=6a750e73&hm=c10db33075ef211457077a97679ffab6a0e9225397110a168cb3a3c28adda31f&" },
    }, finishedReplay)

    const startLines = [
      { text: line1, color: winnerKitColor, style: 'bold', sound: NotifSound.MENTION },
      { text: line2, color: 0xffffff, style: 'small', sound: NotifSound.NONE },
      { text: line3, color: colorMuted, style: 'small', sound: NotifSound.NONE },
      { text: line4, color: 0xffffff, style: 'small', sound: NotifSound.NONE },
    ].filter(line => line && line.text)
    const LINE_DELAY = 400
    // Bloquea el chat mientras se escribe el banner + 0.5s extra después de la última línea
    chatLockedUntil = Date.now() + (startLines.length - 1) * LINE_DELAY + 2000
    chatLockNotified.clear()
    startLines.forEach(({ text, color, style, sound }, i) => {
      setTimeout(() => {
        if (!room) return
        try {
          room.sendAnnouncement(text, null, color, style, sound)
        } catch (lineErr) {
          console.error('rotateTeamsAfterWin: fallo al enviar línea del banner:', text, lineErr)
        }
      }, i * LINE_DELAY)
    })

    // El arranque se espera hasta DESPUÉS de que termine de mostrarse todo el banner.
    const BANNER_TOTAL_MS = startLines.length * LINE_DELAY + 600
    setTimeout(() => {
      if (!room) return
      matchScore = { red: 0, blue: 0 }
      matchGoalsByPlayer.clear()
      matchAssistsByPlayer.clear()
      matchTouchesByTeam = { red: 0, blue: 0 }
      const c = getTeamCounts(room)
      if (c.red.length > 0 && c.blue.length > 0 && !room.gameState) {
        room.startGame()
      }
    }, BANNER_TOTAL_MS)

  } catch (e) {
    console.error('rotateTeamsAfterWin error:', e)
    setTimeout(() => {
      if (!room) return
      if (room.gameState) room.stopGame()
      lastAuthTeamChange = Date.now()
      assignTeams(winningTeamId, null)
      matchScore = { red: 0, blue: 0 }
      matchGoalsByPlayer.clear()
      matchAssistsByPlayer.clear()
      matchTouchesByTeam = { red: 0, blue: 0 }
      setTimeout(() => {
        if (!room) return
        const c = getTeamCounts(room)
        if (c.red.length > 0 && c.blue.length > 0 && !room.gameState) room.startGame()
      }, 400)
    }, 1200)
  }
}

function updateStadiumAndTeams(opts) {
  if (!room) return
  const options = opts || {}
  const leavingId = options.leavingId
  try {
    const activePlayers = room.players.filter(
      (p) => p && p.id !== undefined && p.id !== leavingId
    )
    const total = activePlayers.length

    if (total <= 1) {
      if (room.gameState) room.stopGame()
      lastAuthTeamChange = Date.now()
      activePlayers.forEach(p => {
        if (p.team && p.team.id !== Team.SPECTATORS) room.setPlayerTeam(p.id, Team.SPECTATORS)
        assignedTeams.set(p.id, Team.SPECTATORS)
      })
      winningTeam = null; winStreak = 0; matchScore = { red: 0, blue: 0 }; matchGoalsByPlayer.clear(); matchAssistsByPlayer.clear(); matchTouchesByTeam = { red: 0, blue: 0 }
      return
    }

    // Rebalancear sin reiniciar (sale jugador de partida activa)
    if (options.mode === 'rebalance' && room.gameState) {
      _rebalanceTeams(leavingId)
      return
    }

    // Flujo completo: parar + cargar mapa + distribuir + iniciar
    if (room.gameState) room.stopGame()
    if (stadiumF)
      room.setCurrentStadium(Utils.parseStadium(JSON.stringify(stadiumF), console.log))
    // Un reshuffle completo arma equipos nuevos sin relación con la racha anterior
    winningTeam = null; winStreak = 0

    setTimeout(() => {
      if (!room) return
      try {
        const keepTeam = options.keepTeam !== undefined ? options.keepTeam : null
        assignTeams(keepTeam, leavingId)
        setTimeout(() => {
          if (!room) return
          const c = getTeamCounts(room)
          if (c.red.length > 0 && c.blue.length > 0) {
            matchScore = { red: 0, blue: 0 }
            matchGoalsByPlayer.clear()
            matchAssistsByPlayer.clear()
            matchTouchesByTeam = { red: 0, blue: 0 }
            if (!room.gameState) room.startGame()
          }
        }, 400)
      } catch(e) { console.error('assignTeams error:', e) }
    }, 800)

  } catch (err) {
    console.error('updateStadiumAndTeams error:', err)
  }
}
let annoTimer = null
function sendAnnos(room) {
  if (annoList.length === 0) {
    console.error("¡La lista de anuncios está vacía!")
    return
  }
  if (annoTimer !== null) return
  function loop() {
    const anno = annoList[annoIndex]
    const annoString = anno.s
    const annoColor = anno.c
    const showBorder = anno.border !== false
    if (showBorder) {
      room.sendAnnouncement(
        `• • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • •`,
        null,
        annoColor,
        "bold",
        NotifSound.NONE,
      )
    }
    room.sendAnnouncement(
      `${annoString}`,
      null,
      annoColor,
      "bold",
      NotifSound.NONE,
    )
    if (showBorder) {
      room.sendAnnouncement(
        `• • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • •`,
        null,
        annoColor,
        "bold",
        NotifSound.NONE,
      )
    }
    annoIndex = (annoIndex + 1) % annoList.length
    const nextDelay = 60 * 1000 // 1 minuto
    annoTimer = setTimeout(loop, nextDelay)
  }
  loop()
}
/*
    ╔══════════════════════════════════════════════════════════════════════════════════════════════════════════╗
    ║                                           O T H E R     E N D                                            ║
    ╚══════════════════════════════════════════════════════════════════════════════════════════════════════════╝
*/

/*
 ▄▄▄       ▄▄▄▄    ██▓ ██▓     ██▓▄▄▄█████▓▓██   ██▓
▒████▄    ▓█████▄ ▓██▒▓██▒    ▓██▒▓  ██▒ ▓▒ ▒██  ██▒
▒██  ▀█▄  ▒██▒ ▄██▒██▒▒██░    ▒██▒▒ ▓██░ ▒░  ▒██ ██░
░██▄▄▄▄██ ▒██░█▀  ░██░▒██░    ░██░░ ▓██▓ ░   ░ ▐██▓░
 ▓█   ▓██▒░▓█  ▀█▓░██░░██████▒░██░  ▒██▒ ░   ░ ██▒▓░
 ▒▒   ▓▒█░░▒▓███▀▒░▓  ░ ▒░▓  ░░▓    ▒ ░░      ██▒▒▒
  ▒   ▒▒ ░▒░▒   ░  ▒ ░░ ░ ▒  ░ ▒ ░    ░     ▓██ ░▒░
  ░   ▒    ░    ░  ▒ ░  ░ ░    ▒ ░  ░       ▒ ▒ ░░
      ░  ░ ░       ░      ░  ░ ░            ░ ░
                ░                           ░ ░
*/
const touchState = {
  touchingPlayerId: null,
  touchStartTime: null,
  lastTouchDuration: 0,
  lastTouchedPlayerName: null,
  lastTouchedPlayerId: null,
  lastDribbledPlayerId: null,
  lastOpenedBarPlayerId: null,
  lastKickedPlayerId: null,
  secondLastTouchedPlayerId: null,
  secondLastTouchedPlayerName: null,
  thirdLastTouchedPlayerId: null,
  thirdLastTouchedPlayerName: null,
}
const curveState = {
  isCurving: false,
  curveStartTime: null,
  curveDirection: null,
  initialXspeed: 0,
  initialYspeed: 0,
  ballGravityX: 0,
  ballGravityY: 0,
  curveDuration: CURVED_SHOT_DURATION,
}
const ultiState = {
  isUlti: false,
  ultiStartTime: null,
  ultiPlayer: null,
}
let IS_ANY_ACTIVE_EFFECT = false
let touchType = null
let allResetted = false
let velocity = { xspeed: 0, yspeed: 0 }
let fixedBarFirstVis = false
let fixedBarPowerVis = false
let cf = {
  kick: 64,
  score: 128,
  ball: 193,
  red: 2,
  blue: 4,
  c0: 268435456,
  c1: 536870912,
  c2: 1073741824,
  c3: -2147483648,
}
const firstTimeThreshold = 0.35
const powerTimeThreshold = 2.25
const powerLobTimeThreshold = 2.25
const ultiTimeThresholdStart = 3.25
const lobShotState = {
  isLobShot: false,
  lobShotStartTime: null,
  lobShotWantedTime: firstTimeThreshold,
  lobShotDuration: 1.4,
}
const normalBallRadius = 6.4
const peakScale = normalBallRadius * 3
const peakHeight = 40
function handleLobShotState(room) {
  const elapsedLobTime = (Date.now() - lobShotState.lobShotStartTime) / 1000
  if (elapsedLobTime < lobShotState.lobShotDuration) {
    if (!IS_ANY_ACTIVE_EFFECT) {
      resetLobShotState() // Corta el efecto de curva
      Utils.runAfterGameTick(() => {
        room.setDiscProperties(0, {
          radius: normalBallRadius,
          cGroup: cf.ball,
          damping: 0.99,
          xgravity: 0,
          ygravity: 0,
        }) // Detecta si la velocidad o dirección de la pelota cambió bruscamente
      })
      return
    } else {
      const progress = elapsedLobTime / lobShotState.lobShotDuration // Va de 0.0 a 1.0
      if (progress >= 1) {
        resetLobShotState()
        IS_ANY_ACTIVE_EFFECT = false
        Utils.runAfterGameTick(() => {
          room.setDiscProperties(0, {
            radius: normalBallRadius,
            cGroup: cf.ball,
            damping: 0.99,
            xgravity: 0,
            ygravity: 0,
          })
        })
        return
      }
      const z = 4 * peakHeight * progress * (1 - progress)
      const scaledRadius =
        normalBallRadius + (z / peakHeight) * (peakScale - normalBallRadius)
      const b = room.getBall(true)
      Utils.runAfterGameTick(() => {
        room.setDiscProperties(0, { damping: 0.994, radius: scaledRadius })
        setTimeout(() => {
          if (IS_ANY_ACTIVE_EFFECT && lobShotState.isLobShot)
            room.setDiscProperties(0, { cGroup: cf.c3 })
        }, 75)
      })
    }
  } else {
    resetLobShotState() // Termina el efecto de curva de forma natural
    IS_ANY_ACTIVE_EFFECT = false
    const bs = room.getBall(true).speed
    Utils.runAfterGameTick(() => {
      room.setDiscProperties(0, {
        radius: normalBallRadius,
        cGroup: cf.ball,
        damping: 0.99,
        xgravity: 0,
        ygravity: 0,
        xspeed: bs.x * 0.8,
        yspeed: bs.y * 0.8,
      })
    })
    return
  }
}
function resetLobShotState() {
  lobShotState.isLobShot = false
  lobShotState.lobShotStartTime = null
}
const CDSprintDurX = 10
const CDSprintDurXWingers = 6
const CDSlideDur = 20
const CDSlideDurDefenders = 15
const slideFrictionDur = 1
function resetSSS(room) {
  const ps = room.players
  for (i = 0; i < ps.length; i++) {
    if (!room.getPlayer(ps[i].id)) return
    ps[i].lastSprintDur = null
    ps[i].pressingXStartTime = null
    ps[i].lastSprintTime = null
    ps[i].lastSprintDur = null
    ps[i].lastSlideTime = null
    ps[i].isSprinting = null
    ps[i].isSliding = null
    ps[i].sprintStartTime = null
  }
}
function handleSprintState(player, room) {
  const now = Date.now()
  const isSpeedThresholdOkay =
    Math.abs(player.disc.speed.x) + Math.abs(player.disc.speed.y) >= 0.5
  const gravityMap = {
    17: { ygravity: -0.06 },
    29: { ygravity: -0.06 },
    18: { ygravity: 0.06 },
    30: { ygravity: 0.06 },
    20: { xgravity: -0.06 },
    23: { xgravity: -0.06 },
    24: { xgravity: 0.06 },
    27: { xgravity: 0.06 },
    21: { xgravity: -0.033, ygravity: -0.033 },
    22: { xgravity: -0.033, ygravity: 0.033 },
    25: { xgravity: 0.033, ygravity: -0.033 },
    26: { xgravity: 0.033, ygravity: 0.033 },
  }
  const speedMap = {
    17: { yspeed: -4 },
    29: { yspeed: -4 },
    18: { yspeed: 4 },
    30: { yspeed: 4 },
    20: { xspeed: -4 },
    23: { xspeed: -4 },
    24: { xspeed: 4 },
    27: { xspeed: 4 },
    21: { xspeed: -2.2, yspeed: -2.2 },
    22: { xspeed: -2.2, yspeed: 2.2 },
    25: { xspeed: 2.2, yspeed: -2.2 },
    26: { xspeed: 2.2, yspeed: 2.2 },
  }
  const props = player.op ? speedMap[player.input] : gravityMap[player.input]
  if (props) {
    Utils.runAfterGameTick(() => {
      room.setPlayerDiscProperties(player.id, props)
    })
  }
  const durLimit = player.op ? OP_DUR : SPRINT_DUR
  if (!isSpeedThresholdOkay || now - player.sprintStartTime >= durLimit) {
    player.lastSprintDur = now - player.sprintStartTime
    player.lastSprintTime = now
    player.isSprinting = false
    if ((!player.vip || !player.ca) && player.pos != 0)
      room.setPlayerAvatar(player.id, String(player.pos), true)
    else if (player.ca) room.setPlayerAvatar(player.id, player.ca, true)
    else room.setPlayerAvatar(player.id, player.avatar, true)
    Utils.runAfterGameTick(() => {
      room.setPlayerDiscProperties(player.id, { xgravity: 0, ygravity: 0 })
    })
    player.sprintStartTime = null
    room.setPlayerAvatar(player.id, "⌛", true)
    setTimeout(
      () => {
        if (player.isSprinting) return
        room.setPlayerAvatar(player.id, "🔋", true)
        setTimeout(() => {
          if (player.isSprinting) return
          if ((!player.vip || !player.ca) && player.pos != 0)
            room.setPlayerAvatar(player.id, String(player.pos), true)
          else if (player.ca) room.setPlayerAvatar(player.id, player.ca, true)
          else room.setPlayerAvatar(player.id, player.avatar, true)
        }, 500)
      },
      player.lastSprintDur *
        (player.pos === 7 || player.pos === 11
          ? CDSprintDurXWingers
          : CDSprintDurX),
    )
  }
}
function handleSlideFriction(player, room) {
  Utils.runAfterGameTick(async () => {
    room.setPlayerDiscProperties(player.id, {
      xspeed: player.disc.speed.x * 0.9,
      yspeed: player.disc.speed.y * 0.9,
    })
  })
}
let firstSlideLineTime = null
let secondSlideLineTime = null
function handleSlideState(player, room) {
  const now = Date.now() // Se guarda una sola vez para no llamarlo de nuevo en esta función
  const playerDisc = player.disc
  if (!playerDisc) return
  const vx = playerDisc.speed.x || 0
  const vy = playerDisc.speed.y || 0
  const magnitude = Math.sqrt(vx * vx + vy * vy)
  if (magnitude > 0.01) {
    const directionX = vx / magnitude
    const directionY = vy / magnitude
    const gravityStrength = 0.8
    const props = {
      xgravity: directionX * gravityStrength,
      ygravity: directionY * gravityStrength,
    }
    const px = playerDisc.pos.x
    const py = playerDisc.pos.y
    const slideLength = 50
    const spacing = 12
    const forwardOffset = 10
    const dx = directionX
    const dy = directionY
    const nx = -dy
    const ny = dx
    const baseX = px + dx * forwardOffset
    const baseY = py + dy * forwardOffset
    const line1Start = {
      x: baseX + nx * spacing,
      y: baseY + ny * spacing,
    }
    const line1End = {
      x: line1Start.x + dx * slideLength,
      y: line1Start.y + dy * slideLength,
    }
    const line2Start = {
      x: baseX - nx * spacing,
      y: baseY - ny * spacing,
    }
    const line2End = {
      x: line2Start.x + dx * slideLength,
      y: line2Start.y + dy * slideLength,
    }
    Utils.runAfterGameTick(() => {
      room.setPlayerDiscProperties(player.id, props)
      if (
        firstSlideLineTime === null ||
        (secondSlideLineTime != null &&
          firstSlideLineTime < secondSlideLineTime)
      ) {
        room.setDiscProperties(96, line1Start)
        room.setDiscProperties(97, line1End)
        room.setDiscProperties(98, line2Start)
        room.setDiscProperties(99, line2End)
        firstSlideLineTime = Date.now()
      } else {
        room.setDiscProperties(100, line1Start)
        room.setDiscProperties(101, line1End)
        room.setDiscProperties(102, line2Start)
        room.setDiscProperties(103, line2End)
        secondSlideLineTime = Date.now()
      }
    })
  }
  player.lastSlideTime = now
  setTimeout(() => {
    Utils.runAfterGameTick(async () => {
      room.setPlayerDiscProperties(player.id, { xgravity: 0, ygravity: 0 })
    })
  }, 100)
  setTimeout(() => {
    player.slideStartTime = null
    room.setPlayerAvatar(player.id, "⌛", true)
    player.CDForSlide = true
    player.isSlideFriction = true
    player.isSliding = false
    setTimeout(() => {
      player.isSlideFriction = false
    }, 1000 * slideFrictionDur)
    setTimeout(
      () => {
        player.CDForSlide = false
        if (player.isSliding) return
        room.setPlayerAvatar(player.id, "🔋", true)
        setTimeout(() => {
          if (player.isSliding) return
          if ((!player.vip || !player.ca) && player.pos != 0)
            room.setPlayerAvatar(player.id, String(player.pos), true)
          else if (player.ca) room.setPlayerAvatar(player.id, player.ca, true)
          else room.setPlayerAvatar(player.id, player.avatar, true)
        }, 500)
      },
      (player.pos === 1 || player.pos === 4 || player.pos === 5
        ? CDSlideDurDefenders
        : CDSlideDur) * 1000,
    )
  }, 400)
}
function handleKickState(player, room) {
  const now = Date.now()
  const holdDuration = player.pressingXStartTime
    ? now - player.pressingXStartTime
    : 0
  const isCoolDownDoneSlide = player.lastSlideTime
    ? now - player.lastSlideTime >
      (player.pos === 1 || player.pos === 4 || player.pos === 5
        ? CDSlideDurDefenders
        : CDSlideDur) *
        1000
    : true
  const isCoolDownDoneSprint = player.lastSprintTime
    ? now - player.lastSprintTime >
      player.lastSprintDur *
        (player.pos === 7 || player.pos === 11
          ? CDSprintDurXWingers
          : CDSprintDurX)
    : true
  const isSpeedThresholdOkay =
    Math.abs(player.disc.speed.x) + Math.abs(player.disc.speed.y) >= 0.5
  if (!(holdDuration === 0 && player.isKicking)) player.lhd = holdDuration
  if (
    player.isKicking &&
    !player.isSliding &&
    holdDuration >= 1600 &&
    isSpeedThresholdOkay &&
    isCoolDownDoneSlide &&
    isCoolDownDoneSprint
  ) {
    player.isSprinting = true
    player.sprintStartTime = now
    room.setPlayerAvatar(player.id, "⚡", true)
  } else if (
    player.es &&
    player.isKicking &&
    holdDuration === 0 &&
    !player.isSprinting &&
    player.lhd >= 600 &&
    isSpeedThresholdOkay &&
    isCoolDownDoneSlide &&
    isCoolDownDoneSprint
  ) {
    player.isSliding = true
    player.slideStartTime = now
    room.setPlayerAvatar(player.id, "💨", true)
    handleSlideState(player, room)
  } else if (
    player.es &&
    player.isKicking &&
    !player.isSliding &&
    !player.isSprinting &&
    holdDuration >= 600 &&
    isSpeedThresholdOkay &&
    isCoolDownDoneSlide &&
    isCoolDownDoneSprint
  ) {
    room.setPlayerAvatar(player.id, "👟", true)
  } else if (
    isCoolDownDoneSlide &&
    isCoolDownDoneSprint &&
    (player.headlessAvatar === "👟" ||
      player.headlessAvatar === "💨" ||
      player.headlessAvatar === "⚡" ||
      player.headlessAvatar === "🔋" ||
      player.headlessAvatar === "⌛")
  ) {
    if ((!player.vip || !player.ca) && player.pos != 0)
      room.setPlayerAvatar(player.id, String(player.pos), true)
    else if (player.ca) room.setPlayerAvatar(player.id, player.ca, true)
    else room.setPlayerAvatar(player.id, player.avatar, true)
  }
  if (holdDuration === 0 && player.headlessAvatar === "👟") {
    if ((!player.vip || !player.ca) && player.pos != 0)
      room.setPlayerAvatar(player.id, String(player.pos), true)
    else if (player.ca) room.setPlayerAvatar(player.id, player.ca, true)
    else room.setPlayerAvatar(player.id, player.avatar, true)
  }
}
function handleTouchState(room, lastDribbledPlayerId) {
  const now = Date.now()
  if (touchState.touchingPlayerId !== lastDribbledPlayerId) {
    touchState.touchingPlayerId = lastDribbledPlayerId
    touchState.touchStartTime = now // Arranca un toque nuevo
  }
  touchState.lastTouchDuration = (now - touchState.touchStartTime) / 1000 // Duración en segundos
  const player = room.getPlayer(lastDribbledPlayerId)
  const ability = player.e
  if (!isPausedNow) {
    const playerDiscProps = room.getPlayerDisc(lastDribbledPlayerId)
    const playerX = playerDiscProps.pos.x
    const playerY = playerDiscProps.pos.y
    const playerNx = playerDiscProps.speed.x
    const playerNy = playerDiscProps.speed.y
    const speedMultiplier = 1.05
    const playerSpeedX = playerNx * speedMultiplier
    const playerSpeedY = playerNy * speedMultiplier
    Utils.runAfterGameTick(() => {
      if (
        touchState.lastTouchDuration > ultiTimeThresholdStart &&
        ENABLE_POW_AND_ULTI &&
        ability === "curve"
      ) {
        room.setDiscProperties(0, { color: 0x0000ff })
      } else if (ability === "power") {
        const powerChargeRatio = Math.min(touchState.lastTouchDuration / powerTimeThreshold, 1)
        room.setDiscProperties(0, { color: lerpColor(0xffffff, 0xff0000, powerChargeRatio) })
      } else {
        room.setDiscProperties(0, { color: 0xffffff })
      }
      if (
        ability !== "none" &&
        ability !== "power" &&
        touchState.lastTouchDuration > firstTimeThreshold &&
        !fixedBarFirstVis
      ) {
        touchState.lastOpenedBarPlayerId = player.id
        if (ability == "curve") {
          room.setDiscProperties(currentStartDisc, {
            x: playerX - 28,
            y: playerY - 25,
          }) // Actualiza la posición de los discos de la barra
          room.setDiscProperties(currentStartDisc + 2, {
            x: playerX - 28,
            y: playerY - 25,
          })
          room.setDiscProperties(currentStartDisc + 1, {
            x: playerX + 28,
            y: playerY - 25,
          })
        } else if (ability == "lob") {
          if (ENABLE_BANANA) {
            room.setDiscProperties(currentStartDiscL, {
              x: playerX - 28,
              y: playerY - 25,
            }) // Actualiza la posición de los discos de la barra
            room.setDiscProperties(currentStartDiscL + 2, {
              x: playerX - 28,
              y: playerY - 25,
            })
            room.setDiscProperties(currentStartDiscL + 1, {
              x: playerX + 28,
              y: playerY - 25,
            })
          } else {
            room.setDiscProperties(currentStartDisc, {
              x: playerX,
              y: playerY - 40,
            }) // Actualiza la posición de los discos de la barra
            room.setDiscProperties(currentStartDisc + 2, {
              x: playerX + 6,
              y: playerY - 25,
            })
            room.setDiscProperties(currentStartDisc + 1, {
              x: playerX - 6,
              y: playerY - 25,
            })
          }
        } else {
          room.setDiscProperties(currentStartDisc, {
            x: playerX - 20,
            y: playerY - 25,
          }) // Actualiza la posición de los discos de la barra
          room.setDiscProperties(currentStartDisc + 2, {
            x: playerX - 20,
            y: playerY - 25,
          })
          room.setDiscProperties(currentStartDisc + 1, {
            x: playerX + 20,
            y: playerY - 25,
          })
        }
        fixedBarFirstVis = true
      } else if (
        ability !== "none" &&
        ability !== "power" &&
        touchState.lastTouchDuration > firstTimeThreshold &&
        fixedBarFirstVis
      ) {
        if (ENABLE_BANANA && ability == "lob") {
          room.setDiscProperties(currentStartDiscL, {
            xspeed: playerSpeedX,
            yspeed: playerSpeedY,
          }) // Actualiza la velocidad de los discos de la barra
          room.setDiscProperties(currentStartDiscL + 2, {
            xspeed: playerSpeedX,
            yspeed: playerSpeedY,
          })
          room.setDiscProperties(currentStartDiscL + 1, {
            xspeed: playerSpeedX,
            yspeed: playerSpeedY,
          })
        } else {
          room.setDiscProperties(currentStartDisc, {
            xspeed: playerSpeedX,
            yspeed: playerSpeedY,
          }) // Actualiza la velocidad de los discos de la barra
          room.setDiscProperties(currentStartDisc + 2, {
            xspeed: playerSpeedX,
            yspeed: playerSpeedY,
          })
          room.setDiscProperties(currentStartDisc + 1, {
            xspeed: playerSpeedX,
            yspeed: playerSpeedY,
          })
        }
      }
      if (
        ability == "curve" &&
        touchState.lastTouchDuration > firstTimeThreshold &&
        fixedBarFirstVis &&
        touchState.lastTouchDuration < powerTimeThreshold
      )
        room.setDiscProperties(currentStartDisc + 2, {
          xspeed: playerSpeedX + 0.45,
        })
      else if (
        ability == "curve" &&
        ENABLE_POW_AND_ULTI &&
        touchState.lastTouchDuration > powerTimeThreshold &&
        fixedBarFirstVis &&
        !fixedBarPowerVis
      ) {
        const startDisc = room.getDisc(currentStartDisc)
        if (startDisc) room.setDiscProperties(currentStartDisc + 2, {
          x: startDisc.pos.x,
          y: startDisc.pos.y,
        })
        fixedBarPowerVis = true
      } else if (
        ENABLE_BANANA &&
        ability == "lob" &&
        touchState.lastTouchDuration > firstTimeThreshold &&
        fixedBarFirstVis &&
        touchState.lastTouchDuration < powerTimeThreshold
      )
        room.setDiscProperties(currentStartDiscL + 2, {
          xspeed: playerSpeedX + 0.45,
        })
      else if (
        ENABLE_BANANA &&
        ability == "lob" &&
        touchState.lastTouchDuration > powerTimeThreshold &&
        fixedBarFirstVis &&
        !fixedBarPowerVis
      ) {
        room.setDiscProperties(currentStartDiscL, {
          x: playerX,
          y: playerY - 40,
        }) // Actualiza la posición de los discos de la barra
        room.setDiscProperties(currentStartDiscL + 2, {
          x: playerX + 6,
          y: playerY - 25,
        })
        room.setDiscProperties(currentStartDiscL + 1, {
          x: playerX - 6,
          y: playerY - 25,
        })
        fixedBarPowerVis = true
      } else if (
        ENABLE_BANANA &&
        ability == "none" &&
        touchState.lastTouchDuration > firstTimeThreshold &&
        fixedBarFirstVis &&
        touchState.lastTouchDuration < powerTimeThreshold
      ) {
        room.setDiscProperties(currentStartDisc + 1, {
          xspeed: playerSpeedX + 0.1,
        })
        room.setDiscProperties(currentStartDisc, { xspeed: playerSpeedX - 0.1 })
        room.setDiscProperties(currentStartDisc + 2, {
          xspeed: playerSpeedX - 0.1,
        })
      } else if (
        ENABLE_BANANA &&
        ability == "none" &&
        touchState.lastTouchDuration > powerTimeThreshold &&
        fixedBarFirstVis &&
        !fixedBarPowerVis
      ) {
        fixedBarPowerVis = true
      }
    })
  }
  allResetted = false
}
function resetTouchState(room) {
  touchState.touchingPlayerId = null
  touchState.touchStartTime = null
  touchState.lastDribbledPlayerId = null
  const ball = room.getBall()
  Utils.runAfterGameTick(() => {
    const _sd = room.getDisc(currentStartDisc)
    for (i = currentStartDisc; i < currentStartDisc + 3; i++)
      if (_sd)
        room.setDiscProperties(i, { x: _sd.pos.x, y: _sd.pos.y, xspeed: 0, yspeed: 0 })
      else room.setDiscProperties(i, { x: 0, y: 0, xspeed: 0, yspeed: 0 })
    if (ENABLE_BANANA) {
      const _sdL = room.getDisc(currentStartDiscL)
      for (i = currentStartDiscL; i < currentStartDiscL + 3; i++)
        if (_sdL)
          room.setDiscProperties(i, { x: _sdL.pos.x, y: _sdL.pos.y, xspeed: 0, yspeed: 0 })
        else room.setDiscProperties(i, { x: 0, y: 0, xspeed: 0, yspeed: 0 })
    }
  })
  fixedBarFirstVis = false
  fixedBarPowerVis = false
  allResetted = true
}
function handleUltiState(room) {
  const elapsedTime = (Date.now() - ultiState.ultiStartTime) / 1000
  if (
    elapsedTime <= 2.2 ||
    ultiState.ultiPlayer !== touchState.lastTouchedPlayerId ||
    !room.getPlayer(ultiState.ultiPlayer)
  ) {
    if (!IS_ANY_ACTIVE_EFFECT) {
      resetUltiState() // Corta el efecto si la velocidad/dirección de la pelota cambió bruscamente
      Utils.runAfterGameTick(() => {
        room.setDiscProperties(0, {
          xgravity: 0,
          ygravity: 0,
          radius: normalBallRadius,
          cGroup: cf.ball,
          damping: 0.99,
        })
      })
      return
    }
    let gravity = {
      x: 0,
      y: 0,
    }
    const playerInput = room.getPlayer(ultiState.ultiPlayer).input
    const ball = room.getBall(true)
    const negativeX = [7, 4, 6, 5]
    const positiveX = [8, 11, 9, 10]
    const negativeY = [1, 13, 5, 9]
    const positiveY = [2, 14, 6, 10]
    if (negativeX.includes(playerInput))
      gravity.x = -0.24 / Math.max(Math.abs(ball.speed.x), 1)
    else if (positiveX.includes(playerInput))
      gravity.x = 0.24 / Math.max(Math.abs(ball.speed.x), 1)
    if (negativeY.includes(playerInput))
      gravity.y = -0.24 / Math.max(Math.abs(ball.speed.y), 1)
    else if (positiveY.includes(playerInput))
      gravity.y = 0.24 / Math.max(Math.abs(ball.speed.y), 1)
    Utils.runAfterGameTick(() => {
      room.setDiscProperties(0, {
        xgravity: gravity.x,
        ygravity: gravity.y,
      })
    })
  } else {
    resetUltiState()
    IS_ANY_ACTIVE_EFFECT = false
    Utils.runAfterGameTick(() => {
      room.setDiscProperties(0, {
        xgravity: 0,
        ygravity: 0,
        radius: normalBallRadius,
        cGroup: cf.ball,
        damping: 0.99,
      })
    })
  }
}
function handleCurveState(room) {
  const elapsedTime = (Date.now() - curveState.curveStartTime) / 1000 // Tiempo transcurrido desde que arrancó la curva
  if (elapsedTime <= curveState.curveDuration) {
    const increasingFactor =
      (Math.min(elapsedTime * 3, 0.7) * (1 + curveState.curveIntensity * 4)) /
      curveState.curveDuration
    const curveEffect = {
      x: curveState.curveDirection.x * 0.1 * increasingFactor, // Aplica el efecto de curva
      y: curveState.curveDirection.y * 0.1 * increasingFactor,
    }
    velocity.xspeed = curveEffect.x
    velocity.yspeed = curveEffect.y
    if (!IS_ANY_ACTIVE_EFFECT) {
      // Corta el efecto si la velocidad/dirección de la pelota cambió bruscamente
      resetCurveState()
      Utils.runAfterGameTick(() => {
        room.setDiscProperties(0, {
          xgravity: 0,
          ygravity: 0,
          radius: normalBallRadius,
          cGroup: cf.ball,
          damping: 0.99,
        })
      })
      return
    }
    curveState.ballGravityX = velocity.xspeed * 0.5
    curveState.ballGravityY = -velocity.yspeed * 0.5
    Utils.runAfterGameTick(() => {
      room.setDiscProperties(0, {
        xgravity: curveState.ballGravityX,
        ygravity: curveState.ballGravityY,
      }) // Aplica la nueva velocidad
    })
  } else {
    resetCurveState() // Termina el efecto de curva de forma natural
    IS_ANY_ACTIVE_EFFECT = false
    Utils.runAfterGameTick(() => {
      room.setDiscProperties(0, {
        xgravity: 0,
        ygravity: 0,
        radius: normalBallRadius,
        cGroup: cf.ball,
        damping: 0.99,
      })
    })
  }
}
function calculateDistance(pos1, pos2) {
  const dx = pos1.x - pos2.x
  const dy = pos1.y - pos2.y
  const distanceSquared = dx * dx + dy * dy // Distancia al cuadrado, evita la raíz cuadrada si no hace falta
  return Math.sqrt(distanceSquared)
}
function isClosestPlayerTouchingBall(posBall, closestPlayer) {
  const TOUCH_DISTANCE = 25
  if (!closestPlayer || !closestPlayer.pos) return 0 // No hay jugador cerca, no hay nada que calcular
  const distance = calculateDistance(posBall, closestPlayer.pos)
  if (distance > TOUCH_DISTANCE) return 0 // No está lo bastante cerca como para considerarse un toque
  if (
    (closestPlayer.pos.y > posBall.y && closestPlayer.pos.x > posBall.x) ||
    (closestPlayer.pos.y < posBall.y && closestPlayer.pos.x < posBall.x)
  )
    return 1
  return 2 // El jugador toca la pelota por arriba
}
function isMovingRightOfPerpendicular(player, ball) {
  const dx = ball.x - player.disc.pos.x
  const dy = ball.y - player.disc.pos.y
  let playerInputX
  let playerInputY
  let realInput
  const negativeX = [7, 4, 6, 5, 20, 21, 22, 23]
  const positiveX = [8, 11, 9, 10, 24, 25, 26, 27]
  const negativeY = [1, 13, 5, 9, 17, 21, 25, 29]
  const positiveY = [2, 14, 6, 10, 18, 22, 26, 30]
  const notr = [12, 28, 3, 19, 15, 31]
  if (notr.includes(player.input)) realInput = player.rpi
  else realInput = player.input
  if (negativeX.includes(realInput)) playerInputX = -1
  else if (positiveX.includes(realInput)) playerInputX = 1
  if (negativeY.includes(realInput)) playerInputY = -1
  else if (positiveY.includes(realInput)) playerInputY = 1
  if (playerInputX === undefined) playerInputX = 0
  if (playerInputY === undefined) playerInputY = 0
  const velocityX = playerInputX
  const velocityY = playerInputY
  const dirX = dx
  const dirY = dy
  const normalX = -dirY
  const normalY = dirX
  const dot = velocityX * normalX + velocityY * normalY
  return dot > 0
}
function calculateCurveEffectDirection(ball, player) {
  const kickDirection = {
    x: ball.x - player.disc.pos.x,
    y: ball.y - player.disc.pos.y,
  }
  const magnitudeSquared = kickDirection.x ** 2 + kickDirection.y ** 2
  if (magnitudeSquared === 0) return { x: 0, y: 0 } // Evita dividir por cero
  const magnitude = Math.sqrt(magnitudeSquared)
  const directionForAngle = isMovingRightOfPerpendicular(player, ball)
  const directionMultiplier = directionForAngle ? 1 : -1
  return {
    x: (kickDirection.y / magnitude) * directionMultiplier,
    y: (kickDirection.x / magnitude) * directionMultiplier,
  }
}
function resetCurveState() {
  curveState.isCurving = false
  curveState.curveStartTime = null
  curveState.curveDirection = null
  curveState.curveIntensity = 0
  curveState.ballGravityX = 0
  curveState.ballGravityY = 0
}
function resetUltiState() {
  ultiState.isUlti = false
  ultiState.ultiStartTime = null
  ultiState.ultiPlayer = null
}
let isShot = false
let lId, sId, prevLId, tId
function updateLastTouchedPlayer(playerId, room) {
  if (playerId !== touchState.lastTouchedPlayerId) {
    if (
      touchState.lastTouchedPlayerId != null &&
      room.getPlayer(touchState.lastTouchedPlayerId) != null
    ) {
      if (
        touchState.secondLastTouchedPlayerId != null &&
        room.getPlayer(touchState.secondLastTouchedPlayerId) != null
      ) {
        touchState.thirdLastTouchedPlayerId =
          touchState.secondLastTouchedPlayerId
        touchState.thirdLastTouchedPlayerName = room.getPlayer(
          touchState.thirdLastTouchedPlayerId,
        ).name
      }
      touchState.secondLastTouchedPlayerId = touchState.lastTouchedPlayerId
      touchState.secondLastTouchedPlayerName = room.getPlayer(
        touchState.secondLastTouchedPlayerId,
      ).name
    }
    touchState.lastTouchedPlayerId = playerId
    touchState.lastTouchedPlayerName = room.getPlayer(
      touchState.lastTouchedPlayerId,
    ).name
    touchState.lastDribbledPlayerId = touchState.lastTouchedPlayerId
    if (lId) prevLId = lId
    lId = room.getPlayer(touchState.lastTouchedPlayerId)
      ? room.getPlayer(touchState.lastTouchedPlayerId)
      : null
    sId = room.getPlayer(touchState.secondLastTouchedPlayerId)
      ? room.getPlayer(touchState.secondLastTouchedPlayerId)
      : null
    tId = room.getPlayer(touchState.thirdLastTouchedPlayerId)
      ? room.getPlayer(touchState.thirdLastTouchedPlayerId)
      : null
    if (
      tId &&
      sId &&
      lId &&
      sId.team.id !== tId.team.id &&
      lId.id !== sId.id &&
      lId.team.id === sId.team.id
    ) {
      sId.topc++
    }
    if (!lId || !sId || lId.id === sId.id || isShot || lId === prevLId) return
    const lIdT = lId.team.id
    const sIdT = sId.team.id
    if (lIdT === sIdT) {
      sId.ap++
      room.sendAnnouncement(
        `${emojiSucces} 𝖯𝖺𝗌𝖾 𝖼𝗈𝗋𝗋𝖾𝖼𝗍𝗈: ${sId.name} → ${lId.name}`,
        null,
        colorSucces,
        "small",
        NotifSound.NONE,
      )
    }
  }
}
function resetLastTouchedPlayer() {
  touchState.secondLastTouchedPlayerId = null
  touchState.secondLastTouchedPlayerName = null
  touchState.lastTouchedPlayerId = null
  touchState.lastTouchedPlayerName = null
  touchState.lastDribbledPlayerId = null
}

/*
    ╔══════════════════════════════════════════════════════════════════════════════════════════════════════════╗
    ║                                         A B I L I T Y     E N D                                          ║
    ╚══════════════════════════════════════════════════════════════════════════════════════════════════════════╝
*/

/*
 ██▀███   ▒█████   ▒█████   ███▄ ▄███▓
▓██ ▒ ██▒▒██▒  ██▒▒██▒  ██▒▓██▒▀█▀ ██▒
▓██ ░▄█ ▒▒██░  ██▒▒██░  ██▒▓██    ▓██░
▒██▀▀█▄  ▒██   ██░▒██   ██░▒██    ▒██
░██▓ ▒██▒░ ████▓▒░░ ████▓▒░▒██▒   ░██▒
░ ▒▓ ░▒▓░░ ▒░▒░▒░ ░ ▒░▒░▒░ ░ ▒░   ░  ░
  ░▒ ░ ▒░  ░ ▒ ▒░   ░ ▒ ▒░ ░  ░      ░
  ░░   ░ ░ ░ ░ ▒  ░ ░ ░ ▒  ░      ░
   ░         ░ ░      ░ ░         ░

*/
function onError(error, playerId) {
  console.log(playerId, error)
}
Room.create(
  {
    name: ROOM_NAME,
    showInRoomList: IS_PUBLIC,
    maxPlayerCount: MAX_PLAYER_NUMBER,
    token: HEADLESS_TOKEN,
    noPlayer: true,
    unlimitedPlayerCount: true,
    geo: { lat: -33.4372, lon: -70.6506, flag: "cl" },
    onError: onError,
  },
  {
    onError: (error, playerId) => {
      console.log(playerId, error)
    },
    onOpen: (openedRoom) => {
      room = openedRoom
      room.onAfterRoomLink = (roomLink) => {
        const now = new Date()
        console.log(`${now.getHours()}:${now.getMinutes()}:${now.getSeconds()}`)
        ROOM_LINK = roomLink
        console.log(roomLink)
        if (room.players.length === 0) {
          sendDiscordEmbed(WEBHOOK_ROOM_OPEN, {
            author: { name: `🐺 ${ROOM_NAME}` },
            title: "<a:sd:1533345082777014452> Sala abierta",
            url: roomLink,
            description: `**[➤ Click acá para entrar](${roomLink})**`,
            color: 0xE6E6E6,
            fields: [
              { name: "<:arrow:1524898169694064765> Link directo", value: `\`${roomLink}\``, inline: false },
              { name: "<:arrow:1524898169694064765> Objetivo", value: `${mono(String(GOALS_TO_WIN))} goles`, inline: true },
              { name: "<:arrow:1524898169694064765> Enfriamiento chat", value: `${mono('1')} min por spam`, inline: true },
            ],
            timestamp: now.toISOString(),
            footer: { text: "Sala abierta" },
            image: { url: DISCORD_IMAGE_ROOM_OPEN },
            thumbnail: { url: "https://cdn.discordapp.com/attachments/1524879478831190181/1535056155632467990/Logo-SD.png?ex=6a765ff3&is=6a750e73&hm=c10db33075ef211457077a97679ffab6a0e9225397110a168cb3a3c28adda31f&" },
          })
          room.setScoreLimit(SCORE_LIMIT)
          room.setTimeLimit(TIME_LIMIT)
          room.lockTeams() // Bloquea el cambio de equipo manual a nivel de protocolo: nadie puede tocar Rojo/Azul salvo el bot (es un toggle, arranca destrabado)
          stadFCmd()
          dbKits[homeTeam]
            .slice(1, 2)
            .forEach((k) =>
              k.c3 !== undefined
                ? room.setTeamColors(Team.RED, k.a, k.c0, k.c1, k.c2, k.c3)
                : k.c2 !== undefined
                  ? room.setTeamColors(Team.RED, k.a, k.c0, k.c1, k.c2)
                  : room.setTeamColors(Team.RED, k.a, k.c0, k.c1),
            )
          dbKits[awayTeam]
            .slice(1, 2)
            .forEach((k) =>
              k.c3 !== undefined
                ? room.setTeamColors(Team.BLUE, k.a, k.c0, k.c1, k.c2, k.c3)
                : k.c2 !== undefined
                  ? room.setTeamColors(Team.BLUE, k.a, k.c0, k.c1, k.c2)
                  : room.setTeamColors(Team.BLUE, k.a, k.c0, k.c1),
            )
          sendAnnos(room)
        }
      }

      /*
             ▄████▄   ▒█████   ███▄ ▄███▓ ███▄ ▄███▓ ▄▄▄       ███▄    █ ▓█████▄   ██████
            ▒██▀ ▀█  ▒██▒  ██▒▓██▒▀█▀ ██▒▓██▒▀█▀ ██▒▒████▄     ██ ▀█   █ ▒██▀ ██▌▒██    ▒
            ▒▓█    ▄ ▒██░  ██▒▓██    ▓██░▓██    ▓██░▒██  ▀█▄  ▓██  ▀█ ██▒░██   █▌░ ▓██▄
            ▒▓▓▄ ▄██▒▒██   ██░▒██    ▒██ ▒██    ▒██ ░██▄▄▄▄██ ▓██▒  ▐▌██▒░▓█▄   ▌  ▒   ██▒
            ▒ ▓███▀ ░░ ████▓▒░▒██▒   ░██▒▒██▒   ░██▒ ▓█   ▓██▒▒██░   ▓██░░▒████▓ ▒██████▒▒
            ░ ░▒ ▒  ░░ ▒░▒░▒░ ░ ▒░   ░  ░░ ▒░   ░  ░ ▒▒   ▓▒█░░ ▒░   ▒ ▒  ▒▒▓  ▒ ▒ ▒▓▒ ▒ ░
              ░  ▒     ░ ▒ ▒░ ░  ░      ░░  ░      ░  ▒   ▒▒ ░░ ░░   ░ ▒░ ░ ▒  ▒ ░ ░▒  ░ ░
            ░        ░ ░ ░ ▒  ░      ░   ░      ░     ░   ▒      ░   ░ ░  ░ ░  ░ ░  ░  ░
            ░ ░          ░ ░         ░          ░         ░  ░         ░    ░          ░
            ░                                                             ░
      */
      function getCommand(commandStr) {
        if (commands.hasOwnProperty(commandStr)) return commandStr
        for (const [key, value] of Object.entries(commands))
          for (let alias of value.aliases) if (alias == commandStr) return key
        return false
      }
      function helpCmd(player) {
        room.sendAnnouncement(
          helpString,
          player.id,
          colorSucces,
          "normal",
          NotifSound.NONE,
        )
      }
      function controlsCmd(player) {
        room.sendAnnouncement(
          controlsString,
          player.id,
          colorInfo,
          "small",
          NotifSound.NONE,
        )
      }
      function changeSlideStatePlayerSpecialCmd(player) {
        if (!player.es) {
          player.es = true
          room.sendAnnouncement(
            `${emojiSucces} 𝖥𝗎𝗇𝖼𝗂𝗈́𝗇 𝖽𝖾 𝖽𝖾𝗌𝗅𝗂𝗓𝖺𝗆𝗂𝖾𝗇𝗍𝗈 𝖺𝖼𝗍𝗂𝗏𝖺𝖽𝖺.`,
            player.id,
            colorSucces,
            "small",
            NotifSound.NONE,
          )
        } else {
          player.es = false
          room.sendAnnouncement(
            `${emojiSucces} 𝖫𝖺 𝖿𝗎𝗇𝖼𝗂𝗈́𝗇 𝖽𝖾 𝖽𝖾𝗌𝗅𝗂𝗓𝖺𝗆𝗂𝖾𝗇𝗍𝗈 𝖾𝗌𝗍𝖺́ 𝖽𝖾𝗌𝖺𝖼𝗍𝗂𝗏𝖺𝖽𝖺.`,
            player.id,
            colorSucces,
            "small",
            NotifSound.NONE,
          )
        }
        return
      }
      function changeOPModeStatePlayerSpecialCmd(player) {
        if (!player.op) {
          player.op = true
          room.sendAnnouncement(
            `${emojiSucces} 𝖥𝗎𝗇𝖼𝗂𝗈́𝗇 𝖽𝖾𝗅 𝗆𝗈𝖽𝗈 𝐎𝐏 𝖺𝖼𝗍𝗂𝗏𝖺𝖽𝖺.`,
            player.id,
            colorSucces,
            "small",
            NotifSound.NONE,
          )
        } else {
          player.op = false
          room.sendAnnouncement(
            `${emojiSucces} 𝖥𝗎𝗇𝖼𝗂𝗈́𝗇 𝖽𝖾𝗅 𝗆𝗈𝖽𝗈 𝐎𝐏 𝖽𝖾𝗌𝖺𝖼𝗍𝗂𝗏𝖺𝖽𝖺.`,
            player.id,
            colorSucces,
            "small",
            NotifSound.NONE,
          )
        }
        return
      }
      function setCurveAbility(player) {
        if (player.e === "curve") {
          room.sendAnnouncement(
            `${emojiAtt} 𝖫𝖺 𝗈𝗉𝖼𝗂𝗈́𝗇 𝖽𝖾 𝖼𝗎𝗋𝗏𝖺 𝗒𝖺 𝖾𝗌𝗍𝖺́ 𝗌𝖾𝗅𝖾𝖼𝖼𝗂𝗈𝗇𝖺𝖽𝖺.`,
            player.id,
            colorAtt,
            "small",
            NotifSound.NONE,
          )
          return
        }
        setSpecialAbility(player, "curve", "Curve")
      }
      function setLobAbility(player) {
        if (player.e === "lob") {
          room.sendAnnouncement(
            `${emojiAtt} 𝖸𝖺 𝗌𝖾 𝗁𝖺 𝗌𝖾𝗅𝖾𝖼𝖼𝗂𝗈𝗇𝖺𝖽𝗈 𝗅𝖺 𝗁𝖺𝖻𝗂𝗅𝗂𝖽𝖺𝖽 «𝖫𝗈𝖻-𝗌𝗁𝗈𝗍».`,
            player.id,
            colorAtt,
            "small",
            NotifSound.NONE,
          )
          return
        }
        setSpecialAbility(player, "lob", "Lob-shot")
      }
      function setNoneAbility(player) {
        if (player.e === "none") {
          room.sendAnnouncement(
            `${emojiAtt} 𝖸𝖺 𝗌𝖾 𝗁𝖺 𝗌𝖾𝗅𝖾𝖼𝖼𝗂𝗈𝗇𝖺𝖽𝗈 «N𝗈𝗋𝗆𝖺𝗅».`,
            player.id,
            colorAtt,
            "small",
            NotifSound.NONE,
          )
          return
        }
        setSpecialAbility(player, "none", "Nada")
      }
      function setPowerAbility(player) {
        if (player.e === "power") {
          room.sendAnnouncement(
            `${emojiAtt} 𝖸𝖺 𝗌𝖾 𝗁𝖺 𝗌𝖾𝗅𝖾𝖼𝖼𝗂𝗈𝗇𝖺𝖽𝗈 𝗅𝖺 𝗁𝖺𝖻𝗂𝗅𝗂𝖽𝖺𝖽 «𝖯𝗈𝗐𝖾𝗋 𝗋𝖾𝖼𝗍𝗈».`,
            player.id,
            colorAtt,
            "small",
            NotifSound.NONE,
          )
          return
        }
        setSpecialAbility(player, "power", "Power recto")
      }
      function setSpecialAbility(player, abilityValue, abilityLabel) {
        try {
          player.e = abilityValue
          const msg =
            abilityValue === "none"
              ? `${emojiSucces} 𝖲𝖾 𝗁𝖺 𝗌𝖾𝗅𝖾𝖼𝖼𝗂𝗈𝗇𝖺𝖽𝗈 𝖼𝗈𝗋𝗋𝖾𝖼𝗍𝖺𝗆𝖾𝗇𝗍𝖾 𝗅𝖺 𝖿𝗎𝗇𝖼𝗂𝗈́𝗇 «N𝗈𝗋𝗆𝖺𝗅»`
              : `${emojiSucces} 𝖲𝖾 𝗁𝖺 𝗌𝖾𝗅𝖾𝖼𝖼𝗂𝗈𝗇𝖺𝖽𝗈 𝖼𝗈𝗋𝗋𝖾𝖼𝗍𝖺𝗆𝖾𝗇𝗍𝖾 𝗅𝖺 𝖿𝗎𝗇𝖼𝗂𝗈́𝗇 «${abilityLabel}»`
          room.sendAnnouncement(
            msg,
            player.id,
            colorSucces,
            "small",
            NotifSound.NONE,
          )
        } catch (err) {
          console.error(err)
        } finally {
        }
      }
      function dcCmd(player) {
        room.sendAnnouncement(
          discordString,
          player.id,
          colorDiscord,
          "bold",
          NotifSound.NONE,
        )
      }
      function leaveCmd(player) {
        const hour = new Date().getHours()
        let message
        if (hour >= 6 && hour < 18) message = "Bᴜᴇɴᴏs ᴅɪ́ᴀs, ʜᴀsᴛᴀ ʟᴀ ᴘʀᴏ́xɪᴍᴀ."
        else if (hour >= 18 && hour < 23)
          message = "Bᴜᴇɴᴀs ɴᴏᴄʜᴇs, ʜᴀsᴛᴀ ʟᴀ ᴘʀᴏ́xɪᴍᴀ."
        else message = "Bᴜᴇɴᴀs ɴᴏᴄʜᴇs, ʜᴀsᴛᴀ ʟᴀ ᴘʀᴏ́xɪᴍᴀ."
        room.kickPlayer(player.id, message, false)
      }
      function seeKitsCmd(player) {
        room.sendAnnouncement(
          `${kitsInfo}`,
          player.id,
          colorInfo,
          "small",
          NotifSound.NONE,
        )
        room.sendAnnouncement(
          `${emojiInfo} 𝖯𝖺𝗋𝖺 𝖼𝖺𝗆𝖻𝗂𝖺𝗋 𝖽𝖾 𝗄𝗂𝗍, 𝗎𝗍𝗂𝗅𝗂𝗓𝖺 !kr <kit_no> (Red)  !kb <kit_no> (Blue)`,
          player.id,
          colorInfo,
          "small",
          NotifSound.NONE,
        )
      }
      function changeRedKitCmd(player, message) {
        if (message.length < 2) {
          room.sendAnnouncement(
            `${emojiAtt} 𝖤𝗅 𝗇𝗎́𝗆𝖾𝗋𝗈 𝖽𝖾 𝗄𝗂𝗍 𝖽𝖾𝖻𝖾 𝖾𝗌𝗍𝖺𝗋 𝖾𝗇𝗍𝗋𝖾 𝟢 𝗒 ${dbKits.length}.`,
            player.id,
            colorAtt,
            "bold",
            NotifSound.NONE,
          )
          return
        }
        const msgArray = message.split(/ +/).slice(1)
        if (msgArray.length < 1) {
          room.sendAnnouncement(
            `${emojiAtt} 𝖤𝗅 𝗇𝗎́𝗆𝖾𝗋𝗈 𝖽𝖾 𝗄𝗂𝗍 𝖽𝖾𝖻𝖾 𝖾𝗌𝗍𝖺𝗋 𝖾𝗇𝗍𝗋𝖾 𝟢 𝗒 ${dbKits.length}.`,
            player.id,
            colorAtt,
            "bold",
            NotifSound.NONE,
          )
          return
        }
        if (msgArray[0].length > 0) {
          if (msgArray[0] < dbKits.length && msgArray[0] >= 0) {
            const kit = msgArray[0]
            if (awayTeam == kit) {
              room.sendAnnouncement(
                `${emojiAtt} 𝖭𝗈 𝗌𝖾 𝗉𝗎𝖾𝖽𝖾 𝖺𝗌𝗂𝗀𝗇𝖺𝗋 𝗅𝖺 𝗆𝗂𝗌𝗆𝖺 𝖾𝗊𝗎𝗂𝗉𝖺𝖼𝗂𝗈́𝗇 𝖺 𝖺𝗆𝖻𝗈𝗌 𝖾𝗊𝗎𝗂𝗉𝗈𝗌.`,
                player.id,
                colorAtt,
                "bold",
                NotifSound.NONE,
              )
              return
            }
            homeTeam = kit
            dbKits[kit]
              .slice(1, 2)
              .forEach((k) =>
                k.c3 !== undefined
                  ? room.setTeamColors(Team.RED, k.a, k.c0, k.c1, k.c2, k.c3)
                  : k.c2 !== undefined
                    ? room.setTeamColors(Team.RED, k.a, k.c0, k.c1, k.c2)
                    : room.setTeamColors(Team.RED, k.a, k.c0, k.c1),
              )
            room.sendAnnouncement(
              `${emojiSucces} ${player.name}, 𝖺𝗌𝗂𝗀𝗇𝗈́ 𝖾𝗅 ${dbKits[kit][0].t} 𝗄𝗂𝗍 𝗉𝖺𝗋𝖺 𝖾𝗅 𝖾𝗊𝗎𝗂𝗉𝗈 𝗋𝗈𝗃𝗈.`,
              null,
              colorSucces,
              "small",
              NotifSound.NONE,
            )
          } else
            room.sendAnnouncement(
              `${emojiAtt} 𝖤𝗅 𝗇𝗎́𝗆𝖾𝗋𝗈 𝖽𝖾 𝗄𝗂𝗍 𝖽𝖾𝖻𝖾 𝖾𝗌𝗍𝖺𝗋 𝖾𝗇𝗍𝗋𝖾 𝟢 𝗒 ${dbKits.length}.`,
              player.id,
              colorAtt,
              "bold",
              NotifSound.NONE,
            )
        }
      }
      function changeBlueKitCmd(player, message) {
        if (message.length < 2) {
          room.sendAnnouncement(
            `${emojiAtt} 𝖤𝗅 𝗇𝗎́𝗆𝖾𝗋𝗈 𝖽𝖾 𝗄𝗂𝗍 𝖽𝖾𝖻𝖾 𝖾𝗌𝗍𝖺𝗋 𝖾𝗇𝗍𝗋𝖾 𝟢 𝗒 ${dbKits.length}.`,
            player.id,
            colorAtt,
            "bold",
            NotifSound.NONE,
          )
          return
        }
        const msgArray = message.split(/ +/).slice(1)
        if (msgArray.length < 1) {
          room.sendAnnouncement(
            `${emojiAtt} 𝖤𝗅 𝗇𝗎́𝗆𝖾𝗋𝗈 𝖽𝖾 𝗄𝗂𝗍 𝖽𝖾𝖻𝖾 𝖾𝗌𝗍𝖺𝗋 𝖾𝗇𝗍𝗋𝖾 𝟢 𝗒 ${dbKits.length}.`,
            player.id,
            colorAtt,
            "bold",
            NotifSound.NONE,
          )
          return
        }
        if (msgArray && msgArray[0] && msgArray[0].length > 0) {
          if (msgArray[0] < dbKits.length && msgArray[0] >= 0) {
            const kit = msgArray[0]
            if (homeTeam == kit) {
              room.sendAnnouncement(
                `${emojiAtt} 𝖭𝗈 𝗌𝖾 𝗉𝗎𝖾𝖽𝖾 𝖺𝗌𝗂𝗀𝗇𝖺𝗋 𝗅𝖺 𝗆𝗂𝗌𝗆𝖺 𝖾𝗊𝗎𝗂𝗉𝖺𝖼𝗂𝗈́𝗇 𝖺 𝖺𝗆𝖻𝗈𝗌 𝖾𝗊𝗎𝗂𝗉𝗈𝗌.`,
                player.id,
                colorAtt,
                "bold",
                NotifSound.NONE,
              )
              return
            }
            awayTeam = kit
            dbKits[kit]
              .slice(1, 2)
              .forEach((k) =>
                k.c3 !== undefined
                  ? room.setTeamColors(Team.BLUE, k.a, k.c0, k.c1, k.c2, k.c3)
                  : k.c2 !== undefined
                    ? room.setTeamColors(Team.BLUE, k.a, k.c0, k.c1, k.c2)
                    : room.setTeamColors(Team.BLUE, k.a, k.c0, k.c1),
              )
            room.sendAnnouncement(
              `${emojiSucces} ${player.name}, 𝖺𝗌𝗂𝗀𝗇𝗈́ 𝖾𝗅 ${dbKits[kit][0].t} 𝗄𝗂𝗍 𝗉𝖺𝗋𝖺 𝖾𝗅 𝖾𝗊𝗎𝗂𝗉𝗈 𝖺𝗓𝗎𝗅.`,
              null,
              colorSucces,
              "small",
              NotifSound.NONE,
            )
          } else
            room.sendAnnouncement(
              `${emojiAtt} 𝖤𝗅 𝗇𝗎́𝗆𝖾𝗋𝗈 𝖽𝖾 𝗄𝗂𝗍 𝖽𝖾𝖻𝖾 𝖾𝗌𝗍𝖺𝗋 𝖾𝗇𝗍𝗋𝖾 𝟢 𝗒 ${dbKits.length}.`,
              player.id,
              colorAtt,
              "bold",
              NotifSound.NONE,
            )
        }
      }
      function lerpColor(hexA, hexB, t) {
        const r = Math.round(((hexA >> 16) & 0xff) * (1 - t) + ((hexB >> 16) & 0xff) * t)
        const g = Math.round(((hexA >> 8) & 0xff) * (1 - t) + ((hexB >> 8) & 0xff) * t)
        const b = Math.round((hexA & 0xff) * (1 - t) + (hexB & 0xff) * t)
        return (r << 16) | (g << 8) | b
      }

      function percentColor(pct) {
        const clamp = Math.max(0, Math.min(100, pct))
        if (clamp < 50) return lerpColor(0xf85651, 0xf5c518, clamp / 49)
        return lerpColor(0xf5c518, 0xd2ad78ff, (clamp - 50) / 50)
      }

      function memideCmd(player, message) {
        const parts = message.trim().split(/ +/)
        const cosa = parts.slice(1).join(" ") || "𝗅𝖾 𝗆𝗂𝖽𝖾"
        const pct = Math.floor(Math.random() * 101) // 0–100
        const color = percentColor(pct)

        const filled = Math.round(pct / 10)
        const bar = "█".repeat(filled) + "░".repeat(10 - filled)

        room.sendAnnouncement(
          `🐺 ${player.name} — ${cosa}: [${bar}] ${pct}%`,
          null,
          color,
          "bold",
          NotifSound.NONE,
        )
      }

      function suerteCmd(player) {
        const pct = Math.floor(Math.random() * 101)
        const color = percentColor(pct)
        const filled = Math.round(pct / 10)
        const bar = "🍀".repeat(filled) + "".repeat(10 - filled)
        const frases = [
          "𝗆𝖾𝗃𝗈𝗋 𝗊𝗎𝖾́𝖽𝖺𝗍𝖾 𝖾𝗇 𝖼𝖺𝗌𝖺",
          "𝖾𝗏𝗂𝗍𝖺 𝖺𝗉𝗈𝗌𝗍𝖺𝗋 𝗁𝗈𝗒",
          "𝗇𝗈𝗋𝗆𝖺𝗅, 𝖼𝗈𝗆𝗈 𝗌𝗂𝖾𝗆𝗉𝗋𝖾",
          "𝗏𝖺𝗌 𝖻𝗂𝖾𝗇, 𝖼𝗈𝗇𝖿𝗂́𝖺 𝖾𝗇 𝗍𝗂",
          "¡𝖣𝗂𝖺 𝖽𝖾 𝗌𝗎𝖾𝗋𝗍𝖾!",
        ]
        const frase = frases[Math.floor((pct / 100) * (frases.length - 1))]
        room.sendAnnouncement(
          `🐺 🎲 𝖲𝗎𝖾𝗋𝗍𝖾 𝖽𝖾 ${player.name} 𝗁𝗈𝗒 [${bar}] ${pct}% — ${frase}`,
          null,
          color,
          "bold",
          NotifSound.NONE,
        )
      }

      function dadoCmd(player, message) {
        const parts = message.trim().split(/ +/)
        const caras = parseInt(parts[1]) || 6
        if (caras < 2 || caras > 100) {
          room.sendAnnouncement(
            `${emojiAtt} 𝖤𝗅 𝖽𝖺𝖽𝗈 𝖽𝖾𝖻𝖾 𝗍𝖾𝗇𝖾𝗋 𝖾𝗇𝗍𝗋𝖾 𝟤 𝗒 𝟣𝟢𝟢 𝖼𝖺𝗋𝖺𝗌.`,
            player.id, colorAtt, "small", NotifSound.NONE,
          )
          return
        }
        const resultado = Math.floor(Math.random() * caras) + 1
        const t = (resultado - 1) / (caras - 1)
        const color = lerpColor(0xf85651, 0xd2ad78ff, t)
        room.sendAnnouncement(
          `🐺 🎲 ${player.name} 𝗍𝗂𝗋𝗈́ 𝗎𝗇 𝖣𝖺𝖽𝗈 𝖽𝖾 ${caras} 𝖼𝖺𝗋𝖺𝗌 𝗒 𝗌𝖺𝖼𝗈́: ${resultado}`,
          null, color, "bold", NotifSound.NONE,
        )
      }

      function stadFCmd() {
        room.stopGame()
        room.setCurrentStadium(
          Utils.parseStadium(JSON.stringify(stadiumF), console.log),
        )
      }
      function claimAdminCmd(player, message) {
        const parts = message.trim().split(/\s+/)
        const code = parts[1] || ""
        if (!code) {
          room.sendAnnouncement(
            `${emojiAtt} 𝖴𝗌𝖺 𝖾𝗅 𝖼𝗈𝖽𝗂𝗀𝗈 𝖽𝖾 𝖺𝖽𝗆𝗂𝗇 𝗏𝖺𝗅𝗂𝖽𝗈. 𝗎𝗌𝖺 !𝖼𝗅𝖺𝗂𝗆 <𝖼𝗈𝖽𝗂𝗀𝗈>`,
            player.id,
            colorAtt,
            "small",
            NotifSound.NONE,
          )
          return
        }
        if (code !== ADMIN_CLAIM_CODE) {
          room.sendAnnouncement(
            `${emojiAtt} 𝖢𝗈𝖽𝗂𝗀𝗈 𝖽𝖾 𝖺𝖽𝗆𝗂𝗇 𝖨𝗇𝗏𝖺𝗅𝗂𝖽𝗈.`,
            player.id,
            colorAtt,
            "small",
            NotifSound.NONE,
          )
          return
        }
        room.setPlayerAdmin(player.id, true)
        room.sendAnnouncement(
          `${emojiSucces} ${player.name} 𝖠𝗁𝗈𝗋𝖺 𝖾𝗌 𝖺𝖽𝗆𝗂𝗇𝗂𝗌𝗍𝗋𝖺𝖽𝗈𝗋.`,
          null,
          colorSucces,
          "small",
          NotifSound.NONE,
        )
      }
      function adminHelpCmd(player) {
        room.sendAnnouncement(
          adminHelpString,
          player.id,
          colorSucces,
          "normal",
          NotifSound.NONE,
        )
      }
      function moveCmd(player, message) {
        const parts = message.trim().split(/\s+/)
        const targetName = parts[1]
        const teamArg = (parts[2] || '').toLowerCase()
        if (!targetName || !teamArg) {
          room.sendAnnouncement(
            `${emojiAtt} 𝖴𝗌𝖺: !mover <jugador o [ID]> <rojo|azul|esp>`,
            player.id,
            colorAtt,
            "small",
            NotifSound.NONE,
          )
          return
        }
        const target = findPlayerByNameOrId(targetName)
        if (!target) {
          room.sendAnnouncement(
            `${emojiAtt} No encontré a "${targetName}" en la sala (probá con el nombre o con el [ID] que sale en el chat).`,
            player.id,
            colorAtt,
            "small",
            NotifSound.NONE,
          )
          return
        }
        let teamId, teamLabel
        if (["rojo", "red", "r"].includes(teamArg)) { teamId = Team.RED; teamLabel = "🔴 Rojo" }
        else if (["azul", "blue", "b"].includes(teamArg)) { teamId = Team.BLUE; teamLabel = "🔵 Azul" }
        else if (["esp", "spec", "espectador", "espectadores", "e"].includes(teamArg)) { teamId = Team.SPECTATORS; teamLabel = "⚪ Espectadores" }
        else {
          room.sendAnnouncement(
            `${emojiAtt} Equipo inválido. Usa: rojo, azul o esp.`,
            player.id,
            colorAtt,
            "small",
            NotifSound.NONE,
          )
          return
        }
        lastAuthTeamChange = Date.now()
        room.setPlayerTeam(target.id, teamId)
        assignedTeams.set(target.id, teamId)
        room.sendAnnouncement(
          `🔀 ${player.name} movió a ${target.name} a ${teamLabel}.`,
          null,
          colorInfo,
          "small",
          NotifSound.NONE,
        )
      }
      function llamarAdminCmd(player, message) {
        const now = Date.now()
        if (now - lastAdminCallAt < CALL_ADMIN_COOLDOWN_MS) {
          const waitSec = Math.ceil((CALL_ADMIN_COOLDOWN_MS - (now - lastAdminCallAt)) / 1000)
          const waitMin = Math.max(1, Math.ceil(waitSec / 60))
          room.sendAnnouncement(
            `${emojiAtt} Ya se llamó a un admin hace poco, esperá ${waitMin} minuto${waitMin === 1 ? "" : "s"} antes de volver a llamar.`,
            player.id, colorAtt, "small", NotifSound.NONE,
          )
          return
        }
        const reason = message.trim().split(/\s+/).slice(1).join(" ") || "Sin razón especificada"
        lastAdminCallAt = now
        room.sendAnnouncement(
          `🕐️ ${mono(player.name)} llamó a un admin: ${reason}`,
          null, colorAtt, "small", NotifSound.MENTION,
        )
        sendDiscordEmbed(
          WEBHOOK_CALL_ADMIN,
          {
            author: { name: `🐺 ${ROOM_NAME}` },
            title: "<:warning:1524898677259501810> Llamado de admin",
            description: `**${player.name}** [${player.playerId ?? "?"}] necesita un admin en la sala.`,
            color: 0xE63946,
            fields: [
              { name: "<:sd:1533350231805136998> Razón", value: reason, inline: false },
              { name: "<:sd:1533350231805136998> Sala", value: ROOM_LINK ? `[**Entrar al host**](${ROOM_LINK})` : "—", inline: true },
            ],
            timestamp: new Date().toISOString(),
            footer: { text: "Llamado de admin" },
            image: { url: DISCORD_IMAGE_CALL_ADMIN },
            thumbnail: { url: "https://cdn.discordapp.com/attachments/1524879478831190181/1535056155632467990/Logo-SD.png?ex=6a765ff3&is=6a750e73&hm=c10db33075ef211457077a97679ffab6a0e9225397110a168cb3a3c28adda31f&" },
          },
          null,
          `<:arrow:1524898169694064765> <@&1524886893412614185> <a:sd:1533345082777014452> 𝙽𝚞𝚎𝚟𝚘 𝚕𝚕𝚊𝚖𝚊𝚍𝚘 𝚍𝚎 𝚊𝚍𝚖𝚒𝚗 𝚎𝚗 𝚕𝚊 𝚜𝚊𝚕𝚊 <:mod:1524898151587119134>`,
        )
      }
      function statsCmd(player, message) {
        const arg = (message || "").trim().split(/\s+/)[1]
        if (arg && arg.toLowerCase() === "clan") {
          topClanCmd(player)
          return
        }
        const saved = player.auth ? persistentStats.get(player.auth) : null
        const totalGoals = saved ? saved.goals || 0 : player.goals || 0
        const totalAssists = saved ? saved.assists || 0 : player.assists || 0
        const matchEntry = matchGoalsByPlayer.get(player.id)
        const matchAssistEntry = matchAssistsByPlayer.get(player.id)
        const matchGoals = matchEntry ? matchEntry.goals : 0
        const matchAssists = matchAssistEntry ? matchAssistEntry.assists : 0
        const leaderTag = player.auth && player.auth === packLeaderAuth ? ' 🐺 Líder de la Manada' : ''
        room.sendAnnouncement(
          `📊 Stats de [${player.playerId ?? "?"}] ${player.name}${leaderTag}`,
          player.id,
          colorInfo,
          "bold",
          NotifSound.NONE,
        )
        room.sendAnnouncement(
          `Historial: ⚽ ${mono(String(totalGoals))} goles・🅰️ ${mono(String(totalAssists))} asistencias`,
          player.id,
          colorMuted,
          "small",
          NotifSound.NONE,
        )
        room.sendAnnouncement(
          `Este partido: ⚽ ${mono(String(matchGoals))} goles・🅰️ ${mono(String(matchAssists))} asistencias`,
          player.id,
          colorMuted,
          "small",
          NotifSound.NONE,
        )
      }

      // ── Sistema de clanes ────────────────────────────────────────────────
      function clanCrearCmd(player, parts) {
        if (!player.auth || player.auth === "fake-auth-do-not-believe-it") {
          room.sendAnnouncement(
            `${emojiAtt} No se pudo verificar tu cuenta, no podés fundar un clan.`,
            player.id, colorAtt, "small", NotifSound.NONE,
          )
          return
        }
        const score = getPlayerScore(player.auth)
        if (score < CLAN_MIN_SCORE) {
          room.sendAnnouncement(
            `${emojiAtt} Necesitás ${CLAN_MIN_SCORE} goles+asistencias en tu historial para fundar un clan (llevás ${score}).`,
            player.id, colorAtt, "small", NotifSound.NONE,
          )
          return
        }
        if (memberClanTag.has(player.auth)) {
          room.sendAnnouncement(
            `${emojiAtt} Ya pertenecés al clan [${memberClanTag.get(player.auth)}]. Usá !clan salir primero.`,
            player.id, colorAtt, "small", NotifSound.NONE,
          )
          return
        }
        const rawTag = parts[2]
        const rawColor = parts[3]
        const rawEmoji = parts[4]
        const name = parts.slice(5).join(" ")
        if (!rawTag || !rawColor || !rawEmoji || !name) {
          room.sendAnnouncement(
            `${emojiAtt} Uso: !clan crear <TAG> <#COLOR> <EMOJI> <Nombre del clan>`,
            player.id, colorAtt, "small", NotifSound.NONE,
          )
          return
        }
        const tag = rawTag.toUpperCase()
        if (!/^[A-Z0-9]{2,5}$/.test(tag)) {
          room.sendAnnouncement(
            `${emojiAtt} La abreviatura debe tener entre 2 y 5 letras/números, sin espacios.`,
            player.id, colorAtt, "small", NotifSound.NONE,
          )
          return
        }
        if (clans.has(tag)) {
          room.sendAnnouncement(
            `${emojiAtt} Ya existe un clan con la abreviatura [${tag}].`,
            player.id, colorAtt, "small", NotifSound.NONE,
          )
          return
        }
        const normalizedName = name.trim().toLowerCase()
        const nameTaken = [...clans.values()].some(
          (c) => c.name.trim().toLowerCase() === normalizedName,
        )
        if (nameTaken) {
          room.sendAnnouncement(
            `${emojiAtt} Ya existe un clan con el nombre "${name}".`,
            player.id, colorAtt, "small", NotifSound.NONE,
          )
          return
        }
        const colorMatch = rawColor.match(/^#?([0-9A-Fa-f]{6})$/)
        if (!colorMatch) {
          room.sendAnnouncement(
            `${emojiAtt} Color inválido, usá formato hexadecimal: #FF0000`,
            player.id, colorAtt, "small", NotifSound.NONE,
          )
          return
        }
        if ([...rawEmoji].length > 3) {
          room.sendAnnouncement(
            `${emojiAtt} El emoji del clan es muy largo, usá uno solo.`,
            player.id, colorAtt, "small", NotifSound.NONE,
          )
          return
        }
        const colorNum = parseInt(colorMatch[1], 16)
        clans.set(tag, {
          tag,
          name,
          emoji: rawEmoji,
          color: colorNum,
          founderAuth: player.auth,
          members: new Set([player.auth]),
        })
        rebuildMemberClanTag()
        scheduleClansSave()
        room.sendAnnouncement(
          `${rawEmoji} ${fraktur('Nuevo clan fundado')}: ${rawEmoji}[${tag}] ${mono(name)}, por ${mono(player.name)}!`,
          null, colorNum, "bold", NotifSound.MENTION,
        )
      }
      function clanUnirseCmd(player, tagArg) {
        if (!player.auth) return
        if (memberClanTag.has(player.auth)) {
          room.sendAnnouncement(
            `${emojiAtt} Ya pertenecés al clan [${memberClanTag.get(player.auth)}]. Usá !clan salir primero.`,
            player.id, colorAtt, "small", NotifSound.NONE,
          )
          return
        }
        const invite = clanInvites.get(player.auth)
        if (!invite || (tagArg && invite.tag !== tagArg.toUpperCase())) {
          room.sendAnnouncement(
            `${emojiAtt} No tenés ninguna invitación pendiente${tagArg ? ` a [${tagArg.toUpperCase()}]` : ''}. Pedile al fundador que use !clan invitar.`,
            player.id, colorAtt, "small", NotifSound.NONE,
          )
          return
        }
        if (Date.now() > invite.expiresAt) {
          clanInvites.delete(player.auth)
          room.sendAnnouncement(
            `${emojiAtt} Tu invitación a [${invite.tag}] expiró, pedí una nueva.`,
            player.id, colorAtt, "small", NotifSound.NONE,
          )
          return
        }
        const clan = clans.get(invite.tag)
        clanInvites.delete(player.auth)
        if (!clan) {
          room.sendAnnouncement(
            `${emojiAtt} Ese clan ya no existe.`,
            player.id, colorAtt, "small", NotifSound.NONE,
          )
          return
        }
        clan.members.add(player.auth)
        rebuildMemberClanTag()
        scheduleClansSave()
        room.sendAnnouncement(
          `${clan.emoji} ${mono(player.name)} se unió a ${clan.emoji}[${clan.tag}] ${mono(clan.name)}!`,
          null, clan.color, "small", NotifSound.NONE,
        )
      }
      function clanInvitarCmd(player, targetQuery) {
        const tag = player.auth ? memberClanTag.get(player.auth) : null
        if (!tag) {
          room.sendAnnouncement(
            `${emojiAtt} No pertenecés a ningún clan.`,
            player.id, colorAtt, "small", NotifSound.NONE,
          )
          return
        }
        const clan = clans.get(tag)
        if (clan.founderAuth !== player.auth) {
          room.sendAnnouncement(
            `${emojiAtt} Solo el fundador del clan puede invitar gente.`,
            player.id, colorAtt, "small", NotifSound.NONE,
          )
          return
        }
        if (!targetQuery) {
          room.sendAnnouncement(
            `${emojiAtt} Uso: !clan invitar <jugador o [ID]>`,
            player.id, colorAtt, "small", NotifSound.NONE,
          )
          return
        }
        const target = findPlayerByNameOrId(targetQuery)
        if (!target) {
          room.sendAnnouncement(
            `${emojiAtt} No encontré a "${targetQuery}" en la sala (probá con el nombre o con el [ID] que sale en el chat).`,
            player.id, colorAtt, "small", NotifSound.NONE,
          )
          return
        }
        if (!target.auth) {
          room.sendAnnouncement(
            `${emojiAtt} No se pudo verificar la cuenta de ${target.name}, no se le puede invitar.`,
            player.id, colorAtt, "small", NotifSound.NONE,
          )
          return
        }
        if (memberClanTag.has(target.auth)) {
          room.sendAnnouncement(
            `${emojiAtt} ${target.name} ya pertenece a un clan.`,
            player.id, colorAtt, "small", NotifSound.NONE,
          )
          return
        }
        clanInvites.set(target.auth, {
          tag,
          invitedByName: player.name,
          expiresAt: Date.now() + CLAN_INVITE_TTL_MS,
        })
        room.sendAnnouncement(
          `${clan.emoji} ${mono(player.name)} te invitó a ${clan.emoji}[${clan.tag}] ${mono(clan.name)}. Usá !clan aceptar (2 min para responder).`,
          target.id, clan.color, "small", NotifSound.MENTION,
        )
        room.sendAnnouncement(
          `✅ Invitación enviada a ${target.name}.`,
          player.id, colorSucces, "small", NotifSound.NONE,
        )
      }
      function clanAceptarCmd(player) {
        clanUnirseCmd(player, null)
      }
      function clanRechazarCmd(player) {
        if (!player.auth || !clanInvites.has(player.auth)) {
          room.sendAnnouncement(
            `${emojiAtt} No tenés ninguna invitación pendiente.`,
            player.id, colorAtt, "small", NotifSound.NONE,
          )
          return
        }
        const invite = clanInvites.get(player.auth)
        clanInvites.delete(player.auth)
        room.sendAnnouncement(
          `${emojiAtt} Rechazaste la invitación a [${invite.tag}].`,
          player.id, colorAtt, "small", NotifSound.NONE,
        )
      }
      function clanSalirCmd(player) {
        const tag = player.auth ? memberClanTag.get(player.auth) : null
        if (!tag) {
          room.sendAnnouncement(
            `${emojiAtt} No pertenecés a ningún clan.`,
            player.id, colorAtt, "small", NotifSound.NONE,
          )
          return
        }
        const clan = clans.get(tag)
        clan.members.delete(player.auth)
        if (clan.members.size === 0) {
          clans.delete(tag) // sin miembros, el clan se disuelve
        }
        rebuildMemberClanTag()
        scheduleClansSave()
        room.sendAnnouncement(
          `👋 ${mono(player.name)} dejó el clan [${tag}].`,
          player.id, colorMuted, "small", NotifSound.NONE,
        )
      }
      function showClanInfo(player, tagQuery) {
        if (!tagQuery) {
          room.sendAnnouncement(
            `${emojiAtt} No pertenecés a ningún clan. Usá !clan crear o !clan unirse <TAG>.`,
            player.id, colorAtt, "small", NotifSound.NONE,
          )
          return
        }
        const clan = clans.get(tagQuery.toUpperCase())
        if (!clan) {
          room.sendAnnouncement(
            `${emojiAtt} No existe ningún clan con la abreviatura [${tagQuery.toUpperCase()}].`,
            player.id, colorAtt, "small", NotifSound.NONE,
          )
          return
        }
        const memberRows = [...clan.members]
          .map((auth) => {
            const saved = persistentStats.get(auth)
            return { name: saved?.name || "???", score: getPlayerScore(auth) }
          })
          .sort((a, b) => b.score - a.score)
        const totalScore = memberRows.reduce((sum, m) => sum + m.score, 0)
        room.sendAnnouncement(
          `${clan.emoji} ${clan.emoji}[${clan.tag}] ${clan.name} — ${mono(String(memberRows.length))} integrante(s), ${mono(String(totalScore))} g/a en total`,
          player.id, clan.color, "bold", NotifSound.NONE,
        )
        memberRows.slice(0, 10).forEach((m) => {
          room.sendAnnouncement(
            `  ${mono(m.name)} — ${mono(String(m.score))} g/a`,
            player.id, colorMuted, "small", NotifSound.NONE,
          )
        })
      }
      function topClanCmd(player) {
        const rows = [...clans.values()].map((clan) => ({
          clan,
          totalScore: [...clan.members].reduce((sum, auth) => sum + getPlayerScore(auth), 0),
        }))
        rows.sort((a, b) => b.totalScore - a.totalScore)
        if (rows.length === 0) {
          room.sendAnnouncement(
            `${emojiAtt} Todavía no hay ningún clan fundado.`,
            player.id, colorAtt, "small", NotifSound.NONE,
          )
          return
        }
        const medals = ['🥇', '🥈', '🥉']
        room.sendAnnouncement(
          `📊 ${fraktur('Ranking de clanes')} (goles+asistencias)`,
          player.id, colorInfo, "bold", NotifSound.NONE,
        )
        rows.slice(0, 10).forEach((r, i) => {
          const medal = medals[i] || `${i + 1}.`
          room.sendAnnouncement(
            `${medal} ${r.clan.emoji}[${r.clan.tag}] ${r.clan.name} — ${mono(String(r.totalScore))} g/a (${mono(String(r.clan.members.size))} integrantes)`,
            player.id, colorMuted, "small", NotifSound.NONE,
          )
        })
      }
      function clanCmd(player, message) {
        const parts = message.trim().split(/\s+/)
        const sub = (parts[1] || "").toLowerCase()
        if (sub === "crear" || sub === "fundar") return clanCrearCmd(player, parts)
        if (sub === "invitar" || sub === "invite") return clanInvitarCmd(player, parts[2])
        if (sub === "aceptar" || sub === "accept") return clanAceptarCmd(player)
        if (sub === "rechazar" || sub === "reject") return clanRechazarCmd(player)
        if (sub === "unirse" || sub === "join") return clanUnirseCmd(player, parts[2])
        if (sub === "salir" || sub === "leave") return clanSalirCmd(player)
        const tagQuery = sub ? sub : (player.auth ? memberClanTag.get(player.auth) : null)
        showClanInfo(player, tagQuery)
      }
      function kitsrandCmd(player) {
        randomizeKits()
        const hn = getKitName(homeTeam) || 'Rojo'
        const an = getKitName(awayTeam) || 'Azul'
        room.sendAnnouncement(
          `👕 ${player.name} sorteó nuevas camisetas: 🔴 ${hn}  vs  🔵 ${an}`,
          null,
          colorInfo,
          "small",
          NotifSound.NONE,
        )
      }
      function kickCmd(player, message) {
        const parts = message.trim().split(/\s+/)
        const targetName = parts[1]
        const reason = parts.slice(2).join(" ") || "Expulsado por un administrador."
        const target = findPlayerByNameOrId(targetName)
        if (!target) {
          room.sendAnnouncement(
            `${emojiAtt} No encontré a "${targetName}" en la sala (probá con el nombre o con el [ID] que sale en el chat).`,
            player.id,
            colorAtt,
            "small",
            NotifSound.NONE,
          )
          return
        }
        if (target.id === player.id) {
          room.sendAnnouncement(
            `${emojiAtt} No puedes expulsarte a ti mismo con !kick. Usa !bb si quieres salir.`,
            player.id,
            colorAtt,
            "small",
            NotifSound.NONE,
          )
          return
        }
        if (target.isAdmin) {
          room.sendAnnouncement(
            `${emojiAtt} No puedes expulsar a otro admin.`,
            player.id,
            colorAtt,
            "small",
            NotifSound.NONE,
          )
          return
        }
        room.kickPlayer(target.id, reason, false)
        room.sendAnnouncement(
          `🔨 ${target.name} fue expulsado por ${player.name}. Razón: ${reason}`,
          null,
          colorInfo,
          "small",
          NotifSound.NONE,
        )
      }
      function banCmd(player, message) {
        const parts = message.trim().split(/\s+/)
        const targetName = parts[1]
        const reason = parts.slice(2).join(" ") || "Baneado por un administrador."
        const target = findPlayerByNameOrId(targetName)
        if (!target) {
          room.sendAnnouncement(
            `${emojiAtt} No encontré a "${targetName}" en la sala (probá con el nombre o con el [ID] que sale en el chat).`,
            player.id,
            colorAtt,
            "small",
            NotifSound.NONE,
          )
          return
        }
        if (target.isAdmin) {
          room.sendAnnouncement(
            `${emojiAtt} No puedes banear a otro admin.`,
            player.id,
            colorAtt,
            "small",
            NotifSound.NONE,
          )
          return
        }
        room.kickPlayer(target.id, reason, true)
        room.sendAnnouncement(
          `🔒 ${target.name} fue baneado por ${player.name}. Razón: ${reason}`,
          null,
          colorInfo,
          "small",
          NotifSound.NONE,
        )
      }
      function tempBanCmd(player, message) {
        const parts = message.trim().split(/\s+/)
        const targetName = parts[1]
        const durationText = parts[2]
        const reason = parts.slice(3).join(" ") || "Baneo temporal por un administrador."
        const target = findPlayerByNameOrId(targetName)
        if (!target || !durationText) {
          room.sendAnnouncement(
            `${emojiAtt} Uso: !tempban <jugador o [ID]> <duración>s/m/h [razón]`,
            player.id,
            colorAtt,
            "small",
            NotifSound.NONE,
          )
          return
        }
        if (target.isAdmin) {
          room.sendAnnouncement(
            `${emojiAtt} No puedes banear temporalmente a otro admin.`,
            player.id,
            colorAtt,
            "small",
            NotifSound.NONE,
          )
          return
        }
        const durationSeconds = parseDuration(durationText)
        if (!durationSeconds) {
          room.sendAnnouncement(
            `${emojiAtt} Duración inválida. Usa números y unidades: 10s, 5m, 1h.`,
            player.id,
            colorAtt,
            "small",
            NotifSound.NONE,
          )
          return
        }
        room.kickPlayer(target.id, reason, true)
        if (tempBanTimeouts.has(target.id)) {
          clearTimeout(tempBanTimeouts.get(target.id))
        }
        const timeoutId = setTimeout(() => {
          const banEntry = findBanByName(target.name)
          if (banEntry) {
            room.removeBan(banEntry.id)
            room.sendAnnouncement(
              `⏱ ${target.name} ha sido desbaneado automáticamente después de ${durationText}.`,
              null,
              colorInfo,
              "small",
              NotifSound.NONE,
            )
          }
          tempBanTimeouts.delete(target.id)
        }, durationSeconds * 1000)
        tempBanTimeouts.set(target.id, timeoutId)
        room.sendAnnouncement(
          `⏱ ${target.name} fue baneado por ${player.name} durante ${durationText}. Razón: ${reason}`,
          null,
          colorInfo,
          "small",
          NotifSound.NONE,
        )
      }
      function unbanCmd(player, message) {
        const parts = message.trim().split(/\s+/)
        const targetName = parts[1]
        if (!targetName) {
          room.sendAnnouncement(
            `${emojiAtt} Uso: !unban <jugador>`,
            player.id,
            colorAtt,
            "small",
            NotifSound.NONE,
          )
          return
        }
        const banEntry = findBanByName(targetName)
        if (!banEntry) {
          room.sendAnnouncement(
            `${emojiAtt} No se encontró un jugador baneado con ese nombre.`,
            player.id,
            colorAtt,
            "small",
            NotifSound.NONE,
          )
          return
        }
        room.removeBan(banEntry.id)
        room.sendAnnouncement(
          `🔓 ${banEntry.name} fue desbaneado por ${player.name}.`,
          null,
          colorInfo,
          "small",
          NotifSound.NONE,
        )
      }
      function clearBansCmd(player) {
        if (tempBanTimeouts.size > 0) {
          for (const timeoutId of tempBanTimeouts.values()) clearTimeout(timeoutId)
          tempBanTimeouts.clear()
        }
        room.clearBans()
        room.sendAnnouncement(
          `🧹 Todos los baneos han sido eliminados por ${player.name}.`,
          null,
          colorInfo,
          "small",
          NotifSound.NONE,
        )
      }
      function muteCmd(player, message) {
        const parts = message.trim().split(/\s+/)
        const targetName = parts[1]
        const target = findPlayerByNameOrId(targetName)
        if (!target) {
          room.sendAnnouncement(
            `${emojiAtt} No encontré a "${targetName}" en la sala (probá con el nombre o con el [ID] que sale en el chat).`,
            player.id,
            colorAtt,
            "small",
            NotifSound.NONE,
          )
          return
        }
        if (target.isAdmin) {
          room.sendAnnouncement(
            `${emojiAtt} No puedes silenciar a otro admin.`,
            player.id,
            colorAtt,
            "small",
            NotifSound.NONE,
          )
          return
        }
        if (mutedPlayers.has(target.id)) {
          room.sendAnnouncement(
            `${emojiAtt} ${target.name} ya está silenciado.`,
            player.id,
            colorAtt,
            "small",
            NotifSound.NONE,
          )
          return
        }
        mutedPlayers.add(target.id)
        room.sendAnnouncement(
          `🔇 ${target.name} fue silenciado por ${player.name}.`,
          null,
          colorInfo,
          "small",
          NotifSound.NONE,
        )
      }
      function unmuteCmd(player, message) {
        const parts = message.trim().split(/\s+/)
        const targetName = parts[1]
        const target = findPlayerByNameOrId(targetName)
        if (!target) {
          room.sendAnnouncement(
            `${emojiAtt} No encontré a "${targetName}" en la sala (probá con el nombre o con el [ID] que sale en el chat).`,
            player.id,
            colorAtt,
            "small",
            NotifSound.NONE,
          )
          return
        }
        if (!mutedPlayers.has(target.id)) {
          room.sendAnnouncement(
            `${emojiAtt} ${target.name} no está silenciado.`,
            player.id,
            colorAtt,
            "small",
            NotifSound.NONE,
          )
          return
        }
        mutedPlayers.delete(target.id)
        room.sendAnnouncement(
          `🔊 ${target.name} fue des-silenciado por ${player.name}.`,
          null,
          colorInfo,
          "small",
          NotifSound.NONE,
        )
      }
      const commands = {
        help: {
          aliases: ["comandos", "h", "ayuda"],
          roles: Role.PLAYER,
          desc: true,
          function: helpCmd,
        },
        controls: {
          aliases: [],
          roles: Role.PLAYER,
          desc: true,
          function: controlsCmd,
        },
        dc: {
          aliases: ["discord", "ds"],
          roles: Role.PLAYER,
          desc: true,
          function: dcCmd,
        },
        bb: {
          aliases: ["bye", "nv", "bb"],
          roles: Role.PLAYER,
          desc: true,
          function: leaveCmd,
        },
        sl: {
          aliases: ["slide"],
          roles: Role.PLAYER,
          desc: true,
          function: changeSlideStatePlayerSpecialCmd,
        },
        op: {
          aliases: [],
          roles: Role.ADMIN,
          desc: true,
          function: changeOPModeStatePlayerSpecialCmd,
        },
        kits: {
          aliases: ["shirts", "kits"],
          roles: Role.PLAYER,
          desc: true,
          function: seeKitsCmd,
        },
        kr: {
          aliases: [],
          roles: Role.PLAYER,
          desc: true,
          function: changeRedKitCmd,
        },
        kb: {
          aliases: [],
          roles: Role.PLAYER,
          desc: true,
          function: changeBlueKitCmd,
        },
        claim: {
          aliases: [],
          roles: Role.PLAYER,
          desc: true,
          function: claimAdminCmd,
        },
        helpadmin: {
          aliases: ["cmdadmin", "comandosadmin"],
          roles: Role.ADMIN,
          desc: true,
          function: adminHelpCmd,
        },
        kick: {
          aliases: [],
          roles: Role.ADMIN,
          desc: true,
          function: kickCmd,
        },
        ban: {
          aliases: [],
          roles: Role.ADMIN,
          desc: true,
          function: banCmd,
        },
        tempban: {
          aliases: [],
          roles: Role.ADMIN,
          desc: true,
          function: tempBanCmd,
        },
        unban: {
          aliases: [],
          roles: Role.ADMIN,
          desc: true,
          function: unbanCmd,
        },
        clearbans: {
          aliases: ["clearban"],
          roles: Role.ADMIN,
          desc: true,
          function: clearBansCmd,
        },
        mute: {
          aliases: [],
          roles: Role.ADMIN,
          desc: true,
          function: muteCmd,
        },
        unmute: {
          aliases: [],
          roles: Role.ADMIN,
          desc: true,
          function: unmuteCmd,
        },
        mover: {
          aliases: ["mover", "move", "mv"],
          roles: Role.ADMIN,
          desc: true,
          function: moveCmd,
        },
        kitsrand: {
          aliases: ["kitrandom", "camisasrand"],
          roles: Role.ADMIN,
          desc: true,
          function: kitsrandCmd,
        },
        stats: {
          aliases: ['me', 'stats', 'yo', 'top'],
          roles: Role.PLAYER,
          desc: true,
          function: statsCmd,
        },
        clan: {
          aliases: ['clan', 'clanes'],
          roles: Role.PLAYER,
          desc: true,
          function: clanCmd,
        },
        llamaradmin: {
          aliases: ['llamaradmin', 'callAdmin', 'admin'],
          roles: Role.PLAYER,
          desc: true,
          function: llamarAdminCmd,
        },
        memide: {
          aliases: ['mide', 'medirme'],
          roles: Role.PLAYER,
          desc: true,
          function: memideCmd,
        },
        suerte: {
          aliases: ['luck', 'fortunio'],
          roles: Role.PLAYER,
          desc: true,
          function: suerteCmd,
        },
        dado: {
          aliases: ['dice', 'roll'],
          roles: Role.PLAYER,
          desc: true,
          function: dadoCmd,
        },
      }
      /*
            ╔══════════════════════════════════════════════════════════════════════════════════════════════════════════╗
            ║                                        C O M M A N D S     E N D                                         ║
            ╚══════════════════════════════════════════════════════════════════════════════════════════════════════════╝
      */

      room.onPlayerSyncChange = function (playerId, value) {
        if (!value) {
          const player = room.getPlayer(playerId)
          player.syncCount += 1
          console.log("𝖢𝖠𝖬𝖡𝖨𝖮 𝖤𝖭 𝖫𝖠 𝖲𝖸𝖭𝖢", player.name, player.syncCount)
        }
      }
      room.onPlayerObjectCreated = async function (pObj) {
        pObj.lhd = 0
        pObj.lbkt = 0
        pObj.e = "curve"
        pObj.syncCount = 0
        pObj.pos = 0
        pObj.es = true
        pObj.op = false
        pObj.goals = 0
        pObj.lastInputChangeTime = Date.now()
        pObj.assists = 0
        pObj.playerId = getOrAssignPlayerId(pObj)
        if (pObj.auth && adminAuths.has(pObj.auth)) {
          room.setPlayerAdmin(pObj.id, true)
          pObj.isAutoAdmin = true
        }
        const isFirstTimeHere = !!pObj.auth && !persistentStats.has(pObj.auth)
        pObj.isNewbie = isFirstTimeHere
        if (pObj.auth && persistentStats.has(pObj.auth)) {
          const saved = persistentStats.get(pObj.auth)
          pObj.goals = saved.goals || 0
          pObj.assists = saved.assists || 0
        } else if (pObj.auth) {
          // Primera vez que vemos esta cuenta: dejamos un registro para que la
          // próxima vez ya no cuente como "nueva", aunque nunca haya metido gol.
          persistentStats.set(pObj.auth, { name: pObj.name, goals: 0, assists: 0 })
          scheduleStatsSave()
        }
        if (isFirstTimeHere) {
          room.setPlayerAvatar(pObj.id, "🆕", true)
        }
        recalculatePackLeader()
        setTimeout(async () => {
          try {
            pObj.vip = 1
            pObj.mod = 1
            if (pObj.vip) {
              pObj.ca = null
              pObj.aa = 0
              pObj.aas = 0
            }
          } catch (err) {
            console.error(err)
          } finally {
          }
        }, 1000)
        try {
          pObj.e = "curve"
        } catch (err) {
          console.error(err)
        }
      }
      room.onOperationReceived = (type, message) => {
        switch (type) {
          case OperationType.SendInput: {
            const player = room.getPlayer(message.byId)
            if (player.ib || player.ipb || player.ige) message.input = 0
            return true
          }
          case OperationType.SendChat: {
            const msg = message.text
            const player = room.getPlayer(message.byId)
            const isChatAdmin = isAdmin(player)
            if (!isChatAdmin && Date.now() < chatLockedUntil) {
              if (!chatLockNotified.has(player.id)) {
                chatLockNotified.add(player.id)
                room.sendAnnouncement(
                  player.id,
                  colorAtt,
                  "small",
                  NotifSound.NONE,
                )
              }
              return false
            }
            if (!isChatAdmin) {
            const spamNow = Date.now()
            const penalty = spamPenalties.get(player.id)
            if (penalty && spamNow < penalty.until) {
              if (spamNow - penalty.lastMessageTime < SPAM_COOLDOWN_MS) {
                const waitSec = Math.ceil((SPAM_COOLDOWN_MS - (spamNow - penalty.lastMessageTime)) / 1000)
                room.sendAnnouncement(
                  `${emojiAtt} 𝖤𝗌𝗍𝖺́𝗌 𝖾𝗇 𝗆𝗈𝖽𝗈 𝗅𝖾𝗇𝗍𝗈 𝗉𝗈𝗋 𝗌𝗉𝖺𝗆. 𝖤𝗌𝗉𝖾𝗋𝖺́ ${waitSec}𝗌.`,
                  player.id,
                  colorAtt,
                  "small",
                  NotifSound.NONE,
                )
                return false
              }
              penalty.lastMessageTime = spamNow
            } else {
              const timestamps = (recentMessageTimes.get(player.id) || []).filter(
                (t) => spamNow - t < SPAM_WINDOW_MS,
              )
              timestamps.push(spamNow)
              recentMessageTimes.set(player.id, timestamps)
              if (timestamps.length >= SPAM_THRESHOLD) {
                spamPenalties.set(player.id, {
                  until: spamNow + SPAM_PENALTY_MS,
                  lastMessageTime: spamNow,
                })
                recentMessageTimes.delete(player.id)
                room.sendAnnouncement(
                  `⚠️ ${fraktur('Detectamos spam')}. ${fraktur('Chat en modo lento (1 mensaje por minuto) durante 5 minutos')}.`,
                  player.id,
                  colorAtt,
                  "small",
                  NotifSound.MENTION,
                )
                return false
              }
            }
            }
            if (msg[0][0] == "!") {
              const parts = msg.replace("!", "").split(" ")
              let command = getCommand(parts[0].toLowerCase())
              const commandRoles = commands[command]?.roles
              const playerRoles = getPlayerRoleList(player)
              if (command && playerRoles.includes(commandRoles)) {
                commands[command].function(player, msg)
              } else
                setTimeout(function () {
                  room.sendAnnouncement(
                    `${emojiAtt} 𝖤𝗅 𝖼𝗈𝗆𝖺𝗇𝖽𝗈 𝗇𝗈 𝖾𝗌 𝗏𝖺́𝗅𝗂𝖽𝗈, 𝗎𝗌𝖺 !𝖺𝗒𝗎𝖽𝖺`,
                    player.id,
                    colorAtt,
                    "bold",
                    NotifSound.NONE,
                  )
                }, 200)
              return false
            }
            if (mutedPlayers.has(player.id)) {
              room.sendAnnouncement(
                `${emojiAtt} Estás silenciado y no puedes enviar mensajes.`,
                player.id,
                colorAtt,
                "small",
                NotifSound.NONE,
              )
              return false
            }
            if (
              msg.length > 1 &&
              (msg[0] === "t" || msg[0] === "T") &&
              msg[1] === " "
            ) {
              const teamMsg = msg.slice(2).trim()
              if (!player.team || player.team.id === Team.SPECTATORS) {
                room.sendAnnouncement(
                  `${emojiAtt} Los espectadores no tienen chat de equipo.`,
                  player.id,
                  colorAtt,
                  "small",
                  NotifSound.NONE,
                )
                return false
              }
              if (!teamMsg) return false
              const teamEmoji = getPlayerKitEmoji(player)
              const teamColor = player.team.id === Team.RED ? colorRed : colorBlue
              const teammates = room.players.filter(
                (p) => p.team && p.team.id === player.team.id,
              )
              teammates.forEach((p) => {
                room.sendAnnouncement(
                  `[${player.playerId ?? "?"}] ${teamEmoji} ${player.name}: ${teamMsg}`,
                  p.id,
                  teamColor,
                  "normal",
                  NotifSound.NONE,
                )
              })
              flashAvatar(player, CHAT_AVATAR, 1200)
              return false
            }
            if (
              msg.length > 2 &&
              (msg[0] === "t" || msg[0] === "T") &&
              (msg[1] === "c" || msg[1] === "C") &&
              msg[2] === " "
            ) {
              const clanMsg = msg.slice(3).trim()
              const tag = player.auth ? memberClanTag.get(player.auth) : null
              const clan = tag ? clans.get(tag) : null
              if (!clan) {
                room.sendAnnouncement(
                  `${emojiAtt} No pertenecés a ningún clan.`,
                  player.id,
                  colorAtt,
                  "small",
                  NotifSound.NONE,
                )
                return false
              }
              if (!clanMsg) return false
              const clanmates = room.players.filter(
                (p) => p.auth && memberClanTag.get(p.auth) === tag,
              )
              clanmates.forEach((p) => {
                room.sendAnnouncement(
                  `[${player.playerId ?? "?"}] ${clan.emoji}[${clan.tag}] ${player.name}: ${clanMsg}`,
                  p.id,
                  clan.color,
                  "normal",
                  NotifSound.NONE,
                )
              })
              flashAvatar(player, CHAT_AVATAR, 1200)
              return false
            }
            if (
              msg.length > 0 &&
              (msg.toLowerCase() === "c" ||
                msg.toLowerCase() === "l" ||
                msg.toLowerCase() === "a" ||
                msg.toLowerCase() === "n" ||
                msg.toLowerCase() === "p" ||
                msg.toLowerCase() === "s")
            ) {
              switch (msg.toLowerCase()) {
                case "c":
                  setCurveAbility(player)
                  break
                case "l":
                  setLobAbility(player)
                  break
                case "a":
                case "n":
                  setNoneAbility(player)
                  break
                case "p":
                case "s":
                  setPowerAbility(player)
                  break
                default:
                  break
              }
              return false
            }
            const chatTag = getPlayerChatTag(player)
            room.sendAnnouncement(
              `[${player.playerId ?? "?"}] ${chatTag.text} ${player.name}: ${msg}`,
              null,
              chatTag.color,
              "normal",
              NotifSound.CHAT,
            )
            flashAvatar(player, CHAT_AVATAR, 1200)
            return false
          }
          default:
            return true
        }
      }
      const letterMap = {
        A: [
          [
            { x: -5, y: 5 },
            { x: 0, y: -5 },
          ],
          [
            { x: 0, y: -5 },
            { x: 5, y: 5 },
          ],
          [
            { x: -3, y: 0 },
            { x: 3, y: 0 },
          ],
        ],
        B: [
          [
            { x: -5, y: -5 },
            { x: -5, y: 5 },
          ],
          [
            { x: -5, y: -5 },
            { x: 3, y: -2 },
          ],
          [
            { x: 3, y: -2 },
            { x: -5, y: 0 },
          ],
          [
            { x: -5, y: 0 },
            { x: 3, y: 2 },
          ],
          [
            { x: 3, y: 2 },
            { x: -5, y: 5 },
          ],
        ],
        C: [
          [
            { x: 5, y: -5 },
            { x: -5, y: -5 },
          ],
          [
            { x: -5, y: -5 },
            { x: -5, y: 5 },
          ],
          [
            { x: -5, y: 5 },
            { x: 5, y: 5 },
          ],
        ],
        D: [
          [
            { x: -5, y: -5 },
            { x: -5, y: 5 },
          ],
          [
            { x: -5, y: -5 },
            { x: 2, y: -5 },
          ],
          [
            { x: 2, y: -5 },
            { x: 5, y: -2 },
          ],
          [
            { x: 5, y: -2 },
            { x: 5, y: 2 },
          ],
          [
            { x: 5, y: 2 },
            { x: 2, y: 5 },
          ],
          [
            { x: 2, y: 5 },
            { x: -5, y: 5 },
          ],
        ],
        E: [
          [
            { x: 5, y: -5 },
            { x: -5, y: -5 },
          ],
          [
            { x: -5, y: -5 },
            { x: -5, y: 5 },
          ],
          [
            { x: -5, y: 5 },
            { x: 5, y: 5 },
          ],
          [
            { x: -5, y: 0 },
            { x: 3, y: 0 },
          ],
        ],
        F: [
          [
            { x: -5, y: -5 },
            { x: -5, y: 5 },
          ],
          [
            { x: -5, y: -5 },
            { x: 5, y: -5 },
          ],
          [
            { x: -5, y: 0 },
            { x: 3, y: 0 },
          ],
        ],
        G: [
          [
            { x: 5, y: -5 },
            { x: -5, y: -5 },
          ],
          [
            { x: -5, y: -5 },
            { x: -5, y: 5 },
          ],
          [
            { x: -5, y: 5 },
            { x: 5, y: 5 },
          ],
          [
            { x: 5, y: 5 },
            { x: 5, y: 0 },
          ],
          [
            { x: 1, y: 0 },
            { x: 5, y: 0 },
          ],
        ],
        H: [
          [
            { x: -5, y: -5 },
            { x: -5, y: 5 },
          ],
          [
            { x: 5, y: -5 },
            { x: 5, y: 5 },
          ],
          [
            { x: -5, y: 0 },
            { x: 5, y: 0 },
          ],
        ],
        I: [
          [
            { x: 0, y: -5 },
            { x: 0, y: 5 },
          ],
        ],
        J: [
          [
            { x: 5, y: -5 },
            { x: 5, y: 3 },
          ],
          [
            { x: 5, y: 3 },
            { x: 3, y: 5 },
          ],
          [
            { x: 3, y: 5 },
            { x: -1, y: 5 },
          ],
          [
            { x: -1, y: 5 },
            { x: -3, y: 3 },
          ],
          [
            { x: -3, y: 3 },
            { x: -3, y: 2 },
          ],
        ],
        K: [
          [
            { x: -5, y: -5 },
            { x: -5, y: 5 },
          ],
          [
            { x: -5, y: 0 },
            { x: 3, y: -5 },
          ],
          [
            { x: -5, y: 0 },
            { x: 3, y: 5 },
          ],
        ],
        L: [
          [
            { x: -5, y: -5 },
            { x: -5, y: 5 },
          ],
          [
            { x: -5, y: 5 },
            { x: 5, y: 5 },
          ],
        ],
        M: [
          [
            { x: -5, y: 5 },
            { x: -5, y: -5 },
          ],
          [
            { x: -5, y: -5 },
            { x: 0, y: 0 },
          ],
          [
            { x: 0, y: 0 },
            { x: 5, y: -5 },
          ],
          [
            { x: 5, y: -5 },
            { x: 5, y: 5 },
          ],
        ],
        N: [
          [
            { x: -5, y: 5 },
            { x: -5, y: -5 },
          ],
          [
            { x: -5, y: 5 },
            { x: 5, y: -5 },
          ],
          [
            { x: 5, y: -5 },
            { x: 5, y: 5 },
          ],
        ],
        O: [
          [
            { x: -5, y: -5 },
            { x: 5, y: -5 },
          ],
          [
            { x: 5, y: -5 },
            { x: 5, y: 5 },
          ],
          [
            { x: 5, y: 5 },
            { x: -5, y: 5 },
          ],
          [
            { x: -5, y: 5 },
            { x: -5, y: -5 },
          ],
        ],
        P: [
          [
            { x: -5, y: 5 },
            { x: -5, y: -5 },
          ],
          [
            { x: -5, y: -5 },
            { x: 3, y: -5 },
          ],
          [
            { x: 3, y: -5 },
            { x: 5, y: -3 },
          ],
          [
            { x: 5, y: -3 },
            { x: -5, y: -3 },
          ],
        ],
        R: [
          [
            { x: -5, y: 5 },
            { x: -5, y: -5 },
          ],
          [
            { x: -5, y: -5 },
            { x: 3, y: -5 },
          ],
          [
            { x: 3, y: -5 },
            { x: 5, y: -3 },
          ],
          [
            { x: 5, y: -3 },
            { x: -5, y: -3 },
          ],
          [
            { x: -5, y: -3 },
            { x: 5, y: 5 },
          ],
        ],
        S: [
          [
            { x: 5, y: -5 },
            { x: -5, y: -5 },
          ],
          [
            { x: -5, y: -5 },
            { x: -5, y: 0 },
          ],
          [
            { x: -5, y: 0 },
            { x: 5, y: 0 },
          ],
          [
            { x: 5, y: 0 },
            { x: 5, y: 5 },
          ],
          [
            { x: 5, y: 5 },
            { x: -5, y: 5 },
          ],
        ],
        T: [
          [
            { x: -5, y: -5 },
            { x: 5, y: -5 },
          ],
          [
            { x: 0, y: -5 },
            { x: 0, y: 5 },
          ],
        ],
        U: [
          [
            { x: -5, y: -5 },
            { x: -5, y: 3 },
          ],
          [
            { x: -5, y: 3 },
            { x: 5, y: 3 },
          ],
          [
            { x: 5, y: 3 },
            { x: 5, y: -5 },
          ],
        ],
        V: [
          [
            { x: -5, y: -5 },
            { x: 0, y: 5 },
          ],
          [
            { x: 0, y: 5 },
            { x: 5, y: -5 },
          ],
        ],
        Y: [
          [
            { x: -5, y: -5 },
            { x: 0, y: 0 },
          ],
          [
            { x: 5, y: -5 },
            { x: 0, y: 0 },
          ],
          [
            { x: 0, y: 0 },
            { x: 0, y: 5 },
          ],
        ],
        Z: [
          [
            { x: -5, y: -5 },
            { x: 5, y: -5 },
          ],
          [
            { x: 5, y: -5 },
            { x: -5, y: 5 },
          ],
          [
            { x: -5, y: 5 },
            { x: 5, y: 5 },
          ],
        ],
        X: [
          [
            { x: -5, y: -5 },
            { x: 5, y: 5 },
          ],
          [
            { x: -5, y: 5 },
            { x: 5, y: -5 },
          ],
        ],
        " ": [],
      }
      function drawText(
        text,
        centerX = 0,
        centerY = 0,
        spacing = 15,
        discStartId = 12,
        scale = 1,
        maxDiscId = 87,
      ) {
        let discId = discStartId
        const upperText = text.toUpperCase()
        const totalWidth = upperText.length * spacing * scale
        const startX = centerX - totalWidth / 4
        let offsetX = 0
        Utils.runAfterGameTick(() => {
          for (const char of text.toUpperCase()) {
            const segments = letterMap[char]
            if (!segments) {
              offsetX += spacing * scale
              continue
            }
            for (const seg of segments) {
              if (discId + 1 > maxDiscId) {
                console.warn("Disc ID limit exceeded.")
                return
              }
              const p1 = seg[0]
              const p2 = seg[1]
              room.setDiscProperties(discId, {
                x: startX + offsetX + p1.x * scale * 0.6,
                y: centerY + p1.y * scale,
              })
              discId++
              room.setDiscProperties(discId, {
                x: startX + offsetX + p2.x * scale * 0.6,
                y: centerY + p2.y * scale,
              })
              discId++
            }
            offsetX += spacing * scale * 0.6
          }
        })
        setTimeout(() => {
          discId = discStartId
          Utils.runAfterGameTick(() => {
            for (const char of text.toUpperCase()) {
              const segments = letterMap[char]
              for (const seg of segments) {
                if (discId + 1 > maxDiscId) {
                  console.warn("Disc ID limit exceeded.")
                  return
                }
                room.setDiscProperties(discId, {
                  x: -1000,
                  y: -1000,
                })
                discId++
                room.setDiscProperties(discId, {
                  x: -1000,
                  y: -1000,
                })
                discId++
              }
            }
          })
        }, 5 * 1000)
      }
      function replaceTurkishChars(text) {
        const map = {
          Ç: "C",
          Ğ: "G",
          İ: "I",
          I: "I",
          Ö: "O",
          Ş: "S",
          Ü: "U",
          ç: "C",
          ğ: "G",
          ı: "I",
          i: "I",
          ö: "O",
          ş: "S",
          ü: "U",
        }
        return text.replace(/[çğıöşüÇĞİÖŞÜ]/g, (c) => map[c] || c)
      }
      let testGEgp,
        testGEfirstE = false,
        testGErotationAngle = 0
      function testGoalEffectOrbit() {
        const ps = getTeamCounts(room)
        const rps = ps.red
        const bps = ps.blue
        const centerPlayer = room.getPlayer(testGEgp?.id)
        if (
          !centerPlayer ||
          !centerPlayer.disc?.pos ||
          !centerPlayer.disc?.speed
        )
          return
        const otps = centerPlayer.team.id === Team.RED ? bps : rps
        const gpsx = centerPlayer.disc.speed.x
        const gpsy = centerPlayer.disc.speed.y
        const cx = centerPlayer.disc.pos.x
        const cy = centerPlayer.disc.pos.y
        const radius = 60 * 2
        const rotationSpeed = 0.05
        const angleStep = (2 * Math.PI) / otps.length
        if (!testGEfirstE) {
          testGEfirstE = true
          for (let i = 0; i < otps.length; i++) {
            otps[i].ige = true
            const p = room.getPlayer(otps[i].id)
            if (p) {
              const angle = testGErotationAngle + i * angleStep
              const mx = cx + radius * Math.cos(angle)
              const my = cy + radius * Math.sin(angle)
              room.setPlayerDiscProperties(otps[i].id, { x: mx, y: my })
            }
          }
        } else {
          for (let i = 0; i < otps.length; i++) {
            const p = room.getPlayer(otps[i].id)
            if (p) {
              const angle = testGErotationAngle + i * angleStep
              const dx = Math.cos(angle)
              const dy = Math.sin(angle)
              const tx = -dy
              const ty = dx
              const rx = tx * radius * rotationSpeed
              const ry = ty * radius * rotationSpeed
              room.setPlayerDiscProperties(p.id, {
                xspeed: gpsx + rx,
                yspeed: gpsy + ry,
              })
            }
          }
          testGErotationAngle += rotationSpeed
        }
      }
      function resetTGEO() {
        testGEgp = null
        testGEfirstE = false
        testGErotationAngle = 0
        const ps = getTeamCounts(room)
        const aps = ps.all
        for (let i = 0; i < aps.length; i++) aps[i].ige = false
      }
      room.onTeamGoal = function (team) {
        lastGoalTime = Date.now() // se usa para silenciar "¡AL PALO!" mientras la pelota está agrandada por la celebración
        lastScoredTeam = team
        const ball = room.getBall(true)
        touchState.touchingPlayerId = null
        touchState.touchStartTime = null
        allResetted = true
        resetCurveState() // Termina el efecto de curva de forma natural
        IS_ANY_ACTIVE_EFFECT = false
        const ballSpeed = Math.sqrt(ball.speed.x ** 2 + ball.speed.y ** 2) // Magnitud de la velocidad de la pelota en el instante del gol
        const elapsedTime = convertSecondsToTime(room.timeElapsed)
        let goalPlayer = room.getPlayer(touchState.lastTouchedPlayerId)
        const goalPlayerName = goalPlayer
          ? goalPlayer.name
          : "alguien que se fue"
        if (goalPlayer) {
          goalPlayer.vip = 5
          goalPlayer.goalT = GOAL_TEXT
        }
        let isOG = goalPlayer ? goalPlayer.team.id !== team : false
        let checkForAssist = false
        if (
          isOG &&
          touchState.lastKickedPlayerId !== touchState.lastTouchedPlayerId
        ) {
          goalPlayer = room.getPlayer(touchState.lastKickedPlayerId)
          checkForAssist = true
          if (goalPlayer) {
            isOG = goalPlayer.team.id !== team
            goalPlayer.vip = 5
            goalPlayer.goalT = GOAL_TEXT
          } else {
            isOG = false
          }
        }
        const goalPlayerSafeName = goalPlayer
          ? goalPlayer.name
          : goalPlayerName
        const speedText = `${(ballSpeed * 12).toFixed(1)} km/h`
        const assistText =
          checkForAssist &&
          touchState.secondLastTouchedPlayerId ===
            touchState.lastKickedPlayerId &&
          touchState.thirdLastTouchedPlayerId
            ? `・(👟 ${mono(touchState.thirdLastTouchedPlayerName)})`
            : touchState.secondLastTouchedPlayerId
              ? `・(👟 ${mono(touchState.secondLastTouchedPlayerName)})`
              : null
        const goalType = isOG ? "🤡" : "⚽"
        const teamColor = team == Team.RED ? colorRed : colorBlue
        let goalText = fraktur(isOG ? "¡𝖦𝗈𝗅 𝖾𝗇 𝗉𝗋𝗈𝗉𝗂𝖺 𝗉𝗎𝖾𝗋𝗍𝖺!" : "¡𝖧𝖺 𝗆𝖺𝗋𝖼𝖺𝖽𝗈 𝗀𝗈𝗅!")
        let isOGA = false
        let assistPlayer = null
        if (touchState.secondLastTouchedPlayerId && !isOG) {
          assistPlayer =
            checkForAssist &&
            touchState.secondLastTouchedPlayerId ===
              touchState.lastKickedPlayerId
              ? room.getPlayer(touchState.thirdLastTouchedPlayerId)
              : room.getPlayer(touchState.secondLastTouchedPlayerId)
          if (assistPlayer != null) {
            isOGA = assistPlayer.team.id != team
          }
        }
        const distanceText = `${touchType === 0 ? lastKickedBallDistance.toFixed(1) : lastTouchedBallDistance.toFixed(1)} m`
        const shotDistance = touchType === 0 ? lastKickedBallDistance : lastTouchedBallDistance
        const fullGoalText = `${goalType} ${mono(goalPlayerSafeName)} ${goalText} (${mono(elapsedTime)})・🚀 (${mono(speedText)})${!isOG ? `・(${mono(distanceText)})` : ""}${!isOG && !isOGA && assistText ? assistText : ""}`
        room.sendAnnouncement(
          fullGoalText,
          null,
          teamColor,
          "bold",
          NotifSound.MENTION,
        )
        if (!isOG && shotDistance >= MIDFIELD_GOAL_DISTANCE) {
          room.sendAnnouncement(
            `${emojiInfo} ${fraktur('Golazo')}!`,
            null,
            colorInfo,
            "small",
            NotifSound.MENTION,
          )
        }
        if (typeof goalPlayer === "object" && goalPlayer !== null && !isOG) {
          goalPlayer.goals = (goalPlayer.goals || 0) + 1
          recordPersistentStat(goalPlayer, "goals")
          recalculatePackLeader()
          flashAvatar(goalPlayer, randomVariant(GOAL_AVATAR_VARIANTS), 3000)
          const matchEntry = matchGoalsByPlayer.get(goalPlayer.id) || { name: goalPlayer.name, goals: 0 }
          matchEntry.goals++
          matchGoalsByPlayer.set(goalPlayer.id, matchEntry)
          if (matchEntry.goals === 2 || matchEntry.goals === 3) {
            const milestoneTemplate = matchEntry.goals === 2
              ? randomVariant(dobleteRelatoVariants)
              : randomVariant(hattrickRelatoVariants)
            const milestoneText = formatRelato(milestoneTemplate, {
              player: goalPlayerSafeName,
              time: elapsedTime,
            })
            room.sendAnnouncement(
              milestoneText,
              null,
              teamColor,
              "small",
              NotifSound.MENTION,
            )
          }
        }
        if (assistPlayer && typeof assistPlayer === "object" && !isOG && !isOGA) {
          assistPlayer.assists = (assistPlayer.assists || 0) + 1
          recordPersistentStat(assistPlayer, "assists")
          recalculatePackLeader()
          flashAvatar(assistPlayer, ASSIST_AVATAR, 3000)
          const assistEntry = matchAssistsByPlayer.get(assistPlayer.id) || { name: assistPlayer.name, assists: 0 }
          assistEntry.assists++
          matchAssistsByPlayer.set(assistPlayer.id, assistEntry)
        }
        const relatoTemplate = isOG
          ? randomVariant(ownGoalRelatoVariants)
          : assistPlayer && !isOGA
          ? randomVariant(assistRelatoVariants)
          : randomVariant(goalRelatoVariants)
        const relatoText = formatRelato(relatoTemplate, {
          player: goalPlayerSafeName,
          assist: assistPlayer ? assistPlayer.name : "",
          time: elapsedTime,
        })
        room.sendAnnouncement(
          relatoText,
          null,
          teamColor,
          "small",
          NotifSound.NONE,
        )
        const celebEffectWay = team == 1 ? -1 : 1
        Utils.runAfterGameTick(() => {
          for (i = currentStartDisc; i < currentStartDisc + 3; i++)
            room.setDiscProperties(i, { x: 0, y: 0, xspeed: 0, yspeed: 0 })
          if (ENABLE_BANANA) {
            for (i = currentStartDiscL; i < currentStartDiscL + 3; i++)
              room.setDiscProperties(i, { x: 0, y: 0, xspeed: 0, yspeed: 0 })
          }
          fixedBarFirstVis = false
          fixedBarPowerVis = false
          room.setDiscProperties(0, {
            xgravity: 0,
            ygravity: 0,
            radius: normalBallRadius,
            cGroup: cf.ball,
            damping: 0.99,
          })
          if (goalPlayer) {
            if (goalPlayer.vip && !isOG) {
              if (goalPlayer.vip >= 2) {
                const testGoalText = goalPlayer.goalT
                const testStartDiscId = 12
                const MAX_DISCS = 87
                const allowedChars = Object.keys(letterMap)
                function getDiscCountForChar(char) {
                  if (char === " ") return 0
                  const lines = letterMap[char]
                  return lines ? lines.length * 2 : 0
                }
                function getFittingText(inputText, maxDiscs) {
                  let discTotal = 0
                  let finalText = ""
                  const normalizedText = replaceTurkishChars(
                    inputText.toUpperCase(),
                  )
                  for (let char of normalizedText) {
                    if (char !== " " && !allowedChars.includes(char)) continue
                    const charDiscCount = getDiscCountForChar(char)
                    if (discTotal + charDiscCount > maxDiscs) break
                    finalText += char
                    discTotal += charDiscCount
                  }
                  return finalText
                }
                const filteredText = getFittingText(testGoalText, MAX_DISCS)
                drawText(filteredText, 0, 0, 12, testStartDiscId, 6)
              }
              room.setDiscProperties(0, { radius: 31, color: 0x39e600 })
              room.setPlayerDiscProperties(goalPlayer.id, { radius: 100 })
              const players = room.players.filter(
                (player) => !AFKSet.has(player.id),
              )
              if (!testGE) {
                for (i = 0; i < players.length; i++)
                  room.setPlayerDiscProperties(players[i].id, {
                    xspeed: celebEffectWay * 30,
                  })
              } else {
                testGEgp = goalPlayer
              }
            }
          }
          if (
            touchState.secondLastTouchedPlayerId &&
            assistPlayer !== null &&
            !isOG &&
            !isOGA
          ) {
            if (assistPlayer && assistPlayer.vip >= 2)
              room.setPlayerDiscProperties(assistPlayer.id, { radius: 60 })
          }
        })
        setTimeout(() => {
          resetLastTouchedPlayer()
        }, 1000)

        if (team === Team.RED) matchScore.red++
        else matchScore.blue++

        const _teamWon = matchScore.red  >= GOALS_TO_WIN ? Team.RED
                       : matchScore.blue >= GOALS_TO_WIN ? Team.BLUE
                       : null

        if (_teamWon !== null) {
          const _loserTeam = _teamWon === Team.RED ? Team.BLUE : Team.RED
          if (_teamWon === winningTeam) winStreak++
          else { winningTeam = _teamWon; winStreak = 1 }
          const _streak = winStreak
          const _finishedScore = { ...matchScore }
          const _finishedDuration = convertSecondsToTime(room.timeElapsed)

          setTimeout(() => {
            if (!room) return
            let _replayBuffer = null
            try {
              if (room.isRecording()) _replayBuffer = room.stopRecording()
            } catch (err) {
              console.error("No se pudo detener la grabación del replay:", err)
            }
            if (room.gameState) room.stopGame()
            rotateTeamsAfterWin(_teamWon, _loserTeam, _finishedScore, _streak, _finishedDuration, _replayBuffer)
          }, 1200)
        }
      }
      room.onPlayerInputChange = function (id, value) {
        const player = room.getPlayer(id)
        player.lastInputChangeTime = Date.now() // usado por el chequeo de AFK-kick
        if (
          player.team.id === 0 ||
          player.auth === "fake-auth-do-not-believe-it"
        )
          return
        if (player.pi === undefined) player.pi = 0
        if (player.rpi === undefined) player.rpi = 0
        const notr = [12, 28, 3, 19, 15, 31]
        if (!notr.includes(player.pi)) player.rpi = player.pi
        player.pi = value
        const now = Date.now()
        const isPressingX = value >= 16
        player.secondLastXPressTimeCanBeNull = player.pressingXStartTime
        if (isPressingX && !player.isSprinting && !player.pressingXStartTime)
          player.pressingXStartTime = now
        else if (player.isSprinting && !isPressingX) {
          player.lastSprintDur = now - player.sprintStartTime
          player.lastSprintTime = now
          player.isSprinting = false
          Utils.runAfterGameTick(() => {
            room.setPlayerDiscProperties(player.id, {
              xgravity: 0,
              ygravity: 0,
            })
          })
          player.sprintStartTime = null
          player.pressingXStartTime = null
          room.setPlayerAvatar(player.id, "⌛", true)
          setTimeout(() => {
            if (player.isSprinting) return
            room.setPlayerAvatar(player.id, "🔋", true)
            setTimeout(() => {
              if (player.isSprinting) return
              if ((!player.vip || !player.ca) && player.pos != 0)
                room.setPlayerAvatar(player.id, String(player.pos), true)
              else if (player.ca)
                room.setPlayerAvatar(player.id, player.ca, true)
              else room.setPlayerAvatar(player.id, player.avatar, true)
            }, 500)
          }, player.lastSprintDur * 5)
        } else if (!isPressingX) player.pressingXStartTime = null
        if (player.pressingXStartTime) {
          if (player.lastXPressTime != player.pressingXStartTime)
            player.secondLastXPressTime = player.lastXPressTime
          player.lastXPressTime = now
        }
      }
      room.onPlayerTeamChange = function (id, teamId, byId) {
        if (id === undefined || id === null) return

        const withinAuthWindow = Date.now() - lastAuthTeamChange < AUTH_TEAM_CHANGE_WINDOW
        const isAuthorized = byId === 0 || withinAuthWindow
        if (!isAuthorized) {
          const assigned = assignedTeams.has(id) ? assignedTeams.get(id) : Team.SPECTATORS
          lastAuthTeamChange = Date.now()
          room.setPlayerTeam(id, assigned)
          assignedTeams.set(id, assigned)
        }
      }

      room.onTeamsLockChange = function (value, byId) {
        if (value === false && byId !== 0) {
          room.lockTeams()
        }
      }

      room.onPlayerJoin = async function (player) {
        logPlayerJoin(player)
        assignedTeams.set(player.id, Team.SPECTATORS)
        await sendJoinAnnouncements(player)
        setTimeout(() => {
          if (!room) return
          if (room.gameState) {
            const c = getTeamCounts(room)
            const r = c.red.length, b = c.blue.length
            let target
            if (r <= b && r < 4)  target = Team.RED
            else if (b < 4)       target = Team.BLUE
            else                  target = Team.SPECTATORS
            lastAuthTeamChange = Date.now()
            room.setPlayerTeam(player.id, target)
            assignedTeams.set(player.id, target)
          } else {

            const c = getTeamCounts(room)
            if (c.red.length === 0 && c.blue.length === 0) {
              updateStadiumAndTeams({})
            }
          }
        }, 400)
      }
      function logPlayerJoin(player) {
        console.log(
          `\`🟩 F: ${player.flag} | N: ${player.name} joined the room.\``,
        )
      }
      async function sendJoinAnnouncements(player) {
        const welcomeLines = [
          `░▒▒▓▓▓ㅤㅤㅤㅤㅤㅤㅤ𝖲𝗍𝗋𝖾𝖾𝗍 𝔇𝔦𝔰𝔱𝔯𝔦𝔠𝔱ㅤㅤㅤㅤㅤㅤㅤ▓▓▓▒▒░`,
          `• • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • • •`,          
          `🐺 𝖡𝗂𝖾𝗇𝗏𝖾𝗇𝗂𝖽𝗈 ${player.name}! 𝖤𝗌𝖼𝗋𝗂𝖻𝖺 '!𝗁𝖾𝗅𝗉' 𝗉𝖺𝗋𝖺 𝗏𝖾𝗋 𝗅𝗈𝗌 𝖼𝗈𝗆𝖺𝗇𝖽𝗈𝗌.`,
        ]
        const welcomeColors = [
          0xffffff, 
          0xffffff,     
          0xffffff,
        ]
        welcomeLines.forEach((line, index) => {
          setTimeout(() => {
            room.sendAnnouncement(
              line,
              player.id,
              welcomeColors[index % welcomeColors.length],
              "bold",
              NotifSound.NONE,
            )
          }, index * 600)
        })
        setTimeout(() => sendAnnoOnJoin(player.id, room), welcomeLines.length * 600)
        setTimeout(async () => {
          if (!room.getPlayer(player.id)) return
        }, welcomeLines.length * 600 + 400)
      }
      room.onPlayerLeave = async function (player) {
        logPlayerLeave(player)
        assignedTeams.delete(player.id)
        recentMessageTimes.delete(player.id)
        spamPenalties.delete(player.id)
        chatLockNotified.delete(player.id)
        if (player.auth) clanInvites.delete(player.auth)
        if (player.auth === packLeaderAuth) packLeaderAuth = null // fuerza recalcular entre los que quedan
        recalculatePackLeader()
        room.sendAnnouncement(
          `👋 ${player.name} 𝗁𝖺 𝗌𝖺𝗅𝗂𝖽𝗈 𝖽𝖾 𝗅𝖺 𝗌𝖺𝗅𝖺.`,
          null,
          colorInfo,
          "small",
          NotifSound.NONE,
        )
        const wasInGame = !!room.gameState
        const preLeaveCounts = getTeamCounts(room)
        const hasActiveLineup =
          preLeaveCounts.red.filter((p) => p.id !== player.id).length > 0 &&
          preLeaveCounts.blue.filter((p) => p.id !== player.id).length > 0
        setTimeout(() => {
          if (!room) return
          if (wasInGame || hasActiveLineup) {
            updateStadiumAndTeams({ mode: 'rebalance', leavingId: player.id })
          } else {
            updateStadiumAndTeams({ leavingId: player.id })
          }
        }, 300)
      }
      function logPlayerLeave(player) {
        console.log(`\`🟥 ${player.name} leaved the room.\``)
      }
      let lastKickedBallDistance
      let lastTouchedBallDistance
      room.onPlayerBallKick = function (playerId) {
        const lastTouchDuration = touchState.lastTouchDuration || 0 // Si no hubo toque, se toma como 0
        touchState.lastKickedPlayerId = playerId
        const player = room.getPlayer(playerId)
        if (player.auth === "fake-auth-do-not-believe-it") return
        if (player.team && player.team.id === Team.RED) matchTouchesByTeam.red++
        else if (player.team && player.team.id === Team.BLUE) matchTouchesByTeam.blue++
        updateLastTouchedPlayer(playerId, room)
        const ball = room.getBall(true)
        const ballSpeed = ball.speed
        touchState.lastTouchDuration = 0
        if (player.vip) {
          Utils.runAfterGameTick(() => {
            room.setDiscProperties(0, { color: player.colB })
            setTimeout(() => {
              room.setDiscProperties(0, { color: 0xffffff })
            }, 2000)
          })
        } else {
          Utils.runAfterGameTick(() => {
            room.setDiscProperties(0, { color: 0xffffff })
          })
        }
        const ballX = ball.pos.x
        const ballY = ball.pos.y
        const ballPos = ball.pos
        const realStadiumWidth = 13
        const dx =
          (player.team.id == Team.RED ? 1 : -1) * realStadiumWidth -
          ballPos.x * (realStadiumWidth / stadiumWidth)
        const dy = 0 - ballPos.y * (realStadiumWidth / stadiumWidth)
        lastKickedBallDistance = Math.sqrt(dx * dx + dy * dy)
        player.tlts = 1
        switch (player.e) {
          case "curve":
            let canPower = false
            if (
              ENABLE_POW_AND_ULTI &&
              lastTouchDuration > powerTimeThreshold + 0.1 &&
              lastTouchDuration < ultiTimeThresholdStart
            )
              canPower = true
            if (
              ENABLE_POW_AND_ULTI &&
              canPower &&
              touchState.lastTouchedPlayerId == playerId &&
              touchState.lastOpenedBarPlayerId == playerId
            ) {
              IS_ANY_ACTIVE_EFFECT = true
              player.tlts = 5
              const powerIntensity = 1 + 0.4
              Utils.runAfterGameTick(() => {
                room.setDiscProperties(0, {
                  xspeed: ballSpeed.x * powerIntensity,
                  yspeed: ballSpeed.y * powerIntensity,
                })
              })
            } else if (
              ENABLE_POW_AND_ULTI &&
              lastTouchDuration > ultiTimeThresholdStart &&
              touchState.lastTouchedPlayerId == playerId &&
              touchState.lastOpenedBarPlayerId == playerId
            ) {
              IS_ANY_ACTIVE_EFFECT = true
              player.tlts = 6
              ultiState.isUlti = true
              ultiState.ultiStartTime = Date.now()
              ultiState.ultiPlayer = touchState.lastTouchedPlayerId
              const powerIntensity =
                1 +
                Math.min(lastTouchDuration * CURVED_SHOT_MULTIPLIER * 0.5, 0.3)
              Utils.runAfterGameTick(() => {
                room.setDiscProperties(0, {
                  xspeed: ballSpeed.x * powerIntensity,
                  yspeed: ballSpeed.y * powerIntensity,
                })
              })
            } else if (
              !canPower &&
              lastTouchDuration > firstTimeThreshold &&
              touchState.lastTouchedPlayerId == playerId &&
              touchState.lastOpenedBarPlayerId == playerId
            ) {
              const curveDirection = calculateCurveEffectDirection(
                { x: ballX, y: ballY, ...ball },
                room.getPlayer(playerId),
              )
              IS_ANY_ACTIVE_EFFECT = true
              player.tlts = 4
              curveState.isCurving = true
              curveState.curveStartTime = Date.now()
              curveState.curveDirection = curveDirection // Guarda la dirección de la curva
              curveState.curveIntensity = Math.min(
                lastTouchDuration * CURVED_SHOT_MULTIPLIER * 0.9,
                0.8,
              ) // La intensidad escala según cuánto duró el toque
              const powerIntensity =
                1 +
                Math.min(lastTouchDuration * CURVED_SHOT_MULTIPLIER * 0.6, 0.6)
              Utils.runAfterGameTick(() => {
                room.setDiscProperties(0, {
                  xspeed: ballSpeed.x * powerIntensity,
                  yspeed: ballSpeed.y * powerIntensity,
                })
              })
            } else {
              resetCurveState()
              resetUltiState()
              IS_ANY_ACTIVE_EFFECT = false
              Utils.runAfterGameTick(() => {
                room.setDiscProperties(0, {
                  xgravity: 0,
                  ygravity: 0,
                  radius: normalBallRadius,
                  cGroup: cf.ball,
                  damping: 0.99,
                })
              })
            }
            break
          case "power": {
            const powerChargeRatio = Math.min(lastTouchDuration / powerTimeThreshold, 1)
            if (
              lastTouchDuration > firstTimeThreshold &&
              touchState.lastTouchedPlayerId == playerId
            ) {
              IS_ANY_ACTIVE_EFFECT = true
              player.tlts = 8
              const powerIntensity = 1 + powerChargeRatio * 0.5 // hasta +50% a carga completa
              Utils.runAfterGameTick(() => {
                room.setDiscProperties(0, {
                  xspeed: ballSpeed.x * powerIntensity,
                  yspeed: ballSpeed.y * powerIntensity,
                  color: 0xffffff,
                })
              })
            } else {
              Utils.runAfterGameTick(() => {
                room.setDiscProperties(0, { color: 0xffffff })
              })
            }
            break
          }
          case "lob":
            let canCurve = false
            if (
              ENABLE_BANANA &&
              lastTouchDuration > powerLobTimeThreshold + 0.1
            )
              canCurve = true
            if (
              ENABLE_BANANA &&
              canCurve &&
              touchState.lastTouchedPlayerId == playerId &&
              touchState.lastOpenedBarPlayerId == playerId
            ) {
              const curveDirection = calculateCurveEffectDirection(
                { x: ballX, y: ballY, ...ball },
                room.getPlayer(playerId),
              )
              IS_ANY_ACTIVE_EFFECT = true
              player.tlts = 7
              lobShotState.lobShotStartTime = Date.now()
              lobShotState.isLobShot = true
              curveState.isCurving = true
              curveState.curveStartTime = Date.now()
              curveState.curveDirection = curveDirection // Guarda la dirección de la curva
              curveState.curveIntensity = Math.min(
                lastTouchDuration * CURVED_SHOT_MULTIPLIER * 0.8,
                0.7,
              ) // La intensidad escala según cuánto duró el toque
              const powerIntensity =
                0.4 +
                Math.min(lastTouchDuration * CURVED_SHOT_MULTIPLIER * 0.8, 0.7)
              Utils.runAfterGameTick(() => {
                room.setDiscProperties(0, {
                  xspeed: ballSpeed.x * powerIntensity,
                  yspeed: ballSpeed.y * powerIntensity,
                })
              })
            } else if (
              lastTouchDuration > firstTimeThreshold &&
              touchState.lastTouchedPlayerId == playerId
            ) {
              IS_ANY_ACTIVE_EFFECT = true
              player.tlts = 3
              lobShotState.lobShotStartTime = Date.now()
              lobShotState.isLobShot = true
              if (ENABLE_BANANA) {
                const powerIntensity =
                  0.7 +
                  Math.min(
                    lastTouchDuration * CURVED_SHOT_MULTIPLIER * 0.8,
                    0.7,
                  )
                Utils.runAfterGameTick(() => {
                  room.setDiscProperties(0, {
                    xspeed: ballSpeed.x * powerIntensity,
                    yspeed: ballSpeed.y * powerIntensity,
                  })
                })
              }
            } else {
              resetLobShotState()
              IS_ANY_ACTIVE_EFFECT = false
              Utils.runAfterGameTick(() => {
                room.setDiscProperties(0, {
                  xgravity: 0,
                  ygravity: 0,
                  radius: normalBallRadius,
                  cGroup: cf.ball,
                  damping: 0.99,
                })
              })
            }
            break
          case "none":
            break
          default:
            break
        }
      }
      room.onAfterCollisionDiscVsSegment = (
        discId,
        discPlayerId,
        segmentId,
      ) => {
        if (
          discId === 0 &&
          segmentId !== null &&
          ((curveState.isCurving && !lobShotState.isLobShot) ||
            ultiState.isUlti)
        )
          IS_ANY_ACTIVE_EFFECT = false
        const aps = room.players.filter((p) => !AFKSet.has(p.id))
        if (
          discId === 0 &&
          (segmentId === 125 || segmentId === 126) &&
          lobShotState.isLobShot
        ) {
          room.sendAnnouncement(
            `${emojiInfo} ¡𝖠𝖫 𝖳𝖱𝖠𝖵𝖤𝖲𝖠Ñ𝖮!`,
            null,
            colorInfo,
            "small",
            NotifSound.MENTION,
          )
        }
      }
      room.onCollisionDiscVsDisc = (
        discId1,
        discPlayerId1,
        discId2,
        discPlayerId2,
      ) => {
        if (discId1 !== 0 && discId2 !== 0) return // Ignora las colisiones que no involucran a la pelota
        const otherDisc = discId1 === 0 ? discId2 : discId1
        if (
          POST_DISCS.includes(otherDisc) &&
          Date.now() - lastPostHitAnnounce > 1500 &&
          Date.now() - lastGoalTime > POST_SUPPRESS_AFTER_GOAL_MS
        ) {
          lastPostHitAnnounce = Date.now()
          room.sendAnnouncement(
            `${emojiInfo} ¡𝖠𝖫 𝖯𝖠𝖫𝖮!`,
            null,
            colorInfo,
            "small",
            NotifSound.MENTION,
          )
        }
        const isBallFirst = discId1 === 0 // Identifica cuál de los dos discos es la pelota y cuál el jugador
        const playerId = isBallFirst ? discPlayerId2 : discPlayerId1
        if (room.getPlayer(playerId)) {
          updateLastTouchedPlayer(playerId, room)
          if (touchState.lastTouchDuration < firstTimeThreshold)
            IS_ANY_ACTIVE_EFFECT = false // El toque duró muy poco, se cancela cualquier efecto activo
          const player = room.getPlayer(playerId)
          if (player.isSliding) player.lbkt = Date.now()
          const ball = room.getBall(true)
          if (
            player.team &&
            (player.team.id === Team.RED || player.team.id === Team.BLUE) &&
            Date.now() - lastSaveFlash > 1500
          ) {
            const ownGoalX = player.team.id === Team.RED ? -900 : 900
            const nearOwnGoal =
              Math.abs(ball.pos.x - ownGoalX) < SAVE_ZONE_X &&
              Math.abs(ball.pos.y) < 130
            const towardOwnGoal =
              player.team.id === Team.RED
                ? ball.speed.x < -SAVE_MIN_SPEED_X
                : ball.speed.x > SAVE_MIN_SPEED_X
            if (nearOwnGoal && towardOwnGoal) {
              lastSaveFlash = Date.now()
              flashAvatar(player, "🧤", 3000)
            }
          }
          const ballPos = ball.pos
          const dx =
            (player.team.id == Team.RED ? 1 : -1) *
              (stadiumWidth * (20 / 900)) -
            ballPos.x * (20 / 900)
          const dy = 0 - ballPos.y * (20 / 900)
          lastTouchedBallDistance = Math.sqrt(dx * dx + dy * dy)
        }
      }
      room.onGameStop = function () {
        touchState.touchingPlayerId = null
        touchState.touchStartTime = null
        touchState.lastOpenedBarPlayerId = null
        touchState.lastKickedPlayerId = null
        Utils.runAfterGameTick(() => {
          for (i = currentStartDisc; i < currentStartDisc + 3; i++)
            room.setDiscProperties(i, { x: 0, y: 0, xspeed: 0, yspeed: 0 })
          if (ENABLE_BANANA) {
            for (i = currentStartDiscL; i < currentStartDiscL + 3; i++)
              room.setDiscProperties(i, { x: 0, y: 0, xspeed: 0, yspeed: 0 })
          }
        })
        fixedBarFirstVis = false
        fixedBarPowerVis = false
        allResetted = true
        resetCurveState() // Termina el efecto de curva de forma natural
        resetLobShotState()
        resetUltiState()
        resetTGEO()
        firstSlideLineTime = null
        secondSlideLineTime = null
        firstSprayLineTime = null
        secondSprayLineTime = null
        IS_ANY_ACTIVE_EFFECT = false
        Utils.runAfterGameTick(() => {
          room.setDiscProperties(0, {
            xgravity: 0,
            ygravity: 0,
            color: 0xffffff,
            radius: normalBallRadius,
            cGroup: cf.ball,
            damping: 0.99,
          })
        })
      }
      room.onGameStart = async function () {
        shot = [0, 0, 0, 0]
        goals = []
        outOfBoundsTime = 0
        ballOutTime = null
        isBallOut = false
        firstSlideLineTime = null
        secondSlideLineTime = null
        firstSprayLineTime = null
        secondSprayLineTime = null
        resetSSS(room) // Resetea el estado de sprint/slide de todos los jugadores
        isPausedNow = false
        lastScoredTeam = null
        // Resetear marcador aquí — fuente de verdad única, sin importar qué disparó el reinicio
        matchScore = { red: 0, blue: 0 }
        try {
          if (!room.isRecording()) room.startRecording()
        } catch (err) {
          console.error("No se pudo arrancar la grabación del replay:", err)
        }
      }
      room.onPositionsReset = function () {
        touchState.touchingPlayerId = null
        touchState.touchStartTime = null
        setTimeout(() => resetLastTouchedPlayer(), 1000)
        resetTGEO()
        Utils.runAfterGameTick(() => {
          for (let i = currentStartDisc; i < currentStartDisc + 3; i++) {
            room.setDiscProperties(i, { x: 0, y: 0, xspeed: 0, yspeed: 0 }) // Oculta los discos de la barra
          }
          if (ENABLE_BANANA) {
            for (let i = currentStartDiscL; i < currentStartDiscL + 3; i++) {
              room.setDiscProperties(i, { x: 0, y: 0, xspeed: 0, yspeed: 0 })
            }
          }
        })
        fixedBarFirstVis = false
        fixedBarPowerVis = false
        allResetted = true
        resetCurveState()
        IS_ANY_ACTIVE_EFFECT = false
        Utils.runAfterGameTick(() => {
          room.setDiscProperties(0, {
            color: 0xffffff, // Vuelve la pelota a su color normal
            xgravity: 0,
            ygravity: 0,
            radius: normalBallRadius,
            cGroup: cf.ball,
            damping: 0.99,
          })
        })
      }
      room.onGameTick = async function () {
        const lastTouchPObj =
          room.getPlayer(touchState.lastTouchedPlayerId) || null
        if (lastTouchPObj) {
          const ball = room.getBall()
          touchType = isClosestPlayerTouchingBall(ball.pos, lastTouchPObj.disc)
        } else touchType = null
        if (touchType)
          handleTouchState(room, touchState.lastTouchedPlayerId)
        else if (!allResetted && lastTouchPObj) {
          resetTouchState(room)
          touchState.lastTouchDuration = 0
          touchType = null
        }
        if (curveState.isCurving) handleCurveState(room)
        if (ultiState.isUlti) handleUltiState(room)
        if (lobShotState.isLobShot) handleLobShotState(room)
        if (ENABLE_SPRINT_AND_SLIDE) {
          const ps = room.players.filter((p) => p.team.id !== Team.SPECTATORS)
          ps.filter((p) => p.isSprinting).forEach((p) =>
            handleSprintState(p, room),
          )
          ps.filter((p) => !p.isSprinting).forEach((p) =>
            handleKickState(p, room),
          )
          ps.filter((p) => p.isSlideFriction).forEach((p) =>
            handleSlideFriction(p, room),
          )
        }
        if (testGEgp != null) testGoalEffectOrbit()
        if (parseInt(process.argv[3]) !== 1) return
        const ps = room.players.filter((p) => p.ib || p.ipb || p.ige)
        if (ps) ps.forEach((p) => room.fakeSendPlayerInput(0, p.id))
      }
    },
  },
)
/*
    ╔══════════════════════════════════════════════════════════════════════════════════════════════════════════╗
    ║                                            R O O M     E N D                                             ║
    ╚══════════════════════════════════════════════════════════════════════════════════════════════════════════╝
*/