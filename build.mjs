// 构建独立任务助手单文件粘贴脚本「⭐粘这个-任务助手脚本.js」
// 项目地址：https://github.com/yue-234/quest-assistant
// 优先从当前环境解析 esbuild，亦可通过环境变量 ESBUILD_PATH 指定路径

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

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

const esbuild = loadEsbuild();

function escapeInlineScript(code) {
  return code.replace(/<\/script/gi, '<\\/script');
}

async function build() {
  const srcDir = path.join(__dirname, 'src');
  const outFile = path.join(__dirname, '⭐粘这个-任务助手脚本.js');
  const outTxtFile = path.join(__dirname, '⭐粘这个-任务助手脚本.txt');

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

  fs.writeFileSync(outFile, finalCode, 'utf8');
  fs.writeFileSync(outTxtFile, finalCode, 'utf8');
  const kb = (Buffer.byteLength(finalCode, 'utf8') / 1024).toFixed(1);
  console.log(`构建完成：${outFile} & ${outTxtFile} (${kb} KB)`);
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
