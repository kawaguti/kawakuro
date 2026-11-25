// VOICEVOXエンジン（ローカルで起動しているアプリ）に喋る音声を作ってもらう
import { extractPcm } from './wav.js';

/**
 * @returns {Promise<Buffer>} 48kHz・ステレオ・s16le の生PCM（Discordにそのまま流せる形式）
 */
export async function synthesize(text, { url, speaker, speed = 1.0 }) {
  const q = await fetch(`${url}/audio_query?speaker=${speaker}&text=${encodeURIComponent(text)}`, {
    method: 'POST',
    signal: AbortSignal.timeout(15_000),
  });
  if (!q.ok) throw new Error(`VOICEVOX audio_query が失敗しました (${q.status})`);
  const query = await q.json();
  query.outputSamplingRate = 48000;
  query.outputStereo = true;
  query.speedScale = speed;

  const s = await fetch(`${url}/synthesis?speaker=${speaker}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(query),
    signal: AbortSignal.timeout(30_000),
  });
  if (!s.ok) throw new Error(`VOICEVOX synthesis が失敗しました (${s.status})`);
  return extractPcm(Buffer.from(await s.arrayBuffer()));
}

/** 選べる声の一覧（[{ id, name }]） */
export async function listSpeakers(url) {
  const r = await fetch(`${url}/speakers`, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`VOICEVOX speakers が失敗しました (${r.status})`);
  const speakers = await r.json();
  return speakers.flatMap((sp) => sp.styles.map((st) => ({ id: st.id, name: `${sp.name}（${st.name}）` })));
}

/**
 * 「30」のような話者ID、または「No.7/アナウンス」のような「名前/スタイル」から話者IDを決める。
 * 見つからなければ null。
 */
export async function resolveSpeaker(url, spec) {
  const s = String(spec ?? '').trim();
  if (/^\d+$/.test(s)) return { id: Number(s), name: `話者ID ${s}` };
  const [name, style] = s.split('/').map((x) => x.trim());
  const r = await fetch(`${url}/speakers`, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`VOICEVOX speakers が失敗しました (${r.status})`);
  for (const sp of await r.json()) {
    if (sp.name !== name) continue;
    const st = sp.styles.find((x) => x.name === style) ?? (style ? null : sp.styles[0]);
    if (st) return { id: st.id, name: `${sp.name}（${st.name}）` };
  }
  return null;
}
