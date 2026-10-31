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
  'probe.success': '连接正常 ({latency}ms)',
  'probe.failed': '连接失败: {error}',

  // Editor
  'editor.title_create': '新建 MCP 服务器',
  'editor.title_edit': '编辑 MCP 服务器',
  'editor.subtitle': '填写新的 MCP 配置，保存后返回列表。',
  'editor.mode_form': '表单',
  'editor.mode_json': 'JSON',
  'editor.json_label': '完整配置',
  'editor.json_hint': '支持直接粘贴 {"server-name": {...}} 或 {"mcpServers": {"server-name": {...}}}。',

  // Form fields
  'field.name': '名称',
  'field.name_placeholder': 'my-mcp-server',
  'field.transport': '类型',
  'field.transport_stdio': 'stdio (本地命令)',
  'field.transport_http': 'http',
  'field.transport_sse': 'sse',
  'field.timeout': '超时时间 MS',
  'field.protocol_version': '协议版本',
  'field.protocol_version_auto': '自动 (推荐)',
  'field.command': '命令',
  'field.args': '参数',
  'field.args_help': '命令行参数，多个参数以空格分隔',
  'field.url': 'URL',
  'field.headers': '请求头 (可选)',
  'field.header_key_placeholder': '请求头名称',
  'field.header_val_placeholder': '请求头内容',
  'field.add_header': '+ 添加请求头',
  'field.remove_header': '删除请求头',
  'field.env': '环境变量 (可选)',
  'field.env_key_placeholder': 'KEY (例如 GITHUB_TOKEN)',
  'field.env_val_placeholder': '值',
  'field.add_env': '+ 添加环境变量',
  'field.remove_env': '删除环境变量',
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
  'probe.success': 'Connected successfully ({latency}ms)',
  'probe.failed': 'Connection failed: {error}',

  // Editor
  'editor.title_create': 'New MCP Server',
  'editor.title_edit': 'Edit MCP Server',
  'editor.subtitle': 'Fill in the MCP configuration and save to return to the list.',
  'editor.mode_form': 'Form',
  'editor.mode_json': 'JSON',
  'editor.json_label': 'Configuration JSON',
  'editor.json_hint': 'Supports pasting {"server-name": {...}} or {"mcpServers": {"server-name": {...}}}.',

  // Form fields
  'field.name': 'Name',
  'field.name_placeholder': 'my-mcp-server',
  'field.transport': 'Transport',
  'field.transport_stdio': 'stdio (Local Process)',
  'field.transport_http': 'http',
  'field.transport_sse': 'sse',
  'field.timeout': 'Timeout (ms)',
  'field.protocol_version': 'Protocol Version',
  'field.protocol_version_auto': 'Auto (Recommended)',
  'field.command': 'Command',
  'field.args': 'Arguments',
  'field.args_help': 'Command line arguments, separated by spaces',
  'field.url': 'URL',
  'field.headers': 'Headers (Optional)',
  'field.header_key_placeholder': 'Header Name',
  'field.header_val_placeholder': 'Header Value',
  'field.add_header': '+ Add Header',
  'field.remove_header': 'Delete header',
  'field.env': 'Environment Variables (Optional)',
  'field.env_key_placeholder': 'KEY (e.g. GITHUB_TOKEN)',
  'field.env_val_placeholder': 'Value',
  'field.add_env': '+ Add Environment Variable',
  'field.remove_env': 'Delete environment variable',
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
