import { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField } from "discord.js";
import fetch from "node-fetch";

// ===== ENV =====
const DISCORD_TOKEN = (process.env.DISCORD_TOKEN ?? "").trim();
const XBL_API_KEY = (process.env.XBL_API_KEY ?? "").trim();

const GS_THRESHOLD = Number.parseInt((process.env.GS_THRESHOLD ?? "1000").trim(), 10);
const COOLDOWN_SECONDS = Number.parseInt((process.env.COOLDOWN_SECONDS ?? "10").trim(), 10);
const MODLOG_CHANNEL_ID = (process.env.MODLOG_CHANNEL_ID ?? "").trim(); // optional

function die(msg) {
  console.error(msg);
  process.exit(1);
}

if (!DISCORD_TOKEN) die("Missing DISCORD_TOKEN env var.");
if (!XBL_API_KEY) die("Missing XBL_API_KEY env var.");
if (!Number.isFinite(GS_THRESHOLD)) die("GS_THRESHOLD must be a valid integer.");
if (!Number.isFinite(COOLDOWN_SECONDS) || COOLDOWN_SECONDS < 0) die("COOLDOWN_SECONDS must be a non-negative integer.");

process.on("unhandledRejection", (err) => console.error("Unhandled rejection:", err));
process.on("uncaughtException", (err) => console.error("Uncaught exception:", err));

console.log("Booting 3xBot XCHECK...");
console.log(`Config: GS_THRESHOLD=${GS_THRESHOLD} | COOLDOWN_SECONDS=${COOLDOWN_SECONDS} | MODLOG=${MODLOG_CHANNEL_ID ? "ON" : "OFF"}`);

// ===== DISCORD CLIENT =====
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// cooldown map: userId -> nextAllowedMs
const cooldowns = new Map();

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
 * 1) GET /search/{gamertag} -> people[] -> best match -> xuid
 * 2) GET /account/{xuid} -> profileUsers[0].settings -> gamerscore, tier, pic
 */
async function fetchOpenXblProfile(gamertag) {
  const base = "https://xbl.io/api/v2";
  const wanted = gamertag.trim();
  const wantedLower = wanted.toLowerCase();

  // 1) Search
  const searchUrl = `${base}/search/${encodeURIComponent(wanted)}`;
  const { res: searchRes, data: searchData } = await fetchJsonWithTimeout(
    searchUrl,
    {
      method: "GET",
      headers: {
        "X-Authorization": XBL_API_KEY,
        "Accept": "application/json",
      },
    },
    8000
  );

  if (!searchRes.ok) {
    const msg = searchData?.error || searchData?.message || `OpenXBL search failed (HTTP ${searchRes.status}).`;
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
        "Accept": "application/json",
      },
    },
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

async function tryLogToModChannel(guild, embed) {
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
    console.error("Modlog failed:", err?.message ?? err);
  }
}

// v15 forward-compatible event name
client.once("clientReady", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "xcheck") return;

  try {
    // acknowledge fast to avoid "application did not respond"
    await interaction.deferReply();

    const gamertagInput = interaction.options.getString("gamertag", true).trim();

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

    // CLEAN OUTPUT (no lookup line, no threshold field)
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

    // Mod log
    if (interaction.guild) {
      const logEmbed = EmbedBuilder.from(embed)
        .setTitle("XCHECK LOG")
        .addFields({ name: "Checked by", value: `${interaction.user.tag} (${interaction.user.id})` });

      await tryLogToModChannel(interaction.guild, logEmbed);
    }
  } catch (err) {
    console.error("XCHECK error:", err);
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

client.login(DISCORD_TOKEN);
