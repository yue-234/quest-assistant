// 构建独立任务助手单文件粘贴脚本「⭐粘这个-任务助手脚本.js」
// 项目地址：https://github.com/yue-234/quest-assistant
// 优先从当前环境解析 esbuild，亦可通过环境变量 ESBUILD_PATH 指定路径

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { SCRIPT_VERSION } from './src/data.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function loadEsbuild() {
  if (process.env.ESBUILD_PATH && fs.existsSync(process.env.ESBUILD_PATH)) {
    return require(process.env.ESBUILD_PATH);
  }
  try {
    return require('esbuild');
  } catch {
    /* 继续尝试本地回退路径 */
  }
  const fallbackRoots = [
    path.resolve(__dirname, 'node_modules/.pnpm'),
    'f:/git/Destined-Poem-Card/node_modules/.pnpm',
  ];
  for (const pnpmRoot of fallbackRoots) {
    if (!fs.existsSync(pnpmRoot)) continue;
    const dirs = fs.readdirSync(pnpmRoot).filter((d) => d.startsWith('esbuild@'));
    for (const d of dirs) {
      const candidate = path.join(pnpmRoot, d, 'node_modules', 'esbuild', 'lib', 'main.js');
      if (fs.existsSync(candidate)) return require(candidate);
    }
  }
  throw new Error('未找到 esbuild，请先安装 esbuild 或设置环境变量 ESBUILD_PATH');
}

function escapeInlineScript(code) {
  return code.replace(/<\/script/gi, '<\\/script');
}

function createWorldbookEntry({ uid, comment, order, content }) {
  return {
    uid,
    displayIndex: uid,
    comment,
    disable: false,
    constant: true,
    selective: false,
    key: [],
    selectiveLogic: 0,
    keysecondary: [],
    scanDepth: null,
    vectorized: false,
    position: 4,
    role: 0,
    depth: 1,
    order,
    content,
    useProbability: true,
    probability: 100,
    excludeRecursion: false,
    preventRecursion: true,
    delayUntilRecursion: false,
    sticky: null,
    cooldown: null,
    delay: null,
    addMemo: true,
    matchPersonaDescription: false,
    matchCharacterDescription: false,
    matchCharacterPersonality: false,
    matchCharacterDepthPrompt: false,
    matchScenario: false,
    matchCreatorNotes: false,
    group: '',
    groupOverride: false,
    groupWeight: 100,
    caseSensitive: null,
    matchWholeWords: null,
    useGroupScoring: null,
    automationId: '',
    ignoreBudget: false,
    outletName: '',
    triggers: [],
    characterFilter: { isExclude: false, names: [], tags: [] },
  };
}

/** 生成按当前版本号命名的标准世界书导出文件名。 */
export function worldbookFilename(version = SCRIPT_VERSION) {
  const ver = String(version ?? '').trim();
  return `命定任务助手世界书${ver}.json`;
}

/** 从单一 EJS 源码导出双条目标准酒馆世界书 JSON（剧情引导 + 变量更新，统一使用 [mvu_plot] 供主模型注入）。 */
export function buildWorldbookJson(ejsContent, version = SCRIPT_VERSION) {
  const normalized = String(ejsContent ?? '').replace(/\r\n/g, '\n');
  const roleConstRe = /const\s+_wbRole\s*=\s*['"]all['"]\s*;/;
  const roleMetaRe = /\/\/\s*@role\s+all\b/;
  if (!roleConstRe.test(normalized) || !roleMetaRe.test(normalized)) {
    throw new Error("世界书源码缺少角色声明（`// @role all` 与 `const _wbRole = 'all';`），无法导出双条目世界书");
  }
  const ver = String(version ?? '').trim();
  const verMetaMatch = normalized.match(/\/\/\s*@version\s+([^\s\r\n]+)/i);
  if (verMetaMatch && /^v?\d+\.\d+\.\d+/i.test(ver)) {
    const srcVer = verMetaMatch[1].replace(/^v/i, '');
    const targetVer = ver.replace(/^v/i, '');
    if (srcVer !== targetVer) {
      throw new Error(`世界书源码 @version（v${srcVer}）与目标版本（v${targetVer}）不一致`);
    }
  }
  const renderRole = (role) => {
    const out = normalized
      .replace(roleMetaRe, `// @role ${role}`)
      .replace(roleConstRe, `const _wbRole = '${role}';`);
    if (out === normalized || !out.includes(`// @role ${role}`) || !out.includes(`const _wbRole = '${role}';`)) {
      throw new Error(`世界书角色派生失败（目标角色：${role}）`);
    }
    return out;
  };

  return {
    entries: {
      '0': createWorldbookEntry({
        uid: 0,
        comment: `[mvu_plot]任务助手-剧情引导${ver}`,
        order: 1150,
        content: renderRole('plot'),
      }),
      '1': createWorldbookEntry({
        uid: 1,
        comment: `[mvu_plot]任务助手-变量更新${ver}`,
        order: 99999,
        content: renderRole('update'),
      }),
    },
  };
}

export async function build() {
  const esbuild = loadEsbuild();
  const srcDir = path.join(__dirname, 'src');
  const outFile = path.join(__dirname, '⭐粘这个-任务助手脚本.js');
  const outTxtFile = path.join(__dirname, '⭐粘这个-任务助手脚本.txt');
  const outDistFile = path.join(__dirname, 'dist', 'quest-assistant.js');

  // 1. 打包并压缩 iframe 面板 CSS 与 JS
  const rawCss = fs.readFileSync(path.join(srcDir, 'panel.css'), 'utf8');
  const cssResult = await esbuild.transform(rawCss, { loader: 'css', minify: true });
  const panelCss = cssResult.code.trim();

  const panelBundle = await esbuild.build({
    entryPoints: [path.join(srcDir, 'panel.js')],
    bundle: true,
    write: false,
    format: 'iife',
    target: ['es2020'],
    minify: true,
  });
  const panelJs = escapeInlineScript(panelBundle.outputFiles[0].text.trim());

  // 2. 注入虚拟模块并打包为单文件零依赖 IIFE
  const virtualPlugin = {
    name: 'quest-helper-panel-virtual',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^quest-helper:panel$/ }, () => ({
        path: 'quest-helper:panel',
        namespace: 'qh-virtual',
      }));
      buildApi.onLoad({ filter: /.*/, namespace: 'qh-virtual' }, () => ({
        contents:
          `export const PANEL_CSS = ${JSON.stringify(panelCss)};\n` +
          `export const PANEL_JS = ${JSON.stringify(panelJs)};\n`,
        loader: 'js',
      }));
    },
  };

  const runtimeBundle = await esbuild.build({
    entryPoints: [path.join(srcDir, 'runtime.js')],
    bundle: true,
    write: false,
    format: 'iife',
    target: ['es2020'],
    minify: true,
    plugins: [virtualPlugin],
    banner: {
      js:
        '// 命定之诗 · 独立任务助手脚本（不依赖任何命定核心，直接粘贴至酒馆脚本助手即可）\n' +
        '// 项目地址：https://github.com/yue-234/quest-assistant',
    },
  });

  const finalCode = runtimeBundle.outputFiles[0].text;
  if (/<\/script/i.test(finalCode)) {
    throw new Error('构建产物包含未转义的 </script> 标签');
  }

  fs.mkdirSync(path.dirname(outDistFile), { recursive: true });
  fs.writeFileSync(outFile, finalCode, 'utf8');
  fs.writeFileSync(outTxtFile, finalCode, 'utf8');
  fs.writeFileSync(outDistFile, finalCode, 'utf8');

  // 3. 清理历史世界书交付文件并导出按当前版本号命名的标准酒馆双条目世界书 JSON
  const ejsContent = fs.readFileSync(path.join(__dirname, '任务助手-世界书.ejs'), 'utf8');
  const worldbookJson = buildWorldbookJson(ejsContent, SCRIPT_VERSION);
  const targetWorldbookName = worldbookFilename(SCRIPT_VERSION);
  const legacyWbName = '⭐导入这个-命定任务助手世界书.json';
  const versionedWbRe = /^命定任务助手世界书v\d+\.\d+\.\d+.*\.json$/i;
  for (const name of fs.readdirSync(__dirname)) {
    if ((name === legacyWbName || versionedWbRe.test(name)) && name !== targetWorldbookName) {
      fs.unlinkSync(path.join(__dirname, name));
    }
  }
  const outWorldbookFile = path.join(__dirname, targetWorldbookName);
  fs.writeFileSync(outWorldbookFile, JSON.stringify(worldbookJson), 'utf8');

  const kb = (Buffer.byteLength(finalCode, 'utf8') / 1024).toFixed(1);
  const wbComments = Object.values(worldbookJson.entries).map((e) => e.comment).join(' + ');
  console.log(`构建完成：${outFile} & ${outTxtFile} & ${outDistFile} (${kb} KB) + ${outWorldbookFile} (${wbComments})`);
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  const a = path.resolve(process.argv[1]);
  const b = path.resolve(fileURLToPath(import.meta.url));
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
})();

if (isMain) {
  build().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
