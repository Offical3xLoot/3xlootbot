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
const COOLDOWN_SECONDS = Number.parseInt((process.env.COOLDOWN_SECONDS ?? "10").trim(), 10);

const MODLOG_CHANNEL_ID = (process.env.MODLOG_CHANNEL_ID ?? "").trim(); // where flagged results go
const ONLINE_LIST_CHANNEL_ID = (process.env.ONLINE_LIST_CHANNEL_ID ?? "").trim(); // channel that contains online list

const SCRUB_DELAY_MS = Number.parseInt((process.env.SCRUB_DELAY_MS ?? "1200").trim(), 10);

function die(msg) {
  console.error(msg);
  process.exit(1);
}

if (!DISCORD_TOKEN) die("Missing DISCORD_TOKEN env var.");
if (!XBL_API_KEY) die("Missing XBL_API_KEY env var.");
if (!Number.isFinite(GS_THRESHOLD)) die("GS_THRESHOLD must be a valid integer.");
if (!Number.isFinite(COOLDOWN_SECONDS) || COOLDOWN_SECONDS < 0) die("COOLDOWN_SECONDS must be non-negative.");
if (!Number.isFinite(SCRUB_DELAY_MS) || SCRUB_DELAY_MS < 0) die("SCRUB_DELAY_MS must be non-negative.");

if (!ONLINE_LIST_CHANNEL_ID) {
  console.log("WARNING: ONLINE_LIST_CHANNEL_ID not set. Auto-scrub feature will be OFF.");
}

process.on("unhandledRejection", (err) => console.error("Unhandled rejection:", err));
process.on("uncaughtException", (err) => console.error("Uncaught exception:", err));

console.log("Booting 3xBot XCHECK...");
console.log(
  `Config: GS_THRESHOLD=${GS_THRESHOLD} | COOLDOWN_SECONDS=${COOLDOWN_SECONDS} | MODLOG=${MODLOG_CHANNEL_ID ? "ON" : "OFF"} | AUTO_SCRUB=${ONLINE_LIST_CHANNEL_ID ? "ON" : "OFF"} | SCRUB_DELAY_MS=${SCRUB_DELAY_MS}`
);

// ===== Checked store =====
const CHECKED_FILE = path.resolve(process.cwd(), "checked_gamertags.json");

function loadCheckedSet() {
  try {
    const raw = fs.readFileSync(CHECKED_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed?.checked) ? parsed.checked : [];
    return new Set(arr.map((s) => normalizeGamertag(String(s))).filter(Boolean));
  } catch {
    // if file missing/corrupt, start clean
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

let checkedGamertags = loadCheckedSet();

// ===== Discord client =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,      // needed for message create/update
    GatewayIntentBits.MessageContent,     // REQUIRED to read message text
  ],
  partials: [Partials.Message, Partials.Channel],
});

// /xcheck cooldowns: userId -> nextAllowedMs
const cooldowns = new Map();

// Auto-scrub queue
const scrubQueue = [];
let scrubWorking = false;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeGamertag(s) {
  if (!s) return "";
  // collapse whitespace
  return s.replace(/\s+/g, " ").trim();
}

// Heuristic parser for a “list of online gamertags” message.
// Works best when each gamertag is on its own line.
function extractGamertagsFromText(text) {
  if (!text) return [];
  const lines = text.split(/\r?\n/);

  const tags = [];
  for (let rawLine of lines) {
    let line = rawLine.trim();
    if (!line) continue;

    // strip common bullets/prefixes
    line = line.replace(/^[-•*>\u2022]+\s*/g, "");
    line = line.replace(/^\d+\)\s*/g, "");
    line = line.replace(/^\d+\.\s*/g, "");

    // ignore obvious headers
    const lower = line.toLowerCase();
    if (
      lower.includes("online") && lower.includes("players") ||
      lower.includes("online users") ||
      lower.includes("currently online") ||
      lower.startsWith("updated") ||
      lower.startsWith("last updated")
    ) {
      continue;
    }

    // If the line contains extra info like "GT - something", try to grab the first chunk
    // Prefer text inside backticks if present
    const backtick = line.match(/`([^`]+)`/);
    if (backtick?.[1]) line = backtick[1].trim();

    // Remove trailing status brackets like [alive], (xyz), etc.
    line = line.replace(/\s*[\[\(].*[\]\)]\s*$/g, "").trim();

    // Basic sanity limits for gamertag-ish strings:
    // - allow letters/numbers/spaces and a few symbols seen in tags
    // - ignore super long lines
    if (line.length < 2 || line.length > 20) continue;
    if (!/^[a-zA-Z0-9 _.\-]+$/.test(line)) continue;

    const gt = normalizeGamertag(line);
    if (!gt) continue;

    tags.push(gt);
  }

  // unique, preserve order
  const seen = new Set();
  const out = [];
  for (const t of tags) {
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
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

/**
 * OpenXBL flow:
 * 1) /search/{gamertag} -> people[] -> xuid
 * 2) /account/{xuid} -> settings -> gamerscore
 */
async function fetchOpenXblProfile(gamertag) {
  const base = "https://xbl.io/api/v2";
  const wanted = normalizeGamertag(gamertag);
  const wantedLower = wanted.toLowerCase();

  // 1) Search
  const searchUrl = `${base}/search/${encodeURIComponent(wanted)}`;
  const { res: searchRes, data: searchData } = await fetchJsonWithTimeout(
    searchUrl,
    {
      method: "GET",
      headers: {
        "X-Authorization": XBL_API_KEY,
        Accept: "application/json",
      },
    },
    8000
  );

  if (!searchRes.ok) {
    const msg =
      searchData?.error ||
      searchData?.message ||
      `OpenXBL search failed (HTTP ${searchRes.status}).`;
    throw new Error(msg);
  }

  const people = searchData?.people;
  if (!Array.isArray(people) || people.length === 0) {
    throw new Error("Gamertag not found.");
  }

  const best =
    people.find((p) => (p?.gamertag ?? "").toLowerCase() === wantedLower) ||
    people.find((p) => (p?.modernGamertag ?? "").toLowerCase() === wantedLower) ||
    people[0];

  const xuid = best?.xuid;
  if (!xuid) throw new Error("Search result missing XUID.");

  // 2) Account by XUID
  const accountUrl = `${base}/account/${encodeURIComponent(xuid)}`;
  const { res: accRes, data: accData } = await fetchJsonWithTimeout(
    accountUrl,
    {
      method: "GET",
      headers: {
        "X-Authorization": XBL_API_KEY,
        Accept: "application/json",
      },
    },
    8000
  );

  if (!accRes.ok) {
    const msg =
      accData?.error ||
      accData?.message ||
      `OpenXBL account failed (HTTP ${accRes.status}).`;
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

async function trySendToModlog(guild, embed) {
  if (!MODLOG_CHANNEL_ID) return;
  try {
    const channel = await guild.channels.fetch(MODLOG_CHANNEL_ID);
    if (!channel) return;

    const me = guild.members.me;
    if (!me) return;

    const perms = channel.permissionsFor(me);
    if (!perms?.has(PermissionsBitField.Flags.SendMessages)) return;
    if (!perms?.has(PermissionsBitField.Flags.EmbedLinks)) return;

    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error("Modlog send failed:", err?.message ?? err);
  }
}

function enqueueScrub(gamertag, context) {
  const normalized = normalizeGamertag(gamertag);
  if (!normalized) return;

  // ignore if already checked
  if (checkedGamertags.has(normalized)) return;

  scrubQueue.push({ gamertag: normalized, context });
  void processScrubQueue();
}

async function processScrubQueue() {
  if (scrubWorking) return;
  scrubWorking = true;

  try {
    while (scrubQueue.length > 0) {
      const item = scrubQueue.shift();
      if (!item) continue;

      // check again (queue could contain dupes)
      if (checkedGamertags.has(item.gamertag)) continue;

      // Mark as checked immediately to prevent duplicates piling up
      checkedGamertags.add(item.gamertag);
      saveCheckedSet(checkedGamertags);

      try {
        const profile = await fetchOpenXblProfile(item.gamertag);

        // Ignore above threshold (NO LOG)
        if (profile.gamerscore >= GS_THRESHOLD) {
          // still counted as checked, nothing else
        } else {
          // BELOW threshold: send bot log
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

          if (item.context?.guild) {
            embed.addFields({ name: "Source", value: `<#${item.context.sourceChannelId}>`, inline: true });
            await trySendToModlog(item.context.guild, embed);
          }
        }
      } catch (err) {
        // even if lookup fails, we still keep it "checked" to prevent hammering the API on repeats
        console.error(`Auto-scrub lookup failed for ${item.gamertag}:`, err?.message ?? err);
      }

      // rate-limit safety
      if (SCRUB_DELAY_MS > 0) await sleep(SCRUB_DELAY_MS);
    }
  } finally {
    scrubWorking = false;
  }
}

// ===== READY =====
client.once("clientReady", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

// ===== SLASH COMMAND (/xcheck) =====
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "xcheck") return;

  try {
    await interaction.deferReply();

    const gamertagInput = normalizeGamertag(interaction.options.getString("gamertag", true));

    // cooldown
    const now = Date.now();
    const nextAllowed = cooldowns.get(interaction.user.id) ?? 0;
    if (COOLDOWN_SECONDS > 0 && now < nextAllowed) {
      const remaining = Math.ceil((nextAllowed - now) / 1000);
      await interaction.editReply(`Cooldown active. Try again in ${remaining}s.`);
      return;
    }
    cooldowns.set(interaction.user.id, now + COOLDOWN_SECONDS * 1000);

    const profile = await fetchOpenXblProfile(gamertagInput);
    const flagged = profile.gamerscore < GS_THRESHOLD;

    // CLEAN OUTPUT (as you requested earlier)
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

    // If you ALSO want manual /xcheck to log only flagged, keep it like this:
    if (flagged && interaction.guild) {
      const logEmbed = EmbedBuilder.from(embed)
        .setTitle("XCHECK LOG")
        .addFields({ name: "Checked by", value: `${interaction.user.tag} (${interaction.user.id})` });
      await trySendToModlog(interaction.guild, logEmbed);
    }
  } catch (err) {
    console.error("xcheck error:", err);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply("Could not retrieve gamerscore.");
      } else {
        await interaction.reply({ content: "Could not retrieve gamerscore.", ephemeral: true });
      }
    } catch {
      // ignore
    }
  }
});

// ===== AUTO-SCRUB LISTENER =====
// This watches message creates/updates in ONLINE_LIST_CHANNEL_ID,
// extracts gamertags, and queues NEW ones for checking.
async function handleOnlineListMessage(msg) {
  if (!ONLINE_LIST_CHANNEL_ID) return;
  if (msg.channelId !== ONLINE_LIST_CHANNEL_ID) return;

  // Need message content
  const content = msg.content ?? "";
  if (!content) return;

  const tags = extractGamertagsFromText(content);
  if (tags.length === 0) return;

  const guild = msg.guild;
  if (!guild) return;

  for (const gt of tags) {
    enqueueScrub(gt, { guild, sourceChannelId: msg.channelId });
  }
}

client.on("messageCreate", async (msg) => {
  try {
    await handleOnlineListMessage(msg);
  } catch (err) {
    console.error("messageCreate handler error:", err);
  }
});

client.on("messageUpdate", async (_oldMsg, newMsg) => {
  try {
    // newMsg can be partial
    const msg = newMsg.partial ? await newMsg.fetch() : newMsg;
    await handleOnlineListMessage(msg);
  } catch (err) {
    console.error("messageUpdate handler error:", err);
  }
});

client.login(DISCORD_TOKEN);
