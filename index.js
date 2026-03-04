// =============================
// 3xLoot Discord Bot
// Trader Prices + Autocomplete Dropdowns + Pagination + Trade Calculator
// =============================

import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";

import fs from "node:fs";
import crypto from "node:crypto";

// =============================
// ENV
// =============================

const DISCORD_TOKEN = (process.env.DISCORD_TOKEN ?? "").trim();
const DISCORD_CLIENT_ID = (process.env.DISCORD_CLIENT_ID ?? "").trim();
const GUILD_ID = (process.env.GUILD_ID ?? "").trim();

const TRADER_PRICE_JSON_PATH = (process.env.TRADER_PRICE_JSON_PATH ?? "trader_prices.json").trim();

function die(msg) {
  console.error(msg);
  process.exit(1);
}

if (!DISCORD_TOKEN) die("Missing DISCORD_TOKEN");
if (!DISCORD_CLIENT_ID) die("Missing DISCORD_CLIENT_ID");
if (!GUILD_ID) die("Missing GUILD_ID");

// =============================
// CLIENT
// =============================

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// =============================
// LOAD TRADER DATA
// =============================

let trader = {
  loaded: false,
  itemsByKey: new Map(),          // key -> {key,name,category,buy,sell,unit_note?}
  itemsArray: [],                 // array of item objects
  categories: [],                 // array of category names
  itemsByCategory: new Map(),     // category -> [item objects]
};

function loadTrader() {
  try {
    if (!fs.existsSync(TRADER_PRICE_JSON_PATH)) {
      console.log(`[TRADER] Trader JSON not found at ${TRADER_PRICE_JSON_PATH}.`);
      trader.loaded = false;
      return;
    }

    const raw = fs.readFileSync(TRADER_PRICE_JSON_PATH, "utf8");
    const json = JSON.parse(raw);

    trader.itemsByKey = new Map();
    trader.itemsArray = [];
    trader.categories = Array.isArray(json?.categories) ? json.categories.slice() : [];
    trader.itemsByCategory = new Map();

    const byKey = json?.items_by_key ?? {};
    for (const [k, v] of Object.entries(byKey)) {
      if (!v?.name) continue;
      trader.itemsByKey.set(k, v);
      trader.itemsArray.push(v);
    }

    const byCat = json?.items_by_category ?? {};
    for (const [cat, arr] of Object.entries(byCat)) {
      if (!Array.isArray(arr)) continue;
      trader.itemsByCategory.set(cat, arr);
    }

    // If categories missing, derive from data
    if (!trader.categories.length) {
      const set = new Set();
      for (const it of trader.itemsArray) if (it?.category) set.add(it.category);
      trader.categories = Array.from(set.values()).sort((a, b) => a.localeCompare(b));
    }

    trader.loaded = true;
    console.log(`[TRADER] Loaded ${trader.itemsArray.length} items across ${trader.categories.length} categories.`);
  } catch (e) {
    console.error("[TRADER] Failed to load JSON:", e?.message ?? e);
    trader.loaded = false;
  }
}

loadTrader();

// =============================
// HELPERS
// =============================

function money(n) {
  if (n === null || n === undefined || n === "") return "—";
  const num = Number(n);
  if (!Number.isFinite(num)) return "—";
  return `$${num.toLocaleString()}`;
}

function norm(s) {
  return (s ?? "").toString().trim();
}

function lc(s) {
  return norm(s).toLowerCase();
}

// Prefer startsWith matches, then includes, cap results for autocomplete
function autocompleteItems(query, limit = 25) {
  const q = lc(query);
  if (!q) return trader.itemsArray.slice(0, limit).map((it) => it.name);

  const starts = [];
  const includes = [];
  for (const it of trader.itemsArray) {
    const name = it?.name ?? "";
    const nl = name.toLowerCase();
    if (!nl) continue;
    if (nl.startsWith(q)) starts.push(name);
    else if (nl.includes(q)) includes.push(name);
    if (starts.length >= limit) break;
  }

  const combined = starts.concat(includes).slice(0, limit);
  // De-dupe while preserving order
  const seen = new Set();
  const out = [];
  for (const n of combined) {
    const k = n.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(n);
    if (out.length >= limit) break;
  }
  return out;
}

function autocompleteCategories(query, limit = 25) {
  const q = lc(query);
  const arr = trader.categories || [];
  if (!q) return arr.slice(0, limit);
  return arr.filter((c) => c.toLowerCase().includes(q)).slice(0, limit);
}

function findExactOrFuzzyItem(inputName) {
  const needle = lc(inputName);
  if (!needle) return null;

  // Exact by name (case-insensitive)
  for (const it of trader.itemsArray) {
    if (lc(it?.name) === needle) return it;
  }

  // Then startsWith
  for (const it of trader.itemsArray) {
    if (lc(it?.name).startsWith(needle)) return it;
  }

  // Then includes
  for (const it of trader.itemsArray) {
    if (lc(it?.name).includes(needle)) return it;
  }

  return null;
}

// --- Trade Calc parsing ---
// Accepts lines like:
// "Ghillie Suit x2"
// "2x Ghillie Suit"
// "2 Ghillie Suit"
// "Ghillie Suit 2"
// Also supports comma-separated in one line.
function parseCalcLines(input) {
  const raw = norm(input);
  if (!raw) return [];

  const chunks = raw
    .replace(/\r/g, "")
    .split("\n")
    .flatMap((line) => line.split(","))
    .map((s) => s.trim())
    .filter(Boolean);

  const out = [];
  for (const line of chunks) {
    // Normalize multiple spaces
    const s = line.replace(/\s+/g, " ").trim();

    // Patterns:
    // 1) "2x Item" or "2 x Item"
    let m = s.match(/^\s*(\d+)\s*x\s+(.+?)\s*$/i);
    if (m) {
      out.push({ qty: Number(m[1]), name: m[2].trim() });
      continue;
    }

    // 2) "Item x2" or "Item x 2"
    m = s.match(/^\s*(.+?)\s*x\s*(\d+)\s*$/i);
    if (m) {
      out.push({ qty: Number(m[2]), name: m[1].trim() });
      continue;
    }

    // 3) "2 Item"
    m = s.match(/^\s*(\d+)\s+(.+?)\s*$/);
    if (m) {
      out.push({ qty: Number(m[1]), name: m[2].trim() });
      continue;
    }

    // 4) "Item 2"
    m = s.match(/^\s*(.+?)\s+(\d+)\s*$/);
    if (m) {
      out.push({ qty: Number(m[2]), name: m[1].trim() });
      continue;
    }

    // Default qty=1
    out.push({ qty: 1, name: s });
  }

  // Sanity
  return out
    .map((x) => ({ qty: Number.isFinite(x.qty) ? Math.max(1, Math.floor(x.qty)) : 1, name: norm(x.name) }))
    .filter((x) => x.name.length > 0);
}

// =============================
// PAGINATION
// =============================

const pagerSessions = new Map();
// session id -> { userId, embeds, page, createdMs }
const PAGER_TTL_MS = 10 * 60 * 1000; // 10 minutes

function createPager(userId, embeds) {
  const id = crypto.randomBytes(8).toString("hex");
  pagerSessions.set(id, { userId, embeds, page: 0, createdMs: Date.now() });
  return id;
}

function pagerButtons(id, page, total) {
  const prev = new ButtonBuilder()
    .setCustomId(`pg:${id}:${page - 1}`)
    .setLabel("Prev")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(page <= 0);

  const next = new ButtonBuilder()
    .setCustomId(`pg:${id}:${page + 1}`)
    .setLabel("Next")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(page >= total - 1);

  const info = new ButtonBuilder()
    .setCustomId(`pg:${id}:info`)
    .setLabel(`${page + 1}/${total}`)
    .setStyle(ButtonStyle.Primary)
    .setDisabled(true);

  return new ActionRowBuilder().addComponents(prev, info, next);
}

function gcPagers() {
  const now = Date.now();
  for (const [id, s] of pagerSessions.entries()) {
    if (!s?.createdMs || now - s.createdMs > PAGER_TTL_MS) pagerSessions.delete(id);
  }
}

// =============================
// COMMANDS (with Autocomplete)
// =============================

const commands = [
  new SlashCommandBuilder()
    .setName("price")
    .setDescription("Check trader price for an item.")
    .addStringOption((o) =>
      o
        .setName("item")
        .setDescription("Start typing to pick an item")
        .setRequired(true)
        .setAutocomplete(true)
    ),

  new SlashCommandBuilder()
    .setName("pricesearch")
    .setDescription("Search the trader list (paginated).")
    .addStringOption((o) =>
      o.setName("query").setDescription("Search text").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("pricecategory")
    .setDescription("Show a category (paginated).")
    .addStringOption((o) =>
      o
        .setName("category")
        .setDescription("Start typing to pick a category")
        .setRequired(true)
        .setAutocomplete(true)
    ),

  new SlashCommandBuilder()
    .setName("tradecalc")
    .setDescription("Calculate total buy/sell value for multiple items.")
    .addStringOption((o) =>
      o
        .setName("mode")
        .setDescription("buy = you pay the trader, sell = trader pays you")
        .addChoices({ name: "buy", value: "buy" }, { name: "sell", value: "sell" })
        .setRequired(true)
    )
    .addStringOption((o) =>
      o
        .setName("items")
        .setDescription("Paste items (one per line). Examples: 'Ghillie Suit x2' or '2x Ghillie Suit'")
        .setRequired(true)
    ),
].map((c) => c.toJSON());

async function deployCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  console.log("[COMMANDS] Deploying guild commands...");
  await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, GUILD_ID), { body: commands });
  console.log("[COMMANDS] Done.");
}

// =============================
// AUTOCOMPLETE HANDLER
// =============================

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isAutocomplete()) return;
  if (!trader.loaded) {
    await interaction.respond([]).catch(() => {});
    return;
  }

  try {
    const cmd = interaction.commandName;
    const focused = interaction.options.getFocused(true); // {name,value}
    const q = focused?.value ?? "";

    if (cmd === "price" && focused.name === "item") {
      const items = autocompleteItems(q, 25);
      await interaction.respond(items.map((name) => ({ name, value: name })));
      return;
    }

    if (cmd === "pricecategory" && focused.name === "category") {
      const cats = autocompleteCategories(q, 25);
      await interaction.respond(cats.map((c) => ({ name: c, value: c })));
      return;
    }

    await interaction.respond([]);
  } catch (e) {
    console.error("[AUTOCOMPLETE] error:", e?.message ?? e);
    try {
      await interaction.respond([]);
    } catch {}
  }
});

// =============================
// BUTTON HANDLER (pagination)
// =============================

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;

  const id = interaction.customId;
  if (!id.startsWith("pg:")) return;

  gcPagers();

  const parts = id.split(":"); // pg:<sessionId>:<page>
  const sessionId = parts[1];
  const targetRaw = parts[2];

  const session = pagerSessions.get(sessionId);
  if (!session) {
    await interaction.reply({ content: "That menu expired. Run the command again.", ephemeral: true }).catch(() => {});
    return;
  }

  if (session.userId !== interaction.user.id) {
    await interaction.reply({ content: "Not your menu.", ephemeral: true }).catch(() => {});
    return;
  }

  const target = Number.parseInt(targetRaw, 10);
  if (!Number.isFinite(target)) return;

  const total = session.embeds.length;
  const page = Math.max(0, Math.min(total - 1, target));
  session.page = page;

  await interaction
    .update({
      embeds: [session.embeds[page]],
      components: [pagerButtons(sessionId, page, total)],
    })
    .catch(() => {});
});

// =============================
// COMMAND HANDLER
// =============================

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (!trader.loaded) {
    await interaction.reply("Trader list not loaded. Check TRADER_PRICE_JSON_PATH and redeploy.").catch(() => {});
    return;
  }

  try {
    const cmd = interaction.commandName;

    if (cmd === "price") {
      const itemName = interaction.options.getString("item", true);
      const it = findExactOrFuzzyItem(itemName);

      if (!it) {
        await interaction.reply("Item not found. Try /pricesearch.").catch(() => {});
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle(it.name)
        .setColor(0x2b2d31)
        .addFields(
          { name: "Buy", value: money(it.buy), inline: true },
          { name: "Sell", value: money(it.sell), inline: true },
          { name: "Category", value: it.category || "—", inline: true }
        )
        .setTimestamp();

      if (it.unit_note) embed.addFields({ name: "Notes", value: String(it.unit_note).slice(0, 1024), inline: false });

      await interaction.reply({ embeds: [embed] });
      return;
    }

    if (cmd === "pricesearch") {
      const q = interaction.options.getString("query", true);
      const ql = q.toLowerCase();

      const results = trader.itemsArray.filter((it) => (it?.name ?? "").toLowerCase().includes(ql));
      if (results.length === 0) {
        await interaction.reply("No results.").catch(() => {});
        return;
      }

      // 10 per page
      const embeds = [];
      for (let i = 0; i < results.length; i += 10) {
        const chunk = results.slice(i, i + 10);

        const lines = chunk.map((it) => {
          const note = it.unit_note ? ` _(${it.unit_note})_` : "";
          return `• **${it.name}**${note}\n  Buy: **${money(it.buy)}** • Sell: **${money(it.sell)}** • Cat: *${it.category || "—"}*`;
        });

        const embed = new EmbedBuilder()
          .setTitle(`Search Results: ${q}`)
          .setDescription(lines.join("\n"))
          .setColor(0x2b2d31)
          .setTimestamp();

        embed.setFooter({ text: `Results ${i + 1}-${Math.min(i + 10, results.length)} of ${results.length}` });

        embeds.push(embed);
      }

      const id = createPager(interaction.user.id, embeds);
      await interaction.reply({
        embeds: [embeds[0]],
        components: [pagerButtons(id, 0, embeds.length)],
      });
      return;
    }

    if (cmd === "pricecategory") {
      const cat = interaction.options.getString("category", true);

      // exact match first, then case-insensitive
      let items = trader.itemsByCategory.get(cat);
      if (!items) {
        const found = trader.categories.find((c) => c.toLowerCase() === cat.toLowerCase());
        if (found) items = trader.itemsByCategory.get(found);
      }

      if (!items || items.length === 0) {
        await interaction.reply("Category not found or empty.").catch(() => {});
        return;
      }

      const embeds = [];
      for (let i = 0; i < items.length; i += 10) {
        const chunk = items.slice(i, i + 10);

        const lines = chunk.map((it) => {
          const note = it.unit_note ? ` _(${it.unit_note})_` : "";
          return `• **${it.name}**${note}\n  Buy: **${money(it.buy)}** • Sell: **${money(it.sell)}**`;
        });

        const embed = new EmbedBuilder()
          .setTitle(`Category: ${cat}`)
          .setDescription(lines.join("\n"))
          .setColor(0x2b2d31)
          .setTimestamp();

        embed.setFooter({ text: `Items ${i + 1}-${Math.min(i + 10, items.length)} of ${items.length}` });

        embeds.push(embed);
      }

      const id = createPager(interaction.user.id, embeds);
      await interaction.reply({
        embeds: [embeds[0]],
        components: [pagerButtons(id, 0, embeds.length)],
      });
      return;
    }

    if (cmd === "tradecalc") {
      const mode = interaction.options.getString("mode", true); // buy | sell
      const itemsText = interaction.options.getString("items", true);

      const parsed = parseCalcLines(itemsText);
      if (parsed.length === 0) {
        await interaction.reply("No items detected. Paste one item per line like: `Ghillie Suit x2`").catch(() => {});
        return;
      }

      const lines = [];
      let total = 0;
      const unknown = [];
      const missingPrice = [];

      for (const row of parsed) {
        const it = findExactOrFuzzyItem(row.name);
        if (!it) {
          unknown.push(`${row.qty}x ${row.name}`);
          continue;
        }

        const unit = mode === "buy" ? it.buy : it.sell;
        const unitNum = unit === null || unit === undefined ? null : Number(unit);

        if (!Number.isFinite(unitNum)) {
          missingPrice.push(`${row.qty}x ${it.name}`);
          continue;
        }

        const lineTotal = unitNum * row.qty;
        total += lineTotal;

        const note = it.unit_note ? ` _(${it.unit_note})_` : "";
        lines.push(`• **${row.qty}x ${it.name}**${note}\n  Unit: **${money(unitNum)}** • Line: **${money(lineTotal)}**`);
      }

      // Build embeds (8 lines per page for readability)
      const embeds = [];
      const pageSize = 8;

      const header = new EmbedBuilder()
        .setTitle(`Trade Calculator • ${mode.toUpperCase()}`)
        .setColor(mode === "sell" ? 0x00c853 : 0xff6d00)
        .setTimestamp();

      header.addFields(
        { name: "Total", value: money(total), inline: true },
        { name: "Lines", value: String(lines.length), inline: true }
      );

      if (unknown.length) header.addFields({ name: "Unknown Items", value: String(unknown.length), inline: true });
      if (missingPrice.length) header.addFields({ name: "Missing Price", value: String(missingPrice.length), inline: true });

      embeds.push(header);

      for (let i = 0; i < lines.length; i += pageSize) {
        const chunk = lines.slice(i, i + pageSize);
        const e = new EmbedBuilder()
          .setTitle(`Items • ${mode.toUpperCase()}`)
          .setDescription(chunk.join("\n"))
          .setColor(mode === "sell" ? 0x00c853 : 0xff6d00)
          .setTimestamp();

        e.setFooter({ text: `Items ${i + 1}-${Math.min(i + pageSize, lines.length)} of ${lines.length}` });
        embeds.push(e);
      }

      // Add detail pages for unknown/missing, if needed
      if (unknown.length) {
        for (let i = 0; i < unknown.length; i += 15) {
          const chunk = unknown.slice(i, i + 15);
          const e = new EmbedBuilder()
            .setTitle("Unknown Items (not found)")
            .setDescription(chunk.map((x) => `• ${x}`).join("\n"))
            .setColor(0xff1744)
            .setTimestamp();
          embeds.push(e);
        }
      }

      if (missingPrice.length) {
        for (let i = 0; i < missingPrice.length; i += 15) {
          const chunk = missingPrice.slice(i, i + 15);
          const e = new EmbedBuilder()
            .setTitle(`Missing ${mode === "buy" ? "Buy" : "Sell"} Price`)
            .setDescription(chunk.map((x) => `• ${x}`).join("\n"))
            .setColor(0xff1744)
            .setTimestamp();
          embeds.push(e);
        }
      }

      if (embeds.length === 1) {
        await interaction.reply({ embeds: [embeds[0]] });
        return;
      }

      const id = createPager(interaction.user.id, embeds);
      await interaction.reply({
        embeds: [embeds[0]],
        components: [pagerButtons(id, 0, embeds.length)],
      });
      return;
    }
  } catch (e) {
    console.error("[CMD] error:", e?.message ?? e);
    await interaction.reply({ content: "Something went wrong.", ephemeral: true }).catch(() => {});
  }
});

// =============================
// READY
// =============================

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await deployCommands().catch((e) => console.error("[COMMANDS] deploy error:", e?.message ?? e));
});

client.login(DISCORD_TOKEN);
