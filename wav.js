// WAVファイルから生のPCMデータ部分だけを取り出す

/**
 * @param {Buffer} wav
 * @returns {Buffer} dataチャンクの中身（s16le PCM）
 */
export function extractPcm(wav) {
  if (wav.length < 12 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('WAV形式ではないデータが返ってきました');
  }
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === 'data') return wav.subarray(start, Math.min(start + size, wav.length));
    offset = start + size + (size % 2); // チャンクは偶数境界に揃う
  }
  throw new Error('WAVのdataチャンクが見つかりません');
}
