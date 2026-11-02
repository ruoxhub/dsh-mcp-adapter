# 跨作用域原子迁移与两步武装安全交互规范 (Scope Migration & Two-step Arming)

Context:
参考 `PI-Desktop` 进一步完善 `dsh-mcp-adapter` 的完整管理能力矩阵（编辑、启停、删除、测试、迁移、授权）。目前已具备基础的编辑、行内 Toggle 启停、连接测试（Probe）与基础删除，但仍存在以下体验与安全缺口：
1. **作用域割裂**：用户无法直接将全局级（`~/.dsh/mcp-adapter/mcp.json`）与项目级（`.dsh/mcp.json`）配置进行一键流动转移，导致临时调试的配置需要重新手动配置或手动修改物理文件；
2. **删除误触风险与粗暴弹窗**：使用浏览器的阻塞式 `window.confirm` 原生弹窗，既打断操作流、破坏桌面软件无障碍与一致性，又无法实现可预期的武装保护；
3. **HTTP 凭据授权繁琐**：对于携带 Bearer Token 或 API Key 的 HTTP/SSE MCP 服务器，用户为了配置或更换密钥必须进入庞大的全量编辑表单或手工拼贴 JSON 请求头；
4. **探活反馈不直观**：连接测试结果未充分与卡片头部的状态指示灯联动，缺乏就地微状态反馈。

Decision:
我们决定：
1. **跨作用域原子迁移（Scope Migration）**：
   - 后端新增 `migrateScope({ name, fromScope, toScope, cwd })` API。
   - 实行「源读取 -> 目标重名冲突检查 -> 目标写入 -> 源删除 -> 进程池热驱逐与目录失效」严格流水线。
   - 若目标作用域已存在同名配置，严格予以阻断拦截（409 Conflict），拒绝覆盖已有配置。
   - 前端在 `···` 更多菜单中根据当前作用域动态提供「迁移到项目 “<name>”」或「迁移到全局」操作。
2. **菜单内两步武装确认（Two-step Arming Removal）**：
   - 彻底摒弃 `window.confirm` 原生阻塞弹窗。
   - 首次点击菜单项「移除」时，不关闭菜单，该按钮进入武装态（文字变为「确定移除？」并显示醒目的危险红底高亮）；
   - 二次点击才正式触发物理删除并执行乐观移除；
   - 点击菜单外任意区域或关闭菜单时，自动解除武装态并重置为初始状态，提供零误触且流畅的桌面交互。
3. **HTTP 快捷凭据授权（HTTP Authorization Prompt）**：
   - 针对 HTTP/SSE 类型的服务器，在 `···` 菜单中提供快捷「授权」/「重新授权」（IconKey）入口。
   - 唤出轻量级凭据录入抽屉，直接填写 Bearer Token 或 API Key，保存后自动格式化并合并至 `headers.Authorization` 并热生效，同时自动触发一次快速测试连接。
4. **行内探活微状态联动（Inline Probe Animation & Status）**：
   - 点击测试连接后，菜单立即收起，状态小圆点（Status Dot）切换为旋转动画探测态；
   - 探测完成后就地更新状态小圆点与徽标（成功显示 `ready (XXms)`，失败显示 `failed: 原因`）。

Status: accepted

Amendment (2026-11-02, shipped): 该菜单上线后五项操作全部静默失效，根因是 `ServersListTab` 的 document 级 `mousedown` 监听无条件 `setOpenMenuServer(null)`——浏览器先派发 `mousedown` 再派发 `click`，菜单在 `click` 到达前已被卸载，所有菜单项都收不到点击。修复分四处，均以真实浏览器 CDP 鼠标事件复核：

1. **按压守卫**：`mousedown` 处理函数改为 `target.closest('[data-row-menu]')` 命中时不关菜单，与作用域下拉既有的 `scopeMenuRef.contains` 守卫同构；五项操作与两步武装由此恢复可用。回归测试必须**分两次 `act` 派发** `mousedown`/`click`，合并成一次会被 React 批处理掩盖。
2. **武装超时**：本条 Decision 2 承诺的"超时自动解除武装"此前未实现，现补 `DELETE_ARM_TIMEOUT_MS = 5000`。
3. **复制配置无损**：`McpServerDetail` 新增 `raw` 字段携带磁盘原文，复制出口改为 `{ "mcpServers": { "<name>": <raw> } }`；此前重新拼装的子集会丢掉 `type`、`cwd`、`timeoutMs`、`caFile`、`httpTransport`、`protocolVersion`、`disabled` 及任何未来字段，粘到别处已不是同一台服务器。剪贴板被拒时不再静默，改为报 `copy.failed`。
4. **探活改为真握手**：`service.probeServer` 原实现是"PATH 里找得到命令 / URL 返 200"即通过，实测 `git`、`https://example.com/`、HTTP 401 全部被报成成功，且完全不读 `headers`。现改为复用 `ServerPool` 走 `normalizeEntry → configure → catalog({refresh:true}) → closeAll()`，返回 `toolCount`，`headers`/`env`/`httpTransport`/`caFile`/`protocolVersion` 全部生效；socket 条目因 `loadConfig` 不接 socket 而保留裸连接。文案同步为"握手成功，发现 N 个工具"。

Consequences（补充）：探活改动在宿主侧（`src/service.ts`），**生效需重启 DSH 服务**，仅刷新页面不够。

Considered Options:
- 选项 A：仅支持在编辑器中手动切换 scope 下拉框并重新保存。缺点是无法保证原子性，容易导致两份同名文件并存冲突，且用户操作繁琐。
- 选项 B（采纳）：后端支持原子跨作用域迁移与重名阻断，前端采用两步武装确认与行内快捷授权，全面对齐 PI-Desktop 工业级体验。
- 选项 C：在删除时弹出自定义居中 Modal 对话框。缺点是引入了额外的遮罩和弹窗层级，打断用户的浏览流，远不如 PI-Desktop 的菜单内两步武装轻量优雅。

Consequences:
- `McpServersService` 与路由层需暴露 `api/dsh-mcp-adapter/migrate-scope`。
- `ServersListTab.tsx` 需维护武装删除状态与授权快捷录入状态。
- 用户可在不退出列表视图的前提下完成 100% 的日常运维操作（编辑、开关、删除、探活、迁移、改密钥）。
