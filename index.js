import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  PermissionsBitField,
} from "discord.js";
import fetch from "node-fetch";

const DISCORD_TOKEN = (process.env.DISCORD_TOKEN ?? "").trim();
const XBL_API_KEY = (process.env.XBL_API_KEY ?? "").trim();

const GS_THRESHOLD = Number.parseInt((process.env.GS_THRESHOLD ?? "1000").trim(), 10);
const MODLOG_CHANNEL_ID = (process.env.MODLOG_CHANNEL_ID ?? "").trim();
const COOLDOWN_SECONDS = Number.parseInt((process.env.COOLDOWN_SECONDS ?? "10").trim(), 10);

if (!DISCORD_TOKEN || !XBL_API_KEY) {
  console.error("Missing required environment variables.");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const cooldowns = new Map();

async function fetchOpenXblProfile(gamertag) {
  const base = "https://xbl.io/api/v2";
  const wanted = gamertag.trim();
  const wantedLower = wanted.toLowerCase();

  // Search by gamertag
  const searchRes = await fetch(`${base}/search/${encodeURIComponent(wanted)}`, {
    headers: {
      "X-Authorization": XBL_API_KEY,
      "Accept": "application/json",
    },
  });

  const searchData = await searchRes.json();
  if (!searchRes.ok || !Array.isArray(searchData?.people) || searchData.people.length === 0) {
    throw new Error("Gamertag not found.");
  }

  const best =
    searchData.people.find(p => (p?.gamertag ?? "").toLowerCase() === wantedLower) ||
    searchData.people[0];

  const xuid = best?.xuid;
  if (!xuid) throw new Error("XUID not found.");

  // Fetch account by XUID
  const accRes = await fetch(`${base}/account/${encodeURIComponent(xuid)}`, {
    headers: {
      "X-Authorization": XBL_API_KEY,
      "Accept": "application/json",
    },
  });

  const accData = await accRes.json();
  if (!accRes.ok) throw new Error("Profile lookup failed.");

  const settings = accData?.profileUsers?.[0]?.settings;
  if (!Array.isArray(settings)) throw new Error("Unexpected profile format.");

  const getSetting = (id) => settings.find(s => s?.id === id)?.value ?? null;

  const gamerscore = Number.parseInt(getSetting("Gamerscore"), 10);
  const displayName = getSetting("Gamertag") || best?.gamertag || wanted;
  const tier = getSetting("AccountTier");
  const pfp = getSetting("GameDisplayPicRaw") || getSetting("GameDisplayPic");

  i
