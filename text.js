// 読み上げ前のテキスト整形

const MAX_LENGTH_DEFAULT = 200;

/**
 * @param {string} raw      メッセージ本文（メンションは名前に解決済みのもの）
 * @param {Record<string,string>} dict  読み替え辞書（表記 → 読み）
 * @param {number} maxLength
 * @returns {string} 読み上げる文。読むものがなければ空文字
 */
export function cleanText(raw, dict = {}, maxLength = MAX_LENGTH_DEFAULT) {
  let t = String(raw ?? '');

  // Museに打つときの合図「ーー」「--」「——」が残っていたら外す
  t = t.replace(/^\s*(?:ーー+|--+|——+|――+)\s*/, '');

  t = t.replace(/```[\s\S]*?```/g, ' コード省略 ');   // コードブロック
  t = t.replace(/`([^`]*)`/g, '$1');                  // インラインコード
  t = t.replace(/\|\|[\s\S]*?\|\|/g, ' 伏せ字 ');     // スポイラー
  t = t.replace(/https?:\/\/\S+/g, ' URL ');          // URL
  t = t.replace(/<a?:(\w+):\d+>/g, ' $1 ');           // カスタム絵文字
  t = t.replace(/[*_~>#]/g, '');                      // マークダウン記号
  t = t.replace(/[wｗ]{3,}/g, 'わら');                // 草
  t = t.replace(/\s+/g, ' ').trim();

  // 辞書は長い表記から先に当てる（「RSGT2027」を「RSGT」より先に）
  const keys = Object.keys(dict).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (!key) continue;
    t = t.split(key).join(dict[key]);
  }

  if (t.length > maxLength) t = t.slice(0, maxLength) + '、以下省略';
  return t;
}

/**
 * 受付モードで読み上げる文を作る。
 * @param {string} name      呼んだ人の表示名
 * @param {string} raw       メッセージ本文（メンションは「@名前」に解決済みのもの）
 * @param {string[]} botNames 本文から取り除くBot自身の名前
 * @returns {string} 「〇〇さんから。△△」。本文が空なら「〇〇さんから呼び出しです」
 */
export function receptionText(name, raw, botNames = [], dict = {}, maxLength = MAX_LENGTH_DEFAULT) {
  let body = String(raw ?? '');
  for (const n of [...botNames].sort((a, b) => b.length - a.length)) {
    if (n) body = body.split(`@${n}`).join(' ');
  }
  body = cleanText(body, dict, maxLength);
  const who = cleanText(name, dict, 30) || 'だれか';
  return body ? `${who}さんから。${body}` : `${who}さんから呼び出しです`;
}

// 「18:30 あと5分です」「18時30分 あと5分です」のように、先頭に時刻がある文を {hour, minute, body} に分ける。
// 時刻が無い、または本文が空なら null。全角の数字やコロンも受け付ける
export function parseTimed(raw) {
  const s = String(raw ?? '').normalize('NFKC').trim();
  const m = s.match(/^(\d{1,2})(?::(\d{2})|時(?:(\d{1,2})分|半)?)に?[\s、,]+([\s\S]+)$/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = m[2] != null ? Number(m[2]) : m[3] != null ? Number(m[3]) : /^\d{1,2}時半/.test(s) ? 30 : 0;
  const body = m[4].trim();
  if (hour > 23 || minute > 59 || !body) return null;
  return { hour, minute, body };
}
