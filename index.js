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
const DIGEST_INTERVAL_HOURS = Number.parseInt((process.env.DIGEST_INTERVAL_HOURS ?? "1").trim(), 10);

const SCRUB_DELAY_MS = Number.parseInt((process.env.SCRUB_DELAY_MS ?? "1200").trim(), 10);
const POLL_SECONDS = Number.parseInt((process.env.POLL_SECONDS ?? "60").trim(), 10);

const DATA_DIR = (process.env.DATA_DIR ?? "./data").trim();

// Keep per-flag logs off (digest-only) unless you explicitly enable it
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
if (!ONLINE_LIST_CHANNEL_ID) console.log("WARNING: ONLINE_LIST_CHANNEL_ID missing (auto-scrub won’t run).");
if (!DIGEST_CHANNEL_ID) console.log("WARNING: DIGEST_CHANNEL_ID missing (digest won’t send).");
if (!Number.isFinite(DIGEST_INTERVAL_HOURS) || DIGEST_INTERVAL_HOURS < 1) die("DIGEST_INTERVAL_HOURS must be >= 1.");
if (!Number.isFinite(SCRUB_DELAY_MS) || SCRUB_DELAY_MS < 0) die("SCRUB_DELAY_MS must be non-negative.");
if (!Number.isFinite(POLL_SECONDS) || POLL_SECONDS < 10) die("POLL_SECONDS must be >= 10.");

process.on("unhandledRejection", (err) => console.error("Unhandled rejection:", err));
process.on("uncaughtException", (err) => console.error("Uncaught exception:", err));

console.log("Booting 3xBot (XCHECK + AutoScrub + Digest + XINFO)...");
console.log(`THRESHOLD=${GS_THRESHOLD}`);
console.log(`ONLINE_LIST_CHANNEL_ID=${ONLINE_LIST_CHANNEL_ID || "MISSING"}`);
console.log(`MODLOG_CHANNEL_ID=${MODLOG_CHANNEL_ID || "MISSING"}`);
console.log(`DIGEST_CHANNEL_ID=${DIGEST_CHANNEL_ID || "MISSING"}`);
console.log(`DIGEST_INTERVAL_HOURS=${DIGEST_INTERVAL_HOURS}`);
console.log(`IMMEDIATE_FLAG_LOGS=${IMMEDIATE_FLAG_LOGS}`);
console.log(`SCRUB_DELAY_MS=${SCRUB_DELAY_MS}`);
console.log(`POLL_SECONDS=${POLL_SECONDS}`);
console.log(`DATA_DIR=${DATA_DIR}`);

// ===== Persistence =====
fs.mkdirSync(DATA_DIR, { recursive: true });
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
    return { checked, pending, lastDigestMs };
  } catch {
    return { checked: new Set(), pending: new Map(), lastDigestMs: 0 };
  }
}

function saveState() {
  try {
    const pendingObj = {};
    for (const [k, v] of state.pending.entries()) pendingObj[k] = v;

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

// ===== OpenXBL helpers =====
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
  // Returns an object of found numeric values: { followerCount: 123, ... }
  const found = new Map();

  const visit = (x) => {
    if (!x || typeof x !== "object") return;

    if (Array.isArray(x)) {
      for (const it of x) visit(it);
      return;
    }

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

async function openXblSearch(gamertag) {
  const base = "https://xbl.io/api/v2";
  const wanted = normalizeGamertag(gamertag);

  const url = `${base}/search/${encodeURIComponent(wanted)}`;
  const { res, data } = await fetchJsonWithTimeout(
    url,
    {
      method: "GET",
      headers: { "X-Authorization": XBL_API_KEY, Accept: "application/json" },
    },
    8000
  );

  if (!res.ok) {
    const msg = data?.error || data?.message || `OpenXBL search failed (HTTP ${res.status}).`;
    throw new Error(msg);
  }

  const people = data?.people;
  if (!Array.isArray(people) || people.length === 0) throw new Error("Gamertag not found.");

  // prefer exact case-insensitive match if possible
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

  const { res, data } = await fetchJsonWithTimeout(
    url,
    {
      method: "GET",
      headers: { "X-Authorization": XBL_API_KEY, Accept: "application/json" },
    },
    8000
  );

  if (!res.ok) {
    const msg = data?.error || data?.message || `OpenXBL account failed (HTTP ${res.status}).`;
    throw new Error(msg);
  }

  return data;
}

/**
 * Returns a merged profile:
 * - search person object
 * - account settings map (Xbox profile settings)
 * - derived fields (gamerscore, tier, rep, etc.)
 */
async function fetchOpenXblMergedProfile(gamertag) {
  const person = await openXblSearch(gamertag);
  const xuid = person.xuid;

  const accData = await openXblAccount(xuid);
  const settingsArr = accData?.profileUsers?.[0]?.settings;
  const settingsMap = settingsToMap(settingsArr);

  // Core
  const displayGamertag =
    readSetting(settingsMap, "Gamertag") ||
    person.gamertag ||
    normalizeGamertag(gamertag);

  const gamerscore =
    parseIntOrNull(readSetting(settingsMap, "Gamerscore")) ??
    parseIntOrNull(person.gamerscore) ??
    null;

  const tier = readSetting(settingsMap, "AccountTier") || person?.detail?.accountTier || null;

  // Pictures
  const gamerpic =
    readSetting(settingsMap, "GameDisplayPicRaw", "GameDisplayPic") ||
    person?.displayPicRaw ||
    person?.displayPic ||
    null;

  // Bio / Location / Tenure (keys vary, try multiple)
  const bio =
    readSetting(settingsMap, "Bio") ||
    person?.detail?.bio ||
    null;

  const location =
    readSetting(settingsMap, "Location") ||
    person?.detail?.location ||
    null;

  const tenure =
    readSetting(settingsMap, "TenureLevel") ||
    person?.detail?.tenureLevel ||
    null;

  // Presence / last seen (varies by response)
  const presenceState =
    person?.presenceState ||
    person?.presence?.state ||
    null;

  const presenceText =
    person?.presenceText ||
    person?.presence?.text ||
    null;

  const lastSeen =
    person?.detail?.lastSeenTimestamp ||
    person?.lastSeenDateTimeUtc ||
    person?.detail?.lastSeenDateTimeUtc ||
    null;

  // Xbox rep (commonly xboxOneRep)
  const xboxRep =
    person?.xboxOneRep ||
    person?.detail?.xboxOneRep ||
    null;

  // Game Pass (if returned anywhere)
  const hasGamePass =
    person?.detail?.hasGamePass ??
    person?.hasGamePass ??
    null;

  // Social counts (only if real numbers exist)
  const keyNamesLower = new Set([
    "followerscount",
    "followercount",
    "followingcount",
    "friendscount",
    "friendcount",
  ]);
  const socialNums = deepFindNumbers({ person, accData }, keyNamesLower);

  // Normalize to canonical names if present
  const followerCount =
    socialNums["followercount"] ?? socialNums["followerscount"] ?? null;
  const followingCount =
    socialNums["followingcount"] ?? null;
  const friendCount =
    socialNums["friendcount"] ?? socialNums["friendscount"] ?? null;

  return {
    // raw-ish
    person,
    accData,

    // fields
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

// ===== Embed helpers (omit empties) =====
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

function formatLastSeen(v) {
  // If it's already a readable string, keep it
  const s = String(v ?? "").trim();
  if (!s) return "";
  return s;
}

// ===== Auto-scrub extraction from embed (description + fields) =====
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

// ===== Digest + pending flagged =====
function addPendingFlag(profile) {
  const k = gtKey(profile.gamertag);
  if (!k) return;

  const existing = state.pending.get(k);
  const t = nowMs();

  if (!existing) {
    state.pending.set(k, {
      gamertag: profile.gamertag,
      gamerscore: profile.gamerscore ?? 0,
      firstSeenMs: t,
      lastSeenMs: t,
    });
  } else {
    existing.gamertag = profile.gamertag;
    if (profile.gamerscore !== null && profile.gamerscore !== undefined) {
      existing.gamerscore = profile.gamerscore;
    }
    existing.lastSeenMs = t;
  }

  saveState();
}

async function sendEmbedToChannel(guild, channelId, embed) {
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    console.log(`[SEND] Could not fetch channel ${channelId} (wrong ID or no permissions).`);
    return false;
  }

  const me = guild.members.me;
  if (me) {
    const perms = channel.permissionsFor(me);
    if (!perms?.has(PermissionsBitField.Flags.SendMessages)) return false;
    if (!perms?.has(PermissionsBitField.Flags.EmbedLinks)) return false;
  }

  await channel.send({ embeds: [embed] });
  return true;
}

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

async function sendDigestIfDue() {
  if (!DIGEST_CHANNEL_ID) return;

  const intervalMs = DIGEST_INTERVAL_HOURS * 60 * 60 * 1000;
  const now = nowMs();
  if (state.lastDigestMs && (now - state.lastDigestMs) < intervalMs) return;

  const cutoff = state.lastDigestMs || (now - intervalMs);

  const items = Array.from(state.pending.values())
    .filter((v) => (v?.lastSeenMs ?? 0) >= cutoff)
    .sort((a, b) => (a.gamertag || "").localeCompare(b.gamertag || ""));

  const digestChan = await client.channels.fetch(DIGEST_CHANNEL_ID).catch(() => null);
  if (!digestChan || !digestChan.guild) {
    console.log("[DIGEST] Could not fetch digest channel or guild context.");
    return;
  }

  if (items.length === 0) {
    console.log("[DIGEST] Due, but nothing pending. Updating lastDigestMs.");
    state.lastDigestMs = now;
    state.pending = new Map();
    saveState();
    return;
  }

  const lines = items.map((v) => v.gamertag); // clean list: just gamertags
  const chunks = chunkLines(lines, 3500);

  for (let i = 0; i < chunks.length; i++) {
    const embed = new EmbedBuilder()
      .setTitle("Low Gamerscore Watchlist (Last Hour)")
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

// ===== Auto-scrub queue =====
const queue = [];
let working = false;

function enqueueGamertag(gt, guild, sourceChannelId) {
  const clean = normalizeGamertag(gt);
  const k = gtKey(clean);
  if (!k) return;
  if (state.checked.has(k)) return;

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
      if (state.checked.has(item.k)) continue;

      // mark checked immediately
      state.checked.add(item.k);
      saveState();

      console.log(`[CHECK] ${item.gt}`);

      try {
        const merged = await fetchOpenXblMergedProfile(item.gt);
        const gs = merged.gamerscore;

        // Ignore unknown GS
        if (gs === null) {
          console.log(`[OK] ${merged.gamertag} GS=unknown (ignored)`);
        } else if (gs >= GS_THRESHOLD) {
          console.log(`[OK] ${merged.gamertag} GS=${gs} (ignored)`);
        } else {
          console.log(`[FLAGGED] ${merged.gamertag} GS=${gs} (queued for digest)`);
          addPendingFlag({ gamertag: merged.gamertag, gamerscore: gs });

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
        console.error(`[ERROR] ${item.gt}:`, err?.message ?? err);
      }

      if (SCRUB_DELAY_MS > 0) await sleep(SCRUB_DELAY_MS);
    }
  } finally {
    working = false;
  }
}

// ===== Polling online list =====
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
  if (!newest) return;

  const gts = extractGamertagsFromEmbeds(newest);
  console.log(`[ONLINE LIST POLL] embeds=${newest.embeds?.length ?? 0} extracted=${gts.length}`);

  for (const gt of gts) enqueueGamertag(gt, newest.guild, newest.channelId);
}

// ===== /xcheck + /xinfo =====
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const name = interaction.commandName;

  if (name !== "xcheck" && name !== "xinfo") return;

  try {
    await interaction.deferReply();

    const gamertagInput = normalizeGamertag(interaction.options.getString("gamertag", true));
    const merged = await fetchOpenXblMergedProfile(gamertagInput);

    // Shared visuals
    const flaggedByGS = (merged.gamerscore !== null) ? merged.gamerscore < GS_THRESHOLD : false;

    if (name === "xcheck") {
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

    // ===== /xinfo output =====
    // Professional layout, only show fields that exist.
    // Social warning if counts are explicitly 0 (not blank).
    const embed = new EmbedBuilder()
      .setTitle("Xbox Profile Info")
      .setColor(flaggedByGS ? 0xff4d4d : 0x2b2d31) // subtle; flagged slightly red
      .setTimestamp();

    if (merged.gamerpic) embed.setThumbnail(merged.gamerpic);

    // Identity
    addFieldIf(embed, "Gamertag", merged.gamertag, true);
    addFieldIf(embed, "XUID", merged.xuid ? String(merged.xuid) : "", true);

    // Stats
    if (merged.gamerscore !== null) addFieldIf(embed, "Gamerscore", String(merged.gamerscore), true);
    addFieldIf(embed, "Account Tier", merged.tier ? String(merged.tier) : "", true);
    addFieldIf(embed, "Xbox Rep", merged.xboxRep ? String(merged.xboxRep) : "", true);

    // Presence
    addFieldIf(embed, "Presence", merged.presenceState ? String(merged.presenceState) : "", true);
    addFieldIf(embed, "Status", merged.presenceText ? String(merged.presenceText) : "", true);
    addFieldIf(embed, "Last Seen", merged.lastSeen ? formatLastSeen(merged.lastSeen) : "", false);

    // Profile details
    addFieldIf(embed, "Bio", merged.bio ? String(merged.bio) : "", false);
    addFieldIf(embed, "Location", merged.location ? String(merged.location) : "", true);
    addFieldIf(embed, "Tenure", merged.tenure ? String(merged.tenure) : "", true);

    // Game Pass
    // Only include if it's a real boolean or "true/false-like" value
    if (merged.hasGamePass === true || merged.hasGamePass === false) {
      addFieldIf(embed, "Game Pass", formatBool(merged.hasGamePass), true);
    } else if (typeof merged.hasGamePass === "string" && merged.hasGamePass.trim() !== "") {
      // Some responses might give string-ish values
      addFieldIf(embed, "Game Pass", merged.hasGamePass.trim(), true);
    }

    // Social counts (ONLY if actual numbers exist)
    const hasFollowerCount = typeof merged.followerCount === "number";
    const hasFollowingCount = typeof merged.followingCount === "number";
    const hasFriendCount = typeof merged.friendCount === "number";

    if (hasFollowerCount) addFieldIf(embed, "Followers", String(merged.followerCount), true);
    if (hasFollowingCount) addFieldIf(embed, "Following", String(merged.followingCount), true);
    if (hasFriendCount) addFieldIf(embed, "Friends", String(merged.friendCount), true);

    // Flag “actually 0” (not blank/missing)
    const zeros = [];
    if (hasFollowerCount && merged.followerCount === 0) zeros.push("Followers=0");
    if (hasFollowingCount && merged.followingCount === 0) zeros.push("Following=0");
    if (hasFriendCount && merged.friendCount === 0) zeros.push("Friends=0");

    if (zeros.length > 0) {
      embed.addFields({
        name: "⚠️ Social Looks Empty",
        value: zeros.join(" • "),
        inline: false,
      });
    }

    // Footer “data may be limited by privacy”
    embed.setFooter({ text: "Note: Some fields may be unavailable due to Xbox privacy settings." });

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error("interaction error:", err?.message ?? err);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply("Could not retrieve profile info.");
      } else {
        await interaction.reply({ content: "Could not retrieve profile info.", ephemeral: true });
      }
    } catch {}
  }
});

// ===== Ready =====
client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // Poll immediately
  await pollOnlineList().catch((e) => console.error("[POLL] error:", e));

  // Poll on interval
  setInterval(() => {
    pollOnlineList().catch((e) => console.error("[POLL] error:", e));
  }, POLL_SECONDS * 1000);

  // Digest checker every minute (only sends when due)
  setInterval(() => {
    sendDigestIfDue().catch((e) => console.error("[DIGEST] error:", e));
  }, 60 * 1000);

  // Try digest immediately if overdue
  await sendDigestIfDue().catch((e) => console.error("[DIGEST] error:", e));
});

client.login(DISCORD_TOKEN);
