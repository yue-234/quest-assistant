# 项目协作

这是「任务助手（Quest Assistant）」独立通用插件仓库，面向「命定之诗与黄昏之歌」，不绑定特定核心。

- **核心入口**：
  - 世界书条目：[任务助手-世界书.ejs](任务助手-世界书.ejs)
  - 前端源码：[src/](src/)（构建产物为 [⭐粘这个-任务助手脚本.js](⭐粘这个-任务助手脚本.js) 与 [⭐粘这个-任务助手脚本.txt](⭐粘这个-任务助手脚本.txt)）
  - 构建与测试：[build.mjs](build.mjs)、[test.mjs](test.mjs)
  - 更新日志与文档：[CHANGELOG.md](CHANGELOG.md)、[README.md](README.md)、[使用说明.md](使用说明.md)
- **提示词去古风与标准化（重要）**：编写、修改或审查 [任务助手-世界书.ejs](任务助手-世界书.ejs) 及任何模型提示词时，必须按 [prompt-style](.agents/skills/prompt-style/SKILL.md) 与 [提示词写作与古风清理](docs/archaic-wording-cleanup.md) 审校语体、文风、`<user>` 指代、变量契约与冗余表述。
- **配置口径同步**：[src/data.js](src/data.js) 中的 `DATA` 与 [任务助手-世界书.ejs](任务助手-世界书.ejs) 顶部的 `@data-begin` ~ `@data-end` 必须保持同一份口径。
- **构建与验证**：
  - 修改 `src/` 后运行 `node build.mjs` 重新生成构建产物，不直接手工修补生成物。
  - 任何代码或世界书修改后，运行 `node --test test.mjs` 确认全部单元测试通过。
- **日志与提交**：重要功能、规则调整或问题修复同步记录到 [CHANGELOG.md](CHANGELOG.md)；Git 提交信息默认使用中文，项目修改验证通过后默认提交并推送到远端仓库。
