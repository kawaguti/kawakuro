// 受付モードで読み上げの前に鳴らすチャイムと、間をあける無音を作る
// 形式は VOICEVOX の出力と同じ 48kHz・ステレオ・s16le

const RATE = 48000;

/** @returns {Buffer} 指定した秒数の無音 */
export function silence(seconds) {
  return Buffer.alloc(Math.round(RATE * seconds) * 4);
}

/** @returns {Buffer} 「ピン・ポーン」の2音チャイム（約1.3秒） */
export function chime(volume = 0.35) {
  const notes = [
    { freq: 880, start: 0.0, length: 0.7 },   // ラ
    { freq: 698.46, start: 0.45, length: 0.85 }, // ファ
  ];
  const total = Math.round(RATE * 1.3);
  const buf = Buffer.alloc(total * 4);
  for (let i = 0; i < total; i++) {
    const t = i / RATE;
    let v = 0;
    for (const n of notes) {
      const dt = t - n.start;
      if (dt < 0 || dt > n.length) continue;
      const attack = Math.min(1, dt / 0.01);
      const decay = Math.exp(-4 * dt);
      v += Math.sin(2 * Math.PI * n.freq * dt) * attack * decay;
    }
    const s = Math.max(-1, Math.min(1, v * volume));
    const int = Math.round(s * 32767);
    buf.writeInt16LE(int, i * 4);
    buf.writeInt16LE(int, i * 4 + 2);
  }
  return buf;
}
