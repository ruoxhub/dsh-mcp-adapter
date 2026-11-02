# 项目服务器信任闸门默认放行 (Project Server Trust Defaults to Allow)

Context: 本插件的项目信任闸门（`src/trust.ts` 的 `partition()`）自初版起默认 `projectServers: 'ask'`：
`<project>/.mcp.json` 与 `<project>/.dsh/mcp-adapter.json` 里的服务器必须命中
`mcp-project-approvals.json` 中「项目根 + 服务器名 + 定义哈希」三者一致的记录才会挂载，否则整台服务器
被 blocked，模型只能看到一句 `…/.mcp.json is not approved — run /mcp-adapter approve <name>`。

实际使用中这条闸门挡住的正是用户自己刚写进去的服务器：在一个仓库里声明一台 MCP 服务器、重启会话、
发现它没起来，再去找批准入口。而这道闸门要防的攻击面——克隆来的仓库用 `.mcp.json` 决定跑什么命令——
在用户主动打开陌生仓库时并不比「打开仓库后手动批准」更可控：批准界面展示的是命令与参数，用户读不懂时
照样会点通过。代价却是恒定发生的摩擦，收益只在少数场景兑现。

同时 `ctx.approval` 那条工具级审批（`approveTools` / 服务器 `autoApprove`）默认已经是 `false`，本来
就不问，与本次决定无关，保持不动。

Decision: 我们决定：

1. **默认改成 `allow`**：`DEFAULT_SETTINGS.projectServers` 与包自己的 bundle 层 `cordis.patch.yml`
   都写 `allow`，项目服务器（`.mcp.json`、`.dsh/mcp-adapter.json` 两个来源一视同仁）无需批准即挂载。
   `ask` 与 `deny` 保留为显式选项，闸门代码、审批记录、`mcp_approve` 工具、`/mcp-adapter approve`
   命令、面板「等待批准」分组全部保留——只在 `ask` 下露面。
2. **用户自己的文件仍可收紧**：`projectServers` 继续留在 `USER_ONLY_SETTINGS` 里，克隆仓库不能把
   自己的策略从 `ask` 放宽成 `allow`；放宽只发生在用户全局配置或 loader 行。
3. **非法值 fail-closed**：`sanitizeConfig()` 对**未设置**取默认（`allow`），对**认识不了的字符串**
   退回 `ask` 并 `console.warn`。没写是「采用默认」，写错是「说不清要什么」，后者放行等于把笔误变成
   安全缺口。
4. **面板行状态跟随策略**：`McpServersService` 增加可选 `projectServers`（缺省取
   `DEFAULT_SETTINGS.projectServers`），`toServerDetail()` 按策略判定 workspace 行的 `blocked`：
   `allow` 报 ready、`deny` 报 blocked、`ask` 才去查审批记录。此前它只看审批记录，于是 `allow` 下
   会出现「服务器在跑、列表页却挂未批准红标」的谎报。

Status: accepted

Considered Options:

- 选项 A：维持 `ask` 默认，只优化批准入口（更醒目的按钮、批量批准、按仓库一次性信任）。缺点是没有
  解决「写进去就要再点一次」的恒定摩擦，且本适配器的用户基本就是同一个写配置的人。
- 选项 B（采纳）：默认 `allow`，`ask` / `deny` 作为显式收紧手段保留。代价是打开陌生仓库时更危险，
  用文档与 ADR 记录该风险，而不是用默认值替用户决定。
- 选项 C：TOFU——首次见到静默写一条审批记录，定义变化才重新要批准。缺点是「改 args 就要重新批准」
  这条仍然会在迭代 MCP 配置时反复咬人，而这恰恰是改配置最频繁的场景。
- 选项 D：按传输分流（HTTP 放行、stdio 需批准）。缺点是把规则拆成两套、按风险猜语义，用户无法从
  「allow / ask / deny」三个词推出实际行为。
- 选项 E：删掉整套信任闸门，`projectServers` 只留启停语义。缺点是要连带删除 `trust.ts`、审批记录、
  工具、命令、面板分组与 15 个测试文件的相关断言，还得丢掉 `deny` 与审计记录。

Consequences:

- **安全姿态实质性后退**：`allow` 下，打开一个克隆仓库即等于允许它决定跑什么命令。`lifecycle` 为
  `keep-alive` / `eager` 的服务器在挂载时直接起进程，`lazy` 的在第一次调用工具时起。
- 仓库文件仍可写 `autoApprove: true` 免掉工具级审批。该洞在 `ask` 下同样存在（批准只看服务器名，
  不看这些字段会带来什么），并非本次引入，但随默认放行变得更值钱。
- `.mcp.json` 与 `.dsh/mcp-adapter.json` 一起放行：只放一个会造成「同一个克隆仓库，配置文件放在哪
  决定问不问」这种无法向用户解释的差异。
- `packages/pi-mcp-adapter`（上游参考实现，v7.0.0）保持自己的 `ask` 默认，不跟改；差异写进 README
  的对照表。
- 生效需要重启 DSH 服务：`projectServers` 来自 loader 行，不走配置热读。
