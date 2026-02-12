import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  PermissionsBitField,
  Partials,
} from "discord.js";
import fetch from "node-fetch";
import fs from "node:fs";
import path from "node:path";

// ===== ENV =====
const DISCORD_TOKEN = (process.env.DISCORD_TOKEN ?? "").trim();
const XBL_API_KEY = (process.env.XBL_API_KEY ?? "").trim();

const GS_THRESHOLD = Number.parseInt((process.env.GS_THRESHOLD ?? "2500").trim(), 10);
const ONLINE_LIST_CHANNEL_ID = (process.env.ONLINE_LIST_CHANNEL_ID ?? "").trim();
const MODLOG_CHANNEL_ID = (process.env.MODLOG_CHANNEL_ID ?? "").trim();

const DIGEST_CHANNEL_ID = (process.env.DIGEST_CHANNEL_ID ?? MODLOG_CHANNEL_ID).trim();
const DIGEST_INTERVAL_HOURS = Number.parseInt((process.env.DIGEST_INTERVAL_HOURS ?? "24").trim(), 10);

const SCRUB_DELAY_MS = Number.parseInt((process.env.SCRUB_DELAY_MS ?? "1200").trim(), 10);
const POLL_SECONDS = Number.parseInt((process.env.POLL_SECONDS ?? "60").trim(), 10);

const DATA_DIR = (process.env.DATA_DIR ?? "./data").trim();

// If you ever want immediate per-flag logs again, set true
const IMMEDIATE_FLAG_LOGS = (process.env.IMMEDIATE_FLAG_LOGS ?? "false").trim().toLowerCase() === "true";

// Optional one-time reset (be careful)
const RESET_STATE = (process.env.RESET_STATE ?? "").trim().toLowerCase() === "true";

function die(msg) {
  console.error(msg);
  process.exit(1);
}

if (!DISCORD_TOKEN) die("Missing DISCORD_TOKEN env var.");
if (!XBL_API_KEY) die("Missing XBL_API_KEY env var.");
if (!Number.isFinite(GS_THRESHOLD)) die("GS_THRESHOLD must be a valid integer.");
if (!ONLINE_LIST_CHANNEL_ID) die("Missing ONLINE_LIST_CHANNEL_ID env var.");
if (!MODLOG_CHANNEL_ID) console.log("WARNING: MODLOG_CHANNEL_ID not set (manual flagged modlog will be limited).");
if (!DIGEST_CHANNEL_ID) die("Missing DIGEST_CHANNEL_ID (or MODLOG_CHANNEL_ID).");
if (!Number.isFinite(DIGEST_INTERVAL_HOURS) || DIGEST_INTERVAL_HOURS < 1) die("DIGEST_INTERVAL_HOURS must be >= 1.");
if (!Number.isFinite(SCRUB_DELAY_MS) || SCRUB_DELAY_MS < 0) die("SCRUB_DELAY_MS must be non-negative.");
if (!Number.isFinite(POLL_SECONDS) || POLL_SECONDS < 10) die("POLL_SECONDS must be >= 10.");

process.on("unhandledRejection", (err) => console.error("Unhandled rejection:", err));
process.on("uncaughtException", (err) => console.error("Uncaught exception:", err));

console.log("Booting 3xBot (XCHECK + AutoScrub + Daily Digest)...");
console.log(`THRESHOLD=${GS_THRESHOLD}`);
console.log(`ONLINE_LIST_CHANNEL_ID=${ONLINE_LIST_CHANNEL_ID}`);
console.log(`MODLOG_CHANNEL_ID=${MODLOG_CHANNEL_ID || "MISSING"}`);
console.log(`DIGEST_CHANNEL_ID=${DIGEST_CHANNEL_ID}`);
console.log(`DIGEST_INTERVAL_HOURS=${DIGEST_INTERVAL_HOURS}`);
console.log(`IMMEDIATE_FLAG_LOGS=${IMMEDIATE_FLAG_LOGS}`);
console.log(`SCRUB_DELAY_MS=${SCRUB_DELAY_MS}`);
console.log(`POLL_SECONDS=${POLL_SECONDS}`);
console.log(`DATA_DIR=${DATA_DIR}`);

// ===== Persistence =====
fs.mkdirSync(DATA_DIR, { recursive: true });

// One file for everything (checked list + pending digest + last digest time)
const STATE_FILE = path.resolve(DATA_DIR, "state.json");

function nowMs() {
  return Date.now();
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

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);

    const checked = new Set(Array.isArray(parsed?.checked) ? parsed.checked : []);
    const pending = new Map(); // key -> { gamertag, gamerscore, firstSeenMs, lastSeenMs }

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

    return { checked, pending, lastDigestMs };
  } catch {
    return { checked: new Set(), pending: new Map(), lastDigestMs: 0 };
  }
}

function saveState() {
  try {
    const pendingObj = {};
    for (const [k, v] of state.pending.entries()) {
      pendingObj[k] = v;
    }

    const out = {
      checked: Array.from(state.checked.values()).sort((a, b) => a.localeCompare(b)),
      pending: pendingObj,
      lastDigestMs: state.lastDigestMs,
    };

    fs.writeFileSync(STATE_FILE, JSON.stringify(out, null, 2), "utf8");
  } catch (err) {
    console.error("Failed saving state:", err?.message ?? err);
  }
}

let state = loadState();

if (RESET_STATE) {
  console.log("RESET_STATE=true -> clearing state.json");
  state = { checked: new Set(), pending: new Map(), lastDigestMs: 0 };
  saveState();
}

console.log(`State loaded: checked=${state.checked.size}, pending=${state.pending.size}, lastDigestMs=${state.lastDigestMs}`);

// ===== Discord Client =====
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  partials: [Partials.Message, Partials.Channel],
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJsonWithTimeout(url, options, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    return { res, data, text };
  } finally {
    clearTimeout(timer);
  }
}

// ===== OpenXBL =====
async function fetchOpenXblProfile(gamertag) {
  const base = "https://xbl.io/api/v2";
  const wanted = normalizeGamertag(gamertag);
  const wantedLower = wanted.toLowerCase();

  const searchUrl = `${base}/search/${encodeURIComponent(wanted)}`;
  const { res: searchRes, data: searchData } = await fetchJsonWithTimeout(
    searchUrl,
    { method: "GET", headers: { "X-Authorization": XBL_API_KEY, Accept: "application/json" } },
    8000
  );

  if (!searchRes.ok) {
    const msg = searchData?.error || searchData?.message || `OpenXBL search failed (HTTP ${searchRes.status}).`;
    throw new Error(msg);
  }

  const people = searchData?.people;
  if (!Array.isArray(people) || people.length === 0) throw new Error("Gamertag not found.");

  const best =
    people.find((p) => (p?.gamertag ?? "").toLowerCase() === wantedLower) ||
    people.find((p) => (p?.modernGamertag ?? "").toLowerCase() === wantedLower) ||
    people[0];

  const xuid = best?.xuid;
  if (!xuid) throw new Error("Search result missing XUID.");

  const accountUrl = `${base}/account/${encodeURIComponent(xuid)}`;
  const { res: accRes, data: accData } = await fetchJsonWithTimeout(
    accountUrl,
    { method: "GET", headers: { "X-Authorization": XBL_API_KEY, Accept: "application/json" } },
    8000
  );

  if (!accRes.ok) {
    const msg = accData?.error || accData?.message || `OpenXBL account failed (HTTP ${accRes.status}).`;
    throw new Error(msg);
  }

  const settings = accData?.profileUsers?.[0]?.settings;
  if (!Array.isArray(settings)) throw new Error("Unexpected profile format.");

  const getSetting = (id) => settings.find((s) => s?.id === id)?.value ?? null;

  const gamerscore = Number.parseInt(String(getSetting("Gamerscore") ?? ""), 10);
  const displayName = getSetting("Gamertag") || best?.gamertag || wanted;
  const tier = getSetting("AccountTier") || null;
  const pfp = getSetting("GameDisplayPicRaw") || getSetting("GameDisplayPic") || null;

  if (!Number.isFinite(gamerscore)) throw new Error("Invalid gamerscore.");

  return { gamertag: displayName, gamerscore, tier, pfp };
}

// ===== Permissions-safe channel send =====
async function sendEmbedToChannel(guild, channelId, embed) {
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    console.log(`[SEND] Could not fetch channel ${channelId} (wrong ID or no permissions).`);
    return false;
  }

  const me = guild.members.me;
  if (me) {
    const perms = channel.permissionsFor(me);
    if (!perms?.has(PermissionsBitField.Flags.SendMessages)) {
      console.log("[SEND] Missing SendMessages permission.");
      return false;
    }
    if (!perms?.has(PermissionsBitField.Flags.EmbedLinks)) {
      console.log("[SEND] Missing EmbedLinks permission.");
      return false;
    }
  }

  await channel.send({ embeds: [embed] });
  return true;
}

// ===== Extract gamertags from embed (description + fields) =====
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

    // Accept bullet styles: • Name, - Name, - **Name**
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

// ===== Auto-scrub queue =====
const queue = [];
let working = false;

function enqueueGamertag(gt, guild, sourceChannelId) {
  const clean = normalizeGamertag(gt);
  const k = gtKey(clean);
  if (!k) return;

  // Skip already checked (avoids re-checking the same gamertag over and over)
  if (state.checked.has(k)) return;

  queue.push({ gt: clean, k, guild, sourceChannelId });
  void processQueue();
}

function addPendingFlag(profile) {
  const k = gtKey(profile.gamertag);
  if (!k) return;

  const existing = state.pending.get(k);
  const t = nowMs();

  if (!existing) {
    state.pending.set(k, {
      gamertag: profile.gamertag,
      gamerscore: profile.gamerscore,
      firstSeenMs: t,
      lastSeenMs: t,
    });
  } else {
    existing.gamertag = profile.gamertag;
    existing.gamerscore = profile.gamerscore;
    existing.lastSeenMs = t;
  }

  saveState();
}

async function processQueue() {
  if (working) return;
  working = true;

  try {
    while (queue.length) {
      const item = queue.shift();
      if (!item) continue;
      if (state.checked.has(item.k)) continue;

      // Mark checked immediately (prevents duplicate bursts)
      state.checked.add(item.k);
      saveState();

      console.log(`[CHECK] ${item.gt}`);

      try {
        const profile = await fetchOpenXblProfile(item.gt);

        if (profile.gamerscore >= GS_THRESHOLD) {
          console.log(`[OK] ${profile.gamertag} GS=${profile.gamerscore} (ignored)`);
        } else {
          console.log(`[FLAGGED] ${profile.gamertag} GS=${profile.gamerscore} (queued for digest)`);
          addPendingFlag(profile);

          if (IMMEDIATE_FLAG_LOGS && item.guild) {
            const embed = new EmbedBuilder()
              .setTitle("XCHECK FLAGGED")
              .addFields(
                { name: "Gamertag", value: profile.gamertag, inline: true },
                { name: "Gamerscore", value: String(profile.gamerscore), inline: true },
                { name: "Result", value: "FLAGGED", inline: false }
              )
              .setColor(0xff0000)
              .setTimestamp();

            if (profile.tier) embed.addFields({ name: "Tier", value: profile.tier, inline: true });
            if (profile.pfp) embed.setThumbnail(profile.pfp);
            if (item.sourceChannelId) embed.addFields({ name: "Source", value: `<#${item.sourceChannelId}>`, inline: true });

            await sendEmbedToChannel(item.guild, MODLOG_CHANNEL_ID, embed);
          }
        }
      } catch (err) {
        console.error(`[ERROR] ${item.gt}:`, err?.message ?? err);
      }

      if (SCRUB_DELAY_MS > 0) await sleep(SCRUB_DELAY_MS);
    }
  } finally {
    working = false;
  }
}

// ===== Polling =====
async function pollOnlineList() {
  const channel = await client.channels.fetch(ONLINE_LIST_CHANNEL_ID).catch(() => null);
  if (!channel || !("messages" in channel)) {
    console.log("[POLL] Could not fetch online list channel (wrong ID or no permissions).");
    return;
  }

  const messages = await channel.messages.fetch({ limit: 5 }).catch(() => null);
  if (!messages) {
    console.log("[POLL] Could not read messages (missing Read Message History?).");
    return;
  }

  const newest = messages.first();
  if (!newest) return;

  const gts = extractGamertagsFromEmbeds(newest);
  console.log(`[ONLINE LIST POLL] embeds=${newest.embeds?.length ?? 0} extracted=${gts.length}`);

  for (const gt of gts) enqueueGamertag(gt, newest.guild, newest.channelId);
}

// ===== Daily digest =====
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

async function sendDailyDigestIfDue() {
  const intervalMs = DIGEST_INTERVAL_HOURS * 60 * 60 * 1000;
  const now = nowMs();

  if (state.lastDigestMs && (now - state.lastDigestMs) < intervalMs) {
    return; // not due
  }

  // Only include pending flagged seen since last digest
  const cutoff = state.lastDigestMs || (now - intervalMs);
  const items = Array.from(state.pending.values())
    .filter((v) => (v?.lastSeenMs ?? 0) >= cutoff)
    .sort((a, b) => (a.gamertag || "").localeCompare(b.gamertag || ""));

  if (items.length === 0) {
    console.log("[DIGEST] Due, but nothing pending. Updating lastDigestMs anyway.");
    state.lastDigestMs = now;
    // Clear pending anyway (keeps state tidy)
    state.pending = new Map();
    saveState();
    return;
  }

  // Find a guild context by fetching the digest channel (we need guild for permissions + send)
  const digestChan = await client.channels.fetch(DIGEST_CHANNEL_ID).catch(() => null);
  if (!digestChan || !digestChan.guild) {
    console.log("[DIGEST] Could not fetch digest channel or guild context.");
    return;
  }

  const lines = items.map((v) => `${v.gamertag} (${v.gamerscore})`);

  // Discord embed description max is 4096, keep safe
  const chunks = chunkLines(lines, 3500);

  for (let i = 0; i < chunks.length; i++) {
    const embed = new EmbedBuilder()
      .setTitle("Daily Low Gamerscore List")
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

  console.log(`[DIGEST] Sent ${items.length} flagged gamertags in ${chunks.length} message(s).`);

  // Mark digest as sent: clear pending and set lastDigestMs = now
  state.lastDigestMs = now;
  state.pending = new Map();
  saveState();
}

// Check digest due-ness frequently (cheap)
function startDigestTimer() {
  setInterval(() => {
    sendDailyDigestIfDue().catch((e) => console.error("[DIGEST] error:", e));
  }, 60 * 1000); // check every minute
}

// ===== /xcheck =====
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "xcheck") return;

  try {
    await interaction.deferReply();

    const gamertagInput = normalizeGamertag(interaction.options.getString("gamertag", true));
    const profile = await fetchOpenXblProfile(gamertagInput);

    const flagged = profile.gamerscore < GS_THRESHOLD;

    const embed = new EmbedBuilder()
      .setTitle("Xbox Gamerscore Check")
      .addFields(
        { name: "Gamertag", value: profile.gamertag, inline: true },
        { name: "Gamerscore", value: String(profile.gamerscore), inline: true },
        { name: "Result", value: flagged ? "FLAGGED" : "OK", inline: false }
      )
      .setColor(flagged ? 0xff0000 : 0x00ff00)
      .setTimestamp();

    if (profile.tier) embed.addFields({ name: "Tier", value: profile.tier, inline: true });
    if (profile.pfp) embed.setThumbnail(profile.pfp);

    await interaction.editReply({ embeds: [embed] });

    // Manual checks do NOT add to digest by default (but you can change this if you want)
  } catch (err) {
    console.error("xcheck error:", err?.message ?? err);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply("Could not retrieve gamerscore.");
      } else {
        await interaction.reply({ content: "Could not retrieve gamerscore.", ephemeral: true });
      }
    } catch {}
  }
});

// ===== Ready =====
client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // Poll immediately on start
  await pollOnlineList().catch((e) => console.error("[POLL] error:", e));

  // Poll on interval
  setInterval(() => {
    pollOnlineList().catch((e) => console.error("[POLL] error:", e));
  }, POLL_SECONDS * 1000);

  // Start digest timer (checks every minute, sends only when due)
  startDigestTimer();

  // Also try sending digest immediately if overdue (helps after downtime)
  await sendDailyDigestIfDue().catch((e) => console.error("[DIGEST] error:", e));
});

client.login(DISCORD_TOKEN);
