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
const COMMANDS_AUTO_DEPLOY =
  (process.env.COMMANDS_AUTO_DEPLOY ?? "false").trim().toLowerCase() === "true";

const XBL_API_KEY = (process.env.XBL_API_KEY ?? "").trim();

const GS_THRESHOLD = Number.parseInt((process.env.GS_THRESHOLD ?? "2500").trim(), 10);
const ONLINE_LIST_CHANNEL_ID = (process.env.ONLINE_LIST_CHANNEL_ID ?? "").trim();
const MODLOG_CHANNEL_ID = (process.env.MODLOG_CHANNEL_ID ?? "").trim();

const DIGEST_CHANNEL_ID = (process.env.DIGEST_CHANNEL_ID ?? MODLOG_CHANNEL_ID).trim();
const DIGEST_INTERVAL_HOURS = Number.parseInt((process.env.DIGEST_INTERVAL_HOURS ?? "1").trim(), 10);

const SCRUB_DELAY_MS = Number.parseInt((process.env.SCRUB_DELAY_MS ?? "4000").trim(), 10);
const POLL_SECONDS = Number.parseInt((process.env.POLL_SECONDS ?? "180").trim(), 10);

const DATA_DIR = (process.env.DATA_DIR ?? "./data").trim();
const IMMEDIATE_FLAG_LOGS =
  (process.env.IMMEDIATE_FLAG_LOGS ?? "false").trim().toLowerCase() === "true";
const RESET_STATE = (process.env.RESET_STATE ?? "").trim().toLowerCase() === "true";

// Optional: staff role id in addition to ManageGuild
const STAFF_ROLE_ID = (process.env.STAFF_ROLE_ID ?? "").trim();

// ===== Trader price source =====
// Use website data by default. If you want CSV instead, set:
// PRICE_SOURCE=csv and PRICE_CSV_PATH=./data/pricelist.csv
const PRICE_SOURCE = (process.env.PRICE_SOURCE ?? "website").trim().toLowerCase(); // website | csv
const PRICE_CSV_PATH = (process.env.PRICE_CSV_PATH ?? "./data/pricelist.csv").trim();

// ===== OpenXBL retry tuning =====
const XBL_MAX_RETRIES = Number.parseInt((process.env.XBL_MAX_RETRIES ?? "5").trim(), 10);
const XBL_BACKOFF_BASE_MS = Number.parseInt((process.env.XBL_BACKOFF_BASE_MS ?? "4000").trim(), 10);
const XBL_BACKOFF_MAX_MS = Number.parseInt((process.env.XBL_BACKOFF_MAX_MS ?? "60000").trim(), 10);

function die(msg) {
  console.error(msg);
  process.exit(1);
}

if (!DISCORD_TOKEN) die("Missing DISCORD_TOKEN");
if (!XBL_API_KEY) die("Missing XBL_API_KEY");
if (!Number.isFinite(GS_THRESHOLD)) die("GS_THRESHOLD must be a valid integer.");
if (!Number.isFinite(DIGEST_INTERVAL_HOURS) || DIGEST_INTERVAL_HOURS < 1)
  die("DIGEST_INTERVAL_HOURS must be >= 1.");
if (!Number.isFinite(SCRUB_DELAY_MS) || SCRUB_DELAY_MS < 0) die("SCRUB_DELAY_MS must be non-negative.");
if (!Number.isFinite(POLL_SECONDS) || POLL_SECONDS < 10) die("POLL_SECONDS must be >= 10.");

process.on("unhandledRejection", (err) => console.error("Unhandled rejection:", err));
process.on("uncaughtException", (err) => console.error("Uncaught exception:", err));

console.log("Booting 3xBot...");
console.log(`THRESHOLD=${GS_THRESHOLD}`);
console.log(`GUILD_ID=${GUILD_ID ? "SET" : "MISSING"}`);
console.log(`STAFF_ROLE_ID=${STAFF_ROLE_ID ? "SET" : "MISSING"}`);
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
console.log(`XBL_MAX_RETRIES=${XBL_MAX_RETRIES}`);
console.log(`XBL_BACKOFF_BASE_MS=${XBL_BACKOFF_BASE_MS}`);
console.log(`XBL_BACKOFF_MAX_MS=${XBL_BACKOFF_MAX_MS}`);
console.log(`PRICE_SOURCE=${PRICE_SOURCE}`);
console.log(`PRICE_CSV_PATH=${PRICE_CSV_PATH}`);

fs.mkdirSync(DATA_DIR, { recursive: true });
const STATE_FILE = path.resolve(DATA_DIR, "state.json");

// ===== Utils =====
function nowMs() {
  return Date.now();
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

// parse comma-separated gamertags in one string
function parseGamertagList(input) {
  const raw = (input ?? "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((x) => normalizeGamertag(x))
    .filter((x) => x.length >= 2 && x.length <= 20);
}

// ===== State =====
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

    const flaggedAll = new Map();
    if (parsed?.flaggedAll && typeof parsed.flaggedAll === "object") {
      for (const [k, v] of Object.entries(parsed.flaggedAll)) {
        if (!k || !v) continue;
        flaggedAll.set(k, {
          gamertag: String(v.gamertag ?? ""),
          lastKnownGS: Number.parseInt(String(v.lastKnownGS ?? ""), 10),
          firstSeenMs: Number.parseInt(String(v.firstSeenMs ?? ""), 10) || nowMs(),
          lastSeenMs: Number.parseInt(String(v.lastSeenMs ?? ""), 10) || nowMs(),
        });
      }
    }

    let trusted = {};
    if (parsed?.trusted && typeof parsed.trusted === "object" && !Array.isArray(parsed.trusted)) {
      trusted = parsed.trusted;
    } else if (Array.isArray(parsed?.trusted)) {
      for (const k of parsed.trusted) {
        const kk = String(k ?? "").trim().toLowerCase();
        if (kk) trusted[kk] = { gamertag: String(k), addedMs: nowMs() };
      }
    }

    const normalizedTrusted = {};
    for (const [k, v] of Object.entries(trusted || {})) {
      const kk = String(k ?? "").trim().toLowerCase();
      if (!kk) continue;
      const gt = normalizeGamertag(v?.gamertag ?? "");
      if (!gt) continue;
      normalizedTrusted[kk] = {
        gamertag: gt,
        addedMs: Number.parseInt(String(v?.addedMs ?? ""), 10) || nowMs(),
      };
    }

    return { checked, pending, lastDigestMs, flaggedAll, trusted: normalizedTrusted };
  } catch {
    return { checked: new Set(), pending: new Map(), lastDigestMs: 0, flaggedAll: new Map(), trusted: {} };
  }
}

function saveState() {
  const pendingObj = {};
  for (const [k, v] of state.pending.entries()) pendingObj[k] = v;

  const flaggedAllObj = {};
  for (const [k, v] of state.flaggedAll.entries()) flaggedAllObj[k] = v;

  const out = {
    checked: Array.from(state.checked.values()).sort((a, b) => a.localeCompare(b)),
    pending: pendingObj,
    lastDigestMs: state.lastDigestMs,
    trusted: state.trusted,
    flaggedAll: flaggedAllObj,
  };

  fs.writeFileSync(STATE_FILE, JSON.stringify(out, null, 2), "utf8");
}

let state = loadState();

if (RESET_STATE) {
  console.log("RESET_STATE=true -> clearing state.json");
  state = { checked: new Set(), pending: new Map(), lastDigestMs: 0, trusted: {}, flaggedAll: new Map() };
  saveState();
}

console.log(
  `State loaded: checked=${state.checked.size}, pending=${state.pending.size}, flaggedAll=${state.flaggedAll.size}, trusted=${Object.keys(state.trusted).length}, lastDigestMs=${state.lastDigestMs}`
);

// ===== Trusted helpers =====
function isTrustedKey(k) {
  return !!state.trusted?.[k];
}
function trustedDisplayForKey(k) {
  return state.trusted?.[k]?.gamertag || k;
}

// ===== Discord Client =====
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  partials: [Partials.Message, Partials.Channel],
});

// ===== Staff check =====
function isStaff(interaction) {
  const perms = interaction.memberPermissions;
  const hasManageGuild = perms?.has(PermissionsBitField.Flags.ManageGuild);
  if (hasManageGuild) return true;
  if (STAFF_ROLE_ID && interaction.member?.roles?.cache?.has?.(STAFF_ROLE_ID)) return true;
  return false;
}

// =========================
// Trader Pricelist (Website Data + optional CSV loader)
// =========================

function normalizeItemName(s) {
  return (s ?? "").toString().trim().replace(/\s+/g, " ");
}
function itemKey(s) {
  return normalizeItemName(s).toLowerCase();
}

function formatMoney(n) {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1000000 && n % 1000000 === 0) return `${n / 1000000}M`;
  if (n >= 1000 && n % 1000 === 0) return `${n / 1000}K`;
  return n.toLocaleString("en-US");
}

// Website shopData (trimmed exactly from what you sent; keep/edit prices here if desired)
function getWebsiteShopData() {
  return {
    Kit: [{ Item: "Full Kit", BuyFromTrader: 180000, SellToTrader: null }],
    Weapons: [
      { Item: "FX 45", BuyFromTrader: 10000, SellToTrader: 5000 },
      { Item: "Mlock", BuyFromTrader: 10000, SellToTrader: 5000 },
      { Item: "Deagle", BuyFromTrader: 10000, SellToTrader: 5000 },
      { Item: "CZ75", BuyFromTrader: 10000, SellToTrader: 5000 },
      { Item: "Bizon", BuyFromTrader: 16000, SellToTrader: 8000 },
      { Item: "USG", BuyFromTrader: 16000, SellToTrader: 8000 },
      { Item: "MP5", BuyFromTrader: 16000, SellToTrader: 8000 },
      { Item: "RAK", BuyFromTrader: 16000, SellToTrader: 8000 },
      { Item: "Vaiga", BuyFromTrader: 16000, SellToTrader: 8000 },
      { Item: "R12", BuyFromTrader: 30000, SellToTrader: 15000 },
      { Item: "Tundra", BuyFromTrader: 30000, SellToTrader: 15000 },
      { Item: "Blaze", BuyFromTrader: 30000, SellToTrader: 15000 },
      { Item: "Mosin", BuyFromTrader: 30000, SellToTrader: 15000 },
      { Item: "Pioneer", BuyFromTrader: 30000, SellToTrader: 15000 },
      { Item: "AK 74", BuyFromTrader: 30000, SellToTrader: 15000 },
      { Item: "AK101", BuyFromTrader: 30000, SellToTrader: 15000 },
      { Item: "DMR", BuyFromTrader: 60000, SellToTrader: 30000 },
      { Item: "VS89", BuyFromTrader: 60000, SellToTrader: 30000 },
      { Item: "VSD", BuyFromTrader: 60000, SellToTrader: 30000 },
      { Item: "SVAL", BuyFromTrader: 60000, SellToTrader: 30000 },
      { Item: "M4", BuyFromTrader: 60000, SellToTrader: 30000 },
      { Item: "AUG AX", BuyFromTrader: 60000, SellToTrader: 30000 },
      { Item: "LAR", BuyFromTrader: 60000, SellToTrader: 30000 },
      { Item: "KAM", BuyFromTrader: 60000, SellToTrader: 30000 },
      { Item: "All other weapons not covered in the tiers", BuyFromTrader: null, SellToTrader: 5000 },
    ],
    "Medical Supplies": [
      { Item: "Morphine Pen", BuyFromTrader: 4000, SellToTrader: 2000, Size: 2 },
      { Item: "Epinephrine Injector", BuyFromTrader: 2000, SellToTrader: 1000, Size: 4 },
      { Item: "Pox Antidote", BuyFromTrader: 10000, SellToTrader: 5000, Size: 4 },
      { Item: "Bandage", BuyFromTrader: 2000, SellToTrader: 1000, Size: 2 },
      { Item: "IV Start Kit", BuyFromTrader: 4000, SellToTrader: 2000, Size: 2 },
      { Item: "Saline Pouch", BuyFromTrader: 4000, SellToTrader: 2000, Size: 4 },
      { Item: "Blood Collection Kit", BuyFromTrader: 2000, SellToTrader: 1000, Size: 4 },
      { Item: "Blood Test Kit", BuyFromTrader: 2000, SellToTrader: 1000, Size: 4 },
      { Item: "Tetracycline Pills", BuyFromTrader: 2000, SellToTrader: 1000, Size: 2 },
      { Item: "Multivitamins", BuyFromTrader: 2000, SellToTrader: 1000, Size: 2 },
      { Item: "Charcoal", BuyFromTrader: 2000, SellToTrader: 1000, Size: 2 },
      { Item: "Iodine", BuyFromTrader: 2000, SellToTrader: 1000, Size: 2 },
      { Item: "Alchol", BuyFromTrader: 2000, SellToTrader: 1000, Size: 2 },
      { Item: "NBC Clothes", BuyFromTrader: 30000, SellToTrader: 15000 },
      { Item: "Mask", BuyFromTrader: 30000, SellToTrader: 15000 },
      { Item: "Filters", BuyFromTrader: 10000, SellToTrader: 5000 },
    ],
    Magazines: [
      { Item: "FX 45 15 round", BuyFromTrader: 5000, SellToTrader: 2000 },
      { Item: "CZ75 15 round", BuyFromTrader: 5000, SellToTrader: 2000 },
      { Item: "Mlock 15 round", BuyFromTrader: 5000, SellToTrader: 2000 },
      { Item: "Deagle 9 round", BuyFromTrader: 5000, SellToTrader: 2000 },
      { Item: "Bizon 64 round", BuyFromTrader: 5000, SellToTrader: 2000 },
      { Item: "RAK 15 round", BuyFromTrader: 5000, SellToTrader: 2000 },
      { Item: "UMP 25 round", BuyFromTrader: 6000, SellToTrader: 3000 },
      { Item: "MP5", BuyFromTrader: 6000, SellToTrader: 3000 },
      { Item: "Pioneer 5 round", BuyFromTrader: 6000, SellToTrader: 4000 },
      { Item: "Vaiga 20 round", BuyFromTrader: 6000, SellToTrader: 2000 },
      { Item: "RAK 25 round", BuyFromTrader: 6000, SellToTrader: 2000 },
      { Item: "Lemas 25 round", BuyFromTrader: 7000, SellToTrader: 4000 },
      { Item: "30 round 5.56", BuyFromTrader: 10000, SellToTrader: 5000 },
      { Item: "VSD 10 round", BuyFromTrader: 10000, SellToTrader: 5000 },
      { Item: "LAR 20 round", BuyFromTrader: 10000, SellToTrader: 5000 },
      { Item: "VS89 10 round", BuyFromTrader: 10000, SellToTrader: 5000 },
      { Item: "DMR 10 round", BuyFromTrader: 10000, SellToTrader: 5000 },
      { Item: "DMR 20 round", BuyFromTrader: 16000, SellToTrader: 5000 },
      { Item: "40 round MAGC", BuyFromTrader: 12000, SellToTrader: 6000 },
      { Item: "KA74 45 round", BuyFromTrader: 12000, SellToTrader: 6000 },
      { Item: "60 round", BuyFromTrader: 20000, SellToTrader: 10000 },
      { Item: "75 round drum", BuyFromTrader: 30000, SellToTrader: 15000 },
      { Item: "300 round drum", BuyFromTrader: 500000, SellToTrader: 250000 },
    ],
    Miscellaneous: [
      { Item: "Electrical Repair Kit", BuyFromTrader: 20000, SellToTrader: 10000 },
      { Item: "Leather Kit", BuyFromTrader: 10000, SellToTrader: 5000 },
      { Item: "Gun Cleaning Kit", BuyFromTrader: 10000, SellToTrader: 5000 },
      { Item: "Sewing Kit", BuyFromTrader: 5000, SellToTrader: 2000 },
      { Item: "Epoxy Putty", BuyFromTrader: 10000, SellToTrader: 5000 },
      { Item: "Duct Tape", BuyFromTrader: 4000, SellToTrader: 2000 },
    ],
    Food: [
      { Item: "Canned Goods", BuyFromTrader: 4000, SellToTrader: 2000 },
      { Item: "Canteen", BuyFromTrader: 4000, SellToTrader: 2000 },
      { Item: "Water Bottle", BuyFromTrader: 4000, SellToTrader: 2000 },
    ],
    "Ammunition (Box)": [
      { Item: "12 Gauge Rubber Slug", BuyFromTrader: 4000, SellToTrader: 2000 },
      { Item: "12 Gauge Slug", BuyFromTrader: 4000, SellToTrader: 2000 },
      { Item: "12 Gauge Buckshot", BuyFromTrader: 4000, SellToTrader: 2000 },
      { Item: "22", BuyFromTrader: 2000, SellToTrader: 1000 },
      { Item: "45", BuyFromTrader: 2000, SellToTrader: 1000 },
      { Item: "380", BuyFromTrader: 2000, SellToTrader: 1000 },
      { Item: "9x19", BuyFromTrader: 2000, SellToTrader: 1000 },
      { Item: "357", BuyFromTrader: 2000, SellToTrader: 1000 },
      { Item: "7.62x39", BuyFromTrader: 8000, SellToTrader: 4000 },
      { Item: "5.45", BuyFromTrader: 8000, SellToTrader: 4000 },
      { Item: "7.62x54", BuyFromTrader: 8000, SellToTrader: 4000 },
      { Item: "5.56", BuyFromTrader: 8000, SellToTrader: 4000 },
      { Item: "308", BuyFromTrader: 8000, SellToTrader: 4000 },
      { Item: "9x39", BuyFromTrader: 8000, SellToTrader: 4000 },
    ],
    "Cars and Parts": [
      { Item: "Radiator", BuyFromTrader: 20000, SellToTrader: 10000 },
      { Item: "Car Battery", BuyFromTrader: 15000, SellToTrader: 8000 },
      { Item: "Truck Battery", BuyFromTrader: 15000, SellToTrader: 8000 },
      { Item: "Headlight bulb", BuyFromTrader: 2000, SellToTrader: 1000 },
      { Item: "Spark Plug", BuyFromTrader: 4000, SellToTrader: 2000 },
      { Item: "Glow Plug", BuyFromTrader: 6000, SellToTrader: 3000 },
      { Item: "Car Wheels", BuyFromTrader: 10000, SellToTrader: 5000 },
      { Item: "Humvee Wheels", BuyFromTrader: 20000, SellToTrader: 10000 },
      { Item: "Truck Wheels", BuyFromTrader: 20000, SellToTrader: 10000 },
      { Item: "Jerry Can", BuyFromTrader: 10000, SellToTrader: 5000 },
      { Item: "Gas Canister", BuyFromTrader: 5000, SellToTrader: 2000 },
      { Item: "Blow Torch", BuyFromTrader: 5000, SellToTrader: 2000 },
      { Item: "Sarka", BuyFromTrader: 150000, SellToTrader: 75000 },
      { Item: "Ada", BuyFromTrader: 150000, SellToTrader: 75000 },
      { Item: "Gunther", BuyFromTrader: 150000, SellToTrader: 75000 },
      { Item: "Olga", BuyFromTrader: 150000, SellToTrader: 75000 },
      { Item: "Truck", BuyFromTrader: 300000, SellToTrader: 150000 },
      { Item: "Humvee", BuyFromTrader: 400000, SellToTrader: 200000 },
    ],
    Attachments: [
      { Item: "Standard Supressor", BuyFromTrader: 6000, SellToTrader: 3000 },
      { Item: "Normal Suppressor", BuyFromTrader: 6000, SellToTrader: 3000 },
      { Item: "Pistol Suppressor", BuyFromTrader: 6000, SellToTrader: 3000 },
      { Item: "Bottle Suppressor", BuyFromTrader: 6000, SellToTrader: 3000 },
      { Item: "Weapon Parts", BuyFromTrader: 4000, SellToTrader: 2000 },
      { Item: "Mini Sights", BuyFromTrader: 2000, SellToTrader: 1000 },
      { Item: "Handgun Scope", BuyFromTrader: 2000, SellToTrader: 1000 },
      { Item: "BUIS", BuyFromTrader: 2000, SellToTrader: 1000 },
      { Item: "M4 Carry Handel", BuyFromTrader: 2000, SellToTrader: 1000 },
      { Item: "PU Scope", BuyFromTrader: 2000, SellToTrader: 1000 },
      { Item: "Barka", BuyFromTrader: 4000, SellToTrader: 2000 },
      { Item: "RVN", BuyFromTrader: 4000, SellToTrader: 2000 },
      { Item: "Combat Sights", BuyFromTrader: 4000, SellToTrader: 2000 },
      { Item: "Kobra", BuyFromTrader: 4000, SellToTrader: 2000 },
      { Item: "P1-87", BuyFromTrader: 4000, SellToTrader: 2000 },
      { Item: "PSO 6", BuyFromTrader: 6000, SellToTrader: 3000 },
      { Item: "PSO 1 1", BuyFromTrader: 6000, SellToTrader: 3000 },
      { Item: "PSO 1", BuyFromTrader: 6000, SellToTrader: 3000 },
      { Item: "Sporting Optic", BuyFromTrader: 6000, SellToTrader: 3000 },
      { Item: "4x ACOG", BuyFromTrader: 6000, SellToTrader: 3000 },
      { Item: "6x ACOG", BuyFromTrader: 6000, SellToTrader: 3000 },
      { Item: "NVG Scopes", BuyFromTrader: 12000, SellToTrader: 6000 },
      { Item: "Marksman Scope", BuyFromTrader: 6000, SellToTrader: 3000 },
    ],
    "Building Supplies": [
      { Item: "Barbed Wire", BuyFromTrader: 8000, SellToTrader: 4000 },
      { Item: "Wire", BuyFromTrader: 6000, SellToTrader: 3000 },
      { Item: "Saws", BuyFromTrader: 2000, SellToTrader: 1000 },
      { Item: "Sharpening Stones", BuyFromTrader: 2000, SellToTrader: 1000 },
      { Item: "Pliers", BuyFromTrader: 2000, SellToTrader: 1000 },
      { Item: "Rope", BuyFromTrader: 2000, SellToTrader: 1000 },
      { Item: "Nails", BuyFromTrader: 4000, SellToTrader: 2000 },
      { Item: "4Dial", BuyFromTrader: 5000, SellToTrader: 3000 },
      { Item: "3Dial", BuyFromTrader: null, SellToTrader: 1000 },
      { Item: "Pickaxe", BuyFromTrader: 6000, SellToTrader: 3000 },
      { Item: "Shovel", BuyFromTrader: 6000, SellToTrader: 3000 },
      { Item: "Sledgehammer", BuyFromTrader: 4000, SellToTrader: 2000 },
      { Item: "Hatchet", BuyFromTrader: 6000, SellToTrader: 6000 },
      { Item: "Camo Net", BuyFromTrader: 10000, SellToTrader: 5000 },
      { Item: "Medium Tent", BuyFromTrader: 15000, SellToTrader: 7000 },
      { Item: "Large Tent", BuyFromTrader: 20000, SellToTrader: 10000 },
      { Item: "Car Tent", BuyFromTrader: 30000, SellToTrader: 15000 },
      { Item: "Barrel", BuyFromTrader: 10000, SellToTrader: null },
      { Item: "Sea Chest", BuyFromTrader: 5000, SellToTrader: null },
      { Item: "Canopy", BuyFromTrader: 5000, SellToTrader: 2000 },
    ],
    Explosives: [
      { Item: "40MM EX", BuyFromTrader: 80000, SellToTrader: 40000 },
      { Item: "40MM POX", BuyFromTrader: 80000, SellToTrader: 40000 },
      { Item: "Gernades", BuyFromTrader: 80000, SellToTrader: 40000 },
      { Item: "IED Case", BuyFromTrader: 70000, SellToTrader: 35000 },
      { Item: "Plastic Explosives", BuyFromTrader: 150000, SellToTrader: 75000 },
      { Item: "Landmine", BuyFromTrader: 40000, SellToTrader: 20000 },
      { Item: "Claymore", BuyFromTrader: 40000, SellToTrader: 10000 },
      { Item: "Remote Detonator Units", BuyFromTrader: 20000, SellToTrader: 10000 },
      { Item: "M79", BuyFromTrader: 150000, SellToTrader: 75000 },
    ],
    Clothing: [
      { Item: "Tac Helmet", BuyFromTrader: 15000, SellToTrader: 7000 },
      { Item: "NVG", BuyFromTrader: 50000, SellToTrader: 25000 },
      { Item: "Field Jacket", BuyFromTrader: 10000, SellToTrader: 5000 },
      { Item: "Plate Carrier", BuyFromTrader: 50000, SellToTrader: 25000 },
      { Item: "Pouches", BuyFromTrader: 5000, SellToTrader: 3000 },
      { Item: "Holster", BuyFromTrader: 5000, SellToTrader: 3000 },
      { Item: "Belt", BuyFromTrader: 5000, SellToTrader: 3000 },
      { Item: "Cargo Pants", BuyFromTrader: 10000, SellToTrader: 5000 },
      { Item: "Field Backpack", BuyFromTrader: 30000, SellToTrader: 15000 },
    ],
    Pelts: [
      { Item: "Bear", BuyFromTrader: null, SellToTrader: 20000 },
      { Item: "Deer", BuyFromTrader: null, SellToTrader: 5000 },
      { Item: "Wolf", BuyFromTrader: null, SellToTrader: 15000 },
      { Item: "Cow", BuyFromTrader: null, SellToTrader: 2500 },
      { Item: "Pig", BuyFromTrader: null, SellToTrader: 2500 },
    ],
    "Punch Cards": [
      { Item: "Badly Damaged", BuyFromTrader: 1500000, SellToTrader: 1000000 },
      { Item: "Damaged", BuyFromTrader: 3000000, SellToTrader: 2000000 },
      { Item: "Worn", BuyFromTrader: 4500000, SellToTrader: 3000000 },
      { Item: "Pristine", BuyFromTrader: 6000000, SellToTrader: 4000000 },
    ],
    Bargin: [{ Item: "Item Not Listed", BuyFromTrader: null, SellToTrader: 1000 }],
  };
}

// Optional CSV loader (simple: expects columns Item, Buy, Sell somewhere)
// NOTE: Your earlier CSV export is laid out like a grid; this loader is conservative.
// Use PRICE_SOURCE=website unless you normalize the CSV to 3 columns.
function csvSplitLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQ = !inQ;
      }
      continue;
    }
    if (ch === "," && !inQ) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}
function parsePriceToInt(raw) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s) return null;
  s = s.replace(/[$,]/g, "").replace(/\s+/g, "").toUpperCase();
  const m = s.match(/^(\d+(\.\d+)?)(K|M)?$/);
  if (!m) return null;
  const n = Number.parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const suffix = m[3] || "";
  const mult = suffix === "K" ? 1000 : suffix === "M" ? 1000000 : 1;
  return Math.round(n * mult);
}
function loadSimple3ColCsv(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const rows = lines.map(csvSplitLine);
  if (!rows.length) return [];

  const header = rows[0].map((x) => String(x ?? "").trim().toLowerCase());
  const idxItem = header.indexOf("item");
  const idxBuy = header.indexOf("buy");
  const idxSell = header.indexOf("sell");
  if (idxItem < 0 || idxBuy < 0) throw new Error("CSV must have headers: Item, Buy, Sell");

  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const name = normalizeItemName(r[idxItem] ?? "");
    if (!name) continue;
    const buy = parsePriceToInt(r[idxBuy]);
    const sell = idxSell >= 0 ? parsePriceToInt(r[idxSell]) : null;
    out.push({ name, buy: buy ?? null, sell: sell ?? null, category: "CSV" });
  }
  return out;
}

let trader = {
  itemsByKey: new Map(), // key -> { name, buy, sell, category }
  categories: new Map(), // category -> Set(keys)
  categoryList: [],
  source: "website",
};

function indexTraderItems(flatItems) {
  const itemsByKey = new Map();
  const categories = new Map();

  for (const it of flatItems) {
    const k = itemKey(it.name);
    if (!k) continue;
    itemsByKey.set(k, it);

    const cat = it.category || "Uncategorized";
    if (!categories.has(cat)) categories.set(cat, new Set());
    categories.get(cat).add(k);
  }

  const categoryList = Array.from(categories.keys()).sort((a, b) => a.localeCompare(b));
  return { itemsByKey, categories, categoryList };
}

function buildFlatFromWebsite(shopData) {
  const out = [];
  for (const category of Object.keys(shopData)) {
    const arr = shopData[category];
    if (!Array.isArray(arr)) continue;
    for (const row of arr) {
      const name = normalizeItemName(row?.Item ?? "");
      if (!name) continue;
      const buy = row?.BuyFromTrader === null || row?.BuyFromTrader === undefined ? null : Number(row.BuyFromTrader);
      const sell = row?.SellToTrader === null || row?.SellToTrader === undefined ? null : Number(row.SellToTrader);
      out.push({
        name,
        buy: Number.isFinite(buy) ? buy : null,
        sell: Number.isFinite(sell) ? sell : null,
        category,
      });
    }
  }
  return out;
}

function reloadTraderData() {
  try {
    if (PRICE_SOURCE === "csv") {
      const items = loadSimple3ColCsv(PRICE_CSV_PATH);
      const indexed = indexTraderItems(items);
      trader = { ...indexed, source: "csv" };
      console.log(`[TRADER] Loaded ${trader.itemsByKey.size} items from CSV.`);
      return { ok: true, source: "csv", count: trader.itemsByKey.size };
    }

    const shopData = getWebsiteShopData();
    const flat = buildFlatFromWebsite(shopData);
    const indexed = indexTraderItems(flat);
    trader = { ...indexed, source: "website" };
    console.log(`[TRADER] Loaded ${trader.itemsByKey.size} items from website shopData.`);
    return { ok: true, source: "website", count: trader.itemsByKey.size };
  } catch (e) {
    console.error("[TRADER] reload failed:", e?.message ?? e);
    return { ok: false, error: e?.message ?? String(e) };
  }
}

function findItems(query, limit = 10) {
  const q = itemKey(query);
  if (!q) return [];
  const exact = trader.itemsByKey.get(q);
  if (exact) return [exact];

  const hits = [];
  for (const it of trader.itemsByKey.values()) {
    const k = itemKey(it.name);
    if (k.includes(q)) hits.push(it);
  }
  hits.sort((a, b) => a.name.localeCompare(b.name));
  return hits.slice(0, limit);
}

// Batch parser: accepts examples
// "Sea Chest x2, Barrel x1"
// "2 Sea Chest, 1 Barrel"
// "Sea Chest 2, Barrel 1"
// newline-separated works too.
function parseBatch(input) {
  const raw = (input ?? "").trim();
  if (!raw) return [];

  const parts = raw
    .split(/\r?\n|,/)
    .map((p) => p.trim())
    .filter(Boolean);

  const out = [];
  for (const p of parts) {
    // 1) "2 Sea Chest"
    let m = p.match(/^\s*(\d+)\s+(.+?)\s*$/i);
    if (m) {
      const qty = Number.parseInt(m[1], 10);
      const name = normalizeItemName(m[2]);
      if (Number.isFinite(qty) && qty > 0 && name) out.push({ name, qty });
      continue;
    }

    // 2) "Sea Chest x2" or "Sea Chest ×2"
    m = p.match(/^\s*(.+?)\s*(?:x|×)\s*(\d+)\s*$/i);
    if (m) {
      const name = normalizeItemName(m[1]);
      const qty = Number.parseInt(m[2], 10);
      if (Number.isFinite(qty) && qty > 0 && name) out.push({ name, qty });
      continue;
    }

    // 3) "Sea Chest 2"
    m = p.match(/^\s*(.+?)\s+(\d+)\s*$/i);
    if (m) {
      const name = normalizeItemName(m[1]);
      const qty = Number.parseInt(m[2], 10);
      if (Number.isFinite(qty) && qty > 0 && name) out.push({ name, qty });
      continue;
    }

    // 4) just a name => qty 1
    const name = normalizeItemName(p);
    if (name) out.push({ name, qty: 1 });
  }

  // Merge duplicates (by key)
  const merged = new Map();
  for (const it of out) {
    const k = itemKey(it.name);
    if (!k) continue;
    merged.set(k, { name: it.name, qty: (merged.get(k)?.qty ?? 0) + it.qty });
  }
  return Array.from(merged.values());
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

// ===== Extract gamertags from embeds =====
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

// ===== Pending + All-time flagged =====
function addFlagged(profile) {
  const k = gtKey(profile.gamertag);
  if (!k) return;
  if (isTrustedKey(k)) return;

  const t = nowMs();

  const p = state.pending.get(k);
  if (!p) {
    state.pending.set(k, { gamertag: profile.gamertag, gamerscore: profile.gamerscore ?? 0, firstSeenMs: t, lastSeenMs: t });
  } else {
    p.gamertag = profile.gamertag;
    if (profile.gamerscore !== null && profile.gamerscore !== undefined) p.gamerscore = profile.gamerscore;
    p.lastSeenMs = t;
  }

  const a = state.flaggedAll.get(k);
  if (!a) {
    state.flaggedAll.set(k, { gamertag: profile.gamertag, lastKnownGS: profile.gamerscore ?? 0, firstSeenMs: t, lastSeenMs: t });
  } else {
    a.gamertag = profile.gamertag;
    if (profile.gamerscore !== null && profile.gamerscore !== undefined) a.lastKnownGS = profile.gamerscore;
    a.lastSeenMs = t;
  }

  saveState();
}

function trustGamertag(gt) {
  const original = normalizeGamertag(gt);
  const k = gtKey(original);
  if (!k) return { ok: false, display: "" };

  const wasFlagged = state.pending.has(k) || state.flaggedAll.has(k);

  state.trusted[k] = { gamertag: original, addedMs: nowMs() };
  state.pending.delete(k);
  state.flaggedAll.delete(k);
  saveState();

  return { ok: true, display: original, removedFlagged: wasFlagged };
}

function untrustGamertag(gt) {
  const original = normalizeGamertag(gt);
  const k = gtKey(original);
  if (!k) return { ok: false, display: "" };

  const display = trustedDisplayForKey(k);
  delete state.trusted[k];
  saveState();

  return { ok: true, display };
}

// ===== Digest =====
function chunkLines(lines, maxChars) {
  const chunks = [];
  let current = "";
  for (const line of lines) {
    const add = (current ? "\n" : "") + line;
    if (current.length + add.length > maxChars) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current += add;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function sendEmbedToChannel(guild, channelId, embed) {
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel) return false;

  const me = guild.members.me;
  if (me) {
    const perms = channel.permissionsFor(me);
    if (!perms?.has(PermissionsBitField.Flags.SendMessages)) return false;
    if (!perms?.has(PermissionsBitField.Flags.EmbedLinks)) return false;
  }

  await channel.send({ embeds: [embed] });
  return true;
}

async function sendDigestIfDue() {
  if (!DIGEST_CHANNEL_ID) return;

  const intervalMs = DIGEST_INTERVAL_HOURS * 60 * 60 * 1000;
  const now = nowMs();
  if (state.lastDigestMs && now - state.lastDigestMs < intervalMs) return;

  const cutoff = state.lastDigestMs || now - intervalMs;

  const items = Array.from(state.pending.entries())
    .map(([k, v]) => ({ k, ...v }))
    .filter((v) => (v?.lastSeenMs ?? 0) >= cutoff)
    .filter((v) => !isTrustedKey(v.k))
    .sort((a, b) => (a.gamertag || "").localeCompare(b.gamertag || ""));

  const digestChan = await client.channels.fetch(DIGEST_CHANNEL_ID).catch(() => null);
  if (!digestChan || !digestChan.guild) return;

  if (items.length === 0) {
    console.log("[DIGEST] Due, but nothing pending.");
    state.lastDigestMs = now;
    state.pending = new Map();
    saveState();
    return;
  }

  const lines = items.map((v) => v.gamertag);
  const chunks = chunkLines(lines, 3500);

  for (let i = 0; i < chunks.length; i++) {
    const embed = new EmbedBuilder()
      .setTitle(`Low Gamerscore Watchlist (Last ${DIGEST_INTERVAL_HOURS}h)`)
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

// ===== Poll online list =====
async function pollOnlineList() {
  if (!ONLINE_LIST_CHANNEL_ID) return;

  const channel = await client.channels.fetch(ONLINE_LIST_CHANNEL_ID).catch(() => null);
  if (!channel || !("messages" in channel)) return;

  const messages = await channel.messages.fetch({ limit: 5 }).catch(() => null);
  if (!messages) return;

  const newest = messages.first();
  if (!newest) return;

  const gts = extractGamertagsFromEmbeds(newest);
  console.log(`[ONLINE LIST POLL] embeds=${newest.embeds?.length ?? 0} extracted=${gts.length}`);

  for (const gt of gts) enqueueGamertag(gt, newest.guild);
}

// ===== Auto-scrub queue =====
const queue = [];
const queuedKeys = new Set();
let working = false;
let globalCooldownUntilMs = 0;

function enqueueGamertag(gt, guild) {
  const clean = normalizeGamertag(gt);
  const k = gtKey(clean);
  if (!k) return;

  if (isTrustedKey(k)) return;
  if (state.checked.has(k)) return;
  if (queuedKeys.has(k)) return;

  queue.push({ gt: clean, k, guild });
  queuedKeys.add(k);
  void processQueue();
}

async function processQueue() {
  if (working) return;
  working = true;

  try {
    while (queue.length) {
      const item = queue.shift();
      if (!item) continue;
      queuedKeys.delete(item.k);

      if (isTrustedKey(item.k)) continue;
      if (state.checked.has(item.k)) continue;

      const now = nowMs();
      if (globalCooldownUntilMs > now) {
        const wait = globalCooldownUntilMs - now;
        console.log(`[XBL] Global cooldown active. Waiting ${wait}ms`);
        await sleep(wait);
      }

      console.log(`[CHECK] ${item.gt}`);

      try {
        const merged = await fetchOpenXblMergedProfile(item.gt);

        state.checked.add(item.k);
        saveState();

        const gs = merged.gamerscore;

        if (gs === null) {
          console.log(`[OK] ${merged.gamertag} GS=unknown (ignored)`);
        } else if (gs >= GS_THRESHOLD) {
          console.log(`[OK] ${merged.gamertag} GS=${gs} (ignored)`);
        } else {
          console.log(`[FLAGGED] ${merged.gamertag} GS=${gs} (saved)`);
          addFlagged({ gamertag: merged.gamertag, gamerscore: gs });

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
        if (err instanceof RateLimitError) {
          const backoff = Math.min(XBL_BACKOFF_MAX_MS, err.retryAfterMs ?? XBL_BACKOFF_BASE_MS);
          globalCooldownUntilMs = nowMs() + backoff;
          console.log(`[XBL] Rate-limited in worker. Cooling down ${backoff}ms then requeue ${item.gt}`);
          await sleep(Math.min(backoff, 15000));
          enqueueGamertag(item.gt, item.guild);
        } else {
          console.error(`[ERROR] ${item.gt}:`, err?.message ?? err);
        }
      }

      if (SCRUB_DELAY_MS > 0) await sleep(SCRUB_DELAY_MS);
    }
  } finally {
    working = false;
  }
}

// ===== Build paged embeds =====
function buildListEmbeds(title, lines, color = 0x2b2d31) {
  const chunks = chunkLines(lines, 3500);
  const embeds = [];
  for (let i = 0; i < chunks.length; i++) {
    const e = new EmbedBuilder()
      .setTitle(title)
      .setDescription(chunks[i] || "—")
      .setColor(color)
      .setTimestamp();
    if (chunks.length > 1) e.setFooter({ text: `Page ${i + 1}/${chunks.length}` });
    embeds.push(e);
  }
  return embeds;
}

// ===== Commands deploy =====
async function autoDeployCommandsIfEnabled() {
  if (!COMMANDS_AUTO_DEPLOY) return;
  if (!DISCORD_CLIENT_ID || !GUILD_ID) {
    console.log("[COMMANDS] Auto deploy ON but DISCORD_CLIENT_ID or GUILD_ID missing.");
    return;
  }

  const commands = [
    // Xbox
    new SlashCommandBuilder()
      .setName("xcheck")
      .setDescription("Check an Xbox gamertag's gamerscore against the configured threshold.")
      .addStringOption((opt) => opt.setName("gamertag").setDescription("Xbox gamertag").setRequired(true)),

    new SlashCommandBuilder()
      .setName("xinfo")
      .setDescription("Fetch detailed Xbox profile info (only shows fields that are available).")
      .addStringOption((opt) => opt.setName("gamertag").setDescription("Xbox gamertag").setRequired(true)),

    new SlashCommandBuilder()
      .setName("xflagged")
      .setDescription("Show low-gamerscore gamertags saved by the bot.")
      .addStringOption((opt) =>
        opt
          .setName("scope")
          .setDescription("pending = since last digest; all = all-time saved")
          .addChoices({ name: "pending", value: "pending" }, { name: "all", value: "all" })
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName("xtrust")
      .setDescription("Manage trusted gamertags (whitelist). You can add/remove multiple separated by commas.")
      .addStringOption((opt) =>
        opt
          .setName("action")
          .setDescription("add/remove/list")
          .addChoices({ name: "add", value: "add" }, { name: "remove", value: "remove" }, { name: "list", value: "list" })
          .setRequired(true)
      )
      .addStringOption((opt) =>
        opt
          .setName("gamertag")
          .setDescription("Gamertag(s). For add/remove you can paste multiple separated by commas.")
          .setRequired(false)
      ),

    // Trader prices
    new SlashCommandBuilder()
      .setName("price")
      .setDescription("Get trader buy/sell prices for an item.")
      .addStringOption((opt) => opt.setName("item").setDescription("Item name").setRequired(true)),

    new SlashCommandBuilder()
      .setName("buy")
      .setDescription("Get trader buy price for an item.")
      .addStringOption((opt) => opt.setName("item").setDescription("Item name").setRequired(true)),

    new SlashCommandBuilder()
      .setName("sell")
      .setDescription("Get trader sell price for an item.")
      .addStringOption((opt) => opt.setName("item").setDescription("Item name").setRequired(true)),

    new SlashCommandBuilder()
      .setName("pricesearch")
      .setDescription("Search items in the trader price list.")
      .addStringOption((opt) => opt.setName("query").setDescription("Search text").setRequired(true)),

    new SlashCommandBuilder()
      .setName("pricecategory")
      .setDescription("List items in a trader category.")
      .addStringOption((opt) => opt.setName("category").setDescription("Category name").setRequired(true)),

    new SlashCommandBuilder()
      .setName("sellbatch")
      .setDescription("Calculate a total for selling multiple items at once.")
      .addStringOption((opt) =>
        opt
          .setName("items")
          .setDescription('Example: "Sea Chest x2, Nails x1, Bear x3" (comma or newline separated)')
          .setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName("buybatch")
      .setDescription("Calculate a total for buying multiple items at once.")
      .addStringOption((opt) =>
        opt
          .setName("items")
          .setDescription('Example: "Sea Chest x2, Nails x1" (comma or newline separated)')
          .setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName("pricestats")
      .setDescription("Staff: Show price list stats."),

    new SlashCommandBuilder()
      .setName("pricereload")
      .setDescription("Staff: Reload trader price list (CSV mode only)."),
  ].map((c) => c.toJSON());

  try {
    console.log("[COMMANDS] Deploying guild commands...");
    const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
    await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, GUILD_ID), { body: commands });
    console.log("[COMMANDS] Done. Commands registered.");
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
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    return { res, data };
  } finally {
    clearTimeout(timer);
  }
}

class RateLimitError extends Error {
  constructor(message, retryAfterMs = null) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}
function parseRetryAfterMs(res) {
  const ra = res.headers?.get?.("retry-after");
  if (!ra) return null;
  const sec = Number.parseFloat(ra);
  if (!Number.isFinite(sec)) return null;
  return Math.max(0, Math.round(sec * 1000));
}

// ===== OpenXBL with retry/backoff =====
async function openXblFetchJson(url) {
  const { res, data } = await fetchJsonWithTimeout(
    url,
    { method: "GET", headers: { "X-Authorization": XBL_API_KEY, Accept: "application/json" } },
    8000
  );

  if (res.status === 429) {
    const retryAfter = parseRetryAfterMs(res);
    throw new RateLimitError("OpenXBL rate limited (HTTP 429)", retryAfter);
  }
  if (!res.ok) {
    throw new Error(data?.error || data?.message || `OpenXBL request failed (HTTP ${res.status})`);
  }
  return data;
}

async function openXblFetchWithRetry(url) {
  let attempt = 0;
  while (true) {
    try {
      return await openXblFetchJson(url);
    } catch (err) {
      if (err instanceof RateLimitError) {
        attempt += 1;
        if (attempt > XBL_MAX_RETRIES) throw err;

        const backoff = Math.min(
          XBL_BACKOFF_MAX_MS,
          err.retryAfterMs ?? XBL_BACKOFF_BASE_MS * Math.pow(2, attempt - 1)
        );

        console.log(`[XBL] 429 rate limit. Backing off ${backoff}ms (attempt ${attempt}/${XBL_MAX_RETRIES})`);
        await sleep(backoff);
        continue;
      }
      throw err;
    }
  }
}

async function openXblSearch(gamertag) {
  const base = "https://xbl.io/api/v2";
  const wanted = normalizeGamertag(gamertag);
  const url = `${base}/search/${encodeURIComponent(wanted)}`;

  const data = await openXblFetchWithRetry(url);
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
  return await openXblFetchWithRetry(url);
}

// ===== OpenXBL merge =====
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

async function fetchOpenXblMergedProfile(gamertag) {
  const person = await openXblSearch(gamertag);
  const xuid = person.xuid;
  const accData = await openXblAccount(xuid);

  const settingsArr = accData?.profileUsers?.[0]?.settings;
  const settingsMap = settingsToMap(settingsArr);

  const displayGamertag =
    readSetting(settingsMap, "Gamertag") || person.gamertag || normalizeGamertag(gamertag);

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

  const keyNamesLower = new Set(["followerscount", "followercount", "followingcount", "friendscount", "friendcount"]);
  const socialNums = deepFindNumbers({ person, accData }, keyNamesLower);

  const followerCount = socialNums["followercount"] ?? socialNums["followerscount"] ?? null;
  const followingCount = socialNums["followingcount"] ?? null;
  const friendCount = socialNums["friendcount"] ?? socialNums["friendscount"] ?? null;

  return {
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

// ===== Interactions =====
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const cmd = interaction.commandName;
  const allowed = new Set([
    "xcheck",
    "xinfo",
    "xflagged",
    "xtrust",
    "price",
    "buy",
    "sell",
    "pricesearch",
    "pricecategory",
    "sellbatch",
    "buybatch",
    "pricestats",
    "pricereload",
  ]);
  if (!allowed.has(cmd)) return;

  try {
    // staff gating
    if (cmd === "xflagged" || cmd === "xtrust" || cmd === "pricestats" || cmd === "pricereload") {
      if (!isStaff(interaction)) {
        await interaction.reply({ content: "You don’t have permission to use that command.", ephemeral: true });
        return;
      }
    }

    await interaction.deferReply({ ephemeral: false });

    // =========================
    // Trader commands
    // =========================
    if (
      cmd === "price" ||
      cmd === "buy" ||
      cmd === "sell" ||
      cmd === "pricesearch" ||
      cmd === "pricecategory" ||
      cmd === "sellbatch" ||
      cmd === "buybatch" ||
      cmd === "pricestats" ||
      cmd === "pricereload"
    ) {
      if (cmd === "pricereload") {
        if (PRICE_SOURCE !== "csv") {
          await interaction.editReply("❌ PRICE_SOURCE is not set to `csv`, so reload does nothing right now.");
          return;
        }
        const res = reloadTraderData();
        await interaction.editReply(res.ok ? `✅ Reloaded (${res.count} items).` : `❌ Failed: ${res.error}`);
        return;
      }

      if (cmd === "pricestats") {
        const total = trader.itemsByKey.size;
        let buyOnly = 0;
        let sellOnly = 0;
        for (const it of trader.itemsByKey.values()) {
          const hasBuy = Number.isFinite(it.buy);
          const hasSell = Number.isFinite(it.sell);
          if (hasBuy && !hasSell) buyOnly++;
          if (!hasBuy && hasSell) sellOnly++;
        }

        const embed = new EmbedBuilder()
          .setTitle("Trader Pricelist Stats")
          .setColor(0x2b2d31)
          .addFields(
            { name: "Source", value: trader.source, inline: true },
            { name: "Items", value: String(total), inline: true },
            { name: "Categories", value: String(trader.categoryList.length), inline: true },
            { name: "Buy-only", value: String(buyOnly), inline: true },
            { name: "Sell-only", value: String(sellOnly), inline: true }
          )
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (cmd === "pricecategory") {
        const categoryInput = (interaction.options.getString("category", true) ?? "").trim();
        const cat = trader.categoryList.find((c) => c.toLowerCase() === categoryInput.toLowerCase());
        if (!cat) {
          const suggestions = trader.categoryList
            .filter((c) => c.toLowerCase().includes(categoryInput.toLowerCase()))
            .slice(0, 10);
          await interaction.editReply(
            suggestions.length
              ? `Category not found. Did you mean:\n${suggestions.map((s) => `• ${s}`).join("\n")}`
              : "Category not found."
          );
          return;
        }

        const keys = Array.from(trader.categories.get(cat) ?? []);
        const lines = keys
          .map((k) => trader.itemsByKey.get(k))
          .filter(Boolean)
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((it) => {
            const b = Number.isFinite(it.buy) ? `Buy ${formatMoney(it.buy)}` : "";
            const s = Number.isFinite(it.sell) ? `Sell ${formatMoney(it.sell)}` : "";
            const mid = b && s ? `${b} / ${s}` : b || s || "No prices";
            return `${it.name} — ${mid}`;
          });

        const embeds = buildListEmbeds(`Category: ${cat} • ${lines.length}`, lines.length ? lines : ["No items found."], 0x2b2d31);
        await interaction.editReply({ embeds: [embeds[0]] });
        for (let i = 1; i < embeds.length; i++) await interaction.followUp({ embeds: [embeds[i]] });
        return;
      }

      if (cmd === "pricesearch") {
        const q = interaction.options.getString("query", true);
        const hits = findItems(q, 25);
        if (!hits.length) {
          await interaction.editReply("No matches found.");
          return;
        }
        const lines = hits.map((it) => {
          const b = Number.isFinite(it.buy) ? `Buy ${formatMoney(it.buy)}` : "";
          const s = Number.isFinite(it.sell) ? `Sell ${formatMoney(it.sell)}` : "";
          const mid = b && s ? `${b} / ${s}` : b || s || "No prices";
          return `${it.name} — ${mid} • ${it.category}`;
        });
        const embeds = buildListEmbeds(`Search: "${q}" • ${hits.length}`, lines, 0x2b2d31);
        await interaction.editReply({ embeds: [embeds[0]] });
        for (let i = 1; i < embeds.length; i++) await interaction.followUp({ embeds: [embeds[i]] });
        return;
      }

      if (cmd === "sellbatch" || cmd === "buybatch") {
        const mode = cmd === "sellbatch" ? "sell" : "buy";
        const input = interaction.options.getString("items", true);
        const items = parseBatch(input);

        if (!items.length) {
          await interaction.editReply("No items detected. Example: `Sea Chest x2, Nails x1`");
          return;
        }

        const lines = [];
        const missing = [];
        const notAccepted = [];
        let total = 0;

        for (const it of items) {
          const hits = findItems(it.name, 1);
          if (!hits.length) {
            missing.push(`${it.name} x${it.qty}`);
            continue;
          }
          const chosen = hits[0];
          const price = mode === "sell" ? chosen.sell : chosen.buy;

          if (!Number.isFinite(price)) {
            notAccepted.push(`${chosen.name} x${it.qty}`);
            continue;
          }

          const lineTotal = price * it.qty;
          total += lineTotal;
          lines.push(`${chosen.name} x${it.qty} — ${formatMoney(price)} each — **${formatMoney(lineTotal)}**`);
        }

        const embed = new EmbedBuilder()
          .setTitle(mode === "sell" ? "Sell Batch Total" : "Buy Batch Total")
          .setColor(0x2b2d31)
          .setTimestamp();

        if (lines.length) embed.setDescription(lines.join("\n").slice(0, 3900));
        embed.addFields({ name: "Total", value: `**${formatMoney(total)}**`, inline: false });

        if (missing.length) embed.addFields({ name: "Not Found", value: missing.join("\n").slice(0, 1024), inline: false });
        if (notAccepted.length)
          embed.addFields(
            { name: mode === "sell" ? "Trader does not buy" : "Trader does not sell", value: notAccepted.join("\n").slice(0, 1024), inline: false }
          );

        await interaction.editReply({ embeds: [embed] });
        return;
      }

      // price/buy/sell single
      const itemInput = interaction.options.getString("item", true);
      const hits = findItems(itemInput, 10);
      if (!hits.length) {
        await interaction.editReply("Item not found. Try `/pricesearch` with a partial name.");
        return;
      }

      const chosen = hits[0];
      // If multiple results and not an exact match, show suggestions
      if (hits.length > 1 && itemKey(chosen.name) !== itemKey(itemInput)) {
        const lines = hits.map((it) => {
          const b = Number.isFinite(it.buy) ? `Buy ${formatMoney(it.buy)}` : "";
          const s = Number.isFinite(it.sell) ? `Sell ${formatMoney(it.sell)}` : "";
          const mid = b && s ? `${b} / ${s}` : b || s || "No prices";
          return `${it.name} — ${mid} • ${it.category}`;
        });
        const embeds = buildListEmbeds(`Multiple matches for "${itemInput}"`, lines, 0x2b2d31);
        await interaction.editReply({ embeds: [embeds[0]] });
        return;
      }

      if (cmd === "sell") {
        if (!Number.isFinite(chosen.sell)) {
          await interaction.editReply(`❌ Trader does not buy **${chosen.name}** (no sell price set).`);
          return;
        }
      }
      if (cmd === "buy") {
        if (!Number.isFinite(chosen.buy)) {
          await interaction.editReply(`❌ Trader does not sell **${chosen.name}** (no buy price set).`);
          return;
        }
      }

      const embed = new EmbedBuilder().setTitle(chosen.name).setColor(0x2b2d31).setTimestamp();
      addFieldIf(embed, "Category", chosen.category, true);

      if (cmd === "buy") {
        addFieldIf(embed, "Buy", formatMoney(chosen.buy), true);
      } else if (cmd === "sell") {
        addFieldIf(embed, "Sell", formatMoney(chosen.sell), true);
      } else {
        addFieldIf(embed, "Buy", Number.isFinite(chosen.buy) ? formatMoney(chosen.buy) : "—", true);
        addFieldIf(embed, "Sell", Number.isFinite(chosen.sell) ? formatMoney(chosen.sell) : "— (not purchased)", true);
      }

      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // =========================
    // Existing Xbox commands
    // =========================
    if (cmd === "xtrust") {
      const action = (interaction.options.getString("action", true) ?? "").toLowerCase();
      const input = interaction.options.getString("gamertag") ?? "";

      if (action === "list") {
        const entries = Object.entries(state.trusted || {})
          .map(([k, v]) => ({ gamertag: v?.gamertag || k }))
          .sort((a, b) => (a.gamertag || "").localeCompare(b.gamertag || ""));
        const lines = entries.map((e) => e.gamertag);

        const embeds = buildListEmbeds(
          `Trusted Gamertags • ${lines.length}`,
          lines.length ? lines : ["No trusted gamertags saved."],
          0x00ff00
        );
        await interaction.editReply({ embeds: [embeds[0]] });
        for (let i = 1; i < embeds.length; i++) await interaction.followUp({ embeds: [embeds[i]] });
        return;
      }

      const gts = parseGamertagList(input);
      if (gts.length === 0) {
        await interaction.editReply("You must provide gamertag(s) for add/remove. Separate multiple with commas.");
        return;
      }

      if (action === "add") {
        let added = 0;
        let removedFromFlagged = 0;
        let already = 0;
        const addedList = [];
        const alreadyList = [];
        const invalidList = [];

        for (const gt of gts) {
          const k = gtKey(gt);
          if (!k) {
            invalidList.push(gt);
            continue;
          }
          if (isTrustedKey(k)) {
            already++;
            alreadyList.push(trustedDisplayForKey(k));
            continue;
          }
          const res = trustGamertag(gt);
          if (res.ok) {
            added++;
            addedList.push(res.display);
            if (res.removedFlagged) removedFromFlagged++;
          }
        }

        const embed = new EmbedBuilder()
          .setTitle("Trusted Update")
          .setColor(0x00ff00)
          .addFields(
            { name: "Added", value: String(added), inline: true },
            { name: "Removed from flagged", value: String(removedFromFlagged), inline: true },
            { name: "Already trusted", value: String(already), inline: true }
          )
          .setTimestamp();

        if (addedList.length) embed.addFields({ name: "Added Gamertags", value: addedList.join("\n").slice(0, 1024), inline: false });
        if (alreadyList.length) embed.addFields({ name: "Already Trusted", value: alreadyList.join("\n").slice(0, 1024), inline: false });
        if (invalidList.length) embed.addFields({ name: "Invalid", value: invalidList.join("\n").slice(0, 1024), inline: false });

        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (action === "remove") {
        let removed = 0;
        let notFound = 0;
        const removedList = [];
        const notFoundList = [];

        for (const gt of gts) {
          const k = gtKey(gt);
          if (!k) continue;

          if (!isTrustedKey(k)) {
            notFound++;
            notFoundList.push(gt);
            continue;
          }

          const res = untrustGamertag(gt);
          if (res.ok) {
            removed++;
            removedList.push(res.display);
          }
        }

        const embed = new EmbedBuilder()
          .setTitle("Trusted Update")
          .setColor(0xffcc00)
          .addFields(
            { name: "Removed", value: String(removed), inline: true },
            { name: "Not trusted", value: String(notFound), inline: true }
          )
          .setTimestamp();

        if (removedList.length) embed.addFields({ name: "Removed Gamertags", value: removedList.join("\n").slice(0, 1024), inline: false });
        if (notFoundList.length) embed.addFields({ name: "Not Trusted", value: notFoundList.join("\n").slice(0, 1024), inline: false });

        await interaction.editReply({ embeds: [embed] });
        return;
      }

      await interaction.editReply("Invalid action. Use add/remove/list.");
      return;
    }

    if (cmd === "xflagged") {
      const scope = (interaction.options.getString("scope") ?? "pending").toLowerCase();

      if (scope === "pending") {
        const items = Array.from(state.pending.entries())
          .map(([k, v]) => ({ k, ...v }))
          .filter((x) => !isTrustedKey(x.k))
          .sort((a, b) => (a.gamertag || "").localeCompare(b.gamertag || ""));

        const lines = items.map((x) => x.gamertag);
        const embeds = buildListEmbeds(
          `Flagged (Pending) • ${lines.length}`,
          lines.length ? lines : ["No pending low-GS gamertags saved right now."],
          0xff0000
        );

        await interaction.editReply({ embeds: [embeds[0]] });
        for (let i = 1; i < embeds.length; i++) await interaction.followUp({ embeds: [embeds[i]] });
        return;
      }

      const items = Array.from(state.flaggedAll.entries())
        .map(([k, v]) => ({ k, ...v }))
        .filter((x) => !isTrustedKey(x.k))
        .sort((a, b) => (a.gamertag || "").localeCompare(b.gamertag || ""));

      const lines = items.map((x) => `${x.gamertag}${Number.isFinite(x.lastKnownGS) ? ` (${x.lastKnownGS})` : ""}`);

      const embeds = buildListEmbeds(
        `Flagged (All-Time) • ${lines.length}`,
        lines.length ? lines : ["No saved low-GS gamertags yet."],
        0xff0000
      );

      await interaction.editReply({ embeds: [embeds[0]] });
      for (let i = 1; i < embeds.length; i++) await interaction.followUp({ embeds: [embeds[i]] });
      return;
    }

    // /xcheck + /xinfo
    const gamertagInput = normalizeGamertag(interaction.options.getString("gamertag", true));
    const merged = await fetchOpenXblMergedProfile(gamertagInput);
    const flaggedByGS = merged.gamerscore !== null ? merged.gamerscore < GS_THRESHOLD : false;

    if (cmd === "xcheck") {
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

    const embed = new EmbedBuilder()
      .setTitle("Xbox Profile Info")
      .setColor(flaggedByGS ? 0xff4d4d : 0x2b2d31)
      .setTimestamp();

    if (merged.gamerpic) embed.setThumbnail(merged.gamerpic);

    addFieldIf(embed, "Gamertag", merged.gamertag, true);
    addFieldIf(embed, "XUID", merged.xuid ? String(merged.xuid) : "", true);
    if (merged.gamerscore !== null) addFieldIf(embed, "Gamerscore", String(merged.gamerscore), true);
    addFieldIf(embed, "Account Tier", merged.tier ? String(merged.tier) : "", true);
    addFieldIf(embed, "Xbox Rep", merged.xboxRep ? String(merged.xboxRep) : "", true);
    addFieldIf(embed, "Presence", merged.presenceState ? String(merged.presenceState) : "", true);
    addFieldIf(embed, "Status", merged.presenceText ? String(merged.presenceText) : "", true);
    addFieldIf(embed, "Last Seen", merged.lastSeen ? String(merged.lastSeen) : "", false);
    addFieldIf(embed, "Bio", merged.bio ? String(merged.bio) : "", false);
    addFieldIf(embed, "Location", merged.location ? String(merged.location) : "", true);
    addFieldIf(embed, "Tenure", merged.tenure ? String(merged.tenure) : "", true);

    if (merged.hasGamePass === true || merged.hasGamePass === false) {
      addFieldIf(embed, "Game Pass", formatBool(merged.hasGamePass), true);
    } else if (typeof merged.hasGamePass === "string" && merged.hasGamePass.trim() !== "") {
      addFieldIf(embed, "Game Pass", merged.hasGamePass.trim(), true);
    }

    const hasFollowerCount = typeof merged.followerCount === "number";
    const hasFollowingCount = typeof merged.followingCount === "number";
    const hasFriendCount = typeof merged.friendCount === "number";

    if (hasFollowerCount) addFieldIf(embed, "Followers", String(merged.followerCount), true);
    if (hasFollowingCount) addFieldIf(embed, "Following", String(merged.followingCount), true);
    if (hasFriendCount) addFieldIf(embed, "Friends", String(merged.friendCount), true);

    const zeros = [];
    if (hasFollowerCount && merged.followerCount === 0) zeros.push("Followers=0");
    if (hasFollowingCount && merged.followingCount === 0) zeros.push("Following=0");
    if (hasFriendCount && merged.friendCount === 0) zeros.push("Friends=0");
    if (zeros.length) embed.addFields({ name: "⚠️ Social Looks Empty", value: zeros.join(" • "), inline: false });

    embed.setFooter({ text: "Note: Some fields may be unavailable due to Xbox privacy settings." });

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error("interaction error:", err?.message ?? err);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply("Something went wrong while processing that request.");
      } else {
        await interaction.reply({ content: "Something went wrong while processing that request.", ephemeral: true });
      }
    } catch {}
  }
});

// ===== Ready =====
client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // Load trader prices
  const res = reloadTraderData();
  if (!res.ok) console.log(`[TRADER] Price load failed: ${res.error}`);

  await autoDeployCommandsIfEnabled();

  await pollOnlineList().catch((e) => console.error("[POLL] error:", e));

  setInterval(() => {
    pollOnlineList().catch((e) => console.error("[POLL] error:", e));
  }, POLL_SECONDS * 1000);

  setInterval(() => {
    sendDigestIfDue().catch((e) => console.error("[DIGEST] error:", e));
  }, 60 * 1000);

  await sendDigestIfDue().catch((e) => console.error("[DIGEST] error:", e));
});

client.login(DISCORD_TOKEN);
