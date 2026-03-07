import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  PermissionsBitField,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import fetch from "node-fetch";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// ENV
const DISCORD_TOKEN = (process.env.DISCORD_TOKEN ?? "").trim();
const DISCORD_CLIENT_ID = (process.env.DISCORD_CLIENT_ID ?? "").trim();
const GUILD_ID = (process.env.GUILD_ID ?? "").trim();
const COMMANDS_AUTO_DEPLOY =
  (process.env.COMMANDS_AUTO_DEPLOY ?? "false").trim().toLowerCase() === "true";

const XBL_API_KEY = (process.env.XBL_API_KEY ?? "").trim();

const GS_THRESHOLD = Number.parseInt((process.env.GS_THRESHOLD ?? "2500").trim(), 10);
const ONLINE_LIST_CHANNEL_ID = (process.env.ONLINE_LIST_CHANNEL_ID ?? "").trim();
const MODLOG_CHANNEL_ID = (process.env.MODLOG_CHANNEL_ID ?? "").trim();

const DIGEST_CHANNEL_ID = (process.env.DIGEST_CHANNEL_ID ?? MODLOG_CHANNEL_ID).trim();
const DIGEST_INTERVAL_HOURS = Number.parseInt((process.env.DIGEST_INTERVAL_HOURS ?? "1").trim(), 10);

const SCRUB_DELAY_MS = Number.parseInt((process.env.SCRUB_DELAY_MS ?? "4000").trim(), 10);
const POLL_SECONDS = Number.parseInt((process.env.POLL_SECONDS ?? "180").trim(), 10);

const DATA_DIR = (process.env.DATA_DIR ?? "./data").trim();
const IMMEDIATE_FLAG_LOGS =
  (process.env.IMMEDIATE_FLAG_LOGS ?? "false").trim().toLowerCase() === "true";
const RESET_STATE = (process.env.RESET_STATE ?? "").trim().toLowerCase() === "true";
const STAFF_ROLE_ID = (process.env.STAFF_ROLE_ID ?? "").trim();

const XBL_MAX_RETRIES = Number.parseInt((process.env.XBL_MAX_RETRIES ?? "5").trim(), 10);
const XBL_BACKOFF_BASE_MS = Number.parseInt((process.env.XBL_BACKOFF_BASE_MS ?? "4000").trim(), 10);
const XBL_BACKOFF_MAX_MS = Number.parseInt((process.env.XBL_BACKOFF_MAX_MS ?? "60000").trim(), 10);

const TRADER_PRICE_JSON_PATH = (process.env.TRADER_PRICE_JSON_PATH ?? "trader_prices.json").trim();

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

process.on("unhandledRejection", (err) => console.error("Unhandled rejection:", err));
process.on("uncaughtException", (err) => console.error("Uncaught exception:", err));

console.log("Booting 3xBot...");
console.log(`TRADER_PRICE_JSON_PATH=${TRADER_PRICE_JSON_PATH}`);

fs.mkdirSync(DATA_DIR, { recursive: true });
const STATE_FILE = path.resolve(DATA_DIR, "state.json");

function nowMs() { return Date.now(); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function normalizeGamertag(s) { return (s ?? "").replace(/\s+/g, " ").trim(); }
function gtKey(s) { return normalizeGamertag(s).toLowerCase(); }
function stripMarkdown(s) {
  return (s ?? "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1").replace(/`(.+?)`/g, "$1").trim();
}
function normalizeTextKey(s) {
  return (s ?? "").toString().trim().toLowerCase().replace(/[_\-]+/g, " ").replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
}
function formatMoney(n) {
  if (n === null || n === undefined) return "N/A";
  const x = Number(n);
  if (!Number.isFinite(x)) return "N/A";
  return x.toLocaleString("en-US");
}
function parseGamertagList(input) {
  const raw = (input ?? "").trim();
  if (!raw) return [];
  return raw.split(",").map((x) => normalizeGamertag(x)).filter((x) => x.length >= 2 && x.length <= 20);
}
function parseTradeItems(input) {
  const raw = (input ?? "").trim();
  if (!raw) return [];
  return raw.split(",").map((chunk) => chunk.trim()).filter(Boolean).map((chunk) => {
    const m = chunk.match(/^\s*(\d+)\s*(?:x|×)?\s*(.+?)\s*$/i);
    if (m) return { qty: Math.max(1, Number.parseInt(m[1], 10) || 1), name: (m[2] ?? "").trim() };
    return { qty: 1, name: chunk };
  }).filter((x) => x.name.length > 0);
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
    if (parsed?.trusted && typeof parsed.trusted === "object" && !Array.isArray(parsed.trusted)) trusted = parsed.trusted;
    const normalizedTrusted = {};
    for (const [k, v] of Object.entries(trusted || {})) {
      const kk = String(k ?? "").trim().toLowerCase();
      if (!kk) continue;
      const gt = normalizeGamertag(v?.gamertag ?? "");
      if (!gt) continue;
      normalizedTrusted[kk] = { gamertag: gt, addedMs: Number.parseInt(String(v?.addedMs ?? ""), 10) || nowMs() };
    }
    return { checked, pending, lastDigestMs, flaggedAll, trusted: normalizedTrusted };
  } catch {
    return { checked: new Set(), pending: new Map(), lastDigestMs: 0, flaggedAll: new Map(), trusted: {} };
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
  }, null, 2), "utf8");
}

let state = loadState();
if (RESET_STATE) {
  state = { checked: new Set(), pending: new Map(), lastDigestMs: 0, trusted: {}, flaggedAll: new Map() };
  saveState();
}
function isTrustedKey(k) { return !!state.trusted?.[k]; }
function trustedDisplayForKey(k) { return state.trusted?.[k]?.gamertag || k; }

let TRADER = {
  loaded: false,
  categories: [],
  itemsByKey: new Map(),
  itemsByCategory: new Map(),
  allItems: [],
};

function normalizeTraderItem(raw, fallbackKey = "") {
  const name = raw?.name ?? raw?.item ?? fallbackKey;
  return {
    key: raw?.key ?? normalizeTextKey(name),
    item: name,
    category: raw?.category ?? "Uncategorized",
    buy: raw?.buy ?? null,
    sell: raw?.sell ?? null,
    unit: raw?.unit ?? raw?.unit_note ?? null,
    notes: raw?.notes ?? null,
  };
}

function loadTraderJson() {
  try {
    const p = path.resolve(TRADER_PRICE_JSON_PATH);
    if (!fs.existsSync(p)) {
      console.log("[TRADER] missing JSON");
      TRADER.loaded = false;
      return;
    }
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    const itemsByKey = new Map();
    const itemsByCategory = new Map();
    const seen = new Set();

    for (const [k, v] of Object.entries(parsed?.items_by_key ?? {})) {
      const item = normalizeTraderItem(v, k);
      itemsByKey.set(item.key, item);
      seen.add(item.key);
    }
    for (const [cat, arr] of Object.entries(parsed?.items_by_category ?? {})) {
      if (!Array.isArray(arr)) continue;
      const items = arr.map((x) => normalizeTraderItem(x)).sort((a, b) => a.item.localeCompare(b.item));
      itemsByCategory.set(cat, items);
      for (const item of items) {
        if (!seen.has(item.key)) {
          itemsByKey.set(item.key, item);
          seen.add(item.key);
        }
      }
    }
    const categories = Array.isArray(parsed?.categories) && parsed.categories.length ? parsed.categories : Array.from(itemsByCategory.keys()).sort((a,b)=>a.localeCompare(b));
    TRADER = { loaded: true, categories, itemsByKey, itemsByCategory, allItems: Array.from(itemsByKey.values()).sort((a,b)=>a.item.localeCompare(b.item)) };
  } catch (e) {
    console.error("[TRADER] load error", e?.message ?? e);
    TRADER.loaded = false;
  }
}
loadTraderJson();

function findTraderItem(query) {
  if (!TRADER.loaded) return null;
  const q = normalizeTextKey(query);
  if (!q) return null;
  if (TRADER.itemsByKey.has(q)) return TRADER.itemsByKey.get(q);
  for (const item of TRADER.allItems) if (normalizeTextKey(item.item) === q) return item;
  for (const item of TRADER.allItems) if (normalizeTextKey(item.item).startsWith(q)) return item;
  const hits = TRADER.allItems.filter((item) => {
    const k = normalizeTextKey(item.item);
    return k.includes(q) || q.includes(k);
  });
  if (!hits.length) return null;
  hits.sort((a,b)=>normalizeTextKey(a.item).length - normalizeTextKey(b.item).length);
  return hits[0];
}

function searchTraderItems(query, limit = 100) {
  if (!TRADER.loaded) return [];
  const q = normalizeTextKey(query);
  if (!q) return TRADER.allItems.slice(0, limit);
  const scored = [];
  for (const item of TRADER.allItems) {
    const key = normalizeTextKey(item.item);
    let score = 0;
    if (key === q) score = 100;
    else if (key.startsWith(q)) score = 80;
    else if (key.includes(q)) score = 60;
    else continue;
    scored.push({ item, score, len: key.length });
  }
  scored.sort((a,b)=>b.score-a.score || a.len-b.len || a.item.item.localeCompare(b.item.item));
  return scored.slice(0, limit).map((x)=>x.item);
}

function buildPriceEmbed(item, opts = {}) {
  const e = new EmbedBuilder().setTitle(opts.title ?? "Trader Price").setColor(0x2b2d31).setTimestamp();
  e.setDescription(`**${item.item}**\nCategory: **${item.category}**`);
  const lines = [`🟢 **Buy:** $${formatMoney(item.buy)}`, `🔴 **Sell:** $${formatMoney(item.sell)}`];
  if (item.unit) lines.push(`📦 **Unit:** ${item.unit}`);
  if (item.notes) lines.push(`📝 **Notes:** ${item.notes}`);
  e.addFields({ name: "Prices", value: lines.join("\n"), inline: false });
  return e;
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
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
    new SlashCommandBuilder().setName("xcheck").setDescription("Check an Xbox gamertag's gamerscore against the configured threshold.")
      .addStringOption((opt) => opt.setName("gamertag").setDescription("Xbox gamertag").setRequired(true)),
    new SlashCommandBuilder().setName("xinfo").setDescription("Fetch detailed Xbox profile info (only shows fields that are available).")
      .addStringOption((opt) => opt.setName("gamertag").setDescription("Xbox gamertag").setRequired(true)),
    new SlashCommandBuilder().setName("xflagged").setDescription("Show low-gamerscore gamertags saved by the bot.")
      .addStringOption((opt) => opt.setName("scope").setDescription("pending = since last digest; all = all-time saved")
        .addChoices({ name: "pending", value: "pending" }, { name: "all", value: "all" }).setRequired(false)),
    new SlashCommandBuilder().setName("xtrust").setDescription("Manage trusted gamertags (whitelist). You can add/remove multiple separated by commas.")
      .addStringOption((opt) => opt.setName("action").setDescription("add/remove/list")
        .addChoices({ name: "add", value: "add" }, { name: "remove", value: "remove" }, { name: "list", value: "list" }).setRequired(true))
      .addStringOption((opt) => opt.setName("gamertag").setDescription("Gamertag(s).").setRequired(false)),
    new SlashCommandBuilder().setName("price").setDescription("Open trader price menus (shop style)."),
    new SlashCommandBuilder().setName("pricesearch").setDescription("Search the trader list by name.")
      .addStringOption((opt) => opt.setName("query").setDescription("Search text").setRequired(true)),
    new SlashCommandBuilder().setName("pricecategory").setDescription("Browse a trader category.")
      .addStringOption((opt) => opt.setName("category").setDescription("Category name").setRequired(true)),
    new SlashCommandBuilder().setName("tradecalc").setDescription("Calculator for bulk buys/sells. Use commas between items.")
      .addStringOption((opt) => opt.setName("mode").setDescription("buy = cost, sell = payout, net = sell minus buy")
        .addChoices({ name: "buy", value: "buy" }, { name: "sell", value: "sell" }, { name: "net", value: "net" }).setRequired(true))
      .addStringOption((opt) => opt.setName("items").setDescription("Example: 3 four dials,1 bottled suppressor,2 vs89 mags").setRequired(true)),
    new SlashCommandBuilder().setName("shop").setDescription("Open the trader cart/shop UI."),
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
  } finally { clearTimeout(timer); }
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
  const { res, data } = await fetchJsonWithTimeout(url, { method: "GET", headers: { "X-Authorization": XBL_API_KEY, Accept: "application/json" } }, 8000);
  if (res.status === 429) throw new RateLimitError("OpenXBL rate limited (HTTP 429)", parseRetryAfterMs(res));
  if (!res.ok) throw new Error(data?.error || data?.message || `OpenXBL request failed (HTTP ${res.status})`);
  return data;
}
async function openXblFetchWithRetry(url) {
  let attempt = 0;
  while (true) {
    try { return await openXblFetchJson(url); }
    catch (err) {
      if (err instanceof RateLimitError) {
        attempt += 1;
        if (attempt > XBL_MAX_RETRIES) throw err;
        const backoff = Math.min(XBL_BACKOFF_MAX_MS, err.retryAfterMs ?? XBL_BACKOFF_BASE_MS * Math.pow(2, attempt - 1));
        await sleep(backoff);
        continue;
      }
      throw err;
    }
  }
}
async function openXblSearch(gamertag) {
  const wanted = normalizeGamertag(gamertag);
  const data = await openXblFetchWithRetry(`https://xbl.io/api/v2/search/${encodeURIComponent(wanted)}`);
  const people = data?.people;
  if (!Array.isArray(people) || !people.length) throw new Error("Gamertag not found.");
  const wantedLower = wanted.toLowerCase();
  const best = people.find((p) => (p?.gamertag ?? "").toLowerCase() === wantedLower)
    || people.find((p) => (p?.modernGamertag ?? "").toLowerCase() === wantedLower)
    || people[0];
  if (!best?.xuid) throw new Error("Search result missing XUID.");
  return best;
}
async function openXblAccount(xuid) {
  return await openXblFetchWithRetry(`https://xbl.io/api/v2/account/${encodeURIComponent(xuid)}`);
}
function settingsToMap(settingsArr) {
  const map = new Map();
  if (!Array.isArray(settingsArr)) return map;
  for (const s of settingsArr) if (typeof s?.id === "string") map.set(s.id, s.value ?? null);
  return map;
}
function readSetting(map, ...keys) {
  for (const k of keys) if (map.has(k)) return map.get(k);
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
  const settingsMap = settingsToMap(accData?.profileUsers?.[0]?.settings);
  const socialNums = deepFindNumbers({ person, accData }, new Set(["followerscount", "followercount", "followingcount", "friendscount", "friendcount"]));
  return {
    gamertag: readSetting(settingsMap, "Gamertag") || person.gamertag || normalizeGamertag(gamertag),
    xuid: person.xuid,
    gamerscore: parseIntOrNull(readSetting(settingsMap, "Gamerscore")) ?? parseIntOrNull(person.gamerscore) ?? null,
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
    line = line.replace(/^[•\-]+\s*/, "").trim();
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
  if (!p) state.pending.set(k, { gamertag: profile.gamertag, gamerscore: profile.gamerscore ?? 0, firstSeenMs: t, lastSeenMs: t });
  else {
    p.gamertag = profile.gamertag;
    if (profile.gamerscore !== null && profile.gamerscore !== undefined) p.gamerscore = profile.gamerscore;
    p.lastSeenMs = t;
  }
  const a = state.flaggedAll.get(k);
  if (!a) state.flaggedAll.set(k, { gamertag: profile.gamertag, lastKnownGS: profile.gamerscore ?? 0, firstSeenMs: t, lastSeenMs: t });
  else {
    a.gamertag = profile.gamertag;
    if (profile.gamerscore !== null && profile.gamerscore !== undefined) a.lastKnownGS = profile.gamerscore;
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
    } else current += add;
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
  const items = Array.from(state.pending.entries()).map(([k,v])=>({k,...v})).filter((v)=>(v?.lastSeenMs ?? 0) >= cutoff).filter((v)=>!isTrustedKey(v.k)).sort((a,b)=>(a.gamertag||"").localeCompare(b.gamertag||""));
  const digestChan = await client.channels.fetch(DIGEST_CHANNEL_ID).catch(()=>null);
  if (!digestChan || !digestChan.guild) return;
  if (!items.length) {
    state.lastDigestMs = now;
    state.pending = new Map();
    saveState();
    return;
  }
  const lines = items.map((v)=>v.gamertag);
  const chunks = chunkLines(lines, 3500);
  for (let i=0;i<chunks.length;i++) {
    const embed = new EmbedBuilder().setTitle(`Low Gamerscore Watchlist (Last ${DIGEST_INTERVAL_HOURS}h)`).setDescription(chunks[i]).addFields({name:"Threshold", value:`< ${GS_THRESHOLD}`, inline:true}, {name:"Count", value:String(items.length), inline:true}).setColor(0xff0000).setTimestamp();
    if (chunks.length > 1) embed.setFooter({ text: `Page ${i+1}/${chunks.length}` });
    await sendEmbedToChannel(digestChan.guild, DIGEST_CHANNEL_ID, embed);
  }
  state.lastDigestMs = now;
  state.pending = new Map();
  saveState();
}
async function pollOnlineList() {
  if (!ONLINE_LIST_CHANNEL_ID) return;
  const channel = await client.channels.fetch(ONLINE_LIST_CHANNEL_ID).catch(()=>null);
  if (!channel || !("messages" in channel)) return;
  const messages = await channel.messages.fetch({ limit: 5 }).catch(()=>null);
  const newest = messages?.first();
  if (!newest) return;
  const gts = extractGamertagsFromEmbeds(newest);
  for (const gt of gts) enqueueGamertag(gt, newest.guild);
}

const queue = [];
const queuedKeys = new Set();
let working = false;
let globalCooldownUntilMs = 0;
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
      if (globalCooldownUntilMs > now) await sleep(globalCooldownUntilMs - now);
      try {
        const merged = await fetchOpenXblMergedProfile(item.gt);
        state.checked.add(item.k);
        saveState();
        const gs = merged.gamerscore;
        if (gs !== null && gs < GS_THRESHOLD) {
          addFlagged({ gamertag: merged.gamertag, gamerscore: gs });
          if (IMMEDIATE_FLAG_LOGS && item.guild && MODLOG_CHANNEL_ID) {
            const embed = new EmbedBuilder().setTitle("XCHECK FLAGGED").addFields(
              { name: "Gamertag", value: merged.gamertag, inline: true },
              { name: "Gamerscore", value: String(gs), inline: true },
              { name: "Result", value: "FLAGGED", inline: false }
            ).setColor(0xff0000).setTimestamp();
            if (merged.tier) embed.addFields({ name: "Tier", value: String(merged.tier), inline: true });
            if (merged.gamerpic) embed.setThumbnail(merged.gamerpic);
            await sendEmbedToChannel(item.guild, MODLOG_CHANNEL_ID, embed);
          }
        }
      } catch (err) {
        if (err instanceof RateLimitError) {
          const backoff = Math.min(XBL_BACKOFF_MAX_MS, err.retryAfterMs ?? XBL_BACKOFF_BASE_MS);
          globalCooldownUntilMs = nowMs() + backoff;
          await sleep(Math.min(backoff, 15000));
          enqueueGamertag(item.gt, item.guild);
        } else {
          console.error(`[ERROR] ${item.gt}:`, err?.message ?? err);
        }
      }
      if (SCRUB_DELAY_MS > 0) await sleep(SCRUB_DELAY_MS);
    }
  } finally { working = false; }
}

function buildListEmbeds(title, lines, color = 0x2b2d31) {
  const chunks = chunkLines(lines, 3500);
  return chunks.map((chunk, i) => {
    const e = new EmbedBuilder().setTitle(title).setDescription(chunk || "—").setColor(color).setTimestamp();
    if (chunks.length > 1) e.setFooter({ text: `Page ${i+1}/${chunks.length}` });
    return e;
  });
}

const UI_SESSIONS = new Map();
const SHOP_CARTS = new Map();
const UI_TTL_MS = 10 * 60 * 1000;
function purgeSessions() {
  const now = nowMs();
  for (const [sid, s] of UI_SESSIONS.entries()) if (!s || now - (s.createdMs ?? 0) > UI_TTL_MS) UI_SESSIONS.delete(sid);
}
setInterval(purgeSessions, 60 * 1000).unref?.();
function getCart(userId) {
  if (!SHOP_CARTS.has(userId)) SHOP_CARTS.set(userId, []);
  return SHOP_CARTS.get(userId);
}
function clearCart(userId) { SHOP_CARTS.delete(userId); }
function addCartLine(userId, item, mode, qty) {
  const cart = getCart(userId);
  const existing = cart.find((x)=>x.key===item.key && x.mode===mode);
  if (existing) existing.qty += qty;
  else cart.push({ key:item.key, item:item.item, category:item.category, buy:item.buy, sell:item.sell, mode, qty });
}
function cartTotals(cart) {
  let buyTotal = 0, sellTotal = 0;
  for (const line of cart) {
    if (line.mode === "buy" && line.buy !== null && line.buy !== undefined) buyTotal += Number(line.buy) * Number(line.qty);
    if (line.mode === "sell" && line.sell !== null && line.sell !== undefined) sellTotal += Number(line.sell) * Number(line.qty);
  }
  return { buyTotal, sellTotal, net: sellTotal - buyTotal };
}
function buildCartEmbed(userId) {
  const cart = getCart(userId);
  const totals = cartTotals(cart);
  const e = new EmbedBuilder().setTitle("Trader Cart").setColor(0x2b2d31).setTimestamp();
  if (!cart.length) {
    e.setDescription("Your cart is empty.");
    return e;
  }
  e.setDescription(cart.map((line)=>`• **${line.qty}x ${line.item}** — ${line.mode.toUpperCase()} @ $${formatMoney(line.mode==="buy"?line.buy:line.sell)}`).join("\n"));
  e.addFields(
    { name: "Buy Total", value: `$${formatMoney(totals.buyTotal)}`, inline: true },
    { name: "Sell Total", value: `$${formatMoney(totals.sellTotal)}`, inline: true },
    { name: "Net", value: `$${formatMoney(totals.net)}`, inline: true }
  );
  return e;
}
function traderItemOptions(items, offset = 0, max = 25) {
  return items.slice(offset, offset+max).map((item)=>({
    label: item.item.slice(0,100),
    value: item.key,
    description: `Buy $${formatMoney(item.buy)} • Sell $${formatMoney(item.sell)}`.slice(0, 100),
  }));
}
function shopControlsRow(sessionId, qty) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`shopqty:dec:${sessionId}`).setLabel("-1").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`shopqty:inc:${sessionId}`).setLabel("+1").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`shopmode:buy:${sessionId}`).setLabel("Buy").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`shopmode:sell:${sessionId}`).setLabel("Sell").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`shopadd:${sessionId}:${qty}`).setLabel(`Add ${qty}`).setStyle(ButtonStyle.Primary),
  );
}
function shopUtilityRow(sessionId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`shopcart:view:${sessionId}`).setLabel("View Cart").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`shopcart:checkout:${sessionId}`).setLabel("Checkout").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`shopcart:clear:${sessionId}`).setLabel("Clear Cart").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`shopback:${sessionId}`).setLabel("Back").setStyle(ButtonStyle.Secondary),
  );
}
function searchPagerRow(sessionId, page, pageCount, prefix) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${prefix}:prev:${sessionId}:${page}`).setLabel("Prev").setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
    new ButtonBuilder().setCustomId(`${prefix}:next:${sessionId}:${page}`).setLabel("Next").setStyle(ButtonStyle.Secondary).setDisabled(page >= pageCount - 1),
  );
}
function paginateArray(arr, page, perPage) {
  const total = arr.length;
  const pageCount = Math.max(1, Math.ceil(total / perPage));
  const p = Math.max(0, Math.min(page, pageCount - 1));
  return { page: p, pageCount, slice: arr.slice(p * perPage, p * perPage + perPage), total };
}
function buildSearchResultsEmbed(query, items, page, pageCount) {
  return new EmbedBuilder().setTitle(`Trader Search: ${query}`).setColor(0x2b2d31).setTimestamp().setDescription(
    items.length ? items.map((it)=>`• **${it.item}** — ${it.category}\n  Buy: $${formatMoney(it.buy)} • Sell: $${formatMoney(it.sell)}`).join("\n") : "No matches."
  ).setFooter({ text: `Page ${page+1}/${pageCount}` });
}
function buildCategoryEmbed(category, items, page, pageCount) {
  return new EmbedBuilder().setTitle(`Category: ${category}`).setColor(0x2b2d31).setTimestamp().setDescription(
    items.length ? items.map((it)=>`• **${it.item}**\n  Buy: $${formatMoney(it.buy)} • Sell: $${formatMoney(it.sell)}`).join("\n") : "No items."
  ).setFooter({ text: `Page ${page+1}/${pageCount}` });
}

client.on("interactionCreate", async (interaction) => {
  if (interaction.isButton()) {
    try {
      const parts = String(interaction.customId ?? "").split(":");
      const prefix = parts[0];

      if (prefix === "psearch" || prefix === "pcat") {
        const dir = parts[1], sessionId = parts[2], oldPage = Number.parseInt(parts[3] ?? "0", 10) || 0;
        const s = UI_SESSIONS.get(sessionId);
        if (!s) return await interaction.reply({ content: "That menu expired. Run the command again.", ephemeral: true });
        if (s.userId !== interaction.user.id) return await interaction.reply({ content: "That menu isn’t yours.", ephemeral: true });
        const page = dir === "next" ? oldPage + 1 : oldPage - 1;
        if (prefix === "psearch" && s.type === "search") {
          const { page: p, pageCount, slice } = paginateArray(s.results, page, 8);
          return await interaction.update({ embeds: [buildSearchResultsEmbed(s.query, slice, p, pageCount)], components: [searchPagerRow(sessionId, p, pageCount, "psearch")] });
        }
        if (prefix === "pcat" && s.type === "category") {
          const { page: p, pageCount, slice } = paginateArray(s.items, page, 8);
          return await interaction.update({ embeds: [buildCategoryEmbed(s.category, slice, p, pageCount)], components: [searchPagerRow(sessionId, p, pageCount, "pcat")] });
        }
      }

      if (prefix.startsWith("shop")) {
        const action = parts[0];
        if (action === "shopqty") {
          const dir = parts[1], sessionId = parts[2];
          const s = UI_SESSIONS.get(sessionId);
          if (!s) return await interaction.reply({ content: "That shop expired. Run /shop again.", ephemeral: true });
          if (s.userId !== interaction.user.id) return await interaction.reply({ content: "That shop isn’t yours.", ephemeral: true });
          s.qty = Math.max(1, (s.qty ?? 1) + (dir === "inc" ? 1 : -1));
          const item = s.selectedKey ? TRADER.itemsByKey.get(s.selectedKey) : null;
          const embed = item ? buildPriceEmbed(item, { title: `Shop • ${s.mode?.toUpperCase?.() || "BUY"} • Qty ${s.qty}` }) : new EmbedBuilder().setTitle("Trader Shop").setDescription("Pick an item.").setColor(0x2b2d31);
          return await interaction.update({ embeds: [embed], components: item ? [shopControlsRow(sessionId, s.qty), shopUtilityRow(sessionId)] : [shopUtilityRow(sessionId)] });
        }
        if (action === "shopmode") {
          const mode = parts[1], sessionId = parts[2];
          const s = UI_SESSIONS.get(sessionId);
          if (!s) return await interaction.reply({ content: "That shop expired. Run /shop again.", ephemeral: true });
          if (s.userId !== interaction.user.id) return await interaction.reply({ content: "That shop isn’t yours.", ephemeral: true });
          s.mode = mode;
          const item = s.selectedKey ? TRADER.itemsByKey.get(s.selectedKey) : null;
          const embed = item ? buildPriceEmbed(item, { title: `Shop • ${mode.toUpperCase()} • Qty ${s.qty ?? 1}` }) : new EmbedBuilder().setTitle("Trader Shop").setDescription("Pick an item.").setColor(0x2b2d31);
          return await interaction.update({ embeds: [embed], components: item ? [shopControlsRow(sessionId, s.qty ?? 1), shopUtilityRow(sessionId)] : [shopUtilityRow(sessionId)] });
        }
        if (action === "shopadd") {
          const sessionId = parts[1], qty = Number.parseInt(parts[2] ?? "1", 10) || 1;
          const s = UI_SESSIONS.get(sessionId);
          if (!s) return await interaction.reply({ content: "That shop expired. Run /shop again.", ephemeral: true });
          if (s.userId !== interaction.user.id) return await interaction.reply({ content: "That shop isn’t yours.", ephemeral: true });
          const item = s.selectedKey ? TRADER.itemsByKey.get(s.selectedKey) : null;
          if (!item) return await interaction.reply({ content: "Pick an item first.", ephemeral: true });
          addCartLine(interaction.user.id, item, s.mode ?? "buy", qty);
          return await interaction.reply({ embeds: [buildCartEmbed(interaction.user.id)], ephemeral: true });
        }
        if (action === "shopcart") {
          const sub = parts[1], sessionId = parts[2];
          const s = UI_SESSIONS.get(sessionId);
          if (!s) return await interaction.reply({ content: "That shop expired. Run /shop again.", ephemeral: true });
          if (s.userId !== interaction.user.id) return await interaction.reply({ content: "That shop isn’t yours.", ephemeral: true });
          if (sub === "view") return await interaction.reply({ embeds: [buildCartEmbed(interaction.user.id)], ephemeral: true });
          if (sub === "clear") {
            clearCart(interaction.user.id);
            return await interaction.reply({ content: "Your cart was cleared.", ephemeral: true });
          }
          if (sub === "checkout") {
            const embed = buildCartEmbed(interaction.user.id).setTitle("Trader Checkout");
            clearCart(interaction.user.id);
            return await interaction.reply({ embeds: [embed] });
          }
        }
        if (action === "shopback") {
          const sessionId = parts[1];
          const s = UI_SESSIONS.get(sessionId);
          if (!s) return await interaction.reply({ content: "That shop expired. Run /shop again.", ephemeral: true });
          if (s.userId !== interaction.user.id) return await interaction.reply({ content: "That shop isn’t yours.", ephemeral: true });
          const category = s.category ?? TRADER.categories[0];
          const items = (TRADER.itemsByCategory.get(category) ?? []).slice().sort((a,b)=>a.item.localeCompare(b.item));
          const itemSelect = new StringSelectMenuBuilder().setCustomId(`shopitem:${sessionId}`).setPlaceholder("Pick an item…").addOptions(traderItemOptions(items, 0, 25));
          const catSelect = new StringSelectMenuBuilder().setCustomId(`shopcat:${sessionId}`).setPlaceholder("Pick a category…").addOptions(TRADER.categories.slice(0,25).map((c)=>({label:c.slice(0,100), value:c})));
          const embed = new EmbedBuilder().setTitle("Trader Shop").setColor(0x2b2d31).setTimestamp().setDescription(`Category: **${category}**\nPick an item from the dropdown.`);
          return await interaction.update({ embeds: [embed], components: [new ActionRowBuilder().addComponents(catSelect), new ActionRowBuilder().addComponents(itemSelect), shopUtilityRow(sessionId)] });
        }
      }

      return await interaction.reply({ content: "Unknown button.", ephemeral: true });
    } catch (e) {
      console.error("[BUTTON] error:", e?.message ?? e);
      try { return await interaction.reply({ content: "Button error.", ephemeral: true }); } catch {}
    }
    return;
  }

  if (interaction.isStringSelectMenu()) {
    try {
      const parts = String(interaction.customId ?? "").split(":");
      const prefix = parts[0], sessionId = parts[1];
      const s = UI_SESSIONS.get(sessionId);
      if (!s) return await interaction.reply({ content: "That menu expired. Run the command again.", ephemeral: true });
      if (s.userId !== interaction.user.id) return await interaction.reply({ content: "That menu isn’t yours.", ephemeral: true });

      if (prefix === "shopcat") {
        const category = interaction.values?.[0];
        if (!category) return await interaction.reply({ content: "No category selected.", ephemeral: true });
        s.category = category;
        s.qty = 1;
        const items = (TRADER.itemsByCategory.get(category) ?? []).slice().sort((a,b)=>a.item.localeCompare(b.item));
        const catSelect = new StringSelectMenuBuilder().setCustomId(`shopcat:${sessionId}`).setPlaceholder("Pick a category…").addOptions(TRADER.categories.slice(0,25).map((c)=>({label:c.slice(0,100), value:c})));
        const itemSelect = new StringSelectMenuBuilder().setCustomId(`shopitem:${sessionId}`).setPlaceholder("Pick an item…").addOptions(traderItemOptions(items, 0, 25).length ? traderItemOptions(items,0,25) : [{label:"No items", value:"__none__"}]);
        const embed = new EmbedBuilder().setTitle("Trader Shop").setColor(0x2b2d31).setTimestamp().setDescription(`Category: **${category}**\nPick an item from the dropdown.`);
        return await interaction.update({ embeds: [embed], components: [new ActionRowBuilder().addComponents(catSelect), new ActionRowBuilder().addComponents(itemSelect), shopUtilityRow(sessionId)] });
      }

      if (prefix === "shopitem") {
        const key = interaction.values?.[0];
        if (!key || key === "__none__") return await interaction.reply({ content: "No item selected.", ephemeral: true });
        const item = TRADER.itemsByKey.get(key);
        if (!item) return await interaction.reply({ content: "Couldn’t find that item.", ephemeral: true });
        s.selectedKey = key;
        s.qty = s.qty ?? 1;
        s.mode = s.mode ?? "buy";
        const items = (TRADER.itemsByCategory.get(s.category ?? item.category) ?? []).slice().sort((a,b)=>a.item.localeCompare(b.item));
        const catSelect = new StringSelectMenuBuilder().setCustomId(`shopcat:${sessionId}`).setPlaceholder("Pick a category…").addOptions(TRADER.categories.slice(0,25).map((c)=>({label:c.slice(0,100), value:c})));
        const itemSelect = new StringSelectMenuBuilder().setCustomId(`shopitem:${sessionId}`).setPlaceholder("Pick an item…").addOptions(traderItemOptions(items, 0, 25));
        const embed = buildPriceEmbed(item, { title: `Shop • ${s.mode.toUpperCase()} • Qty ${s.qty}` });
        return await interaction.update({ embeds: [embed], components: [new ActionRowBuilder().addComponents(catSelect), new ActionRowBuilder().addComponents(itemSelect), shopControlsRow(sessionId, s.qty), shopUtilityRow(sessionId)] });
      }

      return await interaction.reply({ content: "Unknown menu.", ephemeral: true });
    } catch (e) {
      console.error("[SELECT] error:", e?.message ?? e);
      try { return await interaction.reply({ content: "Menu error.", ephemeral: true }); } catch {}
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  const cmd = interaction.commandName;
  try {
    if ((cmd === "xflagged" || cmd === "xtrust") && !isStaff(interaction)) {
      await interaction.reply({ content: "You don’t have permission to use that command.", ephemeral: true });
      return;
    }
    if (["price","pricesearch","pricecategory","tradecalc","shop"].includes(cmd) && !TRADER.loaded) {
      await interaction.reply({ content: "Trader list not loaded. Make sure trader_prices.json exists and TRADER_PRICE_JSON_PATH points to it.", ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: false });

    if (cmd === "price" || cmd === "shop") {
      const sessionId = crypto.randomBytes(10).toString("hex");
      UI_SESSIONS.set(sessionId, { userId: interaction.user.id, createdMs: nowMs(), category: TRADER.categories[0] ?? null, selectedKey: null, qty: 1, mode: "buy" });
      const catSelect = new StringSelectMenuBuilder().setCustomId(`shopcat:${sessionId}`).setPlaceholder("Pick a category…").addOptions(TRADER.categories.slice(0,25).map((c)=>({label:c.slice(0,100), value:c})));
      const firstCategory = TRADER.categories[0] ?? "";
      const items = (TRADER.itemsByCategory.get(firstCategory) ?? []).slice().sort((a,b)=>a.item.localeCompare(b.item));
      const itemSelect = new StringSelectMenuBuilder().setCustomId(`shopitem:${sessionId}`).setPlaceholder("Pick an item…").addOptions(traderItemOptions(items,0,25).length ? traderItemOptions(items,0,25) : [{label:"No items", value:"__none__"}]);
      const embed = new EmbedBuilder().setTitle(cmd === "shop" ? "Trader Shop" : "Trader Price Lookup").setColor(0x2b2d31).setTimestamp().setDescription(cmd === "shop" ? "Choose a category, choose an item, adjust quantity, then add it to your cart." : "Pick a category and then an item from the dropdowns.");
      await interaction.editReply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(catSelect), new ActionRowBuilder().addComponents(itemSelect), shopUtilityRow(sessionId)] });
      return;
    }

    if (cmd === "pricesearch") {
      const query = interaction.options.getString("query", true);
      const results = searchTraderItems(query, 200);
      const sessionId = crypto.randomBytes(10).toString("hex");
      UI_SESSIONS.set(sessionId, { userId: interaction.user.id, type: "search", createdMs: nowMs(), query, results });
      const { page, pageCount, slice } = paginateArray(results, 0, 8);
      await interaction.editReply({ embeds: [buildSearchResultsEmbed(query, slice, page, pageCount)], components: [searchPagerRow(sessionId, page, pageCount, "psearch")] });
      return;
    }

    if (cmd === "pricecategory") {
      const categoryInput = interaction.options.getString("category", true);
      const category = TRADER.categories.find((c)=>normalizeTextKey(c) === normalizeTextKey(categoryInput)) ?? categoryInput;
      const items = (TRADER.itemsByCategory.get(category) ?? []).slice().sort((a,b)=>a.item.localeCompare(b.item));
      const sessionId = crypto.randomBytes(10).toString("hex");
      UI_SESSIONS.set(sessionId, { userId: interaction.user.id, type: "category", createdMs: nowMs(), category, items });
      const { page, pageCount, slice } = paginateArray(items, 0, 8);
      await interaction.editReply({ embeds: [buildCategoryEmbed(category, slice, page, pageCount)], components: [searchPagerRow(sessionId, page, pageCount, "pcat")] });
      return;
    }

    if (cmd === "tradecalc") {
      const mode = interaction.options.getString("mode", true);
      const itemsInput = interaction.options.getString("items", true);
      const parsed = parseTradeItems(itemsInput);
      const lines = [];
      let buyTotal = 0, sellTotal = 0, hadBuy = false, hadSell = false;
      const missing = [];
      for (const ent of parsed) {
        const it = findTraderItem(ent.name);
        if (!it) {
          missing.push(ent.name);
          lines.push(`• **${ent.qty}x ${ent.name}** — ❓ not found`);
          continue;
        }
        const buy = it.buy ?? null;
        const sell = it.sell ?? null;
        let line = `• **${ent.qty}x ${it.item}**`;
        if (buy !== null) line += ` — Buy $${formatMoney(buy)} ea`;
        if (sell !== null) line += ` • Sell $${formatMoney(sell)} ea`;
        if (it.unit) line += ` • Unit: ${it.unit}`;
        lines.push(line);
        if (buy !== null) { hadBuy = true; buyTotal += Number(buy) * ent.qty; }
        if (sell !== null) { hadSell = true; sellTotal += Number(sell) * ent.qty; }
      }
      const totals = { buy: hadBuy ? buyTotal : null, sell: hadSell ? sellTotal : null, net: hadBuy || hadSell ? (hadSell ? sellTotal : 0) - (hadBuy ? buyTotal : 0) : null };
      const embed = new EmbedBuilder().setTitle("Trader Calculator").setColor(0x2b2d31).setTimestamp().setDescription([`Mode: **${mode.toUpperCase()}**`, `Items parsed: **${parsed.length}**`, "", lines.length ? lines.join("\n") : "No items parsed."].join("\n"));
      if (totals.buy !== null) embed.addFields({ name: "Buy Total", value: `$${formatMoney(totals.buy)}`, inline: true });
      if (totals.sell !== null) embed.addFields({ name: "Sell Total", value: `$${formatMoney(totals.sell)}`, inline: true });
      if (totals.net !== null) embed.addFields({ name: "Net", value: `$${formatMoney(totals.net)}`, inline: true });
      if (missing.length) embed.addFields({ name: "Not Found", value: missing.slice(0, 15).map((x)=>`• ${x}`).join("\n"), inline: false });
      embed.setFooter({ text: "Tip: Separate items with commas. Example: 3 four dials,1 bottled suppressor,2 vs89 mags" });
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (cmd === "xtrust") {
      const action = (interaction.options.getString("action", true) ?? "").toLowerCase();
      const input = interaction.options.getString("gamertag") ?? "";
      if (action === "list") {
        const lines = Object.entries(state.trusted || {}).map(([k,v])=>v?.gamertag || k).sort((a,b)=>a.localeCompare(b));
        const embeds = buildListEmbeds(`Trusted Gamertags • ${lines.length}`, lines.length ? lines : ["No trusted gamertags saved."], 0x00ff00);
        await interaction.editReply({ embeds: [embeds[0]] });
        for (let i = 1; i < embeds.length; i++) await interaction.followUp({ embeds: [embeds[i]] });
        return;
      }
      const gts = parseGamertagList(input);
      if (!gts.length) return await interaction.editReply("You must provide gamertag(s) for add/remove. Separate multiple with commas.");
      if (action === "add") {
        let added = 0, removedFromFlagged = 0, already = 0;
        const addedList = [], alreadyList = [];
        for (const gt of gts) {
          const k = gtKey(gt);
          if (!k) continue;
          if (isTrustedKey(k)) { already++; alreadyList.push(trustedDisplayForKey(k)); continue; }
          const res = trustGamertag(gt);
          if (res.ok) { added++; addedList.push(res.display); if (res.removedFlagged) removedFromFlagged++; }
        }
        const embed = new EmbedBuilder().setTitle("Trusted Update").setColor(0x00ff00).addFields(
          { name: "Added", value: String(added), inline: true },
          { name: "Removed from flagged", value: String(removedFromFlagged), inline: true },
          { name: "Already trusted", value: String(already), inline: true }
        ).setTimestamp();
        if (addedList.length) embed.addFields({ name: "Added Gamertags", value: addedList.join("\n").slice(0,1024), inline: false });
        if (alreadyList.length) embed.addFields({ name: "Already Trusted", value: alreadyList.join("\n").slice(0,1024), inline: false });
        await interaction.editReply({ embeds: [embed] });
        return;
      }
      if (action === "remove") {
        let removed = 0, notFound = 0;
        const removedList = [], notFoundList = [];
        for (const gt of gts) {
          const k = gtKey(gt);
          if (!k) continue;
          if (!isTrustedKey(k)) { notFound++; notFoundList.push(gt); continue; }
          const res = untrustGamertag(gt);
          if (res.ok) { removed++; removedList.push(res.display); }
        }
        const embed = new EmbedBuilder().setTitle("Trusted Update").setColor(0xffcc00).addFields(
          { name: "Removed", value: String(removed), inline: true },
          { name: "Not trusted", value: String(notFound), inline: true }
        ).setTimestamp();
        if (removedList.length) embed.addFields({ name: "Removed Gamertags", value: removedList.join("\n").slice(0,1024), inline: false });
        if (notFoundList.length) embed.addFields({ name: "Not Trusted", value: notFoundList.join("\n").slice(0,1024), inline: false });
        await interaction.editReply({ embeds: [embed] });
        return;
      }
      await interaction.editReply("Invalid action. Use add/remove/list.");
      return;
    }

    if (cmd === "xflagged") {
      const scope = (interaction.options.getString("scope") ?? "pending").toLowerCase();
      const items = scope === "pending"
        ? Array.from(state.pending.entries()).map(([k,v])=>({k,...v})).filter((x)=>!isTrustedKey(x.k)).sort((a,b)=>(a.gamertag||"").localeCompare(b.gamertag||""))
        : Array.from(state.flaggedAll.entries()).map(([k,v])=>({k,...v})).filter((x)=>!isTrustedKey(x.k)).sort((a,b)=>(a.gamertag||"").localeCompare(b.gamertag||""));
      const lines = scope === "pending"
        ? items.map((x)=>x.gamertag)
        : items.map((x)=>`${x.gamertag}${Number.isFinite(x.lastKnownGS) ? ` (${x.lastKnownGS})` : ""}`);
      const embeds = buildListEmbeds(`Flagged (${scope === "pending" ? "Pending" : "All-Time"}) • ${lines.length}`, lines.length ? lines : ["No entries."], 0xff0000);
      await interaction.editReply({ embeds: [embeds[0]] });
      for (let i = 1; i < embeds.length; i++) await interaction.followUp({ embeds: [embeds[i]] });
      return;
    }

    const gamertagInput = normalizeGamertag(interaction.options.getString("gamertag", true));
    const merged = await fetchOpenXblMergedProfile(gamertagInput);
    const flaggedByGS = merged.gamerscore !== null ? merged.gamerscore < GS_THRESHOLD : false;
    if (cmd === "xcheck") {
      const embed = new EmbedBuilder().setTitle("Xbox Gamerscore Check").setColor(flaggedByGS ? 0xff0000 : 0x00ff00).setTimestamp();
      addFieldIf(embed, "Gamertag", merged.gamertag, true);
      if (merged.gamerscore !== null) addFieldIf(embed, "Gamerscore", String(merged.gamerscore), true);
      addFieldIf(embed, "Result", flaggedByGS ? "FLAGGED" : "OK", false);
      addFieldIf(embed, "Tier", merged.tier ? String(merged.tier) : "", true);
      if (merged.gamerpic) embed.setThumbnail(merged.gamerpic);
      await interaction.editReply({ embeds: [embed] });
      return;
    }
    const embed = new EmbedBuilder().setTitle("Xbox Profile Info").setColor(flaggedByGS ? 0xff4d4d : 0x2b2d31).setTimestamp();
    if (merged.gamerpic) embed.setThumbnail(merged.gamerpic);
    addFieldIf(embed, "Gamertag", merged.gamertag, true);
    addFieldIf(embed, "XUID", merged.xuid ? String(merged.xuid) : "", true);
    if (merged.gamerscore !== null) addFieldIf(embed, "Gamerscore", String(merged.gamerscore), true);
    addFieldIf(embed, "Account Tier", merged.tier ? String(merged.tier) : "", true);
    addFieldIf(embed, "Xbox Rep", merged.xboxRep ? String(merged.xboxRep) : "", true);
    addFieldIf(embed, "Presence", merged.presenceState ? String(merged.presenceState) : "", true);
    addFieldIf(embed, "Status", merged.presenceText ? String(merged.presenceText) : "", true);
    addFieldIf(embed, "Last Seen", merged.lastSeen ? String(merged.lastSeen) : "", false);
    addFieldIf(embed, "Bio", merged.bio ? String(merged.bio) : "", false);
    addFieldIf(embed, "Location", merged.location ? String(merged.location) : "", true);
    addFieldIf(embed, "Tenure", merged.tenure ? String(merged.tenure) : "", true);
    if (merged.hasGamePass === true || merged.hasGamePass === false) addFieldIf(embed, "Game Pass", formatBool(merged.hasGamePass), true);
    else if (typeof merged.hasGamePass === "string" && merged.hasGamePass.trim() !== "") addFieldIf(embed, "Game Pass", merged.hasGamePass.trim(), true);
    if (typeof merged.followerCount === "number") addFieldIf(embed, "Followers", String(merged.followerCount), true);
    if (typeof merged.followingCount === "number") addFieldIf(embed, "Following", String(merged.followingCount), true);
    if (typeof merged.friendCount === "number") addFieldIf(embed, "Friends", String(merged.friendCount), true);
    embed.setFooter({ text: "Note: Some fields may be unavailable due to Xbox privacy settings." });
    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error("interaction error:", err?.message ?? err);
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply("Something went wrong while processing that request.");
      else await interaction.reply({ content: "Something went wrong while processing that request.", ephemeral: true });
    } catch {}
  }
});

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await autoDeployCommandsIfEnabled().catch((e)=>console.error("[COMMANDS] deploy error:", e?.message ?? e));
  await pollOnlineList().catch((e)=>console.error("[POLL] error:", e));
  setInterval(() => { pollOnlineList().catch((e)=>console.error("[POLL] error:", e)); }, POLL_SECONDS * 1000);
  setInterval(() => { sendDigestIfDue().catch((e)=>console.error("[DIGEST] error:", e)); }, 60 * 1000);
  await sendDigestIfDue().catch((e)=>console.error("[DIGEST] error:", e));
});

client.login(DISCORD_TOKEN);
