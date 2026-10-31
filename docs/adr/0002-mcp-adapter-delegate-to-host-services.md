# MCP Adapter：凭据、提问、后台任务与落盘交给宿主服务

Context: 在 `packages/dsh-mcp-adapter` 的增强批次开工前，对运行中的 DeepSeek Harness 0.2.1-rc.5
做了一次能力盘点（`app.asar` 内的 `@deepseek-ai/*` 组合与源码）。结论是：ADR-0001 里三条
"自己做"的决策中，有两条的前提已经不成立——宿主已经提供了对应服务，只是当时不知道。

证据（均来自 rc.5 的 base 组合 `dsh-base/cordis.patch.yml` 与包源码）：

- `ctx.userQuestions`（`dsh-user-questions`，base 第 79 行）：`ask(request: { questions, agent, signal })`
  接受结构化问题数组，每项含 `question`/`header`/`detail`/`options[{label, description}]`/`multiSelect`，
  回 `{ answers: [{ id, selected[], custom? }] }`；另有 `askTimed(...)` 提供前台倒计时。
- `ctx.credentials`（`dsh-credentials-local`，base 第 126 行）：两套键空间，`credentialRef('NAME')`
  管密钥引用、`credentialKey('<owner>/<id>')` 管插件自有持久记录；`modifyRecord(key, mutator)`
  是唯一写路径且跨进程排他。
- `ctx.jobs`（`dsh-jobs-local` + `dsh-tool-jobs`，base 第 96 / 290 行）：作业按发起会话独占，
  结算时**主动推一条 in-session notice**，消费方无需轮询。
- `ctx.spillStore`（`dsh-spill-local` + `dsh-spill-policy`，base 第 411 / 414 行，`maxInlineTokens: 12500`）：
  超限的工具结果由宿主换成 `saveText()` 返回的 locator。

Decision: 我们决定：

1. **凭据交给 `ctx.credentials`**，插件不再自建加密文件存储。OAuth 令牌与 bearer 令牌写入
   `credentialKey('mcp-adapter/<server>')` 记录，URL 变更时按记录内的 URL 判失效。
   放弃 "纯 JS AES-256-GCM 文件"方案（ADR-0001 第 2 条的前提已消失，且自制加密不如用宿主
   已做的存储）。插件**不**新增 keytar 等原生依赖，这条原始约束继续守。
2. **MCP elicitation 交给 `ctx.userQuestions`**，不自造对话框。它是 `mcp` 代理的一次调用内的
   前台等待，映射关系：`ElicitRequestFormParams` 的字段 → `AskUserQuestionItem[]`（enum/boolean
   变成 `options`，其余落到 `custom` 文本），`ElicitResult` 的 `accept`/`decline`/`cancel`
   ← 用户的选项提交 / 显式拒绝 / abort。
   **已知边界，写进文档而不是绕过**：子代理上下文会被宿主以 `DELEGATED_CALLER` 拒绝；
   无浏览器附加的 headless 组合会以 `NO_PROVIDER` 拒绝；词汇表只有"选项 + 自定义文本"，
   没有文件选择器或 diff 预览。这三种情况插件表现为"不支持 elicitation"，而不是假装成功。
3. **后台长任务不引入第二套调度**（ADR-0001 第 3 条结论保留，理由更新）：真实理由是
   **`@modelcontextprotocol/client@2.2.0` 没有任何 task 运行时**——全部 task 类型都标注
   `@deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability
   only`，`Client` 上没有 `getTask`/`cancelTask`/`listTasks` 方法，`RequestMethod` 显式排除
   `tasks/*`。因此"用 `ctx.jobs` 承载 MCP Tasks"在本 SDK 版本下无从实现，不是因为平台不允许。
4. **落盘交给 `ctx.spillStore`**，插件不再自己 `writeFileSync` 到 `<home>/spill/`。适配器保留自己的
   阈值判断（代理结果是先由我们拼好的字符串），超过阈值时调 `saveText()` 换取 locator，
   不自己决定路径、清理或保留策略。
5. **`appendPluginRecord` 不用**。DSH 仓库用 `verify-plugin-record-callers` 把这个写入函数
   限定在 `packages/experimental/`；本包现有做法（经 Session 的公开 `publicationEntry`/`commit`
   写一条 `ignorable` 记录）保持不动。

Status: accepted

Considered Options:

- 选项 A：照 ADR-0001 全部自己实现（AES 凭据文件、自建 elicitation 对话框、自建任务轮询）。
  缺点是重复实现宿主已经提供的能力、多两套需要各自维护的持久化格式，并且放弃宿主已做的
  跨进程排他。
- 选项 B（采纳）：能用宿主服务的一律委托，宿主没有明确拒绝的（子代理 elicitation、headless
  elicitation、rich elicitation UI、MCP Tasks）如实记为不支持，写进 README 的差异表。
- 选项 C：全部委托但不记边界，让调用方在运行时才发现限制。排除：这正是当前 README
  "面板能写 `transport: 'sse'` 而归一化器不认"这类谎言的来源。

Consequences:

- 包对 DSH 的依赖面扩大：`ctx.credentials` / `ctx.userQuestions` / `ctx.spillStore` 成为可选注入，
  每个都要按 `ctx.get(name, false)` 读取并在缺失时降级，不能阻断插件挂载。
- `dsh-user-questions` 目前**不是**本包的依赖（宿主组合里有，npm 上只有 rc.4）；接入前必须先把它
  加进 `devDependencies` 并确认类型面。
- 收窄的语义必须写进 README 与 ADR，而不是留在代码注释里。
