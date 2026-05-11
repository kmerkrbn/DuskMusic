require("dotenv").config();

const { spawn } = require("child_process");
const { Client, GatewayIntentBits } = require("discord.js");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  getVoiceConnection,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  entersState,
  VoiceConnectionStatus,
  StreamType,
} = require("@discordjs/voice");

const YtDlpWrapImport = require("yt-dlp-wrap");
const YtDlpWrap = YtDlpWrapImport.default || YtDlpWrapImport;
const ytDlp = new YtDlpWrap("yt-dlp");

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function userVolToGain(vol) {
  const v = clamp(vol, 5, 100);
  return 0.2 + (v - 5) * (2.0 - 0.2) / (100 - 5);
}

function pickUA() {
  return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
}

const YT_CLIENT_TRIES = ["android", "ios", "web"];

const metaCache = new Map();
const CACHE_MS = 10 * 60 * 1000;

async function fetchTitleAndDirect(url) {
  const cached = metaCache.get(url);
  if (cached && Date.now() - cached.ts < CACHE_MS) return cached;

  let lastErr;
  for (const clientName of YT_CLIENT_TRIES) {
    try {
      const args = [
        "--no-warnings",
        "--no-playlist",
        "--geo-bypass",
        "--force-ipv4",
        "--add-header",
        `User-Agent:${pickUA()}`,
        "--extractor-args",
        `youtube:player_client=${clientName}`,
        "-f",
        "bestaudio/best",
        "--print",
        "%(title)s",
        "-g",
        url,
      ];

      const out = await ytDlp.execPromise(args);
      const lines = (out || "")
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);

      const title = lines[0] || "Bilinmeyen";
      const directUrl = lines[lines.length - 1];

      if (!directUrl || !directUrl.startsWith("http")) {
        throw new Error("yt-dlp direct url üretemedi.");
      }

      const result = { title, directUrl, ts: Date.now() };
      metaCache.set(url, result);
      return result;
    } catch (e) {
      lastErr = e;
    }
  }

  throw lastErr || new Error("YouTube engeli: açılamadı.");
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const states = new Map();

function getState(guildId) {
  if (!states.has(guildId)) {
    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });

    const state = {
      player,
      queue: [],
      now: null,
      volumeUser: 50,
      paused: false,
      offsetMs: 0,
      manualStop: false,
      ffmpeg: null,
    };

    player.on(AudioPlayerStatus.Idle, async () => {
      if (state.manualStop) {
        state.manualStop = false;
        return;
      }

      state.now = null;
      state.offsetMs = 0;
      state.paused = false;

      if (state.queue.length > 0) {
        const next = state.queue.shift();
        await playTrack(guildId, next, 0);
      }
    });

    player.on("error", (err) => {
      console.error(`[${guildId}] AudioPlayer error:`, err);
    });

    states.set(guildId, state);
  }
  return states.get(guildId);
}

function killFfmpeg(state) {
  try {
    if (state.ffmpeg && !state.ffmpeg.killed) state.ffmpeg.kill("SIGKILL");
  } catch {}
  state.ffmpeg = null;
}

async function ensureVoice(interaction) {
  const guild = interaction.guild;
  if (!guild) throw new Error("Sunucu bulunamadı.");

  const member = interaction.member;
  const vc = member?.voice?.channel;
  if (!vc) throw new Error("Önce bir ses kanalına girmen lazım.");

  const me = guild.members.me;
  const perms = vc.permissionsFor(me);
  if (!perms?.has("Connect") || !perms?.has("Speak")) {
    throw new Error("Botun bu kanalda Connect/Speak izni yok.");
  }

  let connection = getVoiceConnection(guild.id);
  if (!connection) {
    connection = joinVoiceChannel({
      channelId: vc.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
    });
  }

  await entersState(connection, VoiceConnectionStatus.Ready, 30_000);

  const state = getState(guild.id);
  connection.subscribe(state.player);

  return connection;
}

async function playTrack(guildId, track, offsetMs) {
  const state = getState(guildId);

  state.now = track;
  state.paused = false;

  killFfmpeg(state);

  const meta = await fetchTitleAndDirect(track.url);
  track.title = meta.title;

  const offsetSec = Math.max(0, Math.floor((offsetMs || 0) / 1000));

  const ffmpegArgs = [
    "-reconnect",
    "1",
    "-reconnect_streamed",
    "1",
    "-reconnect_delay_max",
    "5",
    "-probesize",
    "32k",
    "-analyzeduration",
    "0",
    "-fflags",
    "nobuffer",
    "-flags",
    "low_delay",
    "-flush_packets",
    "1",
  ];

  if (offsetSec > 0) ffmpegArgs.push("-ss", String(offsetSec));

  ffmpegArgs.push(
    "-i",
    meta.directUrl,
    "-loglevel",
    "0",
    "-f",
    "s16le",
    "-ar",
    "48000",
    "-ac",
    "2",
    "pipe:1"
  );

  const ff = spawn("ffmpeg", ffmpegArgs, { windowsHide: true });
  state.ffmpeg = ff;

  ff.on("error", (e) => console.error(`[${guildId}] ffmpeg spawn error:`, e));

  const resource = createAudioResource(ff.stdout, {
    inputType: StreamType.Raw,
    inlineVolume: true,
  });

  if (resource.volume) resource.volume.setVolume(userVolToGain(state.volumeUser));
  state.player.play(resource);

  const next = state.queue[0];
  if (next?.url && !metaCache.get(next.url)) {
    fetchTitleAndDirect(next.url).catch(() => {});
  }
}

client.once("ready", () => {
  console.log(`✅ Bot aktif: ${client.user.tag}`);
});

  const durumlar = [
    { name: '🎵 Müzik Keyfi', type: 2 },
    { name: '🎧 YouTube Music', type: 2 },
    { name: '/müzikaç ile şarkı aç!', type: 3 },
    { name: '📻 7/24 Müzik', type: 2 },
    { name: '/yardım yazmayı unutma', type: 3 },
    { name: '🔊 Yüksek Ses Keyfi', type: 2 },
    { name: '🎸 En Sevilen Şarkılar', type: 2 },
    { name: '/sırayamüzikekle ile sıra yap 🎶', type: 3 },
    { name: '🎹 Melodi Zamanı', type: 2 },
  ];
  
  let i = 0;
  setInterval(() => {
    client.user.setActivity(durumlar[i].name, { type: durumlar[i].type });
    i = (i + 1) % durumlar.length;
  }, 15000); // 15 saniyede bir değişir

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.guild) return;

  const guildId = interaction.guild.id;
  const state = getState(guildId);

  try {
    if (interaction.commandName === "müzikaç") {
      await interaction.deferReply();

      const url = interaction.options.getString("youtubeurl", true);
      const ses = interaction.options.getInteger("ses", true);
      state.volumeUser = clamp(ses, 5, 100);

      await ensureVoice(interaction);

      const track = { title: "Açılıyor...", url };
      const status = state.player.state.status;

      if (!state.now && status !== AudioPlayerStatus.Playing && status !== AudioPlayerStatus.Paused) {
        state.offsetMs = 0;
        await playTrack(guildId, track, 0);
        return await interaction.editReply(`▶️ Çalıyor: **${track.title}**\n🔊 Ses: **${state.volumeUser}**`);
      }

      state.queue.push(track);
      return await interaction.editReply(`➕ Sıraya eklendi.`);
    }

    if (interaction.commandName === "sırayamüzikekle") {
      await interaction.deferReply();

      const url = interaction.options.getString("youtubeurl", true);
      await ensureVoice(interaction);

      const track = { title: "Sıraya eklendi", url };
      state.queue.push(track);

      const status = state.player.state.status;
      if (!state.now && status !== AudioPlayerStatus.Playing && status !== AudioPlayerStatus.Paused) {
        const next = state.queue.shift();
        state.offsetMs = 0;
        await playTrack(guildId, next, 0);
      }

      return await interaction.editReply(`➕ Sıraya eklendi.`);
    }

    if (interaction.commandName === "müzikses") {
      const ses = interaction.options.getInteger("ses", true);
      state.volumeUser = clamp(ses, 5, 100);

      const res = state.player.state.resource;
      if (res?.volume) res.volume.setVolume(userVolToGain(state.volumeUser));

      return await interaction.reply(`🔊 Ses güncellendi: **${state.volumeUser}**`);
    }

    if (interaction.commandName === "müzikdurdur") {
      await interaction.deferReply();

      if (!state.now) return await interaction.editReply("Şu an çalan müzik yok.");

      const status = state.player.state.status;
      if (status === AudioPlayerStatus.Playing) {
        const dur = state.player.state.resource?.playbackDuration || 0;
        state.offsetMs += dur;

        state.paused = true;
        state.manualStop = true;

        state.player.stop(true);
        killFfmpeg(state);

        return await interaction.editReply("⏸️ Duraklatıldı.");
      }

      return await interaction.editReply("Şu an çalan müzik yok (veya zaten duraklı).");
    }

    if (interaction.commandName === "müziğibaşlat") {
      await interaction.deferReply();
      await ensureVoice(interaction);

      if (state.now && state.paused) {
        const track = state.now;
        await playTrack(guildId, track, state.offsetMs);
        return await interaction.editReply("▶️ Devam ediyor...");
      }

      if (!state.now && state.queue.length > 0) {
        const next = state.queue.shift();
        state.offsetMs = 0;
        await playTrack(guildId, next, 0);
        return await interaction.editReply("▶️ Sıradan başlatıyorum...");
      }

      return await interaction.editReply("Duraklatılmış/çalan müzik yok.");
    }

    if (interaction.commandName === "geç") {
      await interaction.deferReply();
      await ensureVoice(interaction);

      if (!state.now && state.queue.length === 0) {
        return await interaction.editReply("Çalan/sırada şarkı yok.");
      }

      state.paused = false;
      state.offsetMs = 0;
      state.manualStop = true;

      killFfmpeg(state);
      state.player.stop(true);
      state.now = null;

      if (state.queue.length > 0) {
        const next = state.queue.shift();
        await playTrack(guildId, next, 0);
        return await interaction.editReply(`⏭️ Geçildi. Sıradaki çalıyor: **${next.title || "Açılıyor..."}**`);
      }

      return await interaction.editReply("⏭️ Geçildi. Sırada başka şarkı yok.");
    }
  } catch (err) {
    console.error("Interaction error:", err);
    const msg = err?.message || "Bir hata oluştu.";
    if (interaction.deferred) return await interaction.editReply(`❌ ${msg}`);
    return await interaction.reply({ content: `❌ ${msg}`, ephemeral: true });
  }
});

client.login(process.env.DISCORD_TOKEN);
