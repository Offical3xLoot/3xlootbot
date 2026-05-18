import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  PermissionsBitField,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  MessageFlags,
} from "discord.js";
import fetch from "node-fetch";
import fs from "node:fs";
import path from "node:path";

// ENV
const DISCORD_TOKEN = (process.env.DISCORD_TOKEN ?? "").trim();
const DISCORD_CLIENT_ID = (process.env.DISCORD_CLIENT_ID ?? "").trim();
const GUILD_ID = (process.env.GUILD_ID ?? "").trim();
const COMMANDS_AUTO_DEPLOY =
  (process.env.COMMANDS_AUTO_DEPLOY ?? "false").trim().toLowerCase() === "true";

const XBL_API_KEY = (process.env.XBL_API_KEY ?? "").trim();

const GS_THRESHOLD = Number.parseInt((process.env.GS_THRESHOLD ?? "2500").trim(), 10);
const ONLINE_LIST_CHANNEL_ID = (process.env.ONLINE_LIST_CHANNEL_ID ?? "").trim();
const ONLINE_COUNT_CHANNEL_ID = (process.env.ONLINE_COUNT_CHANNEL_ID ?? "1265079510982725632").trim();
const ONLINE_COUNT_MAX_PLAYERS = Number.parseInt((process.env.ONLINE_COUNT_MAX_PLAYERS ?? "50").trim(), 10);
const MODLOG_CHANNEL_ID = (process.env.MODLOG_CHANNEL_ID ?? "").trim();

const DIGEST_CHANNEL_ID = (process.env.DIGEST_CHANNEL_ID ?? MODLOG_CHANNEL_ID).trim();
const DIGEST_INTERVAL_HOURS = Number.parseInt((process.env.DIGEST_INTERVAL_HOURS ?? "1").trim(), 10);

const SCRUB_DELAY_MS = Number.parseInt((process.env.SCRUB_DELAY_MS ?? "45000").trim(), 10);
const POLL_SECONDS = Number.parseInt((process.env.POLL_SECONDS ?? "900").trim(), 10);

const DATA_DIR = (process.env.DATA_DIR ?? "./data").trim();
const IMMEDIATE_FLAG_LOGS =
  (process.env.IMMEDIATE_FLAG_LOGS ?? "false").trim().toLowerCase() === "true";
const RESET_STATE = (process.env.RESET_STATE ?? "").trim().toLowerCase() === "true";
const STAFF_ROLE_ID = (process.env.STAFF_ROLE_ID ?? "").trim();

const XBL_MAX_RETRIES = Number.parseInt((process.env.XBL_MAX_RETRIES ?? "1").trim(), 10);
const XBL_BACKOFF_BASE_MS = Number.parseInt((process.env.XBL_BACKOFF_BASE_MS ?? "60000").trim(), 10);
const XBL_BACKOFF_MAX_MS = Number.parseInt((process.env.XBL_BACKOFF_MAX_MS ?? "300000").trim(), 10);
const XBL_GLOBAL_COOLDOWN_MS = Number.parseInt((process.env.XBL_GLOBAL_COOLDOWN_MS ?? "900000").trim(), 10);

// Trader status channel rename commands
const TRADER_STATUS_CHANNEL_ID = (process.env.TRADER_STATUS_CHANNEL_ID ?? "1278171924932857959").trim();
const TRADER_PING_ROLE_ID = (process.env.TRADER_PING_ROLE_ID ?? "1266136461682409565").trim();

const TRADER_STATUS_ROLE_IDS = [
  "1257773619770294310",
  "1257773619770294305",
  "1304113872030011434",
];

const TRADER_STATUS_NAMES = {
  online: "ðŸŸ¢â”ƒtrader-status",
  break: "ðŸŸ¡â”ƒtrader-status",
  offline: "ðŸ”´â”ƒtrader-status",
};

const TRADER_STATUS_COMMANDS = {
  "!traderopen": "open",
  "!traderonline": "open",

  "!traderbreak": "break",

  "!traderclose": "close",
  "!traderoffline": "close",

  "!traderstats": "stats",
};

function die(msg) {
  console.error(msg);
  process.exit(1);
}

if (!DISCORD_TOKEN) die("Missing DISCORD_TOKEN");
if (!XBL_API_KEY) die("Missing XBL_API_KEY");
if (!Number.isFinite(GS_THRESHOLD)) die("GS_THRESHOLD must be a valid integer.");
if (!Number.isFinite(DIGEST_INTERVAL_HOURS) || DIGEST_INTERVAL_HOURS < 1) die("DIGEST_INTERVAL_HOURS must be >= 1.");
if (!Number.isFinite(SCRUB_DELAY_MS) || SCRUB_DELAY_MS < 0) die("SCRUB_DELAY_MS must be non-negative.");
if (!Number.isFinite(POLL_SECONDS) || POLL_SECONDS < 10) die("POLL_SECONDS must be >= 10.");
if (!Number.isFinite(ONLINE_COUNT_MAX_PLAYERS) || ONLINE_COUNT_MAX_PLAYERS < 1) die("ONLINE_COUNT_MAX_PLAYERS must be >= 1.");

process.on("unhandledRejection", (err) => console.error("Unhandled rejection:", err));
process.on("uncaughtException", (err) => console.error("Uncaught exception:", err));

console.log("Booting 3xBot...");

fs.mkdirSync(DATA_DIR, { recursive: true });
const STATE_FILE = path.resolve(DATA_DIR, "state.json");

function nowMs() {
  return Date.now();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeGamertag(s) {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

function gtKey(s) {
  return normalizeGamertag(s).toLowerCase();
}

function stripMarkdown(s) {
  return (s ?? "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .trim();
}

function parseGamertagList(input) {
  const raw = (input ?? "").trim();
  if (!raw) return [];

  return raw
    .split(",")
    .map((x) => normalizeGamertag(x))
    .filter((x) => x.length >= 2 && x.length <= 20);
}

function defaultTraderStats() {
  return {
    weekStartMs: 0,
    totals: {},
    activeSessions: {},
  };
}

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);

    const checked = new Set(Array.isArray(parsed?.checked) ? parsed.checked : []);
    const pending = new Map();

    if (parsed?.pending && typeof parsed.pending === "object") {
      for (const [k, v] of Object.entries(parsed.pending)) {
        if (!k || !v) continue;

        pending.set(k, {
          gamertag: String(v.gamertag ?? ""),
          gamerscore: Number.parseInt(String(v.gamerscore ?? ""), 10),
          firstSeenMs: Number.parseInt(String(v.firstSeenMs ?? ""), 10) || nowMs(),
          lastSeenMs: Number.parseInt(String(v.lastSeenMs ?? ""), 10) || nowMs(),
        });
      }
    }

    const lastDigestMs = Number.parseInt(String(parsed?.lastDigestMs ?? "0"), 10) || 0;
    const flaggedAll = new Map();

    if (parsed?.flaggedAll && typeof parsed.flaggedAll === "object") {
      for (const [k, v] of Object.entries(parsed.flaggedAll)) {
        if (!k || !v) continue;

        flaggedAll.set(k, {
          gamertag: String(v.gamertag ?? ""),
          lastKnownGS: Number.parseInt(String(v.lastKnownGS ?? ""), 10),
          firstSeenMs: Number.parseInt(String(v.firstSeenMs ?? ""), 10) || nowMs(),
          lastSeenMs: Number.parseInt(String(v.lastSeenMs ?? ""), 10) || nowMs(),
        });
      }
    }

    let trusted = {};
    if (parsed?.trusted && typeof parsed.trusted === "object" && !Array.isArray(parsed.trusted)) {
      trusted = parsed.trusted;
    }

    const normalizedTrusted = {};
    for (const [k, v] of Object.entries(trusted || {})) {
      const kk = String(k ?? "").trim().toLowerCase();
      if (!kk) continue;

      const gt = normalizeGamertag(v?.gamertag ?? "");
      if (!gt) continue;

      normalizedTrusted[kk] = {
        gamertag: gt,
        addedMs: Number.parseInt(String(v?.addedMs ?? ""), 10) || nowMs(),
      };
    }

    const traderStats = parsed?.traderStats && typeof parsed.traderStats === "object"
      ? parsed.traderStats
      : defaultTraderStats();

    if (!traderStats.totals || typeof traderStats.totals !== "object") traderStats.totals = {};
    if (!traderStats.activeSessions || typeof traderStats.activeSessions !== "object") traderStats.activeSessions = {};
    if (!Number.isFinite(Number(traderStats.weekStartMs))) traderStats.weekStartMs = 0;

    return {
      checked,
      pending,
      lastDigestMs,
      flaggedAll,
      trusted: normalizedTrusted,
      traderStats,
    };
  } catch {
    return {
      checked: new Set(),
      pending: new Map(),
      lastDigestMs: 0,
      flaggedAll: new Map(),
      trusted: {},
      traderStats: defaultTraderStats(),
    };
  }
}

function saveState() {
  const pendingObj = {};
  for (const [k, v] of state.pending.entries()) pendingObj[k] = v;

  const flaggedAllObj = {};
  for (const [k, v] of state.flaggedAll.entries()) flaggedAllObj[k] = v;

  fs.writeFileSync(STATE_FILE, JSON.stringify({
    checked: Array.from(state.checked.values()).sort((a, b) => a.localeCompare(b)),
    pending: pendingObj,
    lastDigestMs: state.lastDigestMs,
    trusted: state.trusted,
    flaggedAll: flaggedAllObj,
    traderStats: state.traderStats,
  }, null, 2), "utf8");
}

let state = loadState();

if (RESET_STATE) {
  state = {
    checked: new Set(),
    pending: new Map(),
    lastDigestMs: 0,
    trusted: {},
    flaggedAll: new Map(),
    traderStats: defaultTraderStats(),
  };

  saveState();
}

function isTrustedKey(k) {
  return !!state.trusted?.[k];
}

function trustedDisplayForKey(k) {
  return state.trusted?.[k]?.gamertag || k;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel],
});

function isStaff(interaction) {
  const perms = interaction.memberPermissions;
  const hasManageGuild = perms?.has(PermissionsBitField.Flags.ManageGuild);

  if (hasManageGuild) return true;
  if (STAFF_ROLE_ID && interaction.member?.roles?.cache?.has?.(STAFF_ROLE_ID)) return true;

  return false;
}

async function autoDeployCommandsIfEnabled() {
  if (!COMMANDS_AUTO_DEPLOY) return;
  if (!DISCORD_CLIENT_ID || !GUILD_ID) return;

  const commands = [
    new SlashCommandBuilder()
      .setName("xcheck")
      .setDescription("Check an Xbox gamertag's gamerscore against the configured threshold.")
      .addStringOption((opt) =>
        opt.setName("gamertag").setDescription("Xbox gamertag").setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName("xinfo")
      .setDescription("Fetch detailed Xbox profile info. Only shows fields that are available.")
      .addStringOption((opt) =>
        opt.setName("gamertag").setDescription("Xbox gamertag").setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName("xflagged")
      .setDescription("Show low-gamerscore gamertags saved by the bot.")
      .addStringOption((opt) =>
        opt.setName("scope")
          .setDescription("pending = since last digest; all = all-time saved")
          .addChoices(
            { name: "pending", value: "pending" },
            { name: "all", value: "all" }
          )
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName("xtrust")
      .setDescription("Manage trusted gamertags. You can add/remove multiple separated by commas.")
      .addStringOption((opt) =>
        opt.setName("action")
          .setDescription("add/remove/list")
          .addChoices(
            { name: "add", value: "add" },
            { name: "remove", value: "remove" },
            { name: "list", value: "list" }
          )
          .setRequired(true)
      )
      .addStringOption((opt) =>
        opt.setName("gamertag").setDescription("Gamertag(s).").setRequired(false)
      ),
  ].map((c) => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, GUILD_ID), { body: commands });
}

async function fetchJsonWithTimeout(url, options, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();

    let data = null;
    try { data = JSON.parse(text); } catch {}

    return { res, data };
  } finally {
    clearTimeout(timer);
  }
}

class RateLimitError extends Error {
  constructor(message, retryAfterMs = null) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

function parseRetryAfterMs(res) {
  const ra = res.headers?.get?.("retry-after");
  if (!ra) return null;

  const sec = Number.parseFloat(ra);
  if (!Number.isFinite(sec)) return null;

  return Math.max(0, Math.round(sec * 1000));
}

async function openXblFetchJson(url) {
  const { res, data } = await fetchJsonWithTimeout(url, {
    method: "GET",
    headers: {
      "X-Authorization": XBL_API_KEY,
      Accept: "application/json",
    },
  }, 8000);

  if (res.status === 429) {
    throw new RateLimitError("OpenXBL rate limited (HTTP 429)", parseRetryAfterMs(res));
  }

  if (!res.ok) {
    throw new Error(data?.error || data?.message || `OpenXBL request failed (HTTP ${res.status})`);
  }

  return data;
}

async function openXblFetchWithRetry(url) {
  let attempt = 0;

  while (true) {
    try {
      return await openXblFetchJson(url);
    } catch (err) {
      if (err instanceof RateLimitError) {
        attempt += 1;

        if (attempt > XBL_MAX_RETRIES) {
          throw err;
        }

        const backoff = Math.min(
          XBL_BACKOFF_MAX_MS,
          err.retryAfterMs ?? XBL_BACKOFF_BASE_MS
        );

        console.warn(`[OPENXBL] Rate limited. Waiting ${Math.round(backoff / 1000)}s before retry ${attempt}/${XBL_MAX_RETRIES}.`);
        await sleep(backoff);
        continue;
      }

      throw err;
    }
  }
}

function settingValue(settings, id) {
  return Array.isArray(settings)
    ? settings.find((s) => s?.id === id)?.value ?? null
    : null;
}

function unwrapOpenXblContent(data) {
  if (data?.content && typeof data.content === "object") return data.content;

  if (typeof data?.content === "string") {
    try {
      return JSON.parse(data.content);
    } catch {
      return data;
    }
  }

  return data;
}

async function openXblSearch(gamertag) {
  const wanted = normalizeGamertag(gamertag);
  const wantedLower = wanted.toLowerCase();
  const data = await openXblFetchWithRetry(`https://xbl.io/api/v2/search/${encodeURIComponent(wanted)}`);
  const payload = unwrapOpenXblContent(data);

  const people = Array.isArray(payload?.people)
    ? payload.people
    : Array.isArray(payload?.profileUsers)
      ? payload.profileUsers
      : [];

  if (!people.length) {
    console.warn(`[OPENXBL SEARCH EMPTY] ${wanted}: response keys=${Object.keys(data || {}).join(",") || "none"}; content keys=${Object.keys(payload || {}).join(",") || "none"}`);
    throw new Error("Gamertag not found.");
  }

  const best =
    people.find((p) => String(settingValue(p?.settings, "Gamertag") ?? "").toLowerCase() === wantedLower) ||
    people.find((p) => String(settingValue(p?.settings, "ModernGamertag") ?? "").toLowerCase() === wantedLower) ||
    people.find((p) => String(settingValue(p?.settings, "UniqueModernGamertag") ?? "").toLowerCase() === wantedLower) ||
    people.find((p) => String(p?.gamertag ?? "").toLowerCase() === wantedLower) ||
    people.find((p) => String(p?.modernGamertag ?? "").toLowerCase() === wantedLower) ||
    people[0];

  const xuid = best?.xuid || best?.id;
  if (!xuid) throw new Error("Search result missing XUID.");

  return {
    ...best,
    xuid,
    gamertag:
      best?.gamertag ||
      settingValue(best?.settings, "Gamertag") ||
      settingValue(best?.settings, "ModernGamertag") ||
      settingValue(best?.settings, "UniqueModernGamertag") ||
      wanted,
  };
}

async function openXblAccount(xuid) {
  return await openXblFetchWithRetry(`https://xbl.io/api/v2/account/${encodeURIComponent(xuid)}`);
}

function settingsToMap(settingsArr) {
  const map = new Map();
  if (!Array.isArray(settingsArr)) return map;

  for (const s of settingsArr) {
    if (typeof s?.id === "string") map.set(s.id, s.value ?? null);
  }

  return map;
}

function readSetting(map, ...keys) {
  for (const k of keys) {
    if (map.has(k)) return map.get(k);
  }

  return null;
}

function parseIntOrNull(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;

  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}

function deepFindNumbers(obj, keyNamesLower) {
  const found = new Map();

  const visit = (x) => {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) return x.forEach(visit);

    for (const [k, v] of Object.entries(x)) {
      const kl = k.toLowerCase();

      if (keyNamesLower.has(kl)) {
        const n = parseIntOrNull(v);
        if (n !== null) found.set(kl, n);
      }

      if (v && typeof v === "object") visit(v);
    }
  };

  visit(obj);

  const out = {};
  for (const [k, v] of found.entries()) out[k] = v;

  return out;
}

async function fetchOpenXblMergedProfile(gamertag) {
  const person = await openXblSearch(gamertag);
  const accData = await openXblAccount(person.xuid);
  const accPayload = unwrapOpenXblContent(accData);
  const settingsMap = settingsToMap(accPayload?.profileUsers?.[0]?.settings || person?.settings);

  const socialNums = deepFindNumbers({ person, accData: accPayload }, new Set([
    "followerscount",
    "followercount",
    "followingcount",
    "friendscount",
    "friendcount",
  ]));

  return {
    gamertag: readSetting(settingsMap, "Gamertag") || person.gamertag || normalizeGamertag(gamertag),
    xuid: person.xuid,
    gamerscore: parseIntOrNull(readSetting(settingsMap, "Gamerscore")) ?? parseIntOrNull(person.gamerscore) ?? parseIntOrNull(person.gamerScore) ?? null,
    tier: readSetting(settingsMap, "AccountTier") || person?.detail?.accountTier || null,
    gamerpic: readSetting(settingsMap, "GameDisplayPicRaw", "GameDisplayPic") || person?.displayPicRaw || person?.displayPic || null,
    bio: readSetting(settingsMap, "Bio") || person?.detail?.bio || null,
    location: readSetting(settingsMap, "Location") || person?.detail?.location || null,
    tenure: readSetting(settingsMap, "TenureLevel") || person?.detail?.tenureLevel || null,
    presenceState: person?.presenceState || person?.presence?.state || null,
    presenceText: person?.presenceText || person?.presence?.text || null,
    lastSeen: person?.detail?.lastSeenTimestamp || person?.lastSeenDateTimeUtc || person?.detail?.lastSeenDateTimeUtc || null,
    xboxRep: person?.xboxOneRep || person?.detail?.xboxOneRep || null,
    hasGamePass: person?.detail?.hasGamePass ?? person?.hasGamePass ?? null,
    followerCount: socialNums["followercount"] ?? socialNums["followerscount"] ?? null,
    followingCount: socialNums["followingcount"] ?? null,
    friendCount: socialNums["friendcount"] ?? socialNums["friendscount"] ?? null,
  };
}

function addFieldIf(embed, name, value, inline = true) {
  const v = (value ?? "").toString().trim();
  if (!v) return;

  embed.addFields({ name, value: v, inline });
}

function formatBool(v) {
  if (v === true) return "Yes";
  if (v === false) return "No";
  return "";
}

function extractOnlineCountFromMessage(msg, parsedGamertags = []) {
  const embedText = [];

  for (const e of msg.embeds ?? []) {
    if (e?.title) embedText.push(String(e.title));
    if (e?.description) embedText.push(String(e.description));

    if (Array.isArray(e?.fields)) {
      for (const f of e.fields) {
        if (f?.name) embedText.push(String(f.name));
        if (f?.value) embedText.push(String(f.value));
      }
    }
  }

  const text = embedText.join("\n");
  const countMatch =
    text.match(/(?:online|players?|survivors?|on now)[^0-9]{0,30}(\d{1,3})\s*\/\s*(\d{1,3})/i) ||
    text.match(/(\d{1,3})\s*\/\s*(\d{1,3})[^\n]*(?:online|players?|survivors?|on now)/i) ||
    text.match(/(?:online|players?|survivors?|on now)[^0-9]{0,30}(\d{1,3})/i);

  if (countMatch) {
    const count = Number.parseInt(countMatch[1], 10);
    if (Number.isFinite(count)) return count;
  }

  return parsedGamertags.length;
}

async function updateOnlineCountChannel(guild, count) {
  if (!ONLINE_COUNT_CHANNEL_ID || !guild) return;

  const channel = await guild.channels.fetch(ONLINE_COUNT_CHANNEL_ID).catch(() => null);
  if (!channel || typeof channel.setName !== "function") return;

  const botMember = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
  const perms = botMember ? channel.permissionsFor(botMember) : null;

  if (!perms?.has(PermissionsBitField.Flags.ManageChannels)) {
    console.warn("[ONLINE COUNT] Missing Manage Channels permission for online count channel.");
    return;
  }

  const desiredName = `\uD83D\uDFE2 On Now ${count}/${ONLINE_COUNT_MAX_PLAYERS}`;

  if (channel.name !== desiredName) {
    await channel.setName(desiredName, "Online player count updated");
  }
}

function extractGamertagsFromEmbeds(msg) {
  const embeds = msg.embeds ?? [];
  if (!embeds.length) return [];

  const chunks = [];

  for (const e of embeds) {
    if (e?.title) chunks.push(String(e.title));
    if (e?.description) chunks.push(String(e.description));

    if (Array.isArray(e?.fields)) {
      for (const f of e.fields) {
        if (f?.name) chunks.push(String(f.name));
        if (f?.value) chunks.push(String(f.value));
      }
    }
  }

  const lines = chunks.join("\n").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out = [];
  const seen = new Set();

  for (let line of lines) {
    line = stripMarkdown(line);

    const lower = line.toLowerCase();
    if (lower.includes("online list") && lower.includes("players")) continue;
    if (lower === "3xloot") continue;

    line = line.replace(/^[â€¢\-]+\s*/, "").trim();

    const gt = normalizeGamertag(line);
    if (gt.length < 2 || gt.length > 20) continue;
    if (!/^[a-zA-Z0-9 _.\-]+$/.test(gt)) continue;

    const k = gtKey(gt);
    if (seen.has(k)) continue;

    seen.add(k);
    out.push(gt);
  }

  return out;
}

function addFlagged(profile) {
  const k = gtKey(profile.gamertag);
  if (!k || isTrustedKey(k)) return;

  const t = nowMs();

  const p = state.pending.get(k);
  if (!p) {
    state.pending.set(k, {
      gamertag: profile.gamertag,
      gamerscore: profile.gamerscore ?? 0,
      firstSeenMs: t,
      lastSeenMs: t,
    });
  } else {
    p.gamertag = profile.gamertag;

    if (profile.gamerscore !== null && profile.gamerscore !== undefined) {
      p.gamerscore = profile.gamerscore;
    }

    p.lastSeenMs = t;
  }

  const a = state.flaggedAll.get(k);
  if (!a) {
    state.flaggedAll.set(k, {
      gamertag: profile.gamertag,
      lastKnownGS: profile.gamerscore ?? 0,
      firstSeenMs: t,
      lastSeenMs: t,
    });
  } else {
    a.gamertag = profile.gamertag;

    if (profile.gamerscore !== null && profile.gamerscore !== undefined) {
      a.lastKnownGS = profile.gamerscore;
    }

    a.lastSeenMs = t;
  }

  saveState();
}

function trustGamertag(gt) {
  const original = normalizeGamertag(gt);
  const k = gtKey(original);

  if (!k) return { ok: false, display: "" };

  const wasFlagged = state.pending.has(k) || state.flaggedAll.has(k);

  state.trusted[k] = { gamertag: original, addedMs: nowMs() };
  state.pending.delete(k);
  state.flaggedAll.delete(k);

  saveState();

  return { ok: true, display: original, removedFlagged: wasFlagged };
}

function untrustGamertag(gt) {
  const original = normalizeGamertag(gt);
  const k = gtKey(original);

  if (!k) return { ok: false, display: "" };

  const display = trustedDisplayForKey(k);
  delete state.trusted[k];

  saveState();

  return { ok: true, display };
}

function chunkLines(lines, maxChars) {
  const chunks = [];
  let current = "";

  for (const line of lines) {
    const add = (current ? "\n" : "") + line;

    if (current.length + add.length > maxChars) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current += add;
    }
  }

  if (current) chunks.push(current);

  return chunks;
}

async function sendEmbedToChannel(guild, channelId, embed) {
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel) return false;

  const me = guild.members.me;

  if (me) {
    const perms = channel.permissionsFor(me);
    if (!perms?.has(PermissionsBitField.Flags.SendMessages)) return false;
    if (!perms?.has(PermissionsBitField.Flags.EmbedLinks)) return false;
  }

  await channel.send({ embeds: [embed] });
  return true;
}

async function sendDigestIfDue() {
  if (!DIGEST_CHANNEL_ID) return;

  const intervalMs = DIGEST_INTERVAL_HOURS * 60 * 60 * 1000;
  const now = nowMs();

  if (state.lastDigestMs && now - state.lastDigestMs < intervalMs) return;

  const cutoff = state.lastDigestMs || now - intervalMs;

  const items = Array.from(state.pending.entries())
    .map(([k, v]) => ({ k, ...v }))
    .filter((v) => (v?.lastSeenMs ?? 0) >= cutoff)
    .filter((v) => !isTrustedKey(v.k))
    .sort((a, b) => (a.gamertag || "").localeCompare(b.gamertag || ""));

  const digestChan = await client.channels.fetch(DIGEST_CHANNEL_ID).catch(() => null);

  if (!digestChan || !digestChan.guild) return;

  if (!items.length) {
    state.lastDigestMs = now;
    state.pending = new Map();
    saveState();
    return;
  }

  const lines = items.map((v) => v.gamertag);
  const chunks = chunkLines(lines, 3500);

  for (let i = 0; i < chunks.length; i++) {
    const embed = new EmbedBuilder()
      .setTitle(`Low Gamerscore Watchlist (Last ${DIGEST_INTERVAL_HOURS}h)`)
      .setDescription(chunks[i])
      .addFields(
        { name: "Threshold", value: `< ${GS_THRESHOLD}`, inline: true },
        { name: "Count", value: String(items.length), inline: true }
      )
      .setColor(0xff0000)
      .setTimestamp();

    if (chunks.length > 1) {
      embed.setFooter({ text: `Page ${i + 1}/${chunks.length}` });
    }

    await sendEmbedToChannel(digestChan.guild, DIGEST_CHANNEL_ID, embed);
  }

  state.lastDigestMs = now;
  state.pending = new Map();
  saveState();
}

const queue = [];
const queuedKeys = new Set();
let working = false;
let globalCooldownUntilMs = 0;

async function pollOnlineList() {
  if (!ONLINE_LIST_CHANNEL_ID) return;

  const channel = await client.channels.fetch(ONLINE_LIST_CHANNEL_ID).catch(() => null);
  if (!channel || !("messages" in channel)) return;

  const messages = await channel.messages.fetch({ limit: 1 }).catch(() => null);
  const newest = messages?.first();

  if (!newest) return;

  const gts = extractGamertagsFromEmbeds(newest);
  await updateOnlineCountChannel(newest.guild, extractOnlineCountFromMessage(newest, gts));

  const now = nowMs();

  if (globalCooldownUntilMs > now) {
    const waitSec = Math.ceil((globalCooldownUntilMs - now) / 1000);
    console.warn(`[OPENXBL] Global cooldown active. Skipping gamertag checks for ${waitSec}s.`);
    return;
  }

  for (const gt of gts) {
    enqueueGamertag(gt, newest.guild);
  }
}

function enqueueGamertag(gt, guild) {
  const clean = normalizeGamertag(gt);
  const k = gtKey(clean);

  if (!k || isTrustedKey(k) || state.checked.has(k) || queuedKeys.has(k)) return;

  queue.push({ gt: clean, k, guild });
  queuedKeys.add(k);

  void processQueue();
}

async function processQueue() {
  if (working) return;

  working = true;

  try {
    while (queue.length) {
      const item = queue.shift();

      if (!item) continue;

      queuedKeys.delete(item.k);

      if (isTrustedKey(item.k) || state.checked.has(item.k)) continue;

      const now = nowMs();

      if (globalCooldownUntilMs > now) {
        const waitMs = globalCooldownUntilMs - now;
        console.warn(`[OPENXBL] Global cooldown active. Pausing queue for ${Math.ceil(waitMs / 1000)}s.`);
        await sleep(waitMs);
      }

      try {
        const merged = await fetchOpenXblMergedProfile(item.gt);
        const gs = merged.gamerscore;

        if (gs === null || gs === undefined) {
          console.warn(`[SKIPPED] ${item.gt}: Gamerscore unavailable. Will try again later.`);
        } else {
          state.checked.add(item.k);
          saveState();

          if (gs < GS_THRESHOLD) {
            addFlagged({ gamertag: merged.gamertag, gamerscore: gs });

            if (IMMEDIATE_FLAG_LOGS && item.guild && MODLOG_CHANNEL_ID) {
              const embed = new EmbedBuilder()
                .setTitle("XCHECK FLAGGED")
                .addFields(
                  { name: "Gamertag", value: merged.gamertag, inline: true },
                  { name: "Gamerscore", value: String(gs), inline: true },
                  { name: "Result", value: "FLAGGED", inline: false }
                )
                .setColor(0xff0000)
                .setTimestamp();

              if (merged.tier) {
                embed.addFields({ name: "Tier", value: String(merged.tier), inline: true });
              }

              if (merged.gamerpic) {
                embed.setThumbnail(merged.gamerpic);
              }

              await sendEmbedToChannel(item.guild, MODLOG_CHANNEL_ID, embed);
            }
          }
        }
      } catch (err) {
        if (err instanceof RateLimitError) {
          globalCooldownUntilMs = nowMs() + XBL_GLOBAL_COOLDOWN_MS;
          console.warn(`[OPENXBL] Rate limited while checking ${item.gt}. Entering ${Math.round(XBL_GLOBAL_COOLDOWN_MS / 60000)} minute cooldown.`);
          break;
        }

        const msg = String(err?.message ?? err);

        if (msg.toLowerCase().includes("gamertag not found")) {
          console.warn(`[NOT FOUND] ${item.gt}: OpenXBL could not find this gamertag. Not marking as checked.`);
        } else {
          console.error(`[ERROR] ${item.gt}:`, msg);
        }
      }

      if (SCRUB_DELAY_MS > 0) {
        await sleep(SCRUB_DELAY_MS);
      }
    }
  } finally {
    working = false;
  }
}

function buildListEmbeds(title, lines, color = 0x2b2d31) {
  const chunks = chunkLines(lines, 3500);

  return chunks.map((chunk, i) => {
    const e = new EmbedBuilder()
      .setTitle(title)
      .setDescription(chunk || "â€”")
      .setColor(color)
      .setTimestamp();

    if (chunks.length > 1) {
      e.setFooter({ text: `Page ${i + 1}/${chunks.length}` });
    }

    return e;
  });
}

function getTraderWeekStartMs(referenceMs = nowMs()) {
  const EST_OFFSET_MS = -5 * 60 * 60 * 1000;
  const d = new Date(referenceMs + EST_OFFSET_MS);

  const day = d.getUTCDay();
  const daysSinceFriday = (day - 5 + 7) % 7;

  const fridayEst = new Date(Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() - daysSinceFriday,
    0,
    0,
    0,
    0
  ));

  return fridayEst.getTime() - EST_OFFSET_MS;
}

function ensureTraderStatsWeek() {
  if (!state.traderStats || typeof state.traderStats !== "object") {
    state.traderStats = defaultTraderStats();
  }

  if (!state.traderStats.totals || typeof state.traderStats.totals !== "object") {
    state.traderStats.totals = {};
  }

  if (!state.traderStats.activeSessions || typeof state.traderStats.activeSessions !== "object") {
    state.traderStats.activeSessions = {};
  }

  const currentWeekStart = getTraderWeekStartMs();

  if (state.traderStats.weekStartMs !== currentWeekStart) {
    state.traderStats.weekStartMs = currentWeekStart;
    state.traderStats.totals = {};
    state.traderStats.activeSessions = {};
    saveState();
  }
}

function formatDuration(ms) {
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours <= 0) return `${minutes}m`;
  if (minutes <= 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

function getActiveTraderCount() {
  ensureTraderStatsWeek();
  return Object.keys(state.traderStats.activeSessions || {}).length;
}

function getDisplayNameForMember(member, fallbackUser) {
  return member?.displayName || fallbackUser?.globalName || fallbackUser?.username || "Unknown Trader";
}

function startTraderSession(member, user) {
  ensureTraderStatsWeek();

  const userId = user.id;
  const displayName = getDisplayNameForMember(member, user);

  if (state.traderStats.activeSessions[userId]) {
    return {
      started: false,
      displayName,
      alreadyActive: true,
    };
  }

  state.traderStats.activeSessions[userId] = {
    userId,
    displayName,
    startedMs: nowMs(),
  };

  if (!state.traderStats.totals[userId]) {
    state.traderStats.totals[userId] = {
      userId,
      displayName,
      totalMs: 0,
    };
  } else {
    state.traderStats.totals[userId].displayName = displayName;
  }

  saveState();

  return {
    started: true,
    displayName,
    alreadyActive: false,
  };
}

function stopTraderSession(member, user) {
  ensureTraderStatsWeek();

  const userId = user.id;
  const displayName = getDisplayNameForMember(member, user);
  const session = state.traderStats.activeSessions[userId];

  if (!session) {
    return {
      stopped: false,
      displayName,
      addedMs: 0,
    };
  }

  const addedMs = Math.max(0, nowMs() - Number(session.startedMs || nowMs()));

  if (!state.traderStats.totals[userId]) {
    state.traderStats.totals[userId] = {
      userId,
      displayName,
      totalMs: 0,
    };
  }

  state.traderStats.totals[userId].displayName = displayName;
  state.traderStats.totals[userId].totalMs =
    Number(state.traderStats.totals[userId].totalMs || 0) + addedMs;

  delete state.traderStats.activeSessions[userId];

  saveState();

  return {
    stopped: true,
    displayName,
    addedMs,
  };
}

function buildTraderStatsText() {
  ensureTraderStatsWeek();

  const totals = { ...(state.traderStats.totals || {}) };

  for (const [userId, session] of Object.entries(state.traderStats.activeSessions || {})) {
    if (!totals[userId]) {
      totals[userId] = {
        userId,
        displayName: session.displayName || "Unknown Trader",
        totalMs: 0,
      };
    }

    totals[userId].totalMs =
      Number(totals[userId].totalMs || 0) + Math.max(0, nowMs() - Number(session.startedMs || nowMs()));
  }

  const rows = Object.values(totals)
    .filter((x) => Number(x.totalMs || 0) > 0)
    .sort((a, b) => Number(b.totalMs || 0) - Number(a.totalMs || 0));

  if (!rows.length) {
    return "**Trader Hours This Week**\nNo trader time logged yet.\n\nWeek resets Friday.";
  }

  const lines = rows.map((x) => `**${x.displayName || "Unknown Trader"}** â€” ${formatDuration(Number(x.totalMs || 0))}`);

  const active = Object.values(state.traderStats.activeSessions || {});
  const activeLine = active.length
    ? `\n\nCurrently active: ${active.map((x) => `**${x.displayName}**`).join(", ")}`
    : "";

  return `**Trader Hours This Week**\n${lines.join("\n")}${activeLine}\n\nWeek resets Friday.`;
}

async function setTraderStatusChannelName(guild, desiredName) {
  const channel = await guild.channels.fetch(TRADER_STATUS_CHANNEL_ID).catch(() => null);

  if (!channel || typeof channel.setName !== "function") {
    return {
      ok: false,
      channel: null,
      error: "Trader status channel not found, or it cannot be renamed.",
    };
  }

  const botMember = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
  const perms = botMember ? channel.permissionsFor(botMember) : null;

  if (!perms?.has(PermissionsBitField.Flags.ManageChannels)) {
    return {
      ok: false,
      channel,
      error: "I need the **Manage Channels** permission to rename the trader status channel.",
    };
  }

  if (channel.name !== desiredName) {
    await channel.setName(desiredName, "Trader status command used");
  }

  return {
    ok: true,
    channel,
    error: null,
  };
}

async function handleTraderStatusCommand(message) {
  try {
    if (message.author.bot) return false;
    if (!message.guild) return false;

    const content = message.content.toLowerCase().trim();
    const action = TRADER_STATUS_COMMANDS[content];

    if (!action) return false;

    const member = message.member ?? await message.guild.members.fetch(message.author.id).catch(() => null);

    const hasRole = member?.roles?.cache?.some((role) =>
      TRADER_STATUS_ROLE_IDS.includes(role.id)
    );

    if (!hasRole) {
      await message.reply("You do not have permission to use this command.");
      return true;
    }

    const displayName = getDisplayNameForMember(member, message.author);

    if (action === "stats") {
      const statsText = buildTraderStatsText();
      await message.reply(statsText);
      return true;
    }

    if (action === "open") {
      const activeCountBeforeOpen = getActiveTraderCount();
      startTraderSession(member, message.author);

      const status = await setTraderStatusChannelName(message.guild, TRADER_STATUS_NAMES.online);

      if (!status.ok) {
        await message.reply(status.error);
        return true;
      }

      const openedAtUnix = Math.floor(Date.now() / 1000);
      const rolePing = activeCountBeforeOpen === 0 ? `<@&${TRADER_PING_ROLE_ID}> ` : "";
      await status.channel.send(`${rolePing}<@${message.author.id}> opened trader at <t:${openedAtUnix}:t>`);

      if (message.channel.id !== status.channel.id) {
        await message.reply("Trader status set to online.");
      }

      return true;
    }

    if (action === "break") {
      const result = stopTraderSession(member, message.author);
      const activeCount = getActiveTraderCount();

      const desiredName = activeCount > 0
        ? TRADER_STATUS_NAMES.online
        : TRADER_STATUS_NAMES.break;

      const status = await setTraderStatusChannelName(message.guild, desiredName);

      if (!status.ok) {
        await message.reply(status.error);
        return true;
      }

      const timeText = result.stopped
        ? ` Time logged: **${formatDuration(result.addedMs)}**.`
        : "";

      const stillOnlineText = activeCount > 0
        ? ` Trader is still online with **${activeCount}** active trader${activeCount === 1 ? "" : "s"}.`
        : " Trader is currently on break.";

      await status.channel.send(`**${displayName}** is on trader break.${timeText}${stillOnlineText}`);

      if (message.channel.id !== status.channel.id) {
        await message.reply("Trader break logged.");
      }

      return true;
    }

    if (action === "close") {
      const result = stopTraderSession(member, message.author);
      const activeCount = getActiveTraderCount();

      const desiredName = activeCount > 0
        ? TRADER_STATUS_NAMES.online
        : TRADER_STATUS_NAMES.offline;

      const status = await setTraderStatusChannelName(message.guild, desiredName);

      if (!status.ok) {
        await message.reply(status.error);
        return true;
      }

      const timeText = result.stopped
        ? ` Time logged: **${formatDuration(result.addedMs)}**.`
        : "";

      const stillOnlineText = activeCount > 0
        ? ` Trader is still online with **${activeCount}** active trader${activeCount === 1 ? "" : "s"}.`
        : " Trader is now offline.";

      await status.channel.send(`**${displayName}** closed trader.${timeText}${stillOnlineText}`);

      if (message.channel.id !== status.channel.id) {
        await message.reply("Trader close logged.");
      }

      return true;
    }

    return false;
  } catch (err) {
    console.error("[TRADER STATUS ERROR]", err?.message ?? err);
    await message.reply("Something went wrong while updating trader status.").catch(() => null);
    return true;
  }
}

client.on("messageCreate", async (message) => {
  await handleTraderStatusCommand(message);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const cmd = interaction.commandName;

  try {
    if ((cmd === "xflagged" || cmd === "xtrust") && !isStaff(interaction)) {
      await interaction.reply({
        content: "You donâ€™t have permission to use that command.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply();

    if (cmd === "xtrust") {
      const action = (interaction.options.getString("action", true) ?? "").toLowerCase();
      const input = interaction.options.getString("gamertag") ?? "";

      if (action === "list") {
        const lines = Object.entries(state.trusted || {})
          .map(([k, v]) => v?.gamertag || k)
          .sort((a, b) => a.localeCompare(b));

        const embeds = buildListEmbeds(
          `Trusted Gamertags â€¢ ${lines.length}`,
          lines.length ? lines : ["No trusted gamertags saved."],
          0x00ff00
        );

        await interaction.editReply({ embeds: [embeds[0]] });

        for (let i = 1; i < embeds.length; i++) {
          await interaction.followUp({ embeds: [embeds[i]] });
        }

        return;
      }

      const gts = parseGamertagList(input);

      if (!gts.length) {
        await interaction.editReply("You must provide gamertag(s) for add/remove. Separate multiple with commas.");
        return;
      }

      if (action === "add") {
        let added = 0;
        let removedFromFlagged = 0;
        let already = 0;

        const addedList = [];
        const alreadyList = [];

        for (const gt of gts) {
          const k = gtKey(gt);

          if (!k) continue;

          if (isTrustedKey(k)) {
            already++;
            alreadyList.push(trustedDisplayForKey(k));
            continue;
          }

          const res = trustGamertag(gt);

          if (res.ok) {
            added++;
            addedList.push(res.display);

            if (res.removedFlagged) removedFromFlagged++;
          }
        }

        const embed = new EmbedBuilder()
          .setTitle("Trusted Update")
          .setColor(0x00ff00)
          .addFields(
            { name: "Added", value: String(added), inline: true },
            { name: "Removed from flagged", value: String(removedFromFlagged), inline: true },
            { name: "Already trusted", value: String(already), inline: true }
          )
          .setTimestamp();

        if (addedList.length) {
          embed.addFields({
            name: "Added Gamertags",
            value: addedList.join("\n").slice(0, 1024),
            inline: false,
          });
        }

        if (alreadyList.length) {
          embed.addFields({
            name: "Already Trusted",
            value: alreadyList.join("\n").slice(0, 1024),
            inline: false,
          });
        }

        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (action === "remove") {
        let removed = 0;
        let notFound = 0;

        const removedList = [];
        const notFoundList = [];

        for (const gt of gts) {
          const k = gtKey(gt);

          if (!k) continue;

          if (!isTrustedKey(k)) {
            notFound++;
            notFoundList.push(gt);
            continue;
          }

          const res = untrustGamertag(gt);

          if (res.ok) {
            removed++;
            removedList.push(res.display);
          }
        }

        const embed = new EmbedBuilder()
          .setTitle("Trusted Update")
          .setColor(0xffcc00)
          .addFields(
            { name: "Removed", value: String(removed), inline: true },
            { name: "Not trusted", value: String(notFound), inline: true }
          )
          .setTimestamp();

        if (removedList.length) {
          embed.addFields({
            name: "Removed Gamertags",
            value: removedList.join("\n").slice(0, 1024),
            inline: false,
          });
        }

        if (notFoundList.length) {
          embed.addFields({
            name: "Not Trusted",
            value: notFoundList.join("\n").slice(0, 1024),
            inline: false,
          });
        }

        await interaction.editReply({ embeds: [embed] });
        return;
      }

      await interaction.editReply("Invalid action. Use add/remove/list.");
      return;
    }

    if (cmd === "xflagged") {
      const scope = (interaction.options.getString("scope") ?? "pending").toLowerCase();

      const items = scope === "pending"
        ? Array.from(state.pending.entries())
            .map(([k, v]) => ({ k, ...v }))
            .filter((x) => !isTrustedKey(x.k))
            .sort((a, b) => (a.gamertag || "").localeCompare(b.gamertag || ""))
        : Array.from(state.flaggedAll.entries())
            .map(([k, v]) => ({ k, ...v }))
            .filter((x) => !isTrustedKey(x.k))
            .sort((a, b) => (a.gamertag || "").localeCompare(b.gamertag || ""));

      const lines = scope === "pending"
        ? items.map((x) => x.gamertag)
        : items.map((x) =>
            `${x.gamertag}${Number.isFinite(x.lastKnownGS) ? ` (${x.lastKnownGS})` : ""}`
          );

      const embeds = buildListEmbeds(
        `Flagged (${scope === "pending" ? "Pending" : "All-Time"}) â€¢ ${lines.length}`,
        lines.length ? lines : ["No entries."],
        0xff0000
      );

      await interaction.editReply({ embeds: [embeds[0]] });

      for (let i = 1; i < embeds.length; i++) {
        await interaction.followUp({ embeds: [embeds[i]] });
      }

      return;
    }

    const gamertagInput = normalizeGamertag(interaction.options.getString("gamertag", true));
    const merged = await fetchOpenXblMergedProfile(gamertagInput);
    const flaggedByGS = merged.gamerscore !== null ? merged.gamerscore < GS_THRESHOLD : false;

    if (cmd === "xcheck") {
      const embed = new EmbedBuilder()
        .setTitle("Xbox Gamerscore Check")
        .setColor(flaggedByGS ? 0xff0000 : 0x00ff00)
        .setTimestamp();

      addFieldIf(embed, "Gamertag", merged.gamertag, true);

      if (merged.gamerscore !== null) {
        addFieldIf(embed, "Gamerscore", String(merged.gamerscore), true);
      }

      addFieldIf(embed, "Result", flaggedByGS ? "FLAGGED" : "OK", false);
      addFieldIf(embed, "Tier", merged.tier ? String(merged.tier) : "", true);

      if (merged.gamerpic) embed.setThumbnail(merged.gamerpic);

      await interaction.editReply({ embeds: [embed] });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle("Xbox Profile Info")
      .setColor(flaggedByGS ? 0xff4d4d : 0x2b2d31)
      .setTimestamp();

    if (merged.gamerpic) embed.setThumbnail(merged.gamerpic);

    addFieldIf(embed, "Gamertag", merged.gamertag, true);
    addFieldIf(embed, "XUID", merged.xuid ? String(merged.xuid) : "", true);

    if (merged.gamerscore !== null) {
      addFieldIf(embed, "Gamerscore", String(merged.gamerscore), true);
    }

    addFieldIf(embed, "Account Tier", merged.tier ? String(merged.tier) : "", true);
    addFieldIf(embed, "Xbox Rep", merged.xboxRep ? String(merged.xboxRep) : "", true);
    addFieldIf(embed, "Presence", merged.presenceState ? String(merged.presenceState) : "", true);
    addFieldIf(embed, "Status", merged.presenceText ? String(merged.presenceText) : "", true);
    addFieldIf(embed, "Last Seen", merged.lastSeen ? String(merged.lastSeen) : "", false);
    addFieldIf(embed, "Bio", merged.bio ? String(merged.bio) : "", false);
    addFieldIf(embed, "Location", merged.location ? String(merged.location) : "", true);
    addFieldIf(embed, "Tenure", merged.tenure ? String(merged.tenure) : "", true);

    if (merged.hasGamePass === true || merged.hasGamePass === false) {
      addFieldIf(embed, "Game Pass", formatBool(merged.hasGamePass), true);
    } else if (typeof merged.hasGamePass === "string" && merged.hasGamePass.trim() !== "") {
      addFieldIf(embed, "Game Pass", merged.hasGamePass.trim(), true);
    }

    if (typeof merged.followerCount === "number") {
      addFieldIf(embed, "Followers", String(merged.followerCount), true);
    }

    if (typeof merged.followingCount === "number") {
      addFieldIf(embed, "Following", String(merged.followingCount), true);
    }

    if (typeof merged.friendCount === "number") {
      addFieldIf(embed, "Friends", String(merged.friendCount), true);
    }

    embed.setFooter({ text: "Note: Some fields may be unavailable due to Xbox privacy settings." });

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error("interaction error:", err?.message ?? err);

    const msg = err instanceof RateLimitError
      ? "OpenXBL is rate limiting requests right now. Try again in a couple minutes."
      : "Something went wrong while processing that request.";

    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(msg);
      } else {
        await interaction.reply({
          content: msg,
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch {}
  }
});

client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  await autoDeployCommandsIfEnabled().catch((e) =>
    console.error("[COMMANDS] deploy error:", e?.message ?? e)
  );

  await pollOnlineList().catch((e) => console.error("[POLL] error:", e));

  setInterval(() => {
    pollOnlineList().catch((e) => console.error("[POLL] error:", e));
  }, POLL_SECONDS * 1000);

  setInterval(() => {
    sendDigestIfDue().catch((e) => console.error("[DIGEST] error:", e));
  }, 60 * 1000);

  await sendDigestIfDue().catch((e) => console.error("[DIGEST] error:", e));
});

client.login(DISCORD_TOKEN);




