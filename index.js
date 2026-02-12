import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  PermissionsBitField,
} from "discord.js";
import fetch from "node-fetch";

// ====== ENV VARS ======
const DISCORD_TOKEN = (process.env.DISCORD_TOKEN ?? "").trim();
const XBL_API_KEY = (process.env.XBL_API_KEY ?? "").trim();

const GS_THRESHOLD = Number.parseInt((process.env.GS_THRESHOLD ?? "1000").trim(), 10);
const MODLOG_CHANNEL_ID = (process.env.MODLOG_CHANNEL_ID ?? "").trim(); // optional
const COOLDOWN_SECONDS = Number.parseInt((process.env.COOLDOWN_SECONDS ?? "10").trim(), 10);

if (!DISCORD_TOKEN) {
  console.error("Missing DISCORD_TOKEN env var.");
  process.exit(1);
}
if (!XBL_API_KEY) {
  console.error("Missing XBL_API_KEY env var (OpenXBL API key).");
  process.exit(1);
}
if (Number.isNaN(GS_THRESHOLD)) {
  console.error("GS_THRESHOLD must be a valid integer.");
  process.exit(1);
}
if (Number.isNaN(COOLDOWN_SECONDS) || COOLDOWN_SECONDS < 0) {
  console.error("COOLDOWN_SECONDS must be a valid non-negative integer.");
  process.exit(1);
}

// ====== CLIENT ======
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// Simple per-user cooldown map: userId -> unix ms timestamp when next allowed
const cooldowns = new Map();

/**
 * OpenXBL request: Search by gamertag -> get XUID -> fetch account profile settings (Gamerscore).
 */
async function fetchOpenXblProfile(gamertag) {
  const base = "https://xbl.io/api/v2";
  const wanted = gamertag.trim();
  const wantedLower = wanted.toLowerCase();

  // 1) Search by gamertag
  const searchUrl = `${base}/search/${encodeURIComponent(wanted)}`;
  const searchRes = await fetch(searchUrl, {
    method: "GET",
    headers: {
      "X-Authorization": XBL_API_KEY,
      "Accept": "application/json",
    },
  });

  const searchText = await searchRes.text();
  let searchData;
  try {
    searchData = JSON.parse(searchText);
  } catch {
    searchData = null;
  }

  if (!searchRes.ok) {
    const msg =
      searchData?.error ||
      searchData?.message ||
      `OpenXBL search failed (HTTP ${searchRes.status}).`;
    throw new Error(msg);
  }

  const people = searchData?.people;
  if (!Array.isArray(people) || people.length === 0) {
    throw new Error("No matching gamertag found (search returned 0 results).");
  }

  // best match preference: exact match on gamertag / modernGamertag, otherwise first result
  const best =
    people.find((p) => (p?.gamertag ?? "").toLowerCase() === wantedLower) ||
    people.find((p) => (p?.modernGamertag ?? "").toLowerCase() === wantedLower) ||
    people[0];

  const xuid = best?.xuid;
  if (!xuid) {
    throw new Error("Search result missing XUID.");
  }

  // 2) Fetch profile/account by XUID (returns profileUsers[0].settings)
  const accountUrl = `${base}/account/${encodeURIComponent(xuid)}`;
  const accRes = await fetch(accountUrl, {
    method: "GET",
    headers: {
      "X-Authorization": XBL_API_KEY,
      "Accept": "application/json",
    },
  });

  const accText = await accRes.text();
  let accData;
  try {
    accData = JSON.parse(accText);
  } catch {
    accData = null;
  }

  if (!accRes.ok) {
    const msg =
      accData?.error ||
      accData?.message ||
      `OpenXBL account failed (HTTP ${accRes.status}).`;
    throw new Error(msg);
  }

  const profileUser = accData?.profileUsers?.[0];
  const settings = profileUser?.settings;

  if (!profileUser || !Array.isArray(settings)) {
    throw new Error("Unexpected OpenXBL response format (missing profile settings).");
  }

  const getSetting = (id) => settings.find((s) => s?.id === id)?.value ?? null;

  const gamerscoreStr = getSetting("Gamerscore");
  const displayName = getSetting("Gamertag") || best?.gamertag || wanted;
  const tier = getSetting("AccountTier");
  const pfp = getSetting("GameDisplayPicRaw") || getSetting("GameDisplayPic");

  const gamerscore = Number.parseInt(String(gamerscoreStr ?? ""), 10);
  if (!Number.isFinite(gamerscore)) {
    throw new Error("Could not read Gamerscore from OpenXBL response.");
  }

  return { gamertag: displayName, gamerscore, tier: tier || null, pfp: pfp || null };
}

async function tryLogToModChannel(guild, embed) {
  if (!MODLOG_CHANNEL_ID) return;

  try {
    const channel = await guild.channels.fetch(MODLOG_CHANNEL_ID);
    if (!channel) return;

    // Only attempt if bot can send messages + embeds
    if ("permissionsFor" in channel) {
      const me = guild.members.me;
      if (!me) return;
      const perms = channel.permissionsFor(me);
      if (!perms?.has(PermissionsBitField.Flags.SendMessages)) return;
      if (!perms?.has(PermissionsBitField.Flags.EmbedLinks)) return;
    }

    await channel.send({ embeds: [embed] });
  } catch {
    // modlog is optional; ignore errors
  }
}

// NOTE: warning is fine; discord.js v15 will rename ready -> clientReady
client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`GS_THRESHOLD=${GS_THRESHOLD}, COOLDOWN_SECONDS=${COOLDOWN_SECONDS}`);
  if (MODLOG_CHANNEL_ID) console.log(`Modlog channel enabled: ${MODLOG_CHANNEL_ID}`);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "xcheck") return;

  const gamertagInput = interaction.options.getString("gamertag", true).trim();

  // Cooldown
  const now = Date.now();
  const nextAllowed = cooldowns.get(interaction.user.id) ?? 0;

  if (COOLDOWN_SECONDS > 0 && now < nextAllowed) {
    const remainingSec = Math.ceil((nextAllowed - now) / 1000);
    await interaction.reply({
      content: `Cooldown active. Try again in ${remainingSec}s.`,
      ephemeral: true,
    });
    return;
  }
  cooldowns.set(interaction.user.id, now + COOLDOWN_SECONDS * 1000);

  await interaction.deferReply({ ephemeral: false });

  try {
    const profile = await fetchOpenXblProfile(gamertagInput);
    const flagged = profile.gamerscore < GS_THRESHOLD;

    const embed = new EmbedBuilder()
      .setTitle("Xbox Gamerscore Check")
      .setDescription("OpenXBL lookup (search → xuid → account)")
      .addFields(
        { name: "Gamertag", value: profile.gamertag, inline: true },
        { name: "Gamerscore", value: String(profile.gamerscore), inline: true },
        { name: "Threshold", value: `< ${GS_THRESHOLD} = flagged`, inline: true },
        { name: "Result", value: flagged ? "**FLAGGED — low gamerscore**" : "**OK**", inline: false }
      )
      .setTimestamp()
      .setColor(flagged ? 0xff0000 : 0x00ff00);

    if (profile.tier) embed.addFields({ name: "Tier", value: profile.tier, inline: true });
    if (profile.pfp) embed.setThumbnail(profile.pfp);

    await interaction.editReply({ embeds: [embed] });

    // Mod log (optional)
    if (interaction.guild) {
      const logEmbed = EmbedBuilder.from(embed)
        .setTitle("XCHECK LOG")
        .addFields(
          { name: "Checked by", value: `${interaction.user.tag} (${interaction.user.id})`, inline: false },
          { name: "Channel", value: interaction.channel ? `<#${interaction.channel.id}>` : "Unknown", inline: true }
        );

      await tryLogToModChannel(interaction.guild, logEmbed);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error.";
    await interaction.editReply({
      content:
        `Could not retrieve gamerscore for \`${gamertagInput}\`.\n` +
        `Reason: ${msg}`,
    });
  }
});

client.login(DISCORD_TOKEN);
