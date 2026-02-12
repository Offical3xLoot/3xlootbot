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
const MODLOG_CHANNEL_ID = (process.env.MODLOG_CHANNEL_ID ?? "").trim();
const ONLINE_LIST_CHANNEL_ID = (process.env.ONLINE_LIST_CHANNEL_ID ?? "").trim();

const SCRUB_DELAY_MS = Number.parseInt((process.env.SCRUB_DELAY_MS ?? "1200").trim(), 10);
const POLL_SECONDS = Number.parseInt((process.env.POLL_SECONDS ?? "60").trim(), 10);

const DATA_DIR = (process.env.DATA_DIR ?? "./data").trim();

// Optional one-time reset
const RESET_CHECKED = (process.env.RESET_CHECKED ?? "").trim().toLowerCase() === "true";

// Optional: prints embed structure once on first poll (helpful debugging)
const DEBUG_EMBED_ONCE = (process.env.DEBUG_EMBED_ONCE ?? "true").trim().toLowerCase() === "true";
let didDebugEmbed = false;

function die(msg) {
  console.error(msg);
  process.exit(1);
}

if (!DISCORD_TOKEN) die("Missing DISCORD_TOKEN env var.");
if (!XBL_API_KEY) die("Missing XBL_API_KEY env var.");
if (!Number.isFinite(GS_THRESHOLD)) die("GS_THRESHOLD must be a valid integer.");
if (!Number.isFinite(SCRUB_DELAY_MS) || SCRUB_DELAY_MS < 0) die("SCRUB_DELAY_MS must be non-negative.");
if (!Number.isFinite(POLL_SECONDS) || POLL_SECONDS < 10) die("POLL_SECONDS must be >= 10.");

process.on("unhandledRejection", (err) => console.error("Unhandled rejection:", err));
process.on("uncaughtException", (err) => console.error("Uncaught exception:", err));

console.log("Booting 3xBot (XCHECK + AutoScrub Poll)...");
console.log(`THRESHOLD=${GS_THRESHOLD}`);
console.log(`ONLINE_LIST_CHANNEL_ID=${ONLINE_LIST_CHANNEL_ID || "MISSING"}`);
console.log(`MODLOG_CHANNEL_ID=${MODLOG_CHANNEL_ID || "MISSING"}`);
console.log(`SCRUB_DELAY_MS=${SCRUB_DELAY_MS}`);
console.log(`POLL_SECONDS=${POLL_SECONDS}`);
console.log(`DATA_DIR=${DATA_DIR}`);

// ===== Persistence =====
fs.mkdirSync(DATA_DIR, { recursive: true });
const CHECKED_FILE = path.resolve(DATA_DIR, "checked_gamertags.json");

function normalizeGamertag(s) {
  return (s ?? "").replace(/\s+/g, " ").trim();
}
function gtKey(s) {
  return normalizeGamertag(s).toLowerCase();
}

function loadCheckedSet() {
  try {
    const raw = fs.readFileSync(CHECKED_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed?.checked) ? parsed.checked : [];
    return new Set(arr.map((x) => String(x)).filter(Boolean));
  } catch {
    return new Set();
  }
}

function saveCheckedSet(set) {
  try {
    const out = { checked: Array.from(set.values()).sort((a, b) => a.localeCompare(b)) };
    fs.writeFileSync(CHECKED_FILE, JSON.stringify(out, null, 2), "utf8");
  } catch (err) {
    console.error("Failed saving checked list:", err?.message ?? err);
  }
}

let checked = loadCheckedSet();
if (RESET_CHECKED) {
  console.log("RESET_CHECKED=true -> clearing checked list.");
  checked = new Set();
  saveCheckedSet(checked);
}
console.log(`Checked loaded: ${checked.size} gamertags`);

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
    try { data = JSON.parse(text); } catch { data = null; }
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

// ===== Modlog send =====
async function sendToModlog(guild, embed) {
  if (!MODLOG_CHANNEL_ID) return;

  const channel = await guild.channels.fetch(MODLOG_CHANNEL_ID).catch(() => null);
  if (!channel) {
    console.log("[MODLOG] Could not fetch modlog channel (wrong ID or no permissions).");
    return;
  }

  const me = guild.members.me;
  if (me) {
    const perms = channel.permissionsFor(me);
    if (!perms?.has(PermissionsBitField.Flags.SendMessages)) {
      console.log("[MODLOG] Missing SendMessages permission.");
      return;
    }
    if (!perms?.has(PermissionsBitField.Flags.EmbedLinks)) {
      console.log("[MODLOG] Missing EmbedLinks permission.");
      return;
    }
  }

  await channel.send({ embeds: [embed] });
}

// ===== Strong extractor: reads description + fields =====
function stripMarkdown(s) {
  return (s ?? "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .trim();
}

function extractGamertagsFromAnyEmbed(msg) {
  const embeds = msg.embeds ?? [];
  if (!embeds.length) return [];

  // Collect all possible text areas from all embeds
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

  const joined = chunks.join("\n");
  if (DEBUG_EMBED_ONCE && !didDebugEmbed) {
    didDebugEmbed = true;
    console.log(`[DEBUG] embed_count=${embeds.length} combined_text_len=${joined.length}`);
    console.log(`[DEBUG] field_counts=${embeds.map(e => Array.isArray(e?.fields) ? e.fields.length : 0).join(",")}`);
  }

  const lines = joined.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const out = [];
  const seen = new Set();

  for (let line of lines) {
    line = stripMarkdown(line);

    // Skip obvious header lines
    const lower = line.toLowerCase();
    if (lower.includes("online list") && lower.includes("players")) continue;
    if (lower === "3xloot") continue;

    // Accept bullet styles:
    // • Name
    // - Name
    // - **Name**
    // • **Name**
    line = line.replace(/^[•\-]+\s*/, "").trim();
    line = stripMarkdown(line);

    const gt = normalizeGamertag(line);

    // sanity limits + allowed chars
    if (gt.length < 2 || gt.length > 20) continue;
    if (!/^[a-zA-Z0-9 _.\-]+$/.test(gt)) continue;

    const k = gtKey(gt);
    if (seen.has(k)) continue;
    seen.add(k);

    out.push(gt);
  }

  return out;
}

// ===== Queue =====
const queue = [];
let working = false;

function enqueueGamertag(gt, guild, sourceChannelId) {
  const clean = normalizeGamertag(gt);
  const k = gtKey(clean);
  if (!k) return;

  if (checked.has(k)) return;

  queue.push({ gt: clean, k, guild, sourceChannelId });
  void processQueue();
}

async function processQueue() {
  if (working) return;
  working = true;

  try {
    while (queue.length) {
      const item = queue.shift();
      if (!item) continue;
      if (checked.has(item.k)) continue;

      checked.add(item.k);
      saveCheckedSet(checked);

      console.log(`[CHECK] ${item.gt}`);

      try {
        const profile = await fetchOpenXblProfile(item.gt);

        if (profile.gamerscore >= GS_THRESHOLD) {
          console.log(`[OK] ${profile.gamertag} GS=${profile.gamerscore} (ignored)`);
        } else {
          console.log(`[FLAGGED] ${profile.gamertag} GS=${profile.gamerscore}`);

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

          await sendToModlog(item.guild, embed);
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

// ===== Handlers + Polling =====
async function handleOnlineListMessage(msg, source) {
  if (!ONLINE_LIST_CHANNEL_ID) return;
  if (msg.channelId !== ONLINE_LIST_CHANNEL_ID) return;

  const gts = extractGamertagsFromAnyEmbed(msg);
  console.log(`[ONLINE LIST ${source}] embeds=${msg.embeds?.length ?? 0} extracted=${gts.length}`);

  if (gts.length) {
    console.log(`[ONLINE LIST ${source}] sample=${gts.slice(0, 5).join(", ")}`);
  }

  for (const gt of gts) enqueueGamertag(gt, msg.guild, msg.channelId);
}

client.on("messageCreate", async (msg) => {
  try { await handleOnlineListMessage(msg, "CREATE"); } catch (e) { console.error("messageCreate:", e); }
});

client.on("messageUpdate", async (_old, newMsg) => {
  try {
    const msg = newMsg.partial ? await newMsg.fetch() : newMsg;
    await handleOnlineListMessage(msg, "UPDATE");
  } catch (e) {
    console.error("messageUpdate:", e);
  }
});

let lastPolledMessageId = null;

async function pollOnlineList() {
  if (!ONLINE_LIST_CHANNEL_ID) return;

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
  if (!newest) {
    console.log("[POLL] No messages found.");
    return;
  }

  // NOTE: If Scheduler EDITS the same message, id won't change.
  // So we should process even if id is same, but only every poll.
  console.log(`[POLL] Newest message id=${newest.id} embeds=${newest.embeds?.length ?? 0}`);
  await handleOnlineListMessage(newest, "POLL");
}

client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  await pollOnlineList();
  setInterval(() => {
    pollOnlineList().catch((e) => console.error("[POLL] error:", e));
  }, POLL_SECONDS * 1000);
});

client.login(DISCORD_TOKEN);
