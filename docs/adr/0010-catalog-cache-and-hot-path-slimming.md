# 目录缓存瘦身与热路径去重

Status: accepted

Context: 这是一次**由实测证据驱动**、而非照搬 opencode 优化清单的性能与内存修复。先看数字：正在运行的
`~/.dsh/mcp-adapter/mcp-cache.json` 有 **4,027,351 字节**，其中 `rea` 一台 3.98 MB，
`inspect_analysis_view` 单个工具的 `outputSchema` 就 **608,551 字节**。本机测量：

```
v1 JSON.parse       23.10 ms/op      v1 JSON.stringify   27.22 ms/op
v2 JSON.parse        0.87 ms/op      v2 JSON.stringify    1.31 ms/op
v1 4,027,351 字节 -> v2 386,383 字节 (9.6%)
```

这份全文**从未被读取内容**：全 `src/` 只有 `ensureOutputSchemaValidation()`
（`src/servers.ts` 旧第 628 行）判过一次 `=== undefined`，`describeTool()` 展示给模型的只有
`inputSchema`。SDK 的 `structuredContent` 校验走的是连接上重新 `listTools` 的自身缓存，与我们持久化
的副本无关。于是每次 `sync()` 全量 parse、每次 `buildCatalog` 复制进堆、每次冷启动全量 stringify，
都在为一个从不消费的对象付费。

同批静态核查还发现四处已测热路径浪费：

1. `searchTools()` 每次调用对每个工具重算 `description.toLowerCase()` /
   `keywords.map(toLowerCase)` / `name.replace(/[-_]/g,'')`；
2. `refreshCatalog()` 在 `Promise.all` 的**每个分支**里调一次 `persistCache()`，N 台冷服务器 =
   N 次全量 stringify + 写盘 + rename；
3. 每次 `mcp({search})` 把全量目录打分排序**两次**——`proxy.ts` 出结果页，
   `activateMatches()` 又用 `limit:50` 独立扫一次。默认 `directTools: false` 时后者必然是空转；
4. `McpSession.cache` 是 `sync()` 时的整份磁盘快照；`purgeCacheEntry()` 只改磁盘、不动活动会话，
   任一会话后续 `persistCache()` 会把自己的旧快照整体写回，抹掉别的会话刚存的条目、也可能复活
   已被 purge 的条目 → 表现为"改了配置后反复冷启动 spawn"。

另外，`dispose()` / `closeAll()` 只停连接，不清 `servers` Map、`catalog`、解析后的 4MB `cache`、
`errors`（失败时无限 push）、`blocked`、`activated`、`execContext`（含最后一次工具调用的 signal）。

Decision:

1. **`ServerTool` / `CatalogTool` 不再持有 `outputSchema` 全文，只留 `hasOutputSchema: boolean`。**
   `fetchCatalog()` 写布尔，`buildCatalog()` 复制布尔，`ensureOutputSchemaValidation()` 判
   `=== false`。`description` 与 `inputSchema` 全保留（搜索打分和 `describeTool` 真的要读）。
   `storeEntry()` 在写入边界做显式投影，连一个手工编辑/旧版内存目录里残留的 `outputSchema` 也只用来
   推导布尔、绝不序列化回去。
2. **`CACHE_VERSION` 1 → 2。** 旧文件按现有 `isCatalogCache()` 版本检查自然冷启动一次，不写迁移
   代码（那等于把错误的缓存形状固化）。
3. **搜索字段在 `buildCatalog()` 预计算**（`CatalogTool.search`：小写名、原名、server、描述、
   归一化名、关键词、参数摘要），`searchTools()` 直接读；手搓的 `CatalogTool` 缺该字段时惰性派生一次。
   打分权重、排序、分页、regex 行为一律不动。
4. **`refreshCatalog()` 合并为循环结束后一次写盘。** `persistCache(names)` 改为 read-merge-write：
   重读磁盘、只覆盖本会话确实刷新过的名字，保留其他会话的条目；`onEvictServer` 顺带调用
   `session.forgetCachedServer(name)` 从内存快照删名，防止下一次写入复活被 purge 的条目。
   瘦身让额外一次 `loadCache()` 从约 23ms 降到约 1ms，这个合并才变得便宜。
5. **`proxy.ts` 在 `hasDirectTools() === false` 时短路 `activateMatches()`。** 默认
   `directTools: false` 下删掉必然空转的第二次全量扫描；`'search'` / `true` 模式保留激活手势
   （`activateMatches` 与 `searchTools` 一行不改，见 Consequences）。
6. **纯内存 hygiene**：`ServerPool.dispose()` 在 `closeAll()` 之后清 `servers` Map 与每个 entry 的
   catalog / stderr / connecting / lastError；`McpSession.dispose()` 清空 `catalog`、`cache`、
   `cachePathResolver`、`blocked`、`errors`、`activated`、`execContext`、`onStatus`、`workspaces`。
   `closeAll()` 本身语义不变——既有测试断言停服后 `status()[0].state === 'idle'`。

Considered Options:

- **照搬 opencode 八项优化清单**：被否决。Code Mode / 2000 字符内联预算在本包**没有对应问题**
  （天生一个 `mcp` 代理 + search/describe，`directTools:false` 默认）；自研 stdio 16 MiB/64 槽、
  Location 60 分钟 TTL、MCP SDK 延迟加载、100ms list-changed 防抖要么属于架构重排，要么已有等价物
  （本包默认 10 分钟 idle + 30s sweep 已在回收进程）。按 opencode 清单逐条搬会把 optimization 建在
  不存在的问题上。
- **按 `projectRoot` 共享 `ServerPool`（ADR-0009 选项 D）**、自研 stdio 替换 SDK、插件级
  SIGTERM/exit teardown 与进程组 kill、把单文件 `mcp-cache.json` 拆成按服务器分文件、
  面板 `probeServer` 的一次性真实连接池、`configChanged()` 的 paths-only 重构：
  全部沿用 ADR-0009 的边界，本轮不做，记入下方残余。这些改的是**常驻 MCP 子进程 RSS**（由进程数
  决定），与本轮改的**宿主 Node 堆 / 磁盘 I/O / 冷启动延迟**是两个不同的量。
- **保留 `outputSchema` 全文，只在写盘时省略**：被否决。堆里的 `PoolEntry.catalog` 与
  `CatalogTool` 仍会持有 608KB 对象，内存收益拿不到；且 `ServerCatalog` 同时是活目录与落盘目录，
  两个形状会漂移。
- **给 `searchTools` 加按输入的 memo 表**：被否决。目录本身按 `catalogStale` 重建，缓存键要带
  query/limit/offset/regex/server，失效复杂且收益低于一次性预计算。
- **`activateMatches()` 复用 `proxy.ts` 已算好的结果页**：被否决，这是一处会改行为的错误。
  `proxy.ts` 的注释明确写着 "It runs regardless of paging, so a match on page two still becomes
  callable"——结果页带用户的 `limit`/`offset`/`regex`/`server`，可能是第 2 页或 `limit:1`；复用会让
  `directTools:'search'` 下本该激活的工具保持隐藏。改为"无直连工具时整段跳过"，零行为变化。
- **计时断言作为回归门槛**：被否决，CI 会 flake。改用确定性断言。

Consequences:

- **一次性全量冷启动**：v1 文件版本不匹配，重启后每台服务器重新 `tools/list` 一次，然后写入 v2 的
  瘦目录。`ask` 模式下的审批记录不受影响（哈希材料没变）。
- **失去"以后本地渲染/校验 `outputSchema`"的可能**。若将来真要展示输出 schema，得重新引入全文并
  处理它带来的体积问题；当前 SDK 校验不依赖它。
- **`directTools:'search'` / `true` 仍保留双扫**。默认 `false` 已短路；要消掉剩下的，需要让
  `searchTools` 暴露 scored 列表，会牵动 `regex`/`server`/`offset` 组合语义，收益不抵风险。
- **O(servers × tools) 索引未建**：`statusText()`、`syncDirectTools()`、`describeServer()` 仍对每台
  server 全扫 `catalog.tools.values()`；真实规模（当前 4 台服务器、约 275 个工具）下不是瓶颈。
- **`GET /servers` 在 `ask` 下对每台重算 `definitionHash`、`configChanged()` 每步重读配置文件**：
  未改，两者的成本主要来自配置发现本身。
- **进程 kill 语义未动**：SDK `StdioClientTransport` 的 SIGTERM→2s→SIGKILL、"不 kill 进程组"、
  宿主直接退出时不派发 `agent/disposed` 的孤儿风险，全部是 ADR-0003 已记录的既有边界，未在真机复现，
  属于另一类风险。
- **残留未改（沿用 ADR-0009 清单）**：`directTools:'search'` 无法真正隐藏工具；面板"测试连接"每次起
  一次性真实进程；`createMcpRouter` koa 分支无围栏；`--trusted-host` 非 loopback 部署 fail-closed；
  `roots/list` 仍是连接时快照。
- **回归证明**（确定性，无计时门槛）：`test/catalog.test.ts` 断言 600KB schema 不落盘、预计算字段
  存在且搜索不改它、手搓 CatalogTool 惰性派生；`test/e2e.test.ts` 断言两台冷服务器只写盘一次、
  read-merge-write 保留第三方条目、被 purge 的名字不复活；`test/proxy.test.ts` 断言无直连工具时不
  触发激活、有或省略时保持激活。`pnpm typecheck && pnpm build && pnpm test` → 29 文件 / 462 自检全绿。
