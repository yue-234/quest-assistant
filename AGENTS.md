# 项目协作

这是「任务助手（Quest Assistant）」独立通用插件仓库，面向「命定之诗与黄昏之歌」，不绑定特定核心。

- **核心入口**：
  - 世界书条目：[任务助手-世界书.ejs](任务助手-世界书.ejs)（交付导入 JSON 按版本命名为 `命定任务助手世界书v1.x.x.json`，当前为 [命定任务助手世界书v1.4.13.json](命定任务助手世界书v1.4.13.json)）
  - 前端源码：[src/](src/)（构建产物为 [⭐粘这个-任务助手脚本.js](⭐粘这个-任务助手脚本.js)、[⭐粘这个-任务助手脚本.txt](⭐粘这个-任务助手脚本.txt) 与 CDN 分发产物 [dist/quest-assistant.js](dist/quest-assistant.js)；远程加载壳为 [⭐粘这个-远程自动更新脚本.js](⭐粘这个-远程自动更新脚本.js)）
  - 构建、测试与 CDN 工具：[build.mjs](build.mjs)、[test.mjs](test.mjs)、[tools/purge-cdn.mjs](tools/purge-cdn.mjs)
  - 更新日志与文档：[CHANGELOG.md](CHANGELOG.md)、[README.md](README.md)、[使用说明.md](使用说明.md)
- **提示词去古风与标准化（重要）**：编写、修改或审查 [任务助手-世界书.ejs](任务助手-世界书.ejs) 及任何模型提示词时，必须按 [prompt-style](.agents/skills/prompt-style/SKILL.md) 与 [提示词写作与古风清理](docs/archaic-wording-cleanup.md) 审校语体、文风、`<user>` 指代、变量契约与冗余表述。
- **配置口径同步**：[src/data.js](src/data.js) 中的 `DATA` 与 [任务助手-世界书.ejs](任务助手-世界书.ejs) 顶部的 `@data-begin` ~ `@data-end` 必须保持同一份口径。
- **构建与发版节奏**：
  - 阶段性修改默认提交并推送到远端 `main` 分支，**不要擅自升版本号、重新打包交付物或打 Git Tag**，避免产生半成品发布包。
  - 仅在 lili 明确确认进入打包或发版阶段时，再统一升 `SCRIPT_VERSION`、运行 `node build.mjs` 生成脚本与世界书 JSON 交付物、跑全量 `node --test test.mjs` 并打 Tag 推送。
  - 日常开发不直接手工修补构建生成物，改动后通过单元测试确认逻辑正确。
- **世界书交付命名约定**：`build.mjs` 会按当前 `SCRIPT_VERSION` 动态生成 `命定任务助手世界书v1.x.x.json`，并在生成前自动清理旧版 `⭐导入这个-命定任务助手世界书.json` 及历史 `命定任务助手世界书v*.json`；每次发版同步更新 [README.md](README.md)、[使用说明.md](使用说明.md) 与本文档。
- **日志与提交**：重要功能、规则调整或问题修复按 [更新日志模版](docs/changelog-template.md) 同步记录到 [CHANGELOG.md](CHANGELOG.md)；Git 提交信息默认使用中文，阶段性修改验证通过后默认提交并推送至 `main`（不自动打 Tag）。
