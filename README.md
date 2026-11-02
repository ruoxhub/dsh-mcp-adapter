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
| 会话页头面板 | 一个 MCP 按钮：各服务器状态与工具数、配置问题、被拦服务器的原因；面板内可批准 |

## 代码结构

宿主侧（Node half，18 个模块）：

```
src/index.ts             插件入口：按 agent 建会话、注册 mcp 工具与命令、空闲清扫、配置热更新
src/config.ts            配置发现、优先级合并、entry 归一化
src/trust.ts             项目批准记录（哈希钉死定义）
src/cache.ts             工具目录缓存
src/servers.ts           MCP 连接池：懒连接、空闲停止、keep-alive 重连
src/catalog.ts           命名、include/exclude、搜索排序、describe
src/proxy.ts             mcp 工具（status/search/describe/instructions/connect/call）
src/direct.ts            直连工具注册 + 搜索激活
src/session.ts           单个 agent 的运行时
src/approval.ts          危险工具审批（映射到 dsh 的 ctx.approval）
src/prompts.ts           MCP prompts → slash command，参数解析与结果摊平
src/imports.ts           收养 Cursor/Claude Code/VS Code/Codex 的全局 MCP 文件
src/testserver.ts        迁移期新增的两个用例驱动的扩展 stdio MCP 服务器（工具/资源/prompt/危险工具）
src/util.ts              超时、abort 组合、结果投影、输出截断
src/status.ts            Web 面板的快照（纯函数，可直接测）
src/projection.ts        Web 面板读的 mcpAdapter 投影 + 发布器
src/approve.ts           Web 面板「批准」按钮驱动的 mcp_approve 工具
src/types.ts             跨模块接口（纯声明，不 import 任何模块）
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

服务器级字段：`command`/`args`/`env`/`cwd`/`inheritEnv`、`url`/`headers`、`httpTransport`（`sse` = 旧式 SSE，默认 Streamable HTTP）、`caFile`、`protocolVersion`（`legacy`（默认）/`auto`/具体版本号）、`lifecycle`（`lazy`/`keep-alive`/`lazy-keep-alive`/`eager`）、`idleTimeout`、`requestTimeoutMs`、`directTools`、`includeTools`/`excludeTools`、`searchKeywords`、`toolPrefix`、`description`、`appendStructuredContent`、`autoApprove`、`approveTools`、`debug`。

四个 `lifecycle` 的实际差别（以前的 `eager` 与 `lazy-keep-alive` 是空实现，现已接线）：

| lifecycle | 会话开始时 | 空闲后 | 掉线后 |
|---|---|---|---|
| `lazy`（默认） | 不启动 | 停止 | 等下次调用 |
| `lazy-keep-alive` | 不启动 | **不停止** | 自动重连 |
| `keep-alive` | 启动 | 不停止 | 自动重连 |
| `eager` | 启动 | 不停止（除非该服务器自己写了 `idleTimeout`） | 等下次调用 |

**只读时接受的别名**：`timeoutMs` → `requestTimeoutMs`，`transport: "sse"` → `httpTransport: "sse"`。写入永远用规范名——面板已经改成写规范名，因为旧拼写写出的是一批没人消费的键。

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

## 验证

`pnpm test` — 20 个测试文件、372 个自检（vitest），其中端到端那组**真的启动一个 stdio MCP 服务器子进程**：

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
- **`caFile` 真的改变信任**：自签证书下全局 `fetch` 拒绝、`fetchWithCa` 接受（真实 TLS 握手，非 mock）。

面板部分（`test/panel.test.ts`、`test/client.test.ts`、`test/client-panel.test.tsx`）：

- 快照永远是投影 codec 能解析的纯 JSON；未初始化的会话是「不可用」而不是「空」；
- 被闸门拦住的服务器一定出现在面板里并带原因；`allow` 下同一份配置报「运行中」、`deny` 下报「未批准」（行状态跟着策略走）；`failed` 算展示但不计入运行中；
- 折叠只认 `mcp-adapter/status`，别的会话事件返回同一引用（零成本）；畸形标记保留上一个值，不会把面板刷白；
- 发布器只在值真的变化时 append —— 反复打开面板不涨日志；
- 批准失败会返回带原因的 refused，而不是穿过 Remote 面抛出去，也不会重建会话；
- 浏览器 bundle 用假 loader 真实加载一遍：声明的 id、导出的 `apply`/`inject`、`./client` 导出、两份字典键完全一致（缺键会在 UI 里显示成裸 key）。

真实 `dsh` 引导链路里也验过：冷缓存 → 服务器被拉起 + `tools/list`；热缓存 → **不拉起**。本机 headless 缺 `DEEPSEEK_API_KEY`，所以「模型真正调用 `mcp({tool})`」这一步没跑，其余都跑通了。

## 与 pi-mcp-adapter 的差异（没做的部分）

重写只覆盖行为，不覆盖 Pi 运行时独有的东西。每一行的"未做"都附了原因；宿主侧有能力但本包没接的，标了 `[宿主已有]`：

| pi-mcp-adapter | 这里 |
|---|---|
| OAuth 登录、keychain 存 token | 未做。`bearerToken` / `bearerTokenEnv` / `headers` 可用；未来令牌应存 `ctx.credentials`（[宿主已有]，见 ADR-0002） |
| elicitation | 未做。[宿主已有] `ctx.userQuestions`，但仅根 agent 可用：子代理会收到 `DELEGATED_CALLER`、无浏览器会话收到 `NO_PROVIDER`，且词汇表只有"选项 + 自定义文本" |
| sampling | 未做。协议侧已废弃（SEP-2577），不建在移除路径上 |
| MCP Tasks | 未做。**SDK 无运行时**：`@modelcontextprotocol/client@2.2.0` 的全部 task 类型标注 `@deprecated 2025-11-25 wire vocabulary with no SDK runtime`，`Client` 上没有 `getTask`/`cancelTask`/`listTasks` |
| MCP UI app | 未做 |
| `mcpScript`（quickjs 沙箱脚本） | 未做 |
| namespace proxy `mcp__<server>` | 未做（`directTools` 覆盖了这个需求） |
| unix socket 传输（`socket` 字段） | **不支持**，且在 `loadConfig` 阶段就拒绝并给出原因，不会等到第一次调用才抛错 |
| `projectServers` 默认 `ask`（项目服务器需批准） | 默认 `allow`，项目服务器直接挂载；`ask` / `deny` 保留为显式选项（见 [ADR-0006](docs/adr/0006-project-server-trust-default-allow.md)） |
| 从 Cursor/Claude/Codex 导入配置 | **已做**（`importHosts`） |
| 语义搜索（System One） | 未做，只有词法排序。宿主无 embedding/classifier 服务 |
| `outputSchema` 校验 | **已做**，由 SDK 完成；热缓存路径会补一次 `tools/list`，否则首调用不校验 |
| `caFile` 自定义 CA | **已做**，走 Node `https.request` + `ca` 的自定义 `fetch`，不新增依赖 |
| `protocolVersion` 协商 | **已做**，接到 `ClientOptions.versionNegotiation` |

**刻意保留的差异**：`timeoutMs` 与 `transport: "sse"` 只在读取时被接受（*transport alias* —— 非规范拼写，读时兼容、写时永远用规范名），面板写出的永远是 `requestTimeoutMs` / `httpTransport`。

架构决策记在 [docs/adr/](docs/adr/)：0001 是初版权衡（凭据自建、任务不做、静态 preset），0002 记录了宿主能力盘点后把凭据、提问与落盘委托出去，并说明 MCP Tasks 不做是因为 SDK 没有运行时；0003 是变更与驱逐；0004 是对齐 PI-Desktop 的管理架构；0005 是跨作用域迁移与两步武装；0006 是项目信任闸门默认改为 `allow`。
