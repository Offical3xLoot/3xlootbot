import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  PermissionsBitField,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import fetch from "node-fetch";
import fs from "node:fs";
import path from "node:path";

// ===== ENV =====
const DISCORD_TOKEN = (process.env.DISCORD_TOKEN ?? "").trim();
const DISCORD_CLIENT_ID = (process.env.DISCORD_CLIENT_ID ?? "").trim();
const GUILD_ID = (process.env.GUILD_ID ?? "").trim();
const COMMANDS_AUTO_DEPLOY = (process.env.COMMANDS_AUTO_DEPLOY ?? "false").trim().toLowerCase() === "true";

const XBL_API_KEY = (process.env.XBL_API_KEY ?? "").trim();

const GS_THRESHOLD = Number.parseInt((process.env.GS_THRESHOLD ?? "2500").trim(), 10);
const ONLINE_LIST_CHANNEL_ID = (process.env.ONLINE_LIST_CHANNEL_ID ?? "").trim();
const MODLOG_CHANNEL_ID = (process.env.MODLOG_CHANNEL_ID ?? "").trim();

const DIGEST_CHANNEL_ID = (process.env.DIGEST_CHANNEL_ID ?? MODLOG_CHANNEL_ID).trim();
const DIGEST_INTERVAL_HOURS = Number.parseInt((process.env.DIGEST_INTERVAL_HOURS ?? "1").trim(), 10);

const SCRUB_DELAY_MS = Number.parseInt((process.env.SCRUB_DELAY_MS ?? "4000").trim(), 10);
const POLL_SECONDS = Number.parseInt((process.env.POLL_SECONDS ?? "180").trim(), 10);

const DATA_DIR = (process.env.DATA_DIR ?? "./data").trim();
const IMMEDIATE_FLAG_LOGS = (process.env.IMMEDIATE_FLAG_LOGS ?? "false").trim().toLowerCase() === "true";
const RESET_STATE = (process.env.RESET_STATE ?? "").trim().toLowerCase() === "true";

// Optional: restrict staff commands to a specific role id too (in addition to ManageGuild)
const STAFF_ROLE_ID = (process.env.STAFF_ROLE_ID ?? "").trim();

// ===== OpenXBL retry tuning =====
const XBL_MAX_RETRIES = Number.parseInt((process.env.XBL_MAX_RETRIES ?? "5").trim(), 10);        // retries on 429
const XBL_BACKOFF_BASE_MS = Number.parseInt((process.env.XBL_BACKOFF_BASE_MS ?? "4000").trim(), 10); // base backoff
const XBL_BACKOFF_MAX_MS = Number.parseInt((process.env.XBL_BACKOFF_MAX_MS ?? "60000").trim(), 10);  // cap backoff

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
console.log(`THRESHOLD=${GS_THRESHOLD}`);
console.log(`ONLINE_LIST_CHANNEL_ID=${ONLINE_LIST_CHANNEL_ID || "MISSING"}`);
console.log(`MODLOG_CHANNEL_ID=${MODLOG_CHANNEL_ID || "MISSING"}`);
console.log(`DIGEST_CHANNEL_ID=${DIGEST_CHANNEL_ID || "MISSING"}`);
console.log(`DIGEST_INTERVAL_HOURS=${DIGEST_INTERVAL_HOURS}`);
console.log(`IMMEDIATE_FLAG_LOGS=${IMMEDIATE_FLAG_LOGS}`);
console.log(`SCRUB_DELAY_MS=${SCRUB_DELAY_MS}`);
console.log(`POLL_SECONDS=${POLL_SECONDS}`);
console.log(`DATA_DIR=${DATA_DIR}`);
console.log(`COMMANDS_AUTO_DEPLOY=${COMMANDS_AUTO_DEPLOY}`);
console.log(`DISCORD_CLIENT_ID=${DISCORD_CLIENT_ID ? "SET" : "MISSING"}`);
console.log(`GUILD_ID=${GUILD_ID ? "SET" : "MISSING"}`);
console.log(`STAFF_ROLE_ID=${STAFF_ROLE_ID ? "SET" : "MISSING"}`);
console.log(`XBL_MAX_RETRIES=${XBL_MAX_RETRIES}`);
console.log(`XBL_BACKOFF_BASE_MS=${XBL_BACKOFF_BASE_MS}`);
console.log(`XBL_BACKOFF_MAX_MS=${XBL_BACKOFF_MAX_MS}`);

// ===== Persistence =====
fs.mkdirSync(DATA_DIR, { recursive: true });
const STATE_FILE = path.resolve(DATA_DIR, "state.json");

function nowMs() { return Date.now(); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function normalizeGamertag(s) { return (s ?? "").replace(/\s+/g, " ").trim(); }
function gtKey(s) { return normalizeGamertag(s).toLowerCase(); }
function stripMarkdown(s) {
  return (s ?? "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .trim();
}

// trusted: { keyLower: { gamertag: "OriginalCase", addedMs: 123 } }
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
    } else if (Array.isArray(parsed?.trusted)) {
      for (const k of parsed.trusted) {
        const kk = String(k ?? "").trim().toLowerCase();
        if (kk) trusted[kk] = { gamertag: String(k), addedMs: nowMs() };
      }
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

    return { checked, pending, lastDigestMs, flaggedAll, trusted: normalizedTrusted };
  } catch {
    return { checked: new Set(), pending: new Map(), lastDigestMs: 0, flaggedAll: new Map(), trusted: {} };
  }
}

function saveState() {
  try {
    const pendingObj = {};
    for (const [k, v] of state.pending.entries()) pendingObj[k] = v;

    const flaggedAllObj = {};
    for (const [k, v] of state.flaggedAll.entries()) flaggedAllObj[k] = v;

    const out = {
      checked: Array.from(state.checked.values()).sort((a, b) => a.localeCompare(b)),
      pending: pendingObj,
      lastDigestMs: state.lastDigestMs,
      trusted: state.trusted,
      flaggedAll: flaggedAllObj,
    };

    fs.writeFileSync(STATE_FILE, JSON.stringify(out, null, 2), "utf8");
  } catch (err) {
    console.error("Failed saving state:", err?.message ?? err);
  }
}

let state = loadState();

if (RESET_STATE) {
  console.log("RESET_STATE=true -> clearing state.json");
  state = { checked: new Set(), pending: new Map(), lastDigestMs: 0, trusted: {}, flaggedAll: new Map() };
  saveState();
}

console.log(
  `State loaded: checked=${state.checked.size}, pending=${state.pending.size}, flaggedAll=${state.flaggedAll.size}, trusted=${Object.keys(state.trusted).length}, lastDigestMs=${state.lastDigestMs}`
);

// ===== Discord Client =====
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  partials: [Partials.Message, Partials.Channel],
});

// ===== Auto-deploy slash commands =====
async function autoDeployCommandsIfEnabled() {
  if (!COMMANDS_AUTO_DEPLOY) return;
  if (!DISCORD_CLIENT_ID || !GUILD_ID) {
    console.log("[COMMANDS] Auto deploy ON but DISCORD_CLIENT_ID or GUILD_ID missing.");
    return;
  }

  const commands = [
    new SlashCommandBuilder()
      .setName("xcheck")
      .setDescription("Check an Xbox gamertag's gamerscore against the configured threshold.")
      .addStringOption((opt) =>
        opt.setName("gamertag").setDescription("Xbox gamertag").setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName("xinfo")
      .setDescription("Fetch detailed Xbox profile info (only shows fields that are available).")
      .addStringOption((opt) =>
        opt.setName("gamertag").setDescription("Xbox gamertag").setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName("xflagged")
      .setDescription("Show low-gamerscore gamertags saved by the bot.")
      .addStringOption((opt) =>
        opt
          .setName("scope")
          .setDescription("pending = since last digest; all = all-time saved")
          .addChoices(
            { name: "pending", value: "pending" },
            { name: "all", value: "all" }
          )
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName("xtrust")
      .setDescription("Manage trusted gamertags (whitelist). Trusted names are excluded from flagged lists.")
      .addStringOption((opt) =>
        opt
          .setName("action")
          .setDescription("add/remove/list")
          .addChoices(
            { name: "add", value: "add" },
            { name: "remove", value: "remove" },
            { name: "list", value: "list" }
          )
          .setRequired(true)
      )
      .addStringOption((opt) =>
        opt
          .setName("gamertag")
          .setDescription("Gamertag (required for add/remove)")
          .setRequired(false)
      ),
  ].map((c) => c.toJSON());

  try {
    console.log("[COMMANDS] Deploying guild commands...");
    const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
    await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, GUILD_ID), {
      body: commands,
    });
    console.log("[COMMANDS] Done. /xcheck /xinfo /xflagged /xtrust registered.");
  } catch (err) {
    console.error("[COMMANDS] Deploy failed:", err?.message ?? err);
  }
}

// ===== Staff check =====
function isStaff(interaction) {
  const perms = interaction.memberPermissions;
  const hasManageGuild = perms?.has(PermissionsBitField.Flags.ManageGuild);
  if (hasManageGuild) return true;
  if (STAFF_ROLE_ID && interaction.member?.roles?.cache?.has?.(STAFF_ROLE_ID)) return true;
  return false;
}

// ===== Trusted helpers =====
function isTrustedKey(k) {
  return !!state.trusted?.[k];
}
function trustedDisplayForKey(k) {
  return state.trusted?.[k]?.gamertag || k;
}

// ===== HTTP helper =====
async function fetchJsonWithTimeout(url, options, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = null; }
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

// ===== OpenXBL with backoff =====
async function openXblFetchJson(url) {
  const { res, data } = await fetchJsonWithTimeout(
    url,
    { method: "GET", headers: { "X-Authorization": XBL_API_KEY, Accept: "application/json" } },
    8000
  );

  if (res.status === 429) {
    const retryAfter = parseRetryAfterMs(res);
    throw new RateLimitError("OpenXBL rate limited (HTTP 429)", retryAfter);
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
        if (attempt > XBL_MAX_RETRIES) throw err;

        const backoff = Math.min(
          XBL_BACKOFF_MAX_MS,
          (err.retryAfterMs ?? 0) || (XBL_BACKOFF_BASE_MS * Math.pow(2, attempt - 1))
        );

        console.log(`[XBL] 429 rate limit. Backing off ${backoff}ms (attempt ${attempt}/${XBL_MAX_RETRIES})`);
        await sleep(backoff);
        continue;
      }
      throw err;
    }
  }
}

async function openXblSearch(gamertag) {
  const base = "https://xbl.io/api/v2";
  const wanted = normalizeGamertag(gamertag);
  const url = `${base}/search/${encodeURIComponent(wanted)}`;

  const data = await openXblFetchWithRetry(url);

  const people = data?.people;
  if (!Array.isArray(people) || people.length === 0) throw new Error("Gamertag not found.");

  const wantedLower = wanted.toLowerCase();
  const best =
    people.find((p) => (p?.gamertag ?? "").toLowerCase() === wantedLower) ||
    people.find((p) => (p?.modernGamertag ?? "").toLowerCase() === wantedLower) ||
    people[0];

  if (!best?.xuid) throw new Error("Search result missing XUID.");
  return best;
}

async function openXblAccount(xuid) {
  const base = "https://xbl.io/api/v2";
  const url = `${base}/account/${encodeURIComponent(xuid)}`;
  return await openXblFetchWithRetry(url);
}

// ===== OpenXBL merge =====
function settingsToMap(settingsArr) {
  const map = new Map();
  if (!Array.isArray(settingsArr)) return map;
  for (const s of settingsArr) {
    const id = s?.id;
    const value = s?.value;
    if (typeof id === "string") map.set(id, value ?? null);
  }
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
    if (Array.isArray(x)) { for (const it of x) visit(it); return; }
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
  const xuid = person.xuid;
  const accData = await openXblAccount(xuid);

  const settingsArr = accData?.profileUsers?.[0]?.settings;
  const settingsMap = settingsToMap(settingsArr);

  const displayGamertag =
    readSetting(settingsMap, "Gamertag") ||
    person.gamertag ||
    normalizeGamertag(gamertag);

  const gamerscore =
    parseIntOrNull(readSetting(settingsMap, "Gamerscore")) ??
    parseIntOrNull(person.gamerscore) ??
    null;

  const tier = readSetting(settingsMap, "AccountTier") || person?.detail?.accountTier || null;

  const gamerpic =
    readSetting(settingsMap, "GameDisplayPicRaw", "GameDisplayPic") ||
    person?.displayPicRaw ||
    person?.displayPic ||
    null;

  const bio = readSetting(settingsMap, "Bio") || person?.detail?.bio || null;
  const location = readSetting(settingsMap, "Location") || person?.detail?.location || null;
  const tenure = readSetting(settingsMap, "TenureLevel") || person?.detail?.tenureLevel || null;

  const presenceState = person?.presenceState || person?.presence?.state || null;
  const presenceText = person?.presenceText || person?.presence?.text || null;
  const lastSeen =
    person?.detail?.lastSeenTimestamp ||
    person?.lastSeenDateTimeUtc ||
    person?.detail?.lastSeenDateTimeUtc ||
    null;

  const xboxRep = person?.xboxOneRep || person?.detail?.xboxOneRep || null;
  const hasGamePass = person?.detail?.hasGamePass ?? person?.hasGamePass ?? null;

  const keyNamesLower = new Set(["followerscount", "followercount", "followingcount", "friendscount", "friendcount"]);
  const socialNums = deepFindNumbers({ person, accData }, keyNamesLower);

  const followerCount = socialNums["followercount"] ?? socialNums["followerscount"] ?? null;
  const followingCount = socialNums["followingcount"] ?? null;
  const friendCount = socialNums["friendcount"] ?? socialNums["friendscount"] ?? null;

  return {
    gamertag: displayGamertag,
    xuid,
    gamerscore,
    tier,
    gamerpic,
    bio,
    location,
    tenure,
    presenceState,
    presenceText,
    lastSeen,
    xboxRep,
    hasGamePass,
    followerCount,
    followingCount,
    friendCount,
  };
}

// ===== Embed helpers =====
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

// ===== Extract gamertags from embeds =====
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
    line = stripMarkdown(line);

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

// ===== Pending + All-time flagged =====
function addFlagged(profile) {
  const k = gtKey(profile.gamertag);
  if (!k) return;
  if (isTrustedKey(k)) return;

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
    if (profile.gamerscore !== null && profile.gamerscore !== undefined) p.gamerscore = profile.gamerscore;
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
    if (profile.gamerscore !== null && profile.gamerscore !== undefined) a.lastKnownGS = profile.gamerscore;
    a.lastSeenMs = t;
  }

  saveState();
}

function isTrustedKey(k) {
  return !!state.trusted?.[k];
}

function trustGamertag(gt) {
  const original = normalizeGamertag(gt);
  const k = gtKey(original);
  if (!k) return { ok: false, display: "" };

  state.trusted[k] = { gamertag: original, addedMs: nowMs() };
  state.pending.delete(k);
  state.flaggedAll.delete(k);
  saveState();

  return { ok: true, display: original };
}

function untrustGamertag(gt) {
  const original = normalizeGamertag(gt);
  const k = gtKey(original);
  if (!k) return { ok: false, display: "" };

  const display = state.trusted?.[k]?.gamertag || original;
  delete state.trusted[k];
  saveState();

  return { ok: true, display };
}

// ===== Digest =====
function chunkLines(lines, maxChars) {
  const chunks = [];
  let current = "";
  for (const line of lines) {
    const add = (current ? "\n" : "") + line;
    if ((current.length + add.length) > maxChars) {
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
  if (state.lastDigestMs && (now - state.lastDigestMs) < intervalMs) return;

  const cutoff = state.lastDigestMs || (now - intervalMs);

  const items = Array.from(state.pending.entries())
    .map(([k, v]) => ({ k, ...v }))
    .filter((v) => (v?.lastSeenMs ?? 0) >= cutoff)
    .filter((v) => !isTrustedKey(v.k))
    .sort((a, b) => (a.gamertag || "").localeCompare(b.gamertag || ""));

  const digestChan = await client.channels.fetch(DIGEST_CHANNEL_ID).catch(() => null);
  if (!digestChan || !digestChan.guild) return;

  if (items.length === 0) {
    console.log("[DIGEST] Due, but nothing pending.");
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

    if (chunks.length > 1) embed.setFooter({ text: `Page ${i + 1}/${chunks.length}` });

    await sendEmbedToChannel(digestChan.guild, DIGEST_CHANNEL_ID, embed);
  }

  console.log(`[DIGEST] Sent ${items.length} gamertags in ${chunks.length} message(s).`);

  state.lastDigestMs = now;
  state.pending = new Map();
  saveState();
}

// ===== Poll online list =====
async function pollOnlineList() {
  if (!ONLINE_LIST_CHANNEL_ID) return;

  const channel = await client.channels.fetch(ONLINE_LIST_CHANNEL_ID).catch(() => null);
  if (!channel || !("messages" in channel)) return;

  const messages = await channel.messages.fetch({ limit: 5 }).catch(() => null);
  if (!messages) return;

  const newest = messages.first();
  if (!newest) return;

  const gts = extractGamertagsFromEmbeds(newest);
  console.log(`[ONLINE LIST POLL] embeds=${newest.embeds?.length ?? 0} extracted=${gts.length}`);

  for (const gt of gts) enqueueGamertag(gt, newest.guild);
}

// ===== Auto-scrub queue (IMPORTANT: only mark checked after success) =====
const queue = [];
const queuedKeys = new Set();
let working = false;

// When OpenXBL rate limits, we pause all processing for a bit.
let globalCooldownUntilMs = 0;

function enqueueGamertag(gt, guild) {
  const clean = normalizeGamertag(gt);
  const k = gtKey(clean);
  if (!k) return;

  if (isTrustedKey(k)) return;
  if (state.checked.has(k)) return;

  // prevent duplicates in queue
  if (queuedKeys.has(k)) return;

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

      if (isTrustedKey(item.k)) continue;
      if (state.checked.has(item.k)) continue;

      // Respect global cooldown if we recently hit rate limit
      const now = nowMs();
      if (globalCooldownUntilMs > now) {
        const wait = globalCooldownUntilMs - now;
        console.log(`[XBL] Global cooldown active. Waiting ${wait}ms`);
        await sleep(wait);
      }

      console.log(`[CHECK] ${item.gt}`);

      try {
        const merged = await fetchOpenXblMergedProfile(item.gt);

        // ✅ mark checked ONLY after successful OpenXBL round trip
        state.checked.add(item.k);
        saveState();

        const gs = merged.gamerscore;

        if (gs === null) {
          console.log(`[OK] ${merged.gamertag} GS=unknown (ignored)`);
        } else if (gs >= GS_THRESHOLD) {
          console.log(`[OK] ${merged.gamertag} GS=${gs} (ignored)`);
        } else {
          console.log(`[FLAGGED] ${merged.gamertag} GS=${gs} (saved)`);
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

            if (merged.tier) embed.addFields({ name: "Tier", value: String(merged.tier), inline: true });
            if (merged.gamerpic) embed.setThumbnail(merged.gamerpic);

            await sendEmbedToChannel(item.guild, MODLOG_CHANNEL_ID, embed);
          }
        }
      } catch (err) {
        // If rate limited, don't “lose” the gamertag — requeue it after cooldown
        if (err instanceof RateLimitError) {
          const backoff = Math.min(
            XBL_BACKOFF_MAX_MS,
            err.retryAfterMs ?? XBL_BACKOFF_BASE_MS
          );

          globalCooldownUntilMs = nowMs() + backoff;
          console.log(`[XBL] Rate-limited in worker. Cooling down ${backoff}ms then requeue ${item.gt}`);

          // requeue (but avoid tight loop)
          await sleep(Math.min(backoff, 15000));
          enqueueGamertag(item.gt, item.guild);
        } else {
          console.error(`[ERROR] ${item.gt}:`, err?.message ?? err);
          // do NOT mark checked here; allow future retry via polling
        }
      }

      if (SCRUB_DELAY_MS > 0) await sleep(SCRUB_DELAY_MS);
    }
  } finally {
    working = false;
  }
}

// ===== Commands =====
function buildListEmbeds(title, lines, color = 0x2b2d31) {
  const chunks = chunkLines(lines, 3500);
  const embeds = [];

  for (let i = 0; i < chunks.length; i++) {
    const e = new EmbedBuilder()
      .setTitle(title)
      .setDescription(chunks[i] || "—")
      .setColor(color)
      .setTimestamp();

    if (chunks.length > 1) e.setFooter({ text: `Page ${i + 1}/${chunks.length}` });
    embeds.push(e);
  }
  return embeds;
}

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const cmd = interaction.commandName;
  if (!["xcheck", "xinfo", "xflagged", "xtrust"].includes(cmd)) return;

  try {
    if (cmd === "xflagged" || cmd === "xtrust") {
      if (!isStaff(interaction)) {
        await interaction.reply({ content: "You don’t have permission to use that command.", ephemeral: true });
        return;
      }
    }

    await interaction.deferReply({ ephemeral: false });

    if (cmd === "xflagged") {
      const scope = (interaction.options.getString("scope") ?? "pending").toLowerCase();
      if (scope === "pending") {
        const items = Array.from(state.pending.entries())
          .map(([k, v]) => ({ k, ...v }))
          .filter((x) => !isTrustedKey(x.k))
          .sort((a, b) => (a.gamertag || "").localeCompare(b.gamertag || ""));

        const lines = items.map((x) => x.gamertag);
        const embeds = buildListEmbeds(
          `Flagged (Pending) • ${lines.length}`,
          lines.length ? lines : ["No pending low-GS gamertags saved right now."],
          0xff0000
        );

        await interaction.editReply({ embeds: [embeds[0]] });
        for (let i = 1; i < embeds.length; i++) await interaction.followUp({ embeds: [embeds[i]] });
        return;
      }

      const items = Array.from(state.flaggedAll.entries())
        .map(([k, v]) => ({ k, ...v }))
        .filter((x) => !isTrustedKey(x.k))
        .sort((a, b) => (a.gamertag || "").localeCompare(b.gamertag || ""));

      const lines = items.map((x) => {
        const gs = Number.isFinite(x.lastKnownGS) ? ` (${x.lastKnownGS})` : "";
        return `${x.gamertag}${gs}`;
      });

      const embeds = buildListEmbeds(
        `Flagged (All-Time) • ${lines.length}`,
        lines.length ? lines : ["No saved low-GS gamertags yet."],
        0xff0000
      );

      await interaction.editReply({ embeds: [embeds[0]] });
      for (let i = 1; i < embeds.length; i++) await interaction.followUp({ embeds: [embeds[i]] });
      return;
    }

    if (cmd === "xtrust") {
      const action = (interaction.options.getString("action", true) ?? "").toLowerCase();
      const gt = interaction.options.getString("gamertag") ?? "";

      if (action === "list") {
        const entries = Object.entries(state.trusted || {})
          .map(([k, v]) => ({ key: k, gamertag: v?.gamertag || k, addedMs: v?.addedMs || 0 }))
          .sort((a, b) => (a.gamertag || "").localeCompare(b.gamertag || ""));

        const lines = entries.map((e) => e.gamertag);
        const embeds = buildListEmbeds(
          `Trusted Gamertags • ${lines.length}`,
          lines.length ? lines : ["No trusted gamertags saved."],
          0x00ff00
        );

        await interaction.editReply({ embeds: [embeds[0]] });
        for (let i = 1; i < embeds.length; i++) await interaction.followUp({ embeds: [embeds[i]] });
        return;
      }

      if ((action === "add" || action === "remove") && !gt.trim()) {
        await interaction.editReply("You must provide a gamertag for add/remove.");
        return;
      }

      if (action === "add") {
        const res = trustGamertag(gt);
        if (!res.ok) return void interaction.editReply("Could not trust that gamertag (invalid).");
        await interaction.editReply(`✅ Trusted: **${res.display}**\nRemoved from flagged lists and will be ignored going forward.`);
        return;
      }

      if (action === "remove") {
        const res = untrustGamertag(gt);
        if (!res.ok) return void interaction.editReply("Could not untrust that gamertag (invalid).");
        await interaction.editReply(`🗑️ Removed from trusted: **${res.display}**`);
        return;
      }

      await interaction.editReply("Invalid action. Use add/remove/list.");
      return;
    }

    // /xcheck + /xinfo
    const gamertagInput = normalizeGamertag(interaction.options.getString("gamertag", true));
    const merged = await fetchOpenXblMergedProfile(gamertagInput);
    const flaggedByGS = merged.gamerscore !== null ? merged.gamerscore < GS_THRESHOLD : false;

    if (cmd === "xcheck") {
      const embed = new EmbedBuilder()
        .setTitle("Xbox Gamerscore Check")
        .setColor(flaggedByGS ? 0xff0000 : 0x00ff00)
        .setTimestamp();

      addFieldIf(embed, "Gamertag", merged.gamertag, true);
      if (merged.gamerscore !== null) addFieldIf(embed, "Gamerscore", String(merged.gamerscore), true);
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
    if (merged.gamerscore !== null) addFieldIf(embed, "Gamerscore", String(merged.gamerscore), true);
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

    const hasFollowerCount = typeof merged.followerCount === "number";
    const hasFollowingCount = typeof merged.followingCount === "number";
    const hasFriendCount = typeof merged.friendCount === "number";

    if (hasFollowerCount) addFieldIf(embed, "Followers", String(merged.followerCount), true);
    if (hasFollowingCount) addFieldIf(embed, "Following", String(merged.followingCount), true);
    if (hasFriendCount) addFieldIf(embed, "Friends", String(merged.friendCount), true);

    const zeros = [];
    if (hasFollowerCount && merged.followerCount === 0) zeros.push("Followers=0");
    if (hasFollowingCount && merged.followingCount === 0) zeros.push("Following=0");
    if (hasFriendCount && merged.friendCount === 0) zeros.push("Friends=0");
    if (zeros.length) embed.addFields({ name: "⚠️ Social Looks Empty", value: zeros.join(" • "), inline: false });

    embed.setFooter({ text: "Note: Some fields may be unavailable due to Xbox privacy settings." });
    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error("interaction error:", err?.message ?? err);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply("Something went wrong while processing that request.");
      } else {
        await interaction.reply({ content: "Something went wrong while processing that request.", ephemeral: true });
      }
    } catch {}
  }
});

// ===== Poll & Digest loops =====
client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  await autoDeployCommandsIfEnabled();

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
