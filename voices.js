// `npm run voices` で、選べる声と話者IDの一覧を表示する
import { listSpeakers } from './voicevox.js';

const url = process.env.VOICEVOX_URL || 'http://127.0.0.1:50021';
try {
  const list = await listSpeakers(url);
  for (const v of list.sort((a, b) => a.id - b.id)) console.log(String(v.id).padStart(4), v.name);
  console.log('\n.env の VOICEVOX_SPEAKER に、使いたい声の番号を書いてください。');
} catch (e) {
  console.error(`VOICEVOXに接続できません（${url}）。VOICEVOXアプリを起動してから、もう一度試してください。`);
  process.exit(1);
}
