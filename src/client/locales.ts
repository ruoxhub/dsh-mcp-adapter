// The panel's copy. Both dictionaries are byte-for-byte the shipped bundle's own.
//
// `zh` is the key source: it declares the key domain, so a key added to one side without the other is
// a compile error rather than a missing string at runtime.

/** Locale namespace owned by this panel. */
export const NS = 'mcp-adapter-panel'

/** Simplified Chinese dictionary and key source. */
export const zh = {
  // Original conversation header panel keys
  trigger: 'MCP',
  title: 'MCP 服务器',
  unavailable: '还没有 MCP 状态。发一条消息让本插件开始工作，或运行 /mcp-adapter status。',
  projectRoot: '项目根',
  servers: '服务器',
  tools: '工具',
  problems: '配置问题',
  empty: '没有发现 MCP 服务器。在项目根放一个 .mcp.json，或写入全局 mcp-adapter/mcp.json。',
  blockedTitle: '等待批准',
  approve: '批准',
  askApprove: '在对话中批准 {name}',
  copyCommand: '复制命令',
  copied: '已复制',
  showTools: '查看 {count} 个工具',
  hideTools: '收起工具',
  lifecycle: '生命周期',
  transport: '传输',
  stateBlocked: '未批准',
  stateStopped: '未启动',
  stateStarting: '启动中',
  stateReady: '运行中',
  stateError: '失败',

  // Native sidebar panel and management view
  'entry.label': 'MCP 服务器',
  'entry.tooltip': 'MCP 服务器管理：查看、测试与配置模型上下文协议服务器',
  'panel.title': 'MCP 服务器',
  'panel.subtitle': '管理本地和工作区 MCP 服务器配置，为模型扩展工具与数据源能力',

  // Scope
  'scope.user': '电脑 用户',
  'scope.workspace': '工作区',
  'scope.workspace_current': '当前工作区',
  'scope.label': '作用域',

  // Categories
  'category.all': '全部',
  'category.browser': '浏览器操作',
  'category.system': '电脑控制',
  'category.document': '文档技能',
  'category.database': '数据存储',
  'category.custom': '自定义工具',

  // Actions & buttons
  'action.create': '+ 新建',
  'action.create_server': '+ 新建 MCP 服务器',
  'action.import': '导入',
  'action.refresh': '刷新',
  'action.probe': '测试连接',
  'action.probing': '探测中...',
  'action.edit': '编辑',
  'action.delete': '删除',
  'action.remove': '移除',
  'action.delete_confirm_prompt': '确认移除？',
  'action.move_to_project': '迁移到项目“{project}”',
  'action.move_to_global': '迁移到全局',
  'action.authorize': '授权',
  'action.reauthorize': '重新授权',
  'action.approve': '批准',
  'action.save': '保存',
  'action.saving': '保存中...',
  'action.cancel': '取消',
  'action.close': '关闭',
  'action.format_json': '格式化 JSON',

  // Search & Empty state
  'search.placeholder': '搜索 MCP 服务器...',
  'empty.title': '尚未安装 MCP 服务器',
  'empty.desc': '手动新建服务器，或导入已有配置。',
  'empty.search': '未找到与 "{query}" 匹配的 MCP 服务器',
  'loading.servers': '正在加载 MCP 服务器...',
  'desc.none': '暂无描述',

  // Status
  'status.ready': '运行中',
  'status.blocked': '等待批准',
  'status.starting': '启动中',
  'status.error': '错误',
  'status.stopped': '未启动',

  // Probe feedback
  'probe.success': '握手成功，发现 {tools} 个工具 ({latency}ms)',
  'probe.failed': '握手失败: {error}',

  // Editor
  'editor.title_create': '新建 MCP 服务器',
  'editor.title_edit': '编辑 MCP 服务器',
  'editor.subtitle': '运行本地命令或调用 HTTP 地址。',
  'editor.mode_form': '表单',
  'editor.mode_json': 'JSON',
  'editor.json_label': '完整配置',
  'editor.json_hint': '支持直接粘贴 {"server-name": {...}} 或 {"mcpServers": {"server-name": {...}}}。',
  'editor.test_after_save': '先保存，再测试连接。',
  'editor.advanced': '高级设置',

  // Form fields
  'field.name': '名称',
  'field.name_placeholder': 'my-mcp-server',
  'field.transport': '连接方式',
  'field.transport_stdio': '本地程序',
  'field.transport_http': 'HTTP 地址',
  'field.transport_sse': 'sse',
  'field.timeout': '连接超时',
  'field.timeout_hint': '连接与发现工具的超时时间（毫秒，默认 30000）。',
  'field.protocol_version': '协议版本',
  'field.protocol_version_auto': '自动 (推荐)',
  'field.command': '命令',
  'field.args': '参数',
  'field.args_help': '写成一行，和 README 里一样。引号会被识别。',
  'field.launcher_custom': '自定义',
  'field.url': '服务地址',
  'field.headers': '请求头',
  'field.header_key_placeholder': '请求头名称',
  'field.header_val_placeholder': '值',
  'field.add_header': '添加请求头',
  'field.remove_header': '删除这一行',
  'field.env': '环境变量',
  'field.env_key_placeholder': 'KEY (例如 GITHUB_TOKEN)',
  'field.env_val_placeholder': '值',
  'field.add_env': '添加变量',
  'field.remove_env': '删除这一行',
  'field.items_count': '{count} 项',
  'field.none': '无',

  // Validation & Dialogs
  'validation.name_required': '请输入服务器名称',
  'validation.name_invalid': '服务器名称只能包含字母、数字、下划线和连字符，长度1-32位',
  'validation.command_required': '请输入执行命令',
  'validation.url_required': '请输入服务 URL',
  'validation.json_invalid': 'JSON 配置格式错误，请检查语法',
  'dialog.delete_confirm': '确定要删除 MCP 服务器 "{name}" 吗？此操作无法撤销。',
  'error.load_failed': '加载 MCP 服务器失败',
  'error.save_failed': '保存失败，请重试',
  'error.delete_failed': '删除服务器失败',
  'error.approve_failed': '批准服务器失败',
  'action.presets': '常用预置',
  'presets.title': '常用 MCP 服务预置',
  'presets.subtitle': '选择开箱即用的标准 MCP 服务快速接入',
  'presets.install': '一键添加',
  'presets.installing': '添加中...',
  'presets.installed': '已添加',
  'error.stderr': '错误日志 (stderr)',

  // Segmented Tabs
  'tab.all': '全部',
  'tab.user': '全局',
  'tab.workspace': '项目',

  // Actions & Buttons
  'action.scan_tools': '从其他工具扫描',
  'action.market': '市场',
  'action.new': '+ 新增',
  'action.copy_json': '复制配置 JSON',
  'action.copied_json': '已复制配置 JSON',
  'copy.failed': '复制失败：浏览器拒绝了剪贴板写入',
  'action.more': '更多选项',
  'action.back_to_servers': '返回 MCP 服务器',
  'action.install': '安装',
  'action.installed': '已安装',
  'action.installing': '正在安装...',
  'action.batch_import': '导入已选',
  'action.select_all': '全选',
  'action.deselect_all': '取消全选',

  // Scan workbench
  'scan.title': '从其他工具扫描 MCP',
  'scan.scanning': '正在扫描本机其他工具配置...',
  'scan.empty': '未在其他 AI 编程工具中发现 MCP 配置',
  'scan.source_claude_desktop': 'Claude Desktop',
  'scan.source_claude_code': 'Claude Code',
  'scan.source_cursor_global': 'Cursor (全局)',
  'scan.source_cursor_project': 'Cursor (项目)',
  'scan.source_vscode': 'VS Code',
  'scan.source_codex': 'Codex',
  'scan.source_opencode': 'OpenCode',
  'scan.source_chatgpt_desktop': 'ChatGPT Desktop',
  'scan.source_agents_servers': 'PI-Desktop / Agents',
  'scan.candidate_exists': '已存在',
  'scan.need_restart_hint': '扫描服务暂不可用：新增后端接口需重启 DSH 服务后生效',
  'scan.import_success': '成功导入 {count} 个 MCP 服务器',
  'scan.import_failed': '导入失败: {error}',

  // Section headers
  'section.global_level': '全局级',
  'section.project_level': '项目级',
  'section.empty_dir': '此目录中没有 MCP 服务器',
  'section.create_in_scope': '+ 新建服务器',
  'section.create_in_project': '+ 新建项目服务器',

  // Market
  'market.title': 'MCP 市场',
  'market.subtitle': '浏览官方与开源精选 MCP 工具集，一键接入丰富数据源与外部生态',
  'market.search_placeholder': '搜索市场中的 MCP 服务器...',
  'market.category_all': '全部',
  'market.category_devtools': '开发调试',
  'market.category_web': '网络检索',
  'market.category_docs': '文档知识',
  'market.category_data': '数据存储',
  'market.category_productivity': '效率工具',
  'market.required_params_title': '安装配置：{name}',
  'market.required_params_desc': '该服务器需要以下必要环境变量或配置参数才能正常启动：',
  'market.install_success': '成功安装 "{name}"',
  'market.copied_json': '已复制 JSON 配置',

  // Toggle feedback
  'toggle.enabled_success': '已启用 "{name}"',
  'toggle.disabled_success': '已停用 "{name}"',
  'toggle.failed': '切换启停状态失败: {error}',
  'approval.success': '已成功批准 "{name}"',
  'approval.blocked_badge': '未批准',
  'approval.approve_action': '批准该服务器',

  // Migration & Auth
  'migrate.success': '成功将 "{name}" 迁移至{target}',
  'migrate.failed': '迁移失败: {error}',
  'migrate.conflict': '目标作用域已存在名为 "{name}" 的服务器',
  'auth.title': '配置授权凭据 - {name}',
  'auth.desc': '填写此 HTTP MCP 服务器的认证凭据（Bearer Token 或 API Key），保存后将作为 Authorization 请求头发送。',
  'auth.token_label': 'Token / API Key',
  'auth.token_placeholder': '例如：ghp_xxxx 或 sk-xxxx',
  'auth.token_type': '凭据格式',
  'auth.bearer': 'Bearer Token (推荐)',
  'auth.raw_key': '原始 Key (无前缀)',
  'auth.save_and_test': '保存并测试连接',
  'auth.success': '已更新 "{name}" 授权凭据',
}

/** The panel's key domain. */
export type McpAdapterLocaleKey = keyof typeof zh

/** English dictionary, same key set. */
export const en: Record<McpAdapterLocaleKey, string> = {
  // Original conversation header panel keys
  trigger: 'MCP',
  title: 'MCP servers',
  unavailable: 'No MCP status yet. Send a message so the adapter starts, or run /mcp-adapter status.',
  projectRoot: 'Project root',
  servers: 'Servers',
  tools: 'Tools',
  problems: 'Configuration problems',
  empty: "No MCP servers found. Add one to this project's .mcp.json, or to the global mcp-adapter/mcp.json.",
  blockedTitle: 'Awaiting approval',
  approve: 'Approve',
  askApprove: 'Approve {name} in the conversation',
  copyCommand: 'Copy command',
  copied: 'Copied',
  showTools: 'Show {count} tools',
  hideTools: 'Hide tools',
  lifecycle: 'Lifecycle',
  transport: 'Transport',
  stateBlocked: 'Unapproved',
  stateStopped: 'Stopped',
  stateStarting: 'Starting',
  stateReady: 'Running',
  stateError: 'Failed',

  // Native sidebar panel and management view
  'entry.label': 'MCP Servers',
  'entry.tooltip': 'MCP Servers: Manage, test, and configure Model Context Protocol servers',
  'panel.title': 'MCP Servers',
  'panel.subtitle': 'Manage local and workspace MCP server configurations to extend tools and data sources',

  // Scope
  'scope.user': 'User',
  'scope.workspace': 'Workspace',
  'scope.workspace_current': 'Current Workspace',
  'scope.label': 'Scope',

  // Categories
  'category.all': 'All',
  'category.browser': 'Browser',
  'category.system': 'System',
  'category.document': 'Document',
  'category.database': 'Database',
  'category.custom': 'Custom',

  // Actions & buttons
  'action.create': '+ New',
  'action.create_server': '+ New MCP Server',
  'action.import': 'Import',
  'action.refresh': 'Refresh',
  'action.probe': 'Test Connection',
  'action.probing': 'Testing...',
  'action.edit': 'Edit',
  'action.delete': 'Delete',
  'action.remove': 'Remove',
  'action.delete_confirm_prompt': 'Remove?',
  'action.move_to_project': 'Move into "{project}"',
  'action.move_to_global': 'Move to Global',
  'action.authorize': 'Authorize',
  'action.reauthorize': 'Re-authorize',
  'action.approve': 'Approve',
  'action.save': 'Save',
  'action.saving': 'Saving...',
  'action.cancel': 'Cancel',
  'action.close': 'Close',
  'action.format_json': 'Format JSON',

  // Search & Empty state
  'search.placeholder': 'Search MCP servers...',
  'empty.title': 'No MCP Servers Installed',
  'empty.desc': 'Create a new server manually, or import an existing configuration.',
  'empty.search': 'No MCP servers matching "{query}"',
  'loading.servers': 'Loading MCP servers...',
  'desc.none': 'No description',

  // Status
  'status.ready': 'Running',
  'status.blocked': 'Awaiting Approval',
  'status.starting': 'Starting',
  'status.error': 'Error',
  'status.stopped': 'Stopped',

  // Probe feedback
  'probe.success': 'Handshake OK, {tools} tools ({latency}ms)',
  'probe.failed': 'Handshake failed: {error}',

  // Editor
  'editor.title_create': 'New MCP Server',
  'editor.title_edit': 'Edit MCP Server',
  'editor.subtitle': 'Run a local command or call an HTTP endpoint.',
  'editor.mode_form': 'Form',
  'editor.mode_json': 'JSON',
  'editor.json_label': 'Configuration JSON',
  'editor.json_hint': 'Supports pasting {"server-name": {...}} or {"mcpServers": {"server-name": {...}}}.',
  'editor.test_after_save': 'Save first, then test the connection.',
  'editor.advanced': 'Advanced settings',

  // Form fields
  'field.name': 'Name',
  'field.name_placeholder': 'my-mcp-server',
  'field.transport': 'Transport',
  'field.transport_stdio': 'Local process',
  'field.transport_http': 'HTTP endpoint',
  'field.transport_sse': 'sse',
  'field.timeout': 'Connect timeout',
  'field.timeout_hint': 'Timeout for connecting and discovering tools (ms, 30000 by default).',
  'field.protocol_version': 'Protocol Version',
  'field.protocol_version_auto': 'Auto (Recommended)',
  'field.command': 'Command',
  'field.args': 'Arguments',
  'field.args_help': 'One line, exactly as the README prints it. Quotes are honoured.',
  'field.launcher_custom': 'Custom',
  'field.url': 'Endpoint URL',
  'field.headers': 'Headers',
  'field.header_key_placeholder': 'Header Name',
  'field.header_val_placeholder': 'Value',
  'field.add_header': 'Add header',
  'field.remove_header': 'Delete this row',
  'field.env': 'Environment Variables',
  'field.env_key_placeholder': 'KEY (e.g. GITHUB_TOKEN)',
  'field.env_val_placeholder': 'Value',
  'field.add_env': 'Add variable',
  'field.remove_env': 'Delete this row',
  'field.items_count': '{count} items',
  'field.none': 'None',

  // Validation & Dialogs
  'validation.name_required': 'Server name is required',
  'validation.name_invalid': 'Name must be 1-32 characters of letters, numbers, underscores, and hyphens',
  'validation.command_required': 'Command is required',
  'validation.url_required': 'URL is required',
  'validation.json_invalid': 'Invalid JSON syntax, please check configuration',
  'dialog.delete_confirm': 'Are you sure you want to delete MCP server "{name}"? This action cannot be undone.',
  'error.load_failed': 'Failed to load MCP servers',
  'error.save_failed': 'Save failed, please retry',
  'error.delete_failed': 'Failed to delete server',
  'error.approve_failed': 'Failed to approve server',
  'action.presets': 'Presets',
  'presets.title': 'Curated MCP Presets',
  'presets.subtitle': 'Select standard, out-of-the-box MCP servers for quick setup',
  'presets.install': 'Add Preset',
  'presets.installing': 'Adding...',
  'presets.installed': 'Added',
  'error.stderr': 'Error Log (stderr)',

  // Segmented Tabs
  'tab.all': 'All',
  'tab.user': 'Global',
  'tab.workspace': 'Project',

  // Actions & Buttons
  'action.scan_tools': 'Scan other tools',
  'action.market': 'Market',
  'action.new': '+ New',
  'action.copy_json': 'Copy JSON',
  'action.copied_json': 'Config JSON copied',
  'copy.failed': 'Copy failed: the browser rejected the clipboard write',
  'action.more': 'More options',
  'action.back_to_servers': 'Back to MCP Servers',
  'action.install': 'Install',
  'action.installed': 'Installed',
  'action.installing': 'Installing...',
  'action.batch_import': 'Import selected',
  'action.select_all': 'Select all',
  'action.deselect_all': 'Deselect all',

  // Scan workbench
  'scan.title': 'Scan other tools for MCP',
  'scan.scanning': 'Scanning other tools on this machine...',
  'scan.empty': 'No MCP configurations found in other AI tools',
  'scan.source_claude_desktop': 'Claude Desktop',
  'scan.source_claude_code': 'Claude Code',
  'scan.source_cursor_global': 'Cursor (Global)',
  'scan.source_cursor_project': 'Cursor (Project)',
  'scan.source_vscode': 'VS Code',
  'scan.source_codex': 'Codex',
  'scan.source_opencode': 'OpenCode',
  'scan.source_chatgpt_desktop': 'ChatGPT Desktop',
  'scan.source_agents_servers': 'PI-Desktop / Agents',
  'scan.candidate_exists': 'Already exists',
  'scan.need_restart_hint': 'Scan API unavailable (restart DSH to activate new backend endpoints)',
  'scan.import_success': 'Successfully imported {count} MCP server(s)',
  'scan.import_failed': 'Import failed: {error}',

  // Section headers
  'section.global_level': 'Global Level',
  'section.project_level': 'Project Level',
  'section.empty_dir': 'No MCP servers in this directory',
  'section.create_in_scope': '+ New Server',
  'section.create_in_project': '+ New Project Server',

  // Market
  'market.title': 'MCP Market',
  'market.subtitle': 'Browse curated official and open-source MCP tools with one-click installation.',
  'market.search_placeholder': 'Search MCP market...',
  'market.category_all': 'All',
  'market.category_devtools': 'DevTools',
  'market.category_web': 'Web & Search',
  'market.category_docs': 'Documentation',
  'market.category_data': 'Data & Storage',
  'market.category_productivity': 'Productivity',
  'market.required_params_title': 'Configure {name}',
  'market.required_params_desc': 'This server requires the following environment variables or arguments to run:',
  'market.install_success': 'Successfully installed "{name}"',
  'market.copied_json': 'Configuration JSON copied',

  // Toggle feedback
  'toggle.enabled_success': 'Enabled "{name}"',
  'toggle.disabled_success': 'Disabled "{name}"',
  'toggle.failed': 'Failed to toggle status: {error}',
  'approval.success': 'Approved "{name}"',
  'approval.blocked_badge': 'Blocked',
  'approval.approve_action': 'Approve Server',

  // Migration & Auth
  'migrate.success': 'Successfully moved "{name}" to {target}',
  'migrate.failed': 'Migration failed: {error}',
  'migrate.conflict': 'Server "{name}" already exists in target scope',
  'auth.title': 'Authorize - {name}',
  'auth.desc': 'Set or update credentials (Bearer Token or API Key) for this HTTP MCP server. Saved as Authorization header.',
  'auth.token_label': 'Token / API Key',
  'auth.token_placeholder': 'e.g. ghp_xxxx or sk-xxxx',
  'auth.token_type': 'Credential Type',
  'auth.bearer': 'Bearer Token (Recommended)',
  'auth.raw_key': 'Raw Key (No Prefix)',
  'auth.save_and_test': 'Save & Test Connection',
  'auth.success': 'Updated authorization credentials for "{name}"',
}

/** Active dictionary based on documentElement.lang */
export function getActiveDictionary(): Record<string, string> {
  const lang = typeof document !== 'undefined' ? document.documentElement.lang : 'zh'
  return lang && lang.toLowerCase().startsWith('en') ? { ...en } : { ...zh }
}

let runtimeT: ((key: McpAdapterLocaleKey, values?: Record<string, string | number>) => string) | undefined

/** Wire runtime translate function */
export function setRuntimeTranslate(
  t: ((key: McpAdapterLocaleKey, values?: Record<string, string | number>) => string) | undefined,
): void {
  runtimeT = t
}

/** Translate a key with optional template parameters */
export function tt(key: McpAdapterLocaleKey, values?: Record<string, string | number>): string {
  if (runtimeT !== undefined) return runtimeT(key, values)
  let text = getActiveDictionary()[key] ?? zh[key] ?? key
  if (values !== undefined) {
    for (const [name, value] of Object.entries(values)) {
      text = text.replaceAll(`{${name}}`, String(value))
    }
  }
  return text
}
