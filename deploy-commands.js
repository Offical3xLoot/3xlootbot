import { REST, Routes, SlashCommandBuilder } from "discord.js";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error("Missing env vars. Need DISCORD_TOKEN, CLIENT_ID, GUILD_ID.");
  process.exit(1);
}

const command = new SlashCommandBuilder()
  .setName("xcheck")
  .setDescription("Check an Xbox gamertag for Gamerscore (OpenXBL)")
  .addStringOption((opt) =>
    opt
      .setName("gamertag")
      .setDescription("Xbox Gamertag (spaces allowed)")
      .setRequired(true)
  );

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

try {
  console.log("Registering guild slash commands...");
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
    body: [command.toJSON()],
  });
  console.log("Done. /xcheck is registered in your guild.");
} catch (err) {
  console.error("Failed to register commands:", err);
  process.exit(1);
}
