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

const SCRUB_DELAY_MS = Number.parseInt((process.env.SCRUB_DELAY_MS ?? "1200").trim(), 10);
const POLL_SECONDS = Number.parseInt((process.env.POLL_SECONDS ?? "60").trim(), 10);

const DATA_DIR = (process.env.DATA_DIR ?? "./data").trim();
const IMMEDIATE_FLAG_LOGS = (process.env.IMMEDIATE_FLAG_LOGS ?? "false").trim().toLowerCase() === "true";
const RESET_STATE = (process.env.RESET_STATE ?? "").trim().toLowerCase() === "true";

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

// ===== Auto-deploy slash commands on startup =====
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
  ].map((c) => c.toJSON());

  try {
    console.log("[COMMANDS] Deploying guild commands...");
    const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
    await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, GUILD_ID), {
      body: commands,
    });
    console.log("[COMMANDS] Done. /xcheck and /xinfo registered.");
  } catch (err) {
    console.error("[COMMANDS] Deploy failed:", err?.message ?? err);
  }
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

// ===== OpenXBL =====
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

async function openXblSearch(gamertag) {
  const base = "https://xbl.io/api/v2";
  const wanted = normalizeGamertag(gamertag);
  const url = `${base}/search/${encodeURIComponent(wanted)}`;

  const { res, data } = await fetchJsonWithTimeout(
    url,
    { method: "GET", headers: { "X-Authorization": XBL_API_KEY, Accept: "application/json" } },
    8000
  );

  if (!res.ok) throw new Error(data?.error || data?.message || `Search failed (HTTP ${res.status})`);

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

  const { res, data } = await fetchJsonWithTimeout(
    url,
    { method: "GET", headers: { "X-Authorization": XBL_API_KEY, Accept: "application/json" } },
    8000
  );

  if (!res.ok) throw new Error(data?.error || data?.message || `Account failed (HTTP ${res.status})`);
  return data;
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

  // social counts if returned as true numbers anywhere
  const keyNamesLower = new Set(["followerscount", "followercount", "followingcount", "friendscount", "friendcount"]);
  const socialNums = deepFindNumbers({ person, accData }, keyNamesLower);

  const followerCount = socialNums["followercount"] ?? socialNums["followerscount"] ?? null;
  const followingCount = socialNums["followingcount"] ?? null;
  const friendCount = socialNums["friendcount"] ?? socialNums["friendscount"] ?? null;

  return {
    person, accData,
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

// ===== /xcheck + /xinfo =====
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "xcheck" && interaction.commandName !== "xinfo") return;

  try {
    await interaction.deferReply();

    const gamertagInput = normalizeGamertag(interaction.options.getString("gamertag", true));
    const merged = await fetchOpenXblMergedProfile(gamertagInput);

    const flaggedByGS = merged.gamerscore !== null ? merged.gamerscore < GS_THRESHOLD : false;

    if (interaction.commandName === "xcheck") {
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

    // /xinfo (professional + omit empties)
    const embed = new EmbedBuilder()
      .setTitle("Xbox Profile Info")
      .setColor(flaggedByGS ? 0xff4d4d : 0x2b2d31)
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
    addFieldIf(embed, "Last Seen", merged.lastSeen ? String(merged.lastSeen) : "", false);

    // Profile details
    addFieldIf(embed, "Bio", merged.bio ? String(merged.bio) : "", false);
    addFieldIf(embed, "Location", merged.location ? String(merged.location) : "", true);
    addFieldIf(embed, "Tenure", merged.tenure ? String(merged.tenure) : "", true);

    // Game Pass
    if (merged.hasGamePass === true || merged.hasGamePass === false) {
      addFieldIf(embed, "Game Pass", formatBool(merged.hasGamePass), true);
    } else if (typeof merged.hasGamePass === "string" && merged.hasGamePass.trim() !== "") {
      addFieldIf(embed, "Game Pass", merged.hasGamePass.trim(), true);
    }

    // Social counts only if true numbers exist
    const hasFollowerCount = typeof merged.followerCount === "number";
    const hasFollowingCount = typeof merged.followingCount === "number";
    const hasFriendCount = typeof merged.friendCount === "number";

    if (hasFollowerCount) addFieldIf(embed, "Followers", String(merged.followerCount), true);
    if (hasFollowingCount) addFieldIf(embed, "Following", String(merged.followingCount), true);
    if (hasFriendCount) addFieldIf(embed, "Friends", String(merged.friendCount), true);

    // Only flag “actually 0”, not blank/missing
    const zeros = [];
    if (hasFollowerCount && merged.followerCount === 0) zeros.push("Followers=0");
    if (hasFollowingCount && merged.followingCount === 0) zeros.push("Following=0");
    if (hasFriendCount && merged.friendCount === 0) zeros.push("Friends=0");

    if (zeros.length) {
      embed.addFields({ name: "⚠️ Social Looks Empty", value: zeros.join(" • "), inline: false });
    }

    embed.setFooter({ text: "Note: Some fields may be unavailable due to Xbox privacy settings." });

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error("interaction error:", err?.message ?? err);
    try {
      await interaction.editReply("Could not retrieve profile info.");
    } catch {}
  }
});

// ===== Ready =====
client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // Auto deploy commands (no Railway shell needed)
  await autoDeployCommandsIfEnabled();

  // (Everything else you already have can stay as-is; this file focuses on /xinfo visibility)
});

client.login(DISCORD_TOKEN);
