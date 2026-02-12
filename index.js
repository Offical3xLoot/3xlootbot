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
const DATA_DIR = (process.env.DATA_DIR ?? "./data").trim();

function die(msg) {
  console.error(msg);
  process.exit(1);
}

if (!DISCORD_TOKEN) die("Missing DISCORD_TOKEN");
if (!XBL_API_KEY) die("Missing XBL_API_KEY");

fs.mkdirSync(DATA_DIR, { recursive: true });
const CHECKED_FILE = path.resolve(DATA_DIR, "checked_gamertags.json");

function normalize(s) {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

function key(s) {
  return normalize(s).toLowerCase();
}

function loadChecked() {
  try {
    const raw = fs.readFileSync(CHECKED_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return new Set((parsed.checked ?? []).map((x) => String(x)));
  } catch {
    return new Set();
  }
}

function saveChecked(set) {
  fs.writeFileSync(
    CHECKED_FILE,
    JSON.stringify({ checked: Array.from(set).sort() }, null, 2),
    "utf8"
  );
}

let checked = loadChecked();

// ===== Discord Client =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages
  ],
  partials: [Partials.Message, Partials.Channel],
});

// ===== OpenXBL =====
async function fetchProfile(gamertag) {
  const base = "https://xbl.io/api/v2";
  const wanted = normalize(gamertag);
  const wantedLower = wanted.toLowerCase();

  const searchRes = await fetch(`${base}/search/${encodeURIComponent(wanted)}`, {
    headers: { "X-Authorization": XBL_API_KEY }
  });

  const searchData = await searchRes.json();
  if (!searchRes.ok || !searchData?.people?.length) {
    throw new Error("Search failed");
  }

  const best =
    searchData.people.find(p => (p.gamertag ?? "").toLowerCase() === wantedLower) ||
    searchData.people[0];

  const xuid = best.xuid;

  const accRes = await fetch(`${base}/account/${xuid}`, {
    headers: { "X-Authorization": XBL_API_KEY }
  });

  const accData = await accRes.json();
  if (!accRes.ok) throw new Error("Account lookup failed");

  const settings = accData.profileUsers[0].settings;
  const get = (id) => settings.find(s => s.id === id)?.value ?? null;

  const gamerscore = Number.parseInt(get("Gamerscore"), 10);
  const tier = get("AccountTier");
  const pfp = get("GameDisplayPicRaw") || get("GameDisplayPic");

  return {
    gamertag: best.gamertag,
    gamerscore,
    tier,
    pfp
  };
}

// ===== Extract Gamertags from Embed =====
function extractFromEmbed(message) {
  if (!message.embeds?.length) return [];

  const embed = message.embeds[0];
  if (!embed.description) return [];

  const lines = embed.description.split("\n");
  const out = [];

  for (let line of lines) {
    line = line.trim();

    // bullet format: • Name
    if (line.startsWith("•")) {
      line = line.replace(/^•\s*/, "").trim();

      if (line === "3xLoot") continue;

      if (line.length >= 2 && line.length <= 20) {
        out.push(normalize(line));
      }
    }
  }

  return out;
}

// ===== Queue System =====
const queue = [];
let working = false;

function enqueue(gt, guild, sourceChannelId) {
  const k = key(gt);
  if (!k || checked.has(k)) return;

  queue.push({ gt, k, guild, sourceChannelId });
  processQueue();
}

async function processQueue() {
  if (working) return;
  working = true;

  while (queue.length) {
    const item = queue.shift();
    if (!item || checked.has(item.k)) continue;

    checked.add(item.k);
    saveChecked(checked);

    try {
      const profile = await fetchProfile(item.gt);

      if (profile.gamerscore < GS_THRESHOLD) {
        const channel = await item.guild.channels.fetch(MODLOG_CHANNEL_ID).catch(() => null);
        if (channel) {
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

          await channel.send({ embeds: [embed] });
        }
      }
    } catch (err) {
      console.error("Auto-scrub error:", err.message);
    }

    if (SCRUB_DELAY_MS > 0) {
      await new Promise(r => setTimeout(r, SCRUB_DELAY_MS));
    }
  }

  working = false;
}

// ===== Listen for Online List =====
client.on("messageCreate", async (message) => {
  if (!ONLINE_LIST_CHANNEL_ID) return;
  if (message.channelId !== ONLINE_LIST_CHANNEL_ID) return;

  const gamertags = extractFromEmbed(message);
  for (const gt of gamertags) {
    enqueue(gt, message.guild, message.channelId);
  }
});

client.on("messageUpdate", async (_, newMessage) => {
  if (!ONLINE_LIST_CHANNEL_ID) return;
  if (newMessage.channelId !== ONLINE_LIST_CHANNEL_ID) return;

  const msg = newMessage.partial ? await newMessage.fetch() : newMessage;
  const gamertags = extractFromEmbed(msg);

  for (const gt of gamertags) {
    enqueue(gt, msg.guild, msg.channelId);
  }
});

client.once("clientReady", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.login(DISCORD_TOKEN);
