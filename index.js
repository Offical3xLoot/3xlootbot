import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  PermissionsBitField,
} from "discord.js";
import fetch from "node-fetch";

// ====== ENV VARS ======
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const XBL_API_KEY = process.env.XBL_API_KEY;

// Required for command deployment, not required at runtime:
// CLIENT_ID, GUILD_ID (used by deploy-commands.js)

const GS_THRESHOLD = Number.parseInt(process.env.GS_THRESHOLD ?? "1000", 10);
const MODLOG_CHANNEL_ID = process.env.MODLOG_CHANNEL_ID || ""; // optional
const COOLDOWN_SECONDS = Number.parseInt(process.env.COOLDOWN_SECONDS ?? "10", 10);

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
 * Safely get a setting from OpenXBL settings array.
 */
function getSetting(settings, id) {
  if (!Array.isArray(settings)) return null;
  const found = settings.find((s) => s?.id === id);
  return found?.value ?? null;
}

/**
 * OpenXBL request: get account/profile by gamertag.
 * NOTE: Endpoint shape can vary; we defensively parse.
 */
async function fetchOpenXblProfile(gamertag) {
  const url = `https://xbl.io/api/v2/account/${encodeURIComponent(gamertag)}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "X-Authorization": XBL_API_KEY,
      "Accept": "application/json",
    },
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`OpenXBL returned non-JSON response (HTTP ${res.status}).`);
  }

  if (!res.ok) {
    const msg =
      data?.error ||
      data?.message ||
      `OpenXBL request failed (HTTP ${res.status}).`;
    throw new Error(msg);
  }

  // Expected: data.profileUsers[0].settings[]
  const profileUser = data?.profileUsers?.[0];
  const settings = profileUser?.settings;

  if (!profileUser || !Array.isArray(settings)) {
    throw new Error("Unexpected OpenXBL response format (missing profile settings).");
  }

  const gamerscoreStr = getSetting(settings, "Gamerscore");
  const displayName = getSetting(settings, "Gamertag") || gamertag;
  const tier = getSetting(settings, "AccountTier");
  const pfp = getSetting(settings, "GameDisplayPicRaw") || getSetting(settings, "GameDisplayPic");

  const gamerscore = Number.parseInt(String(gamerscoreStr ?? ""), 10);

  if (!Number.isFinite(gamerscore)) {
    throw new Error("Could not read Gamerscore from OpenXBL response.");
  }

  return {
    gamertag: displayName,
    gamerscore,
    tier: tier || null,
    pfp: pfp || null,
  };
}

async function tryLogToModChannel(guild, embed) {
  if (!MODLOG_CHANNEL_ID) return;

  try {
    const channel = await guild.channels.fetch(MODLOG_CHANNEL_ID);
    if (!channel) return;

    // Only attempt if bot can send messages
    if ("permissionsFor" in channel) {
      const me = guild.members.me;
      if (!me) return;
      const perms = channel.permissionsFor(me);
      if (!perms?.has(PermissionsBitField.Flags.SendMessages)) return;
      if (!perms?.has(PermissionsBitField.Flags.EmbedLinks)) return;
    }

    await channel.send({ embeds: [embed] });
  } catch {
    // Silent fail; modlog is optional
  }
}

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
    const remainingMs = nextAllowed - now;
    const remainingSec = Math.ceil(remainingMs / 1000);

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
      .setDescription("OpenXBL profile lookup")
      .addFields(
        { name: "Gamertag", value: profile.gamertag, inline: true },
        { name: "Gamerscore", value: String(profile.gamerscore), inline: true },
        { name: "Threshold", value: `< ${GS_THRESHOLD} = flagged`, inline: true },
        { name: "Result", value: flagged ? "**FLAGGED — low gamerscore**" : "**OK**", inline: false }
      )
      .setTimestamp();

    if (profile.tier) embed.addFields({ name: "Tier", value: profile.tier, inline: true });
    if (profile.pfp) embed.setThumbnail(profile.pfp);

    // No fancy colors; but if you want:
    embed.setColor(flagged ? 0xff0000 : 0x00ff00);

    await interaction.editReply({ embeds: [embed] });

    // Mod log
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
