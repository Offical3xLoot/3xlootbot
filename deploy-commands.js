import { REST, Routes, SlashCommandBuilder } from "discord.js";

const DISCORD_TOKEN = (process.env.DISCORD_TOKEN ?? "").trim();
const DISCORD_CLIENT_ID = (process.env.DISCORD_CLIENT_ID ?? "").trim();
const GUILD_ID = (process.env.GUILD_ID ?? "").trim();

function die(msg) {
  console.error(msg);
  process.exit(1);
}

if (!DISCORD_TOKEN) die("Missing DISCORD_TOKEN");
if (!DISCORD_CLIENT_ID) die("Missing DISCORD_CLIENT_ID");
if (!GUILD_ID) die("Missing GUILD_ID");

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

  new SlashCommandBuilder()
    .setName("xflagged")
    .setDescription("Show low-gamerscore gamertags saved by the bot.")
    .addStringOption((opt) =>
      opt
        .setName("scope")
        .setDescription("pending = since last digest; all = all-time saved")
        .addChoices(
          { name: "pending", value: "pending" },
          { name: "all", value: "all" }
        )
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("xtrust")
    .setDescription("Manage trusted gamertags (whitelist). You can add multiple separated by commas.")
    .addStringOption((opt) =>
      opt
        .setName("action")
        .setDescription("add/remove/list")
        .addChoices(
          { name: "add", value: "add" },
          { name: "remove", value: "remove" },
          { name: "list", value: "list" }
        )
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName("gamertag")
        .setDescription("Gamertag(s). For add/remove you can paste multiple separated by commas.")
        .setRequired(false)
    ),
].map((c) => c.toJSON());

async function main() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

  console.log("Deploying guild commands...");
  await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, GUILD_ID), {
    body: commands,
  });
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
