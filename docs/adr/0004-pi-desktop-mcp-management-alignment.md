# 对齐 PI-Desktop 的 MCP 管理架构与交互规范 (PI-Desktop MCP Alignment)

Context: 参考 `PI-Desktop` 完善 `dsh-mcp-adapter` 的 MCP 服务器管理能力。PI-Desktop 具备分段看板（全部/全局/项目）、行内启停开关、外部工具配置扫描导入（Claude/Cursor 等）以及内置精选离线市场（BUILTIN_MCP_CATALOG）。但在存储实现上，PI-Desktop 采用了碎片化的 `.agents/servers/<id>.json` 单文件及独立的 capabilities 覆盖层，与 DSH 现存的标准集中式 `.mcp.json` 规范存在差异。

Decision: 我们决定：

1. **信息架构与状态机对齐**：控制器的视图状态为 `list | editor | market`。列表与市场是整页视图，二者互斥；新增/编辑则是浮在列表之上的居中弹层 sheet（含标题、副标题、关闭按钮、底部「先保存，再测试连接。」），列表在弹层背后保持可见。列表页提供「全部 / 全局 / 项目」分段切换，主列表按「全局级」与「项目级」实际物理路径双分组平铺展示。
   - 弹层与整页的界限：市场是「去另一个地方浏览」，弹层是「就这一台服务器改两个字」。前者替换页面，后者不该把用户已经看过一半的列表清空再重建，也不该在顶部多一条需要读一遍才敢点的面包屑。
   - 复用同一份 `.mcp.json` 契约（见第 2、5 条），表单内容与存储语义与视图形态无关，因此从整页改为弹层不影响已保存的数据。
2. **就地原子启停（In-place Atomic Toggle）**：卡片右侧集成行内 Toggle 开关。启停状态直接原子写入目标作用域 `mcp.json` 对应条目的 `disabled` 属性并支持前端乐观回滚，同时与运行时进程池建立即时联动（禁用时驱逐常驻子进程，启用时清除缓存）；放弃 PI-Desktop 的外部覆盖文件设计，遵循最小代码与集中化规范。
3. **外部工具扫描工作台（External MCP Import Workbench）**：移植 PI-Desktop 的跨平台第三方扫描机制（支持 Claude Desktop、Claude Code、Cursor 全局/项目、Codex、VS Code、ChatGPT Desktop 及 `.agents/servers`），在主界面顶部提供可折叠的导入工作台，采用“重名默认排除 + 手动勾选覆写”的冲突策略。
4. **内置 MCP 市场（MCP Market Panel）**：完整移植 PI-Desktop 的 `BUILTIN_MCP_CATALOG` 离线精选目录与分类筛选（devtools, web, docs, data, productivity），实现“零配置一键静默安装，有必填参数触发快捷补全”的分流机制。
5. **卡片操作精简与一键审批**：卡片右侧统一收拢为「铅笔编辑」、「...更多菜单（测试连接/复制配置/删除）」和「Toggle 开关」；项目级未批准服务在卡片上明确提示并提供一键就地批准入口。
6. **表单词汇对齐 PI-Desktop**：连接方式用两张卡片（本地程序 / HTTP 地址）而非下拉框——这个选择决定表单其余部分问什么；命令用 `npx` / `uvx` / 自定义 chips，自定义才出现文本框；环境变量与请求头是逐行 key/value（各自可删、可加），不再折叠进手风琴；`连接超时` 与 `协议版本` 收进「高级设置」，首屏只留启动一台服务器真正必需的字段。切换连接方式不清空另一分支已输入的内容，保存时只写当前分支。

Status: accepted

Considered Options:

- 选项 A：全盘照搬 PI-Desktop 的存储架构，强制迁移到 `~/.agents/servers/<id>.json` 单文件与独立 overrides 状态表。缺点是破坏与标准 Claude/Cursor/DSH 原生 `.mcp.json` 的兼容性，且极易导致既有项目配置失效。
- 选项 B（采纳）：前端交互体验、功能广度（扫描导入、市场分类、行内启停）完全对齐 PI-Desktop，存储契约坚守 DSH 集中式 `.mcp.json` 标准并透出绝对路径，以最小改动获取最大体验提升。
- 选项 C：仅在现有列表上打补丁增加一两个按钮，不重构分组与状态机。缺点是信息架构依然混乱，无法达到截图呈现的高品质桌面管理体验。

Consequences:

- 前端控制器 `McpPanelController` 需扩展支持 `market` 视图状态及工作区路径联动。
- 后端服务 `McpServersService` 与路由层需新增 `toggle`、`scan-external`、`import-external` 三组核心 API。
- 市场目录离线内置，无需依赖外网拉取即可开箱即用。
- 弹层用 `position: fixed` 覆盖视口，因此必须自带 Escape 关闭（保存进行中除外）与点击遮罩关闭；列表组件在弹层打开期间保持挂载，不再随之卸载重挂。
