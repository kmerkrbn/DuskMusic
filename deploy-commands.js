require("dotenv").config();
const { REST, Routes, SlashCommandBuilder } = require("discord.js");

const commands = [
  new SlashCommandBuilder()
    .setName("müzikaç")
    .setDescription("YouTube linki ile müzik çalar. Ses 5-100.")
    .addStringOption(o => o.setName("youtubeurl").setDescription("YouTube linki").setRequired(true))
    .addIntegerOption(o => o.setName("ses").setDescription("5-100").setRequired(true).setMinValue(5).setMaxValue(100)),

  new SlashCommandBuilder()
    .setName("müzikses")
    .setDescription("Çalan müziğin sesini ayarlar (5-100).")
    .addIntegerOption(o => o.setName("ses").setDescription("5-100").setRequired(true).setMinValue(5).setMaxValue(100)),

  new SlashCommandBuilder()
    .setName("müzikdurdur")
    .setDescription("Müziği duraklatır."),

  new SlashCommandBuilder()
    .setName("müziğibaşlat")
    .setDescription("Duraklatılan müziği devam ettirir."),

  new SlashCommandBuilder()
    .setName("sırayamüzikekle")
    .setDescription("Sıraya YouTube linki ekler.")
    .addStringOption(o => o.setName("youtubeurl").setDescription("YouTube linki").setRequired(true)),

  new SlashCommandBuilder()
    .setName("geç")
    .setDescription("Çalan şarkıyı geçer (skip)."),
].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log("Komutlar yükleniyor...");
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log("Komutlar yüklendi ✅");
  } catch (err) {
    console.error(err);
  }
})();
