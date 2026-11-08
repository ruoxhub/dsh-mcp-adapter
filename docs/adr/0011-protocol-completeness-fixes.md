# MCP 协议完整性补齐：对 opencode 的五项缺陷修复

Status: accepted

Context: 一次与成熟实现 `opencode-2.2.5`（`packages/core/src/mcp/*`，约 2480 行）的逐项对比发现
本适配器在**上下文经济性与生命周期**上明显更强（懒启动、空闲停机、目录缓存、代理工具、项目信任
闸门，opencode 都没有），但在**协议完整性**上有五处会让用户撞上的缺陷。其中两处的证据是实测：

```
# 1. 瞬时 tools/list 失败被当成"服务器没有工具"
RESULT tools = 0  resources = 0
RESULT state = connected   hasCatalog = true
RESULT lastError = tools/list: temporarily unavailable
```

这台服务器此后**永远不会再列一次工具**：`refreshCatalog()` 把空目录 `storeEntry` 落盘，下一个会话
`configHash` 命中，`catalog !== undefined` 使"缺失即重取"的逻辑永不触发。用户看到的是"这台 MCP
忽然没工具了，重启也不恢复"。

```
# 2. 图片结果被压成占位符
[image image/png — 630000 bytes omitted]
```

而 README 自己举的例子就是 `chrome-devtools-mcp` 的 `take_screenshot`——截图类 MCP 的全部价值
（浏览器自动化、图表渲染、页面快照）被这一行文本抹掉，且宿主本来就提供了 `ctx.attachments` 与
`ImageBlock`，opencode 也是原样透传。

另三处是静态核查 + 实测确认的：远端服务器**无法使用 OAuth**（`oauth`/`auth` 字段被 normalize 后
无人消费，比不支持更糟：用户以为配了）；流式 HTTP **会话过期不恢复**（SDK 报 `SdkHttpError` 404
且**不触发 `onclose`**，池子保留死连接、状态永久 `connected`）；**单个 60 秒超时**同时管握手、
列目录和工具执行（长任务必然被误杀，opencode 把 execution 单独给到 12 小时）。

Decision: 我们决定按五条独立缺陷修复，每条一个 commit，可单独回滚。P2 层缺口（资源模板、缓存
TTL、会话终止、sampling 等）单列在下方 Deferred。

1. **失败不是目录。** `fetchCatalog()` 在 `tools/list` 真的失败（且未列到任何工具）时抛错，不再
   返回空 `ServerCatalog`。这使 `entry.catalog` 保持 `undefined`，于是下一次读会重试，且失败
   永远不进磁盘。判据刻意是"记录了失败"而不是"列表为空"：服务器没有 tools 能力时 SDK 直接短路成
   空列表且不记录失败，只提供资源的服务器因此保留合法的空目录。
2. **跟随运行期的清单变化。** 用 SDK 的 `ClientOptions.listChanged`（`autoRefresh: false`，
   100ms 去抖）接住 tools/prompts/resources 三类通知，一次通知触发**一次**完整目录读取并落盘
   （这条路径没有冷启动那样的批量写者，必须自己持久化）。同时给 `client.onerror` 赋值——它此前
   从未被设置，后台传输错误全部被丢弃，池子一边报 `connected` 一边每个请求都失败。
3. **显式拒绝 OAuth，并恢复过期会话。** `loadConfig` 遇到 `oauth` 对象或 `auth: "oauth"` 时拒绝
   该条目并给出可用替代（`headers`/`bearerToken`/`bearerTokenEnv`），与既有 unix socket 拒绝同一
   处理；`oauth: false` 仍然接受，因为它要求的正是本适配器做的事。工具调用、资源读取、提示渲染在
   收到"持有 session id 的连接上的 404"时替换连接并重试一次。
4. **图片交给宿主准入。** 新增 `src/media.ts`：解码 base64 → 校验**当前模型路由**声明了 `image`
   输入模态 → `ctx.attachments.saveImages()` → 产出真 `ImageBlock`。任一环节拒绝（未挂载
   attachment store、路由无法验证、存储失败）都降级为一句带原因的文本，绝不因此让工具调用失败。
   两个宿主服务都以 `ctx.get(name, false)` 结构化读取，不新增对 `@deepseek-ai/dsh-attachment`
   的依赖。`ContentBlock` 改为别名宿主的真实联合类型，"模型看到图片"才是真类型而不是本地结构副本。
5. **拆开请求超时与执行超时。** 新增 `executionTimeoutMs`（默认 10 分钟，settings 与服务器级都可
   设），只约束工具调用/资源读取/提示渲染；`requestTimeoutMs` 继续管握手与目录列举。不采用
   opencode 的三段式（startup/catalog/execution）：真正会误杀用户的只有执行阶段，三个键会让面板与
   文档复杂度翻倍而收益很小。

同时修掉三处文档谎言（都在这轮一起提交）：README 差异表说 elicitation「未做」但
`src/elicitation.ts` 已实现；GLOSSARY 的 `Persisted Catalog` 没写"只持久化**完整**目录"这一新
不变量；GLOSSARY 的 `Output Spilling` 说落盘归宿主，但 `directTools` 路径根本不落盘（宿主
`dsh-spill-policy` 会兜住，适配器自己不写）。

Consequences:

- **行为变化**：`oauth`/`auth: "oauth"` 配置从"被静默忽略"变成"加载期报错并跳过该服务器"。这是
  有意的（静默忽略一个鉴权字段本身就是缺陷），但已有配置会从"失败于 401"变成"`mcp({})` 与面板直接
  显示原因"。
- `executionTimeoutMs` 的默认值从"实际是 60s（与请求超时共用）"变成 10 分钟。楔死的服务器仍然会
  在一个回合内失败，但比过去晚。
- 图片路径**依赖宿主挂载 `ctx.attachments` 与 `ctx.llm`**：缺任一服务时行为与修复前一致（占位文本
  或诊断文本），不报错。子代理/无头组合因此不会因为这条新代码而坏。
- `listChanged` 只在服务器**声明** `tools.listChanged` 等能力时生效（SDK 行为）；不声明该能力的
  服务器仍然只在连接时列一次，这是协议决定的，不是适配器的选择。
- 每次 `list_changed` 会写一次目录缓存。一个高频改动清单的服务器会带来相应的写盘，这是"变化要能被
  下一次启动看见"的代价。

Considered Options:

- **P0-1 的备选**：给持久化条目加 `catalogTrusted: false` 字段（需要 `CACHE_VERSION` +1 与迁移），
  或把"空目录"当异常信号特判（会反复冷启动真·空服务器）。选"不落盘"是因为失败本就不该产生持久化
  事实，且它不需要维护新字段。
- **P0-2 的备选**：自己 `setNotificationHandler('notifications/tools/list_changed')`。SDK 已实现
  modern-era 的 `subscriptions/listen` 流与去抖，自己解析等于重写一遍协议。
- **OAuth**：真做 OAuth（DCR + PKCE + token 落 `ctx.credentials` + 回调本地监听 + `needs_auth`
  状态 + 面板登录按钮）是独立的中等工程，且会引入一个浏览器回调面。本轮选择显式拒绝，把它与
  `needs_auth` 状态一起留给下一批。
- **图片准入**：只存不校验模型模态（简单，但给纯文本模型发图会让该回合及其后所有重放回合的请求
  降级失败），或干脆本轮不做（截图类 MCP 依旧不可用）。选照抄宿主 `dsh-mcp-client` 的完整准入，
  它的失败模式已经由宿主验证过。
- **超时**：保持单键只把默认调大（治不了"长任务与慢握手需要相反预算"这个根因）。

Deferred（本轮不做，按发现时的严重度排序）：

1. **MCP 资源模板**（`resources/templates/list`）：全仓未调用过，`file:///{path}`、`db://{id}`
   这类参数化资源对模型完全不可见。宿主 `dsh-mcp-resources` 已有 `list_mcp_resource_templates`。
2. **OAuth 与 `needs_auth` 状态**：见上。当前远端 OAuth 服务器只能改用静态 token。
3. **目录缓存 TTL**：`cachedAt` 写了但没人读，磁盘目录永不过期；接上 listChanged 后只解决了
   "运行期变化"，"适配器没跑时服务器换了版本"仍要等定义哈希变化。加 TTL 会让"停机仍可离线搜索"
   这个卖点变成"每次冷启动都要连服务器"，需要单独设计（例如命中即用、后台异步刷新）。
4. **关闭时终止 HTTP 会话**：只 `close()` 不发 `DELETE`（`transport.terminateSession()`），懒
   启停频率高，服务端会话泄漏被放大。
5. **`directTools` 输出不落盘**：只有 proxy 路径有 `spillOversized`。宿主 `dsh-spill-policy` 会
   在 `tools/post-execute` 兜住，所以这是"两条路径不一致"而非数据丢失。
6. **总结/采样/任务/UI app**：协议侧未实现或 SDK 无运行时（`tasks/*` 在 `@modelcontextprotocol/
   client@2.2.0` 只有类型没有方法），继续不做。
7. **opencode 的 client-attach（客户端反向托管 MCP）与 Code Mode**：对 DSH 没有对应面，不做。