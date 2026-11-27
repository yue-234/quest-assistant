// 刷新 jsDelivr 上 @main 分支的缓存，使刚推送到 GitHub 的构建产物尽快生效。
// 用法：node tools/purge-cdn.mjs [gitRef]

const REPO = 'yue-234/quest-assistant';
const ref = process.argv[2] || 'main';
const targets = [
  `/gh/${REPO}@${ref}/dist/quest-assistant.js`,
  `/gh/${REPO}@${ref}/⭐粘这个-任务助手脚本.js`,
];

async function purge(path) {
  const url = `https://purge.jsdelivr.net${path}`;
  const res = await fetch(url, { method: 'GET' });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    throw new Error(`${url} 返回 HTTP ${res.status}: ${text}`);
  }
  console.log(`已刷新 ${path} ->`, parsed);
}

Promise.all(targets.map(purge)).catch((err) => {
  console.error('jsDelivr 缓存刷新失败：', err);
  process.exit(1);
});
