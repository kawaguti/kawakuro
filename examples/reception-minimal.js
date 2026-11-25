// 受付インターホンBot（最小版・1ファイル）
// テキストチャンネルでBotにメンションすると、ボイスチャンネルでチャイムを鳴らして読み上げる
import { Readable } from 'node:stream';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import {
  AudioPlayerStatus, StreamType, VoiceConnectionStatus,
  createAudioPlayer, createAudioResource, entersState, getVoiceConnection, joinVoiceChannel,
} from '@discordjs/voice';

// ── 設定（.env から読む）─────────────────────────────
const TOKEN = process.env.DISCORD_TOKEN;
const VOICE_ID = process.env.RECEPTION_VOICE_CHANNEL_ID;            // Botが居続けるボイスチャンネル
const TEXT_IDS = new Set((process.env.RECEPTION_TEXT_CHANNEL_IDS || '').split(',').map((s) => s.trim()).filter(Boolean));
const VOICEVOX = process.env.VOICEVOX_URL || 'http://127.0.0.1:50021';
const SPEAKER = Number(process.env.VOICEVOX_SPEAKER_ID || 3);        // 3 = ずんだもん（ノーマル）
const CREDIT = process.env.VOICEVOX_CREDIT || 'VOICEVOX:ずんだもん';     // 声のクレジット。声を変えたら、その声の規約どおりに書き換える
const REPEAT = 2;            // 同じ文を読む回数
const COOLDOWN_MS = 10_000;  // 同じ人が続けて呼べるまでの時間
const MAX_LENGTH = 200;      // 読み上げる最大文字数
if (!TOKEN || !VOICE_ID) { console.error('.env に DISCORD_TOKEN と RECEPTION_VOICE_CHANNEL_ID が必要です。'); process.exit(1); }

// ── 音を作る（すべて 48kHz・ステレオ・16bit の生PCM）──
const RATE = 48000;
const silence = (sec) => Buffer.alloc(Math.round(RATE * sec) * 4);

function chime() { // 「ピン・ポーン」
  const notes = [{ freq: 880, start: 0, length: 0.7 }, { freq: 698.46, start: 0.45, length: 0.85 }];
  const total = Math.round(RATE * 1.3);
  const buf = Buffer.alloc(total * 4);
  for (let i = 0; i < total; i++) {
    let v = 0;
    for (const n of notes) {
      const dt = i / RATE - n.start;
      if (dt >= 0 && dt <= n.length) v += Math.sin(2 * Math.PI * n.freq * dt) * Math.min(1, dt / 0.01) * Math.exp(-4 * dt);
    }
    const s = Math.round(Math.max(-1, Math.min(1, v * 0.35)) * 32767);
    buf.writeInt16LE(s, i * 4);
    buf.writeInt16LE(s, i * 4 + 2);
  }
  return buf;
}

async function synthesize(text) { // VOICEVOX に喋る音声を作ってもらう
  const q = await fetch(`${VOICEVOX}/audio_query?speaker=${SPEAKER}&text=${encodeURIComponent(text)}`, { method: 'POST' });
  if (!q.ok) throw new Error(`audio_query ${q.status}`);
  const query = await q.json();
  query.outputSamplingRate = RATE; // Discord に合わせる
  query.outputStereo = true;
  const s = await fetch(`${VOICEVOX}/synthesis?speaker=${SPEAKER}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(query),
  });
  if (!s.ok) throw new Error(`synthesis ${s.status}`);
  const wav = Buffer.from(await s.arrayBuffer());
  return wav.subarray(wav.indexOf('data') + 8); // WAVのヘッダーを外して中身だけにする
}

// ── 読み上げ（1件ずつ順番に）─────────────────────────
const player = createAudioPlayer();
let guildId = null;
let chain = Promise.resolve();

function announce(text, onDone) {
  chain = chain.then(async () => {
    if (!getVoiceConnection(guildId)) return;
    const voice = await synthesize(text);
    const parts = [chime(), silence(0.2)];
    for (let i = 0; i < REPEAT; i++) parts.push(voice, silence(0.6));
    player.play(createAudioResource(Readable.from([Buffer.concat(parts)]), { inputType: StreamType.Raw }));
    await entersState(player, AudioPlayerStatus.Playing, 5_000);
    await entersState(player, AudioPlayerStatus.Idle, 120_000);
    onDone?.();
  }).catch((e) => console.error('読み上げ失敗:', e.message));
}

// ── ボイスチャンネルに居続ける ───────────────────────
let stopping = false;
async function stay() {
  if (stopping || (guildId && getVoiceConnection(guildId))) return;
  try {
    const channel = await client.channels.fetch(VOICE_ID);
    guildId = channel.guild.id;
    const connection = joinVoiceChannel({
      channelId: channel.id, guildId, adapterCreator: channel.guild.voiceAdapterCreator, selfDeaf: true,
    });
    connection.subscribe(player);
    connection.on(VoiceConnectionStatus.Disconnected, () => connection.destroy()); // 切れたら片付け、次の見回りで入り直す
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    console.log(`「${channel.name}」に入りました。`);
  } catch (e) {
    getVoiceConnection(guildId)?.destroy();
    console.error('ボイスチャンネルに入れません:', e.message);
  }
}

// ── テキストチャンネルへの知らせ（開始・終了）──────────
async function notify(content) {
  for (const id of TEXT_IDS) {
    try {
      const channel = await client.channels.fetch(id);
      await channel.send({ content, allowedMentions: { parse: [] } }); // 書くだけで、通知は飛ばさない
    } catch (e) {
      console.error(`チャンネル（${id}）に書けません:`, e.message);
    }
  }
}

// ── Discord ─────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, async (c) => {
  console.log(`${c.user.tag} として起動しました。`);
  await stay();
  if (getVoiceConnection(guildId)) {
    const me = `<@${c.user.id}>`;
    await notify([
      '受付を始めます。',
      `このチャンネルで ${me} にメンションして用件を書くと、ボイスチャンネル <#${VOICE_ID}> で読み上げます。`,
      `例：${me} いま1階に着きました`,
      `声のクレジット：${CREDIT}`,
    ].join('\n'));
  }
  setInterval(stay, 30_000);
});

const lastCall = new Map(); // 投稿者ID → 最後に呼んだ時刻
client.on(Events.MessageCreate, (message) => {
  if (!TEXT_IDS.has(message.channelId) && message.channelId !== VOICE_ID) return; // 決めたチャンネルだけ
  if (message.author.bot || !message.mentions.users.has(client.user.id)) return;   // Bot宛てメンションだけ
  const now = Date.now();
  if (now - (lastCall.get(message.author.id) ?? 0) < COOLDOWN_MS) { // 連投よけ
    void message.react('⏳').catch(() => {});
    return;
  }
  lastCall.set(message.author.id, now);

  // 本文から「@Bot名」とURLを外して、読み上げる文にする
  let body = message.cleanContent;
  for (const name of [message.guild.members.me?.displayName, client.user.displayName, client.user.username]) {
    if (name) body = body.split(`@${name}`).join(' ');
  }
  body = body.replace(/https?:\/\/\S+/g, ' URL ').replace(/\s+/g, ' ').trim().slice(0, MAX_LENGTH);
  const who = message.member?.displayName ?? message.author.displayName;
  const text = body ? `${who}さんから。${body}` : `${who}さんから呼び出しです`;

  console.log(`呼び出し：${text}`);
  announce(text, () => void message.react('✅').catch(() => {}));
});

// 止めるとき（Ctrl+C）：退出して「失礼します。」と書き、合図がDiscordに届くのを少し待ってから終わる
process.on('SIGINT', async () => {
  if (stopping) return;
  stopping = true;
  const connection = getVoiceConnection(guildId);
  connection?.destroy();
  if (connection) await notify('失礼します。');
  await new Promise((r) => setTimeout(r, 1500));
  await client.destroy();
  process.exit(0);
});
client.login(TOKEN);
