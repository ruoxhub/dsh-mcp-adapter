# MCP Adapter 架构演进与设计权衡

Superseded in part by [ADR-0002](0002-mcp-adapter-delegate-to-host-services.md): 第 2 条（自制 AES 凭据存储）与第 3 条（不做后台任务）的前提在宿主能力盘点后改变。本文保留为当时的决策记录，不重写。

Context: 在借鉴 `pi-mcp-adapter` 完善 `dsh-mcp-adapter` 过程中，面临大输出处理、认证凭据持久化、后台任务管理等多项架构分支选择。

Decision: 我们决定：
1. **大输出与结果提取（Output Spilling & Extraction）** 采用纯本地文件落盘与确定性字段投影，不依赖外部小型 LLM 模型进行数据解析。
2. **凭据存储** 采用纯 JavaScript 实现的 AES-256-GCM 加密文件方案，完全避免平台相关的原生 C++ 编译依赖（如 keytar/node-gyp）。
3. **后台任务调度** 遵循 DSH 平台约束，不引入独立的第二重任务轮询机制，优先保持 MCP 代理的同步与轻量。
4. **预置服务接入** 采用代码内静态模板元数据，联动 Web UI 面板和 CLI 命令一键填参，降低用户上手成本。

Status: accepted

Considered Options:
- 选项 A：完整移植 pi-mcp-adapter 的全部特性，包括基于 LLM 的语义搜索、外部模型提取、原生 Keyring 以及 Task 后台轮询。缺点是引入重型依赖，构建脆弱，且破坏 DSH 的 Context-First 预算设计。
- 选项 B（采纳）：分期推进，第一期优先交付本地大输出防爆落盘、字段提炼、常用服务预置与错误诊断增强；第二期交付跨平台纯 JS 加密 OAuth 流。
