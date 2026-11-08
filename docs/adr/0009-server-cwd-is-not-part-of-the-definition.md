# 服务器的目录属于会话，不属于定义

Context: `normalizeEntry` 曾经把所有条目（**包括用户全局**）的 `cwd` 写成
`显式 cwd（且必须是绝对路径） ?? projectRoot`（`src/config.ts` 旧第 328 行），而 `definitionHash`
把 `config.cwd` 算进了 stdio 的身份材料（`src/trust.ts:74`）。于是一个在
`$DSH_HOME/mcp-adapter/mcp.json` 里声明一次的 `codegraph`，在每个工作区里都有**不同的定义身份**。

这带来两个可复现的后果，都不是"多一点内存"这种量级：

1. **缓存互相顶掉。** `mcp-cache.json` 是按服务器名索引的单文件（`src/cache.ts:92`
   `cache.servers[name]`），而条目里存着 `configHash`。A 工作区写入 `codegraph` 的目录后，B 工作区
   的条目被覆盖；切回来时 `cachedEntry` 比对 `configHash` 不通过，返回 `undefined`，于是**又一次冷启动
   spawn**。实测：

   ```
   workspace A cached, hit in A? true
   after workspace B stored, hit in A? false   ← A 的条目被 B 顶掉
   ```

2. **全局服务器的哈希随工作区漂移。** 同一份全局文件，在两个目录下归一化出的 `configHash` 不同：

   ```
   codegraph   b25e4ec867c1  vs  8863747cfef2   DIFF
   tavily / deepwiki / context7                 SAME（HTTP 无 cwd 字段）
   ```

   只有 stdio 条目受影响，因为只有 stdio 有 `cwd`——正是本插件最常用的那类（本地 CLI 服务器）。

还有一个被静默吞掉的 bug：相对 `cwd`（`"./servers"`）因为 `isAbsolute` 检查而**被丢弃**，然后用项目根
顶上。作者以为在 `./servers` 里跑，实际在仓库根跑。

同时期读过的两个项目把这条边界分得很清楚：pi-mcp-adapter 用 `definition.cwd ?? defaultCwd`
（`server-manager.ts:1215`），opencode 用 `config.cwd ? path.resolve(directory, config.cwd) : directory`
（`mcp/client.ts:305`）——**定义只记录作者写了什么，目录由会话在连接时提供**。本插件是三家唯一的例外。

Decision: 我们决定：

1. **`ServerConfig.cwd` 变为可选**，只承载配置文件里**真的写了**的值，原样保留（相对路径仍相对）。
   `normalizeEntry` 不再接受 `projectRoot` 参数——它没有任何别的用途，留着迟早会被再次误用。
2. **目录只有一个来源：`ServerPool` 的 `cwd` 回调**。它是函数而不是字符串，因为池子的寿命跨越 step：
   `working_directory` 可能在"池子建好"与"懒服务器第一次连接"之间移动会话，快照会让那次连接仍然
   落在已经离开的目录里。
3. **`resolveServerCwd(config, sessionCwd)`** 是唯一的解析点：显式值 → `resolve(sessionCwd, cwd)`；
   没有显式值 → `sessionCwd`；`sessionCwd` 也没有 → `undefined`。
4. **`roots/list` 与 spawn 用同一个目录**。MCP 的 roots 语义是"我能访问的文件在哪"，与子进程所在目录
   不一致会让工具解析相对路径和进程本身打架。
5. **`cwd` 仍进 `definitionHash`**——但只覆盖"作者写了什么"。写了 `cwd: "./servers"` 的条目与没写的
   条目身份不同（这是对的：它确实改变了跑起来的进程），而**同一个条目**在任意工作区身份相同。
6. **`onEvictServer(name, projectRoot?)` 按作用域分档**：用户全局写操作传 `undefined`，广播给所有池
   （那份定义本来就跨工作区共享）；工作区写操作传该工作区根，只驱逐项目根相同的池。`index.ts` 侧按
   `session.projectRoot` 过滤。
7. **面板 REST 加上浏览器信任围栏**（`src/request-trust.ts`）：`Host` 必须是 loopback 或监听器自己的
   bind 字面量，`Sec-Fetch-Site: cross-site` 拒绝，存在的 `Origin` 必须与 `Host` 同 authority。

Status: accepted

Considered Options:

- 选项 A：只把 `projectRoot` 从哈希里去掉，`config.cwd` 仍由归一化填入。缺点：`cwd` 既是"跑了什么"
  又是"在哪跑"，同一个字段两个真相；任何新代码读 `config.cwd` 都会拿到项目根而不是会话目录。
- 选项 B（采纳）：字段可选 + 运行时解析，用类型表达"未设置"，让混淆在编译期就不可能。
- 选项 C：保留 `cwd: string` 另加 `cwdFromFile: boolean`，哈希只在后者为真时纳入。改动最小（几乎不动
  测试），但把不变量交给调用方记得同步。
- 选项 D：**按 `projectRoot` 共享 `ServerPool`**（opencode 的 Location 模型：`LayerMap<Location.Ref,
  Services>`，`packages/core/src/location-services.ts:20`）。这是唯一能让"同工作区多会话共用一份连接"
  成立的方案，也是 opencode 里子代理不会额外起进程的原因（子会话继承父会话的 location，
  `session.ts:294`）。**本次不做**：它要同时解耦 `roots/list`、`onEvictServer`、每会话 settings 与
  `sweepIdle` 四处，改动量比本 ADR 大一个数量级，而当前实测损失（重复冷启动、缓存互相顶掉）已经被
  选项 B 消除。如果将来进程数真的成为问题，这是既有设计里最值得抄的一条。

Consequences:

- **`ask` 模式下既有的项目服务器审批记录会失效一次**：哈希材料变了，每个服务器需要重新批准一次。
  默认 `projectServers: allow` 下不受影响。没有写迁移代码——那等于把错误的哈希逻辑固化进代码里。
- `mcp-cache.json` 里所有条目会一次性冷启动。之后全局 stdio 服务器在任意工作区命中同一份。
- 相对 `cwd` 从"被静默丢弃"变为"按会话目录解析"。这是一个行为变化：以前写 `"./servers"` 的条目实际在
  项目根运行，现在真的在 `./servers` 运行。若该目录不存在，子进程会以 spawn 失败告终——这比静默在错误
  目录里跑要好，但确实是从"能跑"变成"报错"。
- 会话既无 `workingDirectory` 也无 `header.cwd` 时，stdio 子进程继承**宿主进程的启动目录**。这是唯一
  允许继承的地方：这类会话本来就只读用户全局配置，其中声明的服务器通常与目录无关（`codegraph`、
  `github`），拒绝启动会让 headless 下全局服务器全部不可用。配置发现与审批仍然拒绝猜目录。
- `roots/list` 仍是连接时快照（本次未加 `list_changed`）：`cd` 之后要等连接重建才更新。
- 面板围栏是**有意的 fail-closed**：`--trusted-host` 配了非 loopback 域名的部署（反向代理、局域网），
  插件读不到那份名单（DSH 没有把 `trustedHosts` 或 `isTrustedApiRequest` 放进发布面，且插件不依赖
  `@deepseek-ai/dsh-client-connection`），面板会被自己的围栏 403。升级路径是等 DSH 导出可复用的判定，
  届时 `request-trust.ts` 应缩成一个 wrapper。
- 残留未改：`directTools: 'search'` 仍无法真正隐藏工具（`tools.restrict` 只认全局名）；面板"测试连接"
  仍每次 `new ServerPool` 起一个用完即弃的真实进程；`createMcpRouter` 那条 koa 风格的分支
  （`ctx.router`）没有加围栏——DSH 本身不提供 `router` 服务，该分支在 DSH 里不可达，但若将来有组合
  挂上它，需要补同一道围栏。
- 新增测试钉住四条：同一 `ServerPool` 在两个会话目录下连接同一份定义时，**缓存条目仍命中**且子进程
  的 `cwd` 分别落在两个目录；相对 `cwd` 落到会话目录之下；无 `cwd` 的定义在任意目录哈希相同；面板
  路由对 cross-site、外来 `Origin`、无 `Host`、DNS rebinding 四种请求返回 403 且不触达 handler。
