# ZJSearch

[![License](https://img.shields.io/badge/License-AGPL--3.0%20(upstream)%20%2B%20Apache--2.0%20Commons%20Clause%20(theme)-blue)](LICENSE)
[![Python](https://img.shields.io/badge/Python-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

ZJSearch 是 [SearXNG](https://github.com/searxng/searxng) 的 fork：从零构建的 **ZJSearch React 主题** + **AI 研究助手（DeepResearch）**，隐私友好的元搜索引擎。开发规范见 [AGENTS.md](AGENTS.md)，审计手册见 [AUDIT.md](AUDIT.md)。

## 特性

- **隐私元搜索**：继承 SearXNG，不追踪、不画像用户
- **ZJSearch 主题**：React 19 + TypeScript + Vite + Tailwind v4 全新界面（服务端只渲染数据壳，React 渲染 100% 界面），遵循家族 DESIGN.md 设计契约
- **AI 研究助手（DeepResearch）**：LLM 驱动的多步研究 agent，内置无头浏览器页面阅读、embedding 与 rerank 服务
- **增强引擎**：药典 ChP、PubMed（API Key）、Brave Search API、Google PSE 等
- **搜索增强插件**：高级搜索语法（`site:`、`intitle:`、`&&`/`||` 等）、BM25 重排序
- **PWA** 支持

## 快速开始

### Docker（推荐）

```bash
docker run --name zjsearch -p 8080:8888 -d hezhijie0327/zjsearch:latest
```

### 本地开发

```bash
./manage pyenv.install          # Python venv（./local/py3）
make themes.zjsearch            # pnpm install + vite 构建主题
make run                        # 开发实例 http://127.0.0.1:8888

# 主题开发（HMR，代理 API 到 :8888）
make themes.zjsearch.dev

# 指定开发配置启动
SEARXNG_SETTINGS_PATH=$PWD/client/zjsearch/dev-settings.yml ./manage webapp.run
```

主题客户端在 `client/zjsearch/`（pnpm workspace）； lint/审计：`make themes.zjsearch.lint`、`pnpm run audit`。

## 配置 / 用法

- **`searx/settings.yml` 上游冻结**：本分支不修改它；配置放在部署自己的 settings 文件（开发用 `client/zjsearch/dev-settings.yml`）
- AI 功能经 `ZJSEARCH_AI_KEY` 与 `zjsearch.llm` / `zjsearch.embedding` / `zjsearch.rerank` 配置端点
- 默认主题 `default_theme: zjsearch`，需开启全部 search formats（含 json）

## 文档

- [AGENTS.md](AGENTS.md) — 开发规范、架构约定与 Gotchas（英文）
- [AUDIT.md](AUDIT.md) — 审计手册（Lighthouse 门禁、AI 故障 UX 等）
- [SearXNG 官方文档](https://docs.searxng.org/) — 上游安装与配置指南

## License

混合许可：上游 SearXNG 文件保持 **AGPL-3.0**（见 [LICENSE](LICENSE)）；主题原创文件（`client/zjsearch/`、`searx/templates/zjsearch/`、`searx/zjsearch/` 等新增 Python 代码）为 **Apache-2.0 WITH Commons-Clause-1.0**，逐文件以 SPDX 头标注。
