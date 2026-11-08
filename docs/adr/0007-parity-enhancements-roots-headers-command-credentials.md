# MCP Adapter 功能对齐增强：Roots、动态请求头、Glob过滤与宿主凭据问询对接

Context: `dsh-mcp-adapter` 已经具备稳定的 MCP 连接池、目录缓存、Web UI 管理面板以及基本的安全信任机制。然而，在对照上游/成熟实现 `pi-mcp-adapter`（v7.0）时，发现仍有若干对现实复杂 MCP 服务体验影响重大的关键功能细节缺失：

1. **MCP Roots 协议缺失**：文件系统服务器（如 `@modelcontextprotocol/server-filesystem`）或代码索引服务在初始化后会向客户端发起 `roots/list` 请求以确定边界。当前适配器未声明 `roots` capability 且未注册 `roots/list` 处理程序，导致服务器降级或报错。
2. **动态认证请求头缺失**：很多企业级或云厂商 HTTP MCP 服务（如 AWS、GCP、Vault 或内部网关）依赖动态短期 Token 或请求签名，静态 `headers` 或一次性 `bearerToken` 无法满足长时间会话需求。
3. **工具与关键词过滤不够灵活**：`includeTools` / `excludeTools` 目前仅针对工具原始名做过滤，若配置带前缀名称则失效；`searchKeywords` 仅支持全等匹配或单个 `*`，无法按模式（如 `git_*`）批量注入搜索权重。
4. **宿主核心服务对接滞后**：ADR-0002 确立将凭据托付给 `ctx.credentials`、将 Elicitation 托付给 `ctx.userQuestions`，但尚未形成实际接线与优雅降级回路。

Decision: 我们决定：

1. **实现 MCP Roots 根目录能力**：
   - 在 `ServerConfig` 中引入 `roots?: boolean`（缺省为 `true`）。
   - 在 `ClientOptions.capabilities` 中根据配置声明 `roots: {}`。
   - 在 `ServerPool.connect` 中注册 `"roots/list"` 请求处理器，默认将该 server 的有效工作区目录（`config.cwd` 或 DSH 会话目录）以 `[{ uri: pathToFileURL(cwd).href, name: basename(cwd) }]` 形式返回。
   - 若显式配置 `roots: false`，则不声明能力且不注册响应。

2. **支持 `requestHeadersCommand` 动态请求头**：
   - 在配置层支持 `requestHeadersCommand: { command: string, args?: string[], env?: Record<string, string>, timeoutMs?: number }`。
   - 针对 HTTP 传输，封装底层 `fetch`：在每次外发 MCP 请求前，将包含 `{ method, url, bodyBase64 }` 的 JSON 输入通过 stdin 喂入该命令，提取其 stdout 输出的 JSON 格式 header 键值对，与静态 `headers` 合并（动态 header 优先）。
   - 执行超时缺省 10 秒，失败时 fail-closed 抛错阻断请求，防止未授权裸调。

3. **增强工具与关键词匹配机制（双名与 Glob）**：
   - `includeTools` 与 `excludeTools` 同时比对 `tool.name`（原始名）以及拼接前缀后的完整工具名；支持 `*` 通配符 Glob 模式。
   - `searchKeywords` 键名支持通配符 Glob（如 `git_*`），匹配 originalName 或 prefixedName 即可赋予对应搜索词。

4. **宿主凭据（ctx.credentials）与问询（ctx.userQuestions）防御性集成**：
   - 依赖注入保持解耦：在 `SessionLike` / `ServerPool` 中检查 `ctx.get('credentials', false)` 与 `ctx.get('userQuestions', false)`。
   - 凭据读取优先：当存在 `ctx.credentials` 且记录了 `mcp-adapter/<server>` 时，动态取出 token 作为该服务的 Bearer Authorization；未注入时平滑使用配置文件中的静态配置。
   - Elicitation 降级桥接：在非委托子代理且宿主提供 `ctx.userQuestions` 时，注册 `elicitation/create` 处理程序，将表单字段映射为标准单选/多选/文本问答；宿主缺失或报错时遵循 MCP 协议安全取消或拒绝。

5. **明确排除非必须边缘特性**：
   - 维持 ADR-0002 约束，不强行实现无 SDK 支撑的 MCP Tasks，不自建独立的 iframe MCP AppBridge 沙箱，不引入 quickjs 脚本及 unix socket 传输。

Status: accepted

Consequences:
- `dsh-mcp-adapter` 对现代复杂 MCP 服务的兼容性达到与 `pi-mcp-adapter` 核心功能平齐的标准。
- 无论 DSH 宿主环境是否提供完整扩展服务，适配器均能保持完全独立且行为自洽的单元测试和运行时可用性。
