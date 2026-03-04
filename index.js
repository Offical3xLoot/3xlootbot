
// =============================
// 3xLoot Discord Bot
// Trader Prices + Pagination
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
  ButtonStyle
} from "discord.js";

import fs from "node:fs";
import crypto from "node:crypto";

// =============================
// ENV
// =============================

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const TRADER_PRICE_JSON_PATH = process.env.TRADER_PRICE_JSON_PATH || "trader_prices.json";

// =============================
// CLIENT
// =============================

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// =============================
// LOAD TRADER DATA
// =============================

let trader = {
  loaded: false,
  itemsByKey: new Map(),
  categories: new Map(),
  categoryList: []
};

function loadTrader(){

  if(!fs.existsSync(TRADER_PRICE_JSON_PATH)){
    console.log("Missing trader JSON:", TRADER_PRICE_JSON_PATH);
    return;
  }

  const raw = fs.readFileSync(TRADER_PRICE_JSON_PATH,"utf8");
  const json = JSON.parse(raw);

  for(const [k,v] of Object.entries(json.items_by_key)){
    trader.itemsByKey.set(k,v);
  }

  for(const [c,items] of Object.entries(json.items_by_category)){
    trader.categories.set(c,items);
  }

  trader.categoryList = json.categories;
  trader.loaded = true;

  console.log("Trader loaded:",trader.itemsByKey.size,"items");
}

loadTrader();

// =============================
// HELPERS
// =============================

function money(n){
  if(n===null||n===undefined) return "—";
  return "$"+Number(n).toLocaleString();
}

function findItem(name){
  const key=name.toLowerCase();

  if(trader.itemsByKey.has(key))
    return trader.itemsByKey.get(key);

  for(const it of trader.itemsByKey.values()){
    if(it.name.toLowerCase().includes(key))
      return it;
  }

  return null;
}

function searchItems(q){

  q=q.toLowerCase();

  const out=[];

  for(const it of trader.itemsByKey.values()){

    if(it.name.toLowerCase().includes(q)){
      out.push(it);
      if(out.length>=100) break;
    }

  }

  return out;
}

// =============================
// PAGINATION
// =============================

const pagerSessions = new Map();

function createPager(userId,embeds){

  const id=crypto.randomBytes(8).toString("hex");

  pagerSessions.set(id,{
    userId,
    embeds,
    page:0
  });

  return id;
}

function pagerButtons(id,page,total){

  const prev = new ButtonBuilder()
  .setCustomId(`pg:${id}:${page-1}`)
  .setLabel("Prev")
  .setStyle(ButtonStyle.Secondary)
  .setDisabled(page<=0);

  const next = new ButtonBuilder()
  .setCustomId(`pg:${id}:${page+1}`)
  .setLabel("Next")
  .setStyle(ButtonStyle.Secondary)
  .setDisabled(page>=total-1);

  const info = new ButtonBuilder()
  .setCustomId(`pg:${id}:info`)
  .setLabel(`${page+1}/${total}`)
  .setStyle(ButtonStyle.Primary)
  .setDisabled(true);

  return new ActionRowBuilder().addComponents(prev,info,next);
}

// =============================
// COMMANDS
// =============================

const commands=[

new SlashCommandBuilder()
.setName("price")
.setDescription("Check trader price")
.addStringOption(o=>
  o.setName("item")
  .setDescription("Item name")
  .setRequired(true)
),

new SlashCommandBuilder()
.setName("pricesearch")
.setDescription("Search trader list")
.addStringOption(o=>
  o.setName("query")
  .setDescription("Search")
  .setRequired(true)
),

new SlashCommandBuilder()
.setName("pricecategory")
.setDescription("Show category")
.addStringOption(o=>
  o.setName("category")
  .setDescription("Category")
  .setRequired(true)
)

].map(c=>c.toJSON());

// =============================
// DEPLOY COMMANDS
// =============================

async function deploy(){

const rest=new REST({version:"10"}).setToken(DISCORD_TOKEN);

await rest.put(
Routes.applicationGuildCommands(DISCORD_CLIENT_ID,GUILD_ID),
{body:commands}
);

console.log("Commands deployed");

}

// =============================
// BUTTON HANDLER
// =============================

client.on("interactionCreate",async interaction=>{

if(!interaction.isButton()) return;

const id=interaction.customId;

if(!id.startsWith("pg:")) return;

const parts=id.split(":");
const sessionId=parts[1];
const target=parseInt(parts[2]);

const session=pagerSessions.get(sessionId);

if(!session) return;

if(session.userId!==interaction.user.id){
await interaction.reply({content:"Not your menu.",ephemeral:true});
return;
}

if(isNaN(target)) return;

const total=session.embeds.length;

const page=Math.max(0,Math.min(total-1,target));

session.page=page;

await interaction.update({
embeds:[session.embeds[page]],
components:[pagerButtons(sessionId,page,total)]
});

});

// =============================
// COMMAND HANDLER
// =============================

client.on("interactionCreate",async interaction=>{

if(!interaction.isChatInputCommand()) return;

if(!trader.loaded){
await interaction.reply("Trader list not loaded.");
return;
}

// PRICE

if(interaction.commandName==="price"){

const itemName=interaction.options.getString("item");

const it=findItem(itemName);

if(!it){
await interaction.reply("Item not found.");
return;
}

const embed=new EmbedBuilder()
.setTitle(it.name)
.addFields(
{name:"Buy",value:money(it.buy),inline:true},
{name:"Sell",value:money(it.sell),inline:true},
{name:"Category",value:it.category||"—",inline:true}
);

await interaction.reply({embeds:[embed]});

}

// SEARCH

if(interaction.commandName==="pricesearch"){

const q=interaction.options.getString("query");

const results=searchItems(q);

if(results.length===0){
await interaction.reply("No results.");
return;
}

const embeds=[];

for(let i=0;i<results.length;i+=10){

const chunk=results.slice(i,i+10);

const lines=chunk.map(it=>
`• **${it.name}** | Buy ${money(it.buy)} | Sell ${money(it.sell)}`
);

const embed=new EmbedBuilder()
.setTitle(`Search: ${q}`)
.setDescription(lines.join("\n"));

embeds.push(embed);

}

const id=createPager(interaction.user.id,embeds);

await interaction.reply({
embeds:[embeds[0]],
components:[pagerButtons(id,0,embeds.length)]
});

}

// CATEGORY

if(interaction.commandName==="pricecategory"){

const cat=interaction.options.getString("category");

const items=trader.categories.get(cat);

if(!items){
await interaction.reply("Category not found.");
return;
}

const embeds=[];

for(let i=0;i<items.length;i+=10){

const chunk=items.slice(i,i+10);

const lines=chunk.map(it=>
`• **${it.name}** | Buy ${money(it.buy)} | Sell ${money(it.sell)}`
);

const embed=new EmbedBuilder()
.setTitle(cat)
.setDescription(lines.join("\n"));

embeds.push(embed);

}

const id=createPager(interaction.user.id,embeds);

await interaction.reply({
embeds:[embeds[0]],
components:[pagerButtons(id,0,embeds.length)]
});

}

});

client.once("ready",()=>{

console.log("Bot ready:",client.user.tag);

});

deploy();

client.login(DISCORD_TOKEN);
