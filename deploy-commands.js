import { REST, Routes, SlashCommandBuilder } from "discord.js";

const DISCORD_TOKEN = (process.env.DISCORD_TOKEN ?? "").trim();
const DISCORD_CLIENT_ID = (process.env.DISCORD_CLIENT_ID ?? "").trim();
const GUILD_ID = (process.env.GUILD_ID ?? "").trim();

if (!DISCORD_TOKEN) throw new Error("Missing DISCORD_TOKEN");
if (!DISCORD_CLIENT_ID) throw new Error("Missing DISCORD_CLIENT_ID");
if (!GUILD_ID) throw new Error("Missing GUILD_ID");

const commands = [
  new SlashCommandBuilder()
    .setName("xcheck")
    .setDescription("Check an Xbox gamertag's gamerscore against the configured threshold.")
    .addStringOption((opt) =>
      opt
        .setName("gamertag")
        .setDescription("Xbox gamertag to check")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("xinfo")
    .setDescription("Fetch detailed Xbox profile info (only shows fields that are available).")
    .addStringOption((opt) =>
      opt
        .setName("gamertag")
        .setDescription("Xbox gamertag to look up")
        .setRequired(true)
    ),
].map((c) => c.toJSON());

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

async function main() {
  console.log("Deploying guild slash commands...");
  await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, GUILD_ID), {
    body: commands,
  });
  console.log("Done. /xcheck and /xinfo are registered.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
