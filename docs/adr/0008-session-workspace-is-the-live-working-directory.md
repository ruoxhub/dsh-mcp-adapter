# 会话工作区以宿主当前目录为准，不猜进程目录

Context: 本插件把"会话工作区"当成 `agent.session.header.cwd`，取不到时退回宿主进程的
`process.cwd()`。两处都错：

- DSH 的 `SessionHeader.cwd` 是**会话创建时**的目录（`packages/core/session/src/types.ts` 明确写着
  "Absolute working directory the session was created in"，字段只读）。会话的**当前**目录由
  `ctx.workingDirectory` 拥有：`working_directory` 工具能改、子代理按它派生子会话、DSH 自己的文件工具
  与聊天界面的相对路径解析全都走它（`packages/fs/tool-fs/src/session-cwd.ts`、
  `packages/client/ui-chat/src/client/file-path.ts`）。
- `process.cwd()` 是**宿主进程的启动目录**，不是任何会话的工作区。实测：在 `/home` 启动的
  `dsh web` 上请求面板且不带 `cwd`，`workspaceRoot` 返回 `/home`——一个用户在 UI 里从未选过的目录。

后果是可复现的：会话 `cd` 进另一个仓库后，新目录的 `.mcp.json` 永远不会被加载、旧目录的服务器继续
挂载、懒启动的 stdio 服务器仍在旧 project root 下 spawn、`roots/list` 也告诉 MCP 服务器旧边界；
`configChanged()` 用同一条旧路径重算签名，签名永远不变，于是 `agent/pre-step` 的重新武装也永远不触发，
`/mcp-adapter reload` 同样修不回来。面板侧则更直接：`save`/`approve`/`delete` 接受客户端传来的
`cwd`，缺省时回落到宿主启动目录，等于把 `.mcp.json` 写进一个没人选的仓库。

Decision: 我们决定：

1. **一个取值函数，`McpSession.cwd()`**。先问 `ctx.get('workingDirectory', false)?.get(session)`，只有它
   答不出时才退到 `header.cwd`；**两者都没有就返回 `undefined`，绝不退到 `process.cwd()`**。
   `sync()`、`approve()`、`configChanged()` 三处共用它。
2. **没有目录 = 没有项目**。`loadConfig()` 在 `options.cwd === undefined` 时只读用户全局的两个文件
   （`$DSH_HOME/mcp-adapter/mcp.json`、`mcp-adapter.json`），不生成项目来源；相对的 `configFiles`
   项因为无基准目录而跳过，绝对路径仍可用。`projectRoot` 返回 `''`。
3. **目录变化本身就是一次配置变化**。`McpSession` 记录 `syncedCwd`；`configChanged()` 先比目录，再比
   文件签名。于是 `cd` 之后的下一个 step 就走既有的 debounce 重新武装路径，不需要新机制。
4. **面板与会话共用同一个项目根解析器**。`config.ts` 的 `resolveProjectRoot(cwd, workspaces)`：落在
   某个注册工作区内的目录解析成**那个注册路径**（深的优先），而不是 `.git` 祖先——注册表才是 DSH
   眼中的项目，仓库里的子目录在 DSH 里可以是独立工作区。面板（`McpServersService.resolveTarget`）与
   运行时会话（`McpSession` 每次 `loadConfig` 都带 `workspaces`）都调它，所以"面板存下的服务器"
   与"会话读到的服务器"不可能指向两个文件。没有注册表（headless）或目录不属于任何注册工作区时，
   保持原来的 `findProjectRoot()` 语义（DSH 也允许会话从裸 `cwd` 创建）。
5. **workspace 作用域的写操作必须带目录**。`save`/`approve`/`delete`/`toggle`/`installPreset`/
   `migrateScope` 在需要落到项目文件却没有可解析目录时，返回 `statusCode: 400` 而不是写入进程目录；
   `listServers()` 在没有目录时只列 user 作用域，`workspaceRoot` 返回 `''`。
6. **客户端面板读 `workingDirectory` 投影**。会话列表行的 `projectionValues.workingDirectory` 优先于
   行上的 `cwd`（后者就是 header.cwd），这样聊天界面和 MCP 面板指向同一个目录。
7. **`roots/list` 不再报宿主进程目录**。服务器定义没有解析到目录时，`roots/list` 返回空列表，而不是
   `process.cwd()`——那只是 `dsh` 恰好从哪里启动。

Status: accepted

Considered Options:

- 选项 A：只把 `header.cwd` 换成 `workingDirectory`，但保留 `process.cwd()` 兜底。缺点：兜底本身是错的
  一半——它把一个随机目录当成会话工作区，比"没有工作区"更难排查。排除。
- 选项 B（采纳）：宿主答什么就用什么，答不出就退到"只有用户全局配置"，并在写操作上显式拒绝。
- 选项 C：面板 `cwd` 严格限定在注册工作区内，越界即 400。缺点是 DSH 允许会话从裸 `cwd` 创建，会把
  合法会话挡在面板外；改为"注册优先、其余按项目根处理"。

Consequences:

- 一台服务器在 A 工作区被编辑，不会再让 B 工作区里同名服务器的活连接失效（evict 仍按名广播，这一版
  没有改），但两个工作区不再共享同一个 `projectRoot`，审批记录与 `.mcp.json` 落在各自工作区。
- `roots/list` 仍在连接时快照一次，目录变了要等连接重建才更新——这是本次有意留下的边界。
- 同一个仓库下的两个注册工作区各自拥有 `.mcp.json` 与审批记录。这是"注册路径即项目"的直接后果：
  以前它们共享 `.git` 祖先那一份，现在不会。
- 面板在 headless/无注册表组合下退化为"用户全局 + 项目根"，行为与 ADR-0006 一致。
- 新增测试钉住三条：`cd` 后加载新目录配置且 `configChanged()` 为真；两者都没有时不读 `process.cwd()`
  且只加载全局配置；workspace 写入缺目录时 400 且不落盘。
