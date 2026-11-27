// 分身Bot：打ち込んだ文を、Discordのボイスチャンネルで代わりに喋る
// 受付モードを足すと、決めたボイスチャンネルに居続けて、Bot宛てのメンションも読み上げる
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import {
  Client, Events, GatewayIntentBits, MessageFlags, REST, Routes, SlashCommandBuilder,
} from 'discord.js';
import {
  AudioPlayerStatus, StreamType, VoiceConnectionStatus,
  createAudioPlayer, createAudioResource, entersState, getVoiceConnection, joinVoiceChannel,
} from '@discordjs/voice';
import { cleanText, parseTimed, receptionText } from './text.js';
import { resolveSpeaker, synthesize } from './voicevox.js';
import { chime, silence } from './chime.js';

// ── 設定 ───────────────────────────────────────────
const env = process.env;
const required = (name) => {
  if (!env[name]) {
    console.error(`.env に ${name} がありません。.env.example を見て設定してください。`);
    process.exit(1);
  }
  return env[name];
};
const TOKEN = required('DISCORD_TOKEN');
// カンマ区切りで複数サーバーを指定できる
const GUILD_IDS = required('GUILD_ID').split(',').map((s) => s.trim()).filter(Boolean);
const GUILDS = new Set(GUILD_IDS);
const OWNER_ID = required('OWNER_USER_ID');
const TEXT_CHANNEL_ID = env.TEXT_CHANNEL_ID || '';
const ALLOWED = new Set((env.ALLOWED_AUTHOR_IDS || '').split(',').map((s) => s.trim()).filter(Boolean));
const READ_OWN = env.READ_OWN_MESSAGES === 'true';
// MODE=reception で受付モード：決めたボイスチャンネルに居続ける。入力は2系統で、
// ①受付のチャンネルでのBot宛てメンション（誰でも） ②TEXT_CHANNEL_ID への投稿（あなたと許可した投稿者）
const RECEPTION = env.MODE === 'reception';
const RECEPTION_VOICE_ID = RECEPTION ? required('RECEPTION_VOICE_CHANNEL_ID') : '';
const RECEPTION_TEXT_IDS = new Set((env.RECEPTION_TEXT_CHANNEL_IDS || '').split(',').map((s) => s.trim()).filter(Boolean));
const RECEPTION_REPEAT = Math.max(1, Number(env.RECEPTION_REPEAT || 2));
const RECEPTION_COOLDOWN_MS = Number(env.RECEPTION_COOLDOWN_SEC || 10) * 1000;
const RECEPTION_QUEUE_MAX = 5;
// 受付モードでは喋る先を受付のボイスチャンネル1つに決めるので、ついていかない
const AUTO_FOLLOW = !RECEPTION && env.AUTO_FOLLOW !== 'false';
const MAX_LENGTH = Number(env.MAX_LENGTH || 200);
const SPEAKER_SPEC = env.VOICEVOX_SPEAKER || 'No.7/アナウンス';
// 受付の呼び出しだけ別の声にできる（空なら VOICEVOX_SPEAKER と同じ声）
const RECEPTION_SPEAKER_SPEC = env.RECEPTION_VOICEVOX_SPEAKER || '';
let receptionSpeaker = null; // 起動時に決める
// 受付の開始と終了を、受付のテキストチャンネルに書く（false で書かない）
const RECEPTION_NOTICE = env.RECEPTION_NOTICE !== 'false';
// クレジット表記。空なら声の名前から「VOICEVOX:名前」を作る。書き方が特別な声（もち子さんなど）はここに書く
const RECEPTION_CREDIT = env.RECEPTION_CREDIT || '';
const voicevox = {
  url: (env.VOICEVOX_URL || 'http://127.0.0.1:50021').replace(/\/$/, ''),
  speaker: 3, // 起動時に VOICEVOX_SPEAKER から決め直す（決まらなければ ずんだもん）
  speed: Number(env.VOICEVOX_SPEED || 1.0),
};

let dict = {};
try {
  dict = JSON.parse(readFileSync(new URL('./dict.json', import.meta.url), 'utf8'));
} catch {
  console.warn('dict.json を読めなかったので、読み替え辞書なしで動かします。');
}

// ── 読み上げキュー（サーバーごとに1つ）───────────────
// Botは、サーバーごとに1つのボイスチャンネルに入れる。再生機と待ち行列もサーバーごとに持つ
const voices = new Map(); // サーバーID → { player, queue, speaking }
function voiceOf(guildId) {
  let v = voices.get(guildId);
  if (!v) {
    v = { player: createAudioPlayer(), queue: [], speaking: false };
    v.player.on('error', (e) => console.error('再生エラー:', e.message));
    voices.set(guildId, v);
  }
  return v;
}

// 分身としてついていった先のサーバー（同時に1つ）と、受付のサーバー
let followGuildId = null;
let receptionGuildId = null;
const followConnection = () => (followGuildId ? getVoiceConnection(followGuildId) : undefined);

// opts.announce：チャイムを鳴らしてから RECEPTION_REPEAT 回読む（受付の呼び出し）
// opts.onDone：読み終えたら呼ぶ
function say(guildId, text, opts = {}) {
  const v = voiceOf(guildId);
  v.queue.push({ text, ...opts });
  if (!v.speaking) void drain(guildId);
}

async function drain(guildId) {
  const v = voiceOf(guildId);
  v.speaking = true;
  while (v.queue.length > 0) {
    const { text, announce, onDone, speaker } = v.queue.shift();
    if (!getVoiceConnection(guildId)) { v.queue.length = 0; break; }
    try {
      let pcm = await synthesize(text, speaker == null ? voicevox : { ...voicevox, speaker });
      if (announce) {
        const parts = [chime(), silence(0.2)];
        for (let i = 0; i < RECEPTION_REPEAT; i++) parts.push(pcm, silence(0.6));
        pcm = Buffer.concat(parts);
      }
      const resource = createAudioResource(Readable.from([pcm]), { inputType: StreamType.Raw });
      v.player.play(resource);
      await entersState(v.player, AudioPlayerStatus.Playing, 5_000);
      await entersState(v.player, AudioPlayerStatus.Idle, 120_000);
      onDone?.();
    } catch (e) {
      console.error(`読み上げ失敗「${text.slice(0, 20)}」:`, e.message);
      v.player.stop(true);
    }
  }
  v.speaking = false;
}

function stopSpeaking(guildId) {
  const v = voiceOf(guildId);
  v.queue.length = 0;
  v.player.stop(true);
}

// ── ボイスチャンネルの出入り ───────────────────────
async function connect(channel) {
  const guildId = channel.guild.id;
  if (getVoiceConnection(guildId)?.joinConfig.channelId === channel.id) return;
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: true,
  });
  connection.subscribe(voiceOf(guildId).player);
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      // チャンネル移動なら数秒で復帰する。そうでなければ切断として片付ける
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
      if (followGuildId === guildId && !getVoiceConnection(guildId)) followGuildId = null;
    }
  });
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    console.log(`「${channel.guild.name}」の「${channel.name}」に参加しました。`);
  } catch (e) {
    connection.destroy();
    throw new Error(`「${channel.name}」に接続できませんでした。Botの「接続」「発言」権限を確認してください。`);
  }
}

function disconnect(guildId) {
  stopSpeaking(guildId);
  const connection = getVoiceConnection(guildId);
  if (connection) {
    connection.destroy();
    console.log('ボイスチャンネルから退出しました。');
  }
}

// 分身：あなたのいるボイスチャンネルに入る（受付のサーバーでは受付の場所から動かない）
async function follow(channel) {
  if (channel.guild.id === receptionGuildId) return;
  // 別のサーバーについていっていたら、先にそこを出る
  if (followGuildId && followGuildId !== channel.guild.id) unfollow();
  followGuildId = channel.guild.id;
  try {
    await connect(channel);
  } catch (e) {
    if (followGuildId === channel.guild.id && !getVoiceConnection(channel.guild.id)) followGuildId = null;
    throw e;
  }
}

function unfollow() {
  if (!followGuildId) return;
  const guildId = followGuildId;
  followGuildId = null;
  disconnect(guildId);
}

// ── 受付：決めたボイスチャンネルに居続ける ─────────
let receptionPaused = false; // /leave で止めたら、/join するまで戻らない
async function stayInReception() {
  if (receptionPaused || (receptionGuildId && getVoiceConnection(receptionGuildId))) return;
  try {
    const channel = await client.channels.fetch(RECEPTION_VOICE_ID);
    if (!channel?.isVoiceBased()) throw new Error(`RECEPTION_VOICE_CHANNEL_ID（${RECEPTION_VOICE_ID}）がボイスチャンネルではありません。`);
    receptionGuildId = channel.guild.id;
    if (followGuildId === receptionGuildId) followGuildId = null;
    await connect(channel);
  } catch (e) {
    console.error('受付のボイスチャンネルに入れません:', e.message);
  }
}
// 予約アナウンス：announce.txt に「18:30 あと5分なのだ」のように1行ずつ書くと、その時刻に受付のボイスチャンネルで読む。
// 時刻の無い行はすぐ読む。読んだ行はファイルから消える。時刻はこのPCの時計で、当日ぶんだけ
const ANNOUNCE_FILE = new URL('./announce.txt', import.meta.url);
function checkAnnouncements() {
  if (!receptionGuildId || !getVoiceConnection(receptionGuildId) || !existsSync(ANNOUNCE_FILE)) return;
  try {
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const keep = [];
    const spoken = new Set(); // 同じ時刻に同じ文が重なっていたら、1回だけ読む
    for (const line of readFileSync(ANNOUNCE_FILE, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(\d{1,2}):(\d{2})\s+(.+)$/);
      const body = (m ? m[3] : line).trim();
      if (!body || body.startsWith('#')) { if (line.trim()) keep.push(line); continue; }
      if (m && Number(m[1]) * 60 + Number(m[2]) > nowMin) { keep.push(line); continue; }
      const text = cleanText(body, dict, MAX_LENGTH);
      if (!text || spoken.has(text)) continue;
      spoken.add(text);
      console.log(`予約アナウンス：${text}`);
      say(receptionGuildId, text, { announce: true, speaker: receptionSpeaker });
    }
    writeFileSync(ANNOUNCE_FILE, keep.length ? keep.join('\n') + '\n' : '');
  } catch (e) {
    console.error('announce.txt を読めません:', e.message);
  }
}
// 受付のテキストチャンネルに知らせを書く（書き込み権限が無ければログに出すだけ）
async function notifyReception(content) {
  if (!RECEPTION_NOTICE) return;
  for (const id of RECEPTION_TEXT_IDS) {
    try {
      const channel = await client.channels.fetch(id);
      await channel.send({ content, allowedMentions: { parse: [] } });
    } catch (e) {
      console.error(`受付のチャンネル（${id}）に書けません:`, e.message);
    }
  }
}
function creditLine() {
  if (RECEPTION_CREDIT) return RECEPTION_CREDIT;
  const names = [RECEPTION_SPEAKER_SPEC, SPEAKER_SPEC].filter(Boolean).map((x) => x.split('/')[0].trim());
  return [...new Set(names)].map((n) => `VOICEVOX:${n}`).join('、');
}
function openingNotice() {
  const me = `<@${client.user.id}>`;
  return [
    '受付を始めます。',
    `このチャンネルで ${me} にメンションして用件を書くと、ボイスチャンネル <#${RECEPTION_VOICE_ID}> で読み上げます。`,
    `例：${me} いま1階に着きました`,
    `声のクレジット：${creditLine()}`,
  ].join('\n');
}
const lastCall = new Map(); // 投稿者ID → 最後に呼んだ時刻（連投よけ）

// ── Discordクライアント ────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const commands = [
  new SlashCommandBuilder().setName('join').setDescription('あなたのいるボイスチャンネルに分身を呼ぶ'),
  new SlashCommandBuilder().setName('leave').setDescription('分身をボイスチャンネルから退出させる'),
  new SlashCommandBuilder().setName('skip').setDescription('読み上げ中の文と、待っている文を止める'),
  new SlashCommandBuilder().setName('say').setDescription('打った文を分身に喋らせる（チャットには残らない）')
    .addStringOption((o) => o.setName('text').setDescription('喋らせる文').setRequired(true)),
].map((c) => c.toJSON());

client.once(Events.ClientReady, async (c) => {
  console.log(`${c.user.tag} として起動しました。`);
  const rest = new REST().setToken(TOKEN);
  for (const guildId of GUILD_IDS) {
    try {
      await rest.put(Routes.applicationGuildCommands(c.user.id, guildId), { body: commands });
    } catch (e) {
      console.error(`スラッシュコマンドの登録に失敗（サーバー ${guildId}）:`, e.message);
    }
  }
  try {
    const found = await resolveSpeaker(voicevox.url, SPEAKER_SPEC);
    if (found) {
      voicevox.speaker = found.id;
      console.log(`VOICEVOXに接続できました。声は ${found.name} です。`);
    } else {
      console.warn(`VOICEVOXに「${SPEAKER_SPEC}」という声が見つからないので、話者ID 3 で喋ります。npm run voices で一覧を確認できます。`);
    }
    if (RECEPTION && RECEPTION_SPEAKER_SPEC) {
      const r = await resolveSpeaker(voicevox.url, RECEPTION_SPEAKER_SPEC);
      if (r) { receptionSpeaker = r.id; console.log(`受付の呼び出しの声は ${r.name} です。`); }
      else console.warn(`VOICEVOXに「${RECEPTION_SPEAKER_SPEC}」という声が見つからないので、受付も同じ声で喋ります。`);
    }
  } catch {
    console.warn(`VOICEVOXに接続できません（${voicevox.url}）。VOICEVOXアプリを起動してください。`);
  }
  if (RECEPTION) {
    console.log('受付モードで動きます。Bot宛てのメンションを読み上げます。');
    await stayInReception();
    if (getVoiceConnection(receptionGuildId)) await notifyReception(openingNotice());
    setInterval(() => void stayInReception(), 30_000); // 切れたら入り直す
    setInterval(checkAnnouncements, 5_000);
  }
  // 起動時点であなたがすでにボイスチャンネルにいたら、そこに入る
  if (AUTO_FOLLOW) {
    for (const guildId of GUILD_IDS) {
      if (guildId === receptionGuildId) continue;
      const guild = await client.guilds.fetch(guildId).catch(() => null);
      if (!guild) { console.warn(`サーバー ${guildId} にBotが入っていません。`); continue; }
      const channel = guild.voiceStates.cache.get(OWNER_ID)?.channel;
      if (channel) { await follow(channel).catch((e) => console.error(e.message)); break; }
    }
  }
});

// あなたの出入りについていく（受付のサーバー以外）
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  if (!AUTO_FOLLOW || newState.id !== OWNER_ID || !GUILDS.has(newState.guild.id)) return;
  if (newState.guild.id === receptionGuildId) return;
  if (oldState.channelId === newState.channelId) return;
  if (newState.channel) await follow(newState.channel).catch((e) => console.error(e.message));
  else if (followGuildId === newState.guild.id) unfollow(); // 別サーバーへ移った後の「退出」では出ない
});

// 受付：決めたチャンネルで、Bot宛てにメンションした人の文を誰のものでも読む
function handleReception(message) {
  const connection = getVoiceConnection(receptionGuildId);
  if (!connection) return;
  if (!RECEPTION_TEXT_IDS.has(message.channelId) && message.channelId !== connection.joinConfig.channelId) return;
  // Bot本人へのメンションのほか、Botと同じ名前の「Botのロール」へのメンションも呼び出しとして扱う（入力候補で選び間違えやすい）
  const botRole = message.guild?.members.me?.roles.botRole;
  // 本文に書かれたメンションだけを見る。返信（リプライ）で自動的に付くメンションは呼び出しにしない
  const called = new RegExp(`<@!?${client.user.id}>`).test(message.content) || (botRole && message.content.includes(`<@&${botRole.id}>`));
  if (message.author.bot || !called) return;
  // 「@Bot 18:30 あと5分です」のように先頭に時刻があれば、その時刻の予約にする（今日のこれからの時刻だけ。過ぎていたらふつうに読む）
  const timed = parseTimed(message.content.replace(/<[@#][!&]?\d+>/g, ' '));
  if (timed) {
    const d = new Date();
    if (timed.hour * 60 + timed.minute > d.getHours() * 60 + d.getMinutes()) {
      const hhmm = `${timed.hour}:${String(timed.minute).padStart(2, '0')}`;
      appendFileSync(ANNOUNCE_FILE, `${hhmm} ${timed.body.replace(/\s+/g, ' ')}\n`);
      console.log(`予約を受け付け：${hhmm} ${timed.body}`);
      void message.react('🕒').catch(() => {});
      return;
    }
  }
  const now = Date.now();
  if (now - (lastCall.get(message.author.id) ?? 0) < RECEPTION_COOLDOWN_MS
    || voiceOf(receptionGuildId).queue.length >= RECEPTION_QUEUE_MAX) {
    void message.react('⏳').catch(() => {});
    return;
  }
  lastCall.set(message.author.id, now);
  const name = message.member?.displayName ?? message.author.displayName;
  const botNames = [message.guild?.members.me?.displayName, client.user.displayName, client.user.username, botRole?.name].filter(Boolean);
  const text = receptionText(name, message.cleanContent, botNames, dict, MAX_LENGTH);
  console.log(`呼び出し：${text}`);
  say(receptionGuildId, text, { announce: true, speaker: receptionSpeaker, onDone: () => void message.react('✅').catch(() => {}) });
}

// 分身の声を出すサーバーを決める。受付モードなら受付のボイスチャンネル、そうでなければついていった先
function bunshinGuildId() {
  if (receptionGuildId) return getVoiceConnection(receptionGuildId) ? receptionGuildId : null;
  return followConnection() ? followGuildId : null;
}

// 読み上げ対象の投稿を拾う
client.on(Events.MessageCreate, (message) => {
  if (!GUILDS.has(message.guildId)) return;
  if (receptionGuildId && message.guildId === receptionGuildId) return handleReception(message);

  // 分身：あなたと、許可した投稿者の文を読む
  const inTarget = message.channelId === TEXT_CHANNEL_ID
    || message.channelId === followConnection()?.joinConfig.channelId; // ボイスチャンネル内のチャット
  if (!inTarget) return;

  const isSelf = message.author.id === client.user.id;
  const allowed = message.author.id === OWNER_ID
    || ALLOWED.has(message.author.id)
    || (message.webhookId && ALLOWED.has(message.webhookId))
    || (isSelf && READ_OWN);
  if (!allowed) return;

  const guildId = bunshinGuildId();
  if (!guildId) return;
  const text = cleanText(message.cleanContent, dict, MAX_LENGTH);
  if (text) say(guildId, text);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const reply = (content) => interaction.reply({ content, flags: MessageFlags.Ephemeral });
  if (interaction.user.id !== OWNER_ID) return reply('このBotは持ち主専用です。');
  const guildId = interaction.guildId;
  const inReception = guildId === receptionGuildId;

  try {
    switch (interaction.commandName) {
      case 'join': {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (inReception) {
          receptionPaused = false;
          await stayInReception();
          return interaction.editReply('受付のボイスチャンネルに戻りました。');
        }
        const channel = interaction.member?.voice?.channel;
        if (!channel) return interaction.editReply('先にボイスチャンネルに入ってから呼んでください。');
        await follow(channel);
        return interaction.editReply(`「${channel.name}」に入りました。`);
      }
      case 'leave':
        if (inReception) { receptionPaused = true; disconnect(guildId); }
        else if (followGuildId === guildId) unfollow();
        return reply('退出しました。');
      case 'skip':
        stopSpeaking(guildId);
        return reply('止めました。');
      case 'say': {
        if (!getVoiceConnection(guildId)) return reply('分身がこのサーバーのボイスチャンネルにいません。/join で呼んでください。');
        const text = cleanText(interaction.options.getString('text', true), dict, MAX_LENGTH);
        if (text) say(guildId, text);
        return reply(`🗣 ${text}`);
      }
    }
  } catch (e) {
    console.error(e.message);
    const content = `うまくいきませんでした：${e.message}`;
    return interaction.deferred ? interaction.editReply(content) : reply(content);
  }
});

// 止めるとき：退出の合図がDiscordに届くのを待ってから終わる（すぐ終わると、Botがボイスチャンネルに残って見える）
let stopping = false;
process.on('SIGINT', async () => {
  if (stopping) return;
  stopping = true;
  receptionPaused = true;
  const wasInReception = RECEPTION && receptionGuildId && getVoiceConnection(receptionGuildId);
  for (const guildId of [followGuildId, receptionGuildId]) if (guildId) disconnect(guildId);
  if (wasInReception) await Promise.race([notifyReception('失礼します。'), new Promise((r) => setTimeout(r, 5000))]);
  await new Promise((r) => setTimeout(r, 1500));
  await client.destroy();
  process.exit(0);
});
process.on('unhandledRejection', (e) => console.error('想定外のエラー:', e));

client.login(TOKEN).catch((e) => {
  console.error('Discordにログインできません。DISCORD_TOKEN と、Botページの「Message Content Intent」を確認してください。\n', e.message);
  process.exit(1);
});
