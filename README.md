# dsh-mcp-adapter

pi-mcp-adapter 的行为，用 DeepSeek Harness 的原生 API 重写。

## 为什么要有它

dsh 有两个硬约束，这个插件各补一半：

1. **MCP 配置只能写死在 profile 里。** profile 路径由程序固定（`join(resolveDshHome(), 'profiles', name)`），桌面端更是写死 `profiles/desktop`，所以仓库里放 `.dsh/...` 永远不会被读到。
2. **自带的 MCP 桥是「配置了就常驻」。** 没有懒启动、没有空闲停止、没有 proxy 工具、没有目录缓存——配了 20 个服务器，就是 20 个常驻进程 + 几百个工具定义进上下文。

## 它的行为

| 行为 | 实现 |
|---|---|
| 项目级配置 | 读 `$DSH_HOME/mcp-adapter/mcp.json`、`$DSH_HOME/mcp-adapter/mcp-adapter.json`、`<project>/.mcp.json`、`<project>/.dsh/mcp-adapter.json`，后者覆盖前者 |
| 项目 = 会话当前目录解析出的项目根 | 配置发现用的 `<project>` 是**宿主报告的会话当前目录**（`ctx.workingDirectory`，`working_directory` 工具改的就是它）解析出的**项目根**：落在某个注册工作区内时是那个**注册路径**（仓库子目录也可以是独立工作区），否则是最近的 `.git` 祖先。两者都答不出时会话没有项目，只读用户全局配置。会话 `cd` 进另一个仓库后，下一次 step 会重新加载那边的 `.mcp.json`，面板写的是同一个文件 |
| 服务器运行目录不属于定义 | stdio 子进程与 `roots/list` 用**会话当前目录**（条目显式写了 `cwd` 时按它解析，相对路径相对会话目录）。这个目录**不进定义哈希**：否则一个全局服务器在每个工作区都有不同的身份，审批记录与目录缓存会互相顶掉。详见 ADR-0009 |
| 目录缓存只存必要字段 | `mcp-cache.json` 不保存工具的 `outputSchema` 全文（SDK 用自己 `tools/list` 的缓存校验，适配器只需要知道"声明过"）。真实配置从 4,027,351 字节降到约 386,383 字节，`sync()` 的 parse 从约 23ms 降到约 1ms。搜索字段在目录构建时预计算。详见 ADR-0010 |
| 懒启动 | 配置好不启动；第一次 `mcp({ tool })` 或 `mcp({ connect })` 才连 |
| 空闲停止 | 默认 10 分钟无调用就停进程（`idleTimeout: 0` 保持到会话结束） |
| 一个工具代替几百个 | 上下文里只有 `mcp` 一个工具，工具表放在缓存里 |
| 离线可搜 | 目录缓存在 `mcp-cache.json`，服务器停着也能 `search` / `describe` |
| 项目信任闸门 | 默认 `projectServers: allow`：项目里的服务器直接挂载。设成 `ask` 则回到按 `projectRoot + serverName + 定义哈希` 批准后才启动，改一个 args 就要重新批准 |
| 直连工具 | `directTools: true` 或 `["tool_a"]` 把指定工具提成原生工具；`"search"` 则按搜索激活 |
| MCP 资源 | `mcp({ resources: "<server>" })` 列、`mcp({ server, read: "<uri>" })` 读 |
| MCP prompts | 每个 prompt 自动变成 `/mcp__<server>__<prompt>` 命令，支持位置参数与 `key=value` |
| 危险工具审批 | `approveTools: "destructive"` 或工具名列表，走 dsh 的 `ctx.approval`，拒绝即不执行 |
| 兼容 `autoApprove` | Cursor/Claude Code 那份文件里的 `autoApprove` 直接生效：**列进去的不问，没列的才问**（白名单） |
| 收养其他 agent 的配置 | `importHosts: ["claude-code","cursor","vscode","codex","shared","agents"]`，优先级低于本插件自己的配置 |
| keep-alive 重连 | 连接断开后按 0.5s→30s 指数退避自动重连并重读目录 |
| MCP roots 协议 | 支持 `roots/list` 协议与 capability 宣告，自动映射工作区根路径，支持 `roots: false` 显式 opt-out |
| 动态请求标头 | HTTP/SSE 服务器支持 `requestHeadersCommand`，每请求执行命令动态生成 Authorization 等 Header |
| 工具过滤与审批 Glob | `includeTools`、`excludeTools`、`approveTools`、`autoApprove` 支持 `*`、`?` 通配符与 `server_*` 前缀匹配 |
| 宿主凭证集成 | 自动桥接宿主 `ctx.credentials` 服务，优先解析动态 grant 令牌，无缝回退静态 `bearerToken` |
| 宿主提问与 Elicitation | 将 MCP `elicitation/create` 转接至宿主 `ctx.userQuestions`；在无交互/无头环境中安全降级拒绝，杜绝死锁；工具调用期间支持计时器挂起 |
| 图片结果 | 服务器返回的图片经宿主 `ctx.attachments` 准入后成为真 `ImageBlock`（截图、图表不再变成占位符）；模型路由不接受图片时降级为带原因的文本 |
| 运行期清单变化 | 服务器增删工具/资源/提示时按 `list_changed` 通知重读目录并落盘，不用等下一次调用或重连 |
| HTTP 会话过期恢复 | 持有 `Mcp-Session-Id` 的连接被服务端遗忘（404）时换连接重试一次，而不是永久报 `connected` |
| 服务器 instructions 进系统提示 | 自动注入 `<mcp_instructions>` 块（单台 4KB、全会话 32KB 上限），模型不用主动来问 |
| 会话页头面板 | 一个 MCP 按钮：各服务器状态与工具数、配置问题、被拦服务器的原因；面板内可批准 |

## 代码结构

宿主侧（Node half，27 个模块）：

```
src/index.ts                  插件入口：按 agent 建会话、注册 mcp 工具与命令、空闲清扫、配置热更新
src/config.ts                 配置发现、优先级合并、entry 归一化（支持 roots、requestHeadersCommand 等）
src/trust.ts                  项目批准记录（哈希钉死定义）
src/cache.ts                  工具目录缓存
src/servers.ts                MCP 连接池：懒连接、空闲停止、keep-alive 重连、roots 与 elicitation 注册
src/catalog.ts                命名、include/exclude（Glob/前缀匹配）、搜索排序、describe
src/proxy.ts                  mcp 工具（status/search/describe/instructions/connect/call）
src/direct.ts                 直连工具注册 + 搜索激活
src/session.ts                单个 agent 的运行时（桥接 ctx.credentials 与 ctx.userQuestions）
src/approval.ts               危险工具审批（映射到 dsh 的 ctx.approval，支持 Glob 匹配）
src/prompts.ts                MCP prompts → slash command，参数解析与结果摊平
src/imports.ts                收养 Cursor/Claude Code/VS Code/Codex 的全局 MCP 文件
src/request-headers-command.ts requestHeadersCommand 动态命令执行与 fetch 请求包装
src/credentials.ts            宿主 ctx.credentials 令牌解析桥接
src/elicitation.ts            MCP Elicitation 协议转接 ctx.userQuestions、防死锁回退与超时挂起
src/media.ts                  MCP 图片结果 → 宿主 ctx.attachments 准入 → ImageBlock（拒绝时降级为诊断文本）
src/testserver.ts             迁移期新增的两个用例驱动的扩展 stdio MCP 服务器（工具/资源/prompt/危险工具）
src/util.ts                   超时、abort 组合、结果投影、输出截断
src/status.ts                 Web 面板的快照（纯函数，可直接测）
src/projection.ts             Web 面板读的 mcpAdapter 投影 + 发布器
src/approve.ts                Web 面板「批准」按钮驱动的 mcp_approve 工具
src/routes.ts                面板 REST 路由（每个都过信任围栏）
src/request-trust.ts         面板路由的浏览器信任围栏（Host / Origin / Sec-Fetch-Site）
src/types.ts                  跨模块接口（除一个 ContentBlock 类型别名外不 import 任何模块）
src/service.ts               面板/路由共用服务：服务器 CRUD、作用域迁移、探测、导入、预置
src/presets.ts               内置服务器预置与精选 Market 目录
src/tls-fetch.ts             自定义 CA 的 https fetch（caFile 用）
```

浏览器侧（client half，4 个文件）：

```
src/client/index.ts            入口：注册面板字典与页头动作
src/client/McpPanel.tsx        会话页头的 MCP 按钮与弹出面板
src/client/locales.ts          面板的中英字典（zh 是键的源，各 22 个键）
src/client/McpPanel.module.css 面板样式（CSS Modules，随 bundle 注入）
```

`types/css-modules.d.ts` 给上面那个 `.module.css` 提供类型声明。

源码是 TypeScript，`pnpm build` 分两步：`tsc -p tsconfig.build.json` 产出 `lib/types/**`（`.d.ts`），`tsdown` 产出 `lib/index.js`（宿主 half）与 `lib/client.js` + `lib/client.js.map`（浏览器 half）。运行时依赖只有 `@modelcontextprotocol/client`（外加它已带进来的 `zod`）；没有 vendor 源码、没有 Pi 兼容层。`lib/` 是构建产物，**不入库**（`.gitignore` 忽略，与同族 dsh-skill-manager / dsh-jev-plugin / dsh-mobile 一致）；发布前跑 `pnpm build`。

## Web 面板

会话页头多一个 **MCP** 按钮，点开是一个只读面板。

- **工作区**：面板的 `cwd` 由所在会话的当前目录决定，且必须对得上一个注册工作区（落在注册工作区内的子目录会解析成该工作区）；workspace 作用域的写操作没有可解析目录时直接 400，不会写进宿主的启动目录。列表行优先读会话列表里的 `workingDirectory` 投影，其次才是创建目录。
- **面板显示什么**：项目根、每个服务器的状态（未启动 / 启动中 / 运行中 / 失败 / 未批准）、工具数（可展开看工具名）、最近错误、配置问题。行上的状态跟着 `projectServers` 走：`allow` 下项目服务器直接报「运行中」，`deny` 下报「未批准」。
- **批准（仅 `ask` 模式）**：默认 `allow` 下没有「等待批准」这一组，也就没有批准动作。设回 `ask` 后，被信任闸门拦住的服务器会单独列在「等待批准」里，面板给两条路——按「批准」会往当前会话发一条普通消息，模型调用 `mcp_approve` 完成批准（批准留在对话记录里，这也是它该有的样子）；或按「复制命令」拿到 `/mcp-adapter approve <name>` 自己敲。
- **只读**：面板不能改配置、不能启停服务器、不能删批准记录。刷新目录要连服务器，所以仍然只在命令面（`/mcp-adapter tools`）。

为什么是这个形态，而不是一个 `ctx.remote` 命名空间：**第三方插件包无法申报 Remote 命名空间**。浏览器侧的 Remote 只挂 `@deepseek-ai/dsh-api-remotes` 那个包里硬编码的贡献列表（连自带 `./typert` + `./remote` 的 `dsh-client-ui-plugin-manager` 都是靠进这张表才拿到 `remote.pluginManager`），包外没有发现机制。能用的通路只有一条：宿主注册 **session projection**，浏览器通过注入的 `useProjection` 读——这正是 `agentTeam`、`goal`、`modelSelection` 等内置面板走的路。读法是 **key 在前、selector 在后**：`useProjection('mcpAdapter', (value) => value)`，key 选投影、selector 再收窄；只传 selector 会把 key 解析成 `undefined` 并在 `undefined.mcpAdapter` 上抛错。

投影的状态只能靠折叠已提交的 session 事件推进，而「服务器停了」不是会话事件。所以发布器会在状态**真的变化**时 append 一条 `mcp-adapter/status` 标记事件：seq 是真实日志位置，天然单调，旧帧永远盖不掉新帧；重复打开面板、空闲都不会写日志。这条事件不是 surface 事件、不带消息，不进模型历史。

面板在 `dsh.client` 里声明，`package.json` 用 `./client` 导出，由 Web Client loader 自动挂载，`apply()` 随插件 fiber 一起卸载。

## 配置

```yaml
- id: mcp-adapter
  name: dsh-mcp-adapter
  config:
    enabled: true
    projectServers: allow    # allow | ask | deny
    idleTimeout: 10          # 分钟；0 = 会话内不停止
    directTools: false       # false | true | "search"
    approveTools: false      # false | true | "destructive" | ["tool_a"]
    importHosts: false       # false | true | ["claude-code","cursor","vscode","codex"]
    exposeResources: true
    toolPrefix: ''
    configFiles: []          # 额外文件，越靠后优先级越高
    servers: {}              # inline，最高优先级
```

项目里的 `.mcp.json` 就是 Claude Code 那份格式：

```json
{
  "mcpServers": {
    "chrome-devtools": { "command": "npx", "args": ["-y", "chrome-devtools-mcp@1.6.0"] },
    "remote": { "url": "https://example.test/mcp", "headers": { "Authorization": "Bearer ${TOKEN}" } }
  }
}
```

服务器级字段：`command`/`args`/`env`/`cwd`/`inheritEnv`、`url`/`headers`、`httpTransport`（`sse` = 旧式 SSE，默认 Streamable HTTP）、`caFile`、`protocolVersion`（`legacy`（默认）/`auto`/具体版本号）、`lifecycle`（`lazy`/`keep-alive`/`lazy-keep-alive`/`eager`）、`idleTimeout`、`requestTimeoutMs`（握手与目录列举）、`executionTimeoutMs`（一次工具调用/资源读取/提示渲染，默认 10 分钟）、`directTools`、`includeTools`/`excludeTools`、`searchKeywords`、`toolPrefix`、`description`、`appendStructuredContent`、`autoApprove`、`approveTools`、`debug`。

四个 `lifecycle` 的实际差别（以前的 `eager` 与 `lazy-keep-alive` 是空实现，现已接线）：

| lifecycle | 会话开始时 | 空闲后 | 掉线后 |
|---|---|---|---|
| `lazy`（默认） | 不启动 | 停止 | 等下次调用 |
| `lazy-keep-alive` | 不启动 | **不停止** | 自动重连 |
| `keep-alive` | 启动 | 不停止 | 自动重连 |
| `eager` | 启动 | 不停止（除非该服务器自己写了 `idleTimeout`） | 等下次调用 |

**只读时接受的别名**：`timeoutMs` → `requestTimeoutMs`，`transport: "sse"` → `httpTransport: "sse"`。写入永远用规范名——面板已经改成写规范名，因为旧拼写写出的是一批没人消费的键。`timeoutMs` 只映射到 `requestTimeoutMs`，不会顺带放大 `executionTimeoutMs`。

**两种审批写法方向相反，不会互相覆盖：**

| 写法 | 含义 |
|---|---|
| `autoApprove: ["fetch_txt"]` | 白名单：列出的不问，**其余都问**。`true` 或含 `*` 表示全不问 |
| `approveTools: "destructive"` / `["tool_a"]` | 黑名单：列出的（或服务器自己标了 destructive 的）才问，其余不问 |
| 两者都没写 | 都不问 — 每次调用都弹窗只会训练用户闭眼点同意 |

小提示：`autoApprove` 里常见的空字符串 `""` 会被忽略；某个工具不在白名单时，问的原因是 `autoApprove` 而不是别的。

`${VAR}` / `$env:VAR` / `{env:VAR}` 会展开。`!command` 不执行（那是刻意不提供的 shell 执行面）。

## 用法

模型侧：

```
mcp({})                                    # 状态
mcp({ search: "screenshot" })              # 找工具（服务器可以没启动）
mcp({ describe: "browser_take_screenshot" })  # 看完整参数
mcp({ tool: "browser_take_screenshot", args: { fullPage: true } })  # 调用；这时才启动
```

人侧：`/mcp-adapter status | approve <server> | reload | tools`。默认 `allow` 下不需要批准；`ask` 模式可在会话页头的 **MCP** 面板里直接批准。

装进 profile（桌面端 profile 被 Electron 独占，走 Web UI 的 Plugins 页）：

```bash
dsh plugin --profile <name> add link:<repo>/packages/dsh-mcp-adapter
```

包名已改为 `@ruoxhub/dsh-mcp-adapter`（裸名 `dsh-mcp-adapter` 在 npm 上属于别的发布者），尚未发布到 registry；挂载不依赖包名——bundle 以 profile `dependencies` 的键解析，所以 `link:` 用任意本地键都能挂上。

## 验证

`pnpm test` — 30 个测试文件、484 个自检（vitest），其中端到端那组**真的启动一个 stdio MCP 服务器子进程**：

- 项目服务器默认直接挂载；`ask` 模式下未批准时**完全不会启动**，批准后第一次取目录才启动，`tools/list` 拿到工具、资源、instructions；
- 停掉服务器后 `search` / `describe` 仍然工作（缓存）；
- 再次调用会重新拉起进程，返回 `pong`；
- 空闲清扫只停 lazy 服务器，`keep-alive` 与 `lazy-keep-alive` 不动；
- `warmEager()` 只拉起 `eager` / `keep-alive`，`lazy` 保持 idle；
- 改定义让缓存失效（不会喂陈旧目录）；
- 资源可列可读，prompt 变成命令并能渲染；
- **危险工具被审批挡住**（proxy 与直连工具走同一个闸门，这条测出了真 bug：proxy 曾绕过审批）；
- **`autoApprove` 是白名单**：列表内的不问、列表外的才问，空字符串被忽略；
- 其他 agent 的全局配置默认不读，开了以后优先级低于本插件自己的配置；
- **热缓存调用仍会校验 `outputSchema`**：目录来自磁盘缓存时补一次 `tools/list`，否则首调用静默跳过校验（这条测试经过变异验证：去掉修复它会失败）；
- **settings 级 `requestTimeoutMs` 真的到达请求**：经 `pickPolicySettings` → 池，1 秒默认让慢服务器失败（同样经过变异验证）；
- **`protocolVersion: "auto"` 真的上线**：子进程记录到 `server/discover` 探测；
- **`caFile` 真的改变信任**：自签证书下全局 `fetch` 拒绝、`fetchWithCa` 接受（真实 TLS 握手，非 mock）；
- **目录就是工作区身份**：会话 `cd` 进另一个 checkout 后 `sync()` 读到那边的 `.mcp.json`、`configChanged()` 为真；
- **没有目录时不猜**：宿主既不报当前目录也不给创建目录时只加载用户全局配置，不读 `dsh` 进程的启动目录；
- **workspace 写入必须带目录**：面板 `save`/`approve`/`delete` 缺目录时 400 且磁盘上不产生文件；
- **服务器目录不参与定义身份**：同一份定义在两个会话目录下连接时缓存条目仍命中，而子进程的 `cwd` 分别落在两个目录（ADR-0009）；
- **相对 `cwd` 相对会话目录解析**：写 `"./servers"` 的条目实际在该子目录里 spawn，而不是被静默丢弃后在项目根跑；
- **失败的 `tools/list` 不落盘**（ADR-0011 P0-1）：一个第一次列工具就返回 `-32603` 的服务器，目录**不写进** `mcp-cache.json`、池里也**不留** `catalog`，第二次读取重试后拿到工具；另有一台只提供资源的服务器证明「没有 tools 能力」仍然是合法的空目录（守卫按「记录了失败」而非「列表为空」判定）；
- **运行期清单变化会跟上**（P0-2）：服务器连上后主动发 `notifications/tools/list_changed`，目录从 `before` 变成 `after`，且新目录被写进磁盘缓存——不重连、不靠下一次调用；
- **HTTP 会话过期会恢复**（P1-3）：一个在 `initialize` 后吊销 `Mcp-Session-Id` 的服务器，下一次工具调用自动换连接重试一次并成功；
- **`oauth` 在加载期被拒绝**（P1-3）：`oauth: {}` 与 `auth: "oauth"` 两个条目都不挂载并给出可操作原因，`oauth: false` 与 `headers` 条目照常挂载；
- **图片真的到模型**（P1-4）：真 stdio 服务器返回 image 内容，经真 `ToolRuntime` 断言结果里有 image 块而不是占位文本，且字节确实过了宿主 `saveImages`；模型路由不声明图片输入时降级为带原因的文本；
- **两个超时预算各自生效**（P1-5）：`requestTimeoutMs` 卡住一个永不应答的 `tools/list`，`executionTimeoutMs` 卡住一个永不应答的工具调用，互不干扰；
- **服务器 instructions 进系统提示**（P2-7）：`summary()` 输出 `<mcp_instructions>` 块并缩进；超过单台上限被截断、超过总会话预算的服务器按名字报告；
- **面板围栏拒绝四种外来请求**：DNS rebinding（外来 `Host`）、`Sec-Fetch-Site: cross-site`、外来 `Origin`、无 `Host`——都返回 403 且不触达 handler。
- **目录瘦身（ADR-0010）**：一个 600KB 的 `outputSchema` 不会被写进缓存（写入边界就投影成 `hasOutputSchema` 布尔）；构建目录时预计算小写搜索字段，手搓目录惰性派生；
- **一次冷启动只写一次盘（ADR-0010）**：两台冷服务器不再各写一次全文件；`persistCache` 读-合并-写保留其他会话的条目，被面板 purge 的名字不会被旧快照复活；默认无直连工具时 `mcp({search})` 不再做第二次全量排序。

面板部分（`test/panel.test.ts`、`test/client.test.ts`、`test/client-panel.test.tsx`）：

- 快照永远是投影 codec 能解析的纯 JSON；未初始化的会话是「不可用」而不是「空」；
- 被闸门拦住的服务器一定出现在面板里并带原因；`allow` 下同一份配置报「运行中」、`deny` 下报「未批准」（行状态跟着策略走）；`failed` 算展示但不计入运行中；
- 折叠只认 `mcp-adapter/status`，别的会话事件返回同一引用（零成本）；畸形标记保留上一个值，不会把面板刷白；
- 发布器只在值真的变化时 append —— 反复打开面板不涨日志；
- 批准失败会返回带原因的 refused，而不是穿过 Remote 面抛出去，也不会重建会话；
- 浏览器 bundle 用假 loader 真实加载一遍：声明的 id、导出的 `apply`/`inject`、`./client` 导出、两份字典键完全一致（缺键会在 UI 里显示成裸 key）。

真实 `dsh` 引导链路里也验过：冷缓存 → 服务器被拉起 + `tools/list`；热缓存 → **不拉起**。本机 headless 缺 `DEEPSEEK_API_KEY`，所以「模型真正调用 `mcp({tool})`」这一步没跑，其余都跑通了。图片路径同理：已验证「工具结果里有 ImageBlock 且字节过了宿主存储」，但**没有**验证一次真实的多模态请求往返（需要可用的视觉模型）。桌面端窗口不在验证范围，未验证。

