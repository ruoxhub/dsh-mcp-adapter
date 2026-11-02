// Curated known MCP server presets. Standard, general-purpose servers that require no paid setup.

import type { McpCatalogEntry } from './types.ts'

export interface KnownServerPreset {
  id: string
  name: string
  summary: string
  category: string
  entry: Record<string, unknown>
  requiredEnv?: string[]
}

export const BUILTIN_MCP_CATALOG: McpCatalogEntry[] = [
  {
    id: 'memory',
    name: 'Memory',
    description: '持久知识图谱，让会话之间记住实体与关系。',
    author: 'modelcontextprotocol',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
    categories: ['productivity'],
    verified: true,
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    notes: '首次运行由 npx 自动拉取依赖',
  },
  {
    id: 'sequential-thinking',
    name: 'Sequential Thinking',
    description: '动态反思式分步推理，复杂问题结构化拆解。',
    author: 'modelcontextprotocol',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
    categories: ['productivity'],
    verified: true,
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
  },
  {
    id: 'everything',
    name: 'Everything',
    description: '官方综合测试服务器，覆盖 MCP 全部基础能力（工具、资源、提示词），用于联调测试。',
    author: 'modelcontextprotocol',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/everything',
    categories: ['docs'],
    verified: true,
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-everything'],
  },
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: '在指定根目录范围内进行安全文件读写、目录列表与搜索。',
    author: 'modelcontextprotocol',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    categories: ['data'],
    verified: true,
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '${MCP_FS_ROOT}'],
    requiredEnv: [
      {
        name: 'MCP_FS_ROOT',
        description: '允许访问的根目录绝对路径或相对路径',
        defaultValue: '.',
      },
    ],
    notes: '服务器仅能访问指定根目录之内的路径',
  },
  {
    id: 'chrome-devtools',
    name: 'Chrome DevTools',
    description: '基于 Chrome DevTools 协议实现浏览器 DOM 探查、网络控制与屏幕截图。',
    author: 'google',
    homepage: 'https://github.com/ChromeDevTools/devtools-frontend',
    categories: ['devtools'],
    verified: true,
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'chrome-devtools-mcp@1.6.0'],
  },
  {
    id: 'playwright',
    name: 'Playwright',
    description: '通过无障碍树驱动 Chromium/Firefox 打开网页、点击、填表。',
    author: 'microsoft',
    homepage: 'https://github.com/microsoft/playwright-mcp',
    categories: ['web'],
    verified: true,
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
  },
  {
    id: 'context7',
    name: 'Context7',
    description: '实时查询各大第三方库与开发框架的最新版官方文档与代码示例。',
    author: 'upstash',
    homepage: 'https://github.com/upstash/context7',
    categories: ['docs'],
    verified: true,
    transport: 'http',
    url: 'https://mcp.context7.com/mcp',
  },
  {
    id: 'fetch',
    name: 'Fetch',
    description: '抓取任意网页并将 HTML 内容转为结构化 Markdown 供大模型阅读。',
    author: 'modelcontextprotocol',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
    categories: ['web'],
    verified: true,
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-fetch'],
  },
  {
    id: 'git',
    name: 'Git',
    description: '读取 Git 仓库状态、diff、commit log，并执行常用版本控制操作。',
    author: 'modelcontextprotocol',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/git',
    categories: ['devtools'],
    verified: true,
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-git'],
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'GitHub 官方远程 MCP：仓库、Issue、PR、代码搜索与 Actions 运维。',
    author: 'github',
    homepage: 'https://github.com/github/github-mcp-server',
    categories: ['devtools'],
    verified: true,
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: {
      GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_PERSONAL_ACCESS_TOKEN:-}',
    },
    requiredEnv: [
      {
        name: 'GITHUB_PERSONAL_ACCESS_TOKEN',
        description: 'GitHub 个人访问令牌 (Personal Access Token)',
      },
    ],
  },
  {
    id: 'brave-search',
    name: 'Brave Search',
    description: 'Brave 独立搜索引擎 API：全球网页、新闻与实时网络信息检索。',
    author: 'modelcontextprotocol',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search',
    categories: ['web'],
    verified: true,
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    env: {
      BRAVE_API_KEY: '${BRAVE_API_KEY:-}',
    },
    requiredEnv: [
      {
        name: 'BRAVE_API_KEY',
        description: 'Brave Search API Key',
      },
    ],
  },
  {
    id: 'parallel-search',
    name: 'Parallel Search',
    description: '免 Key 网页搜索与页面内容抓取，无需注册外部 API Key。',
    author: 'parallel',
    homepage: 'https://parallel.fi',
    categories: ['web'],
    verified: true,
    transport: 'http',
    url: 'https://search.parallel.fi/mcp',
    headers: {
      'User-Agent': 'dsh-mcp-adapter',
    },
  },
  {
    id: 'deepwiki',
    name: 'DeepWiki',
    description: 'GitHub 开源仓库架构解析与百科式知识库问答。',
    author: 'devin',
    homepage: 'https://deepwiki.com',
    categories: ['docs'],
    verified: true,
    transport: 'http',
    url: 'https://mcp.deepwiki.org/mcp',
  },
  {
    id: 'tavily-search',
    name: 'Tavily Search',
    description: '专为大模型优化的 Tavily 智能网页检索与事实查验服务。',
    author: 'tavily',
    homepage: 'https://tavily.com',
    categories: ['web'],
    verified: true,
    transport: 'http',
    url: 'https://mcp.tavily.com/mcp',
    headers: {
      'X-Tavily-Access-Mode': 'keyless',
    },
  },
  {
    id: 'time',
    name: 'Time',
    description: '多时区查询与时间戳跨地区换算。',
    author: 'modelcontextprotocol',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/time',
    categories: ['productivity'],
    verified: true,
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-time'],
  },
  {
    id: 'notion',
    name: 'Notion',
    description: '检索、读取并管理 Notion 团队页面与数据库条目。',
    author: 'notion',
    homepage: 'https://developers.notion.com/docs/mcp',
    categories: ['productivity'],
    verified: true,
    transport: 'http',
    url: 'https://mcp.notion.com/mcp',
    notes: '连接后在浏览器完成 Notion 账户授权',
  },
]

export const KNOWN_SERVER_PRESETS: KnownServerPreset[] = BUILTIN_MCP_CATALOG.map((entry) => {
  const serverEntry: Record<string, unknown> = {
    transport: entry.transport,
    ...(entry.command ? { command: entry.command } : {}),
    ...(entry.args ? { args: entry.args } : {}),
    ...(entry.url ? { url: entry.url } : {}),
    ...(entry.headers ? { headers: entry.headers } : {}),
    ...(entry.env ? { env: entry.env } : {}),
  }
  const requiredEnv = entry.requiredEnv
    ? Array.isArray(entry.requiredEnv)
      ? entry.requiredEnv.map((item) => (typeof item === 'string' ? item : item.name))
      : []
    : undefined
  return {
    id: entry.id,
    name: entry.name,
    category: entry.categories[0] || 'custom',
    summary: entry.description,
    entry: serverEntry,
    ...(requiredEnv && requiredEnv.length > 0 ? { requiredEnv } : {}),
  }
})

export function listKnownPresets(): KnownServerPreset[] {
  return [...KNOWN_SERVER_PRESETS]
}

export function getKnownPreset(id: string): KnownServerPreset | undefined {
  return KNOWN_SERVER_PRESETS.find((p) => p.id === id)
}

export function listCatalogEntries(): McpCatalogEntry[] {
  return [...BUILTIN_MCP_CATALOG]
}

export function getCatalogEntry(id: string): McpCatalogEntry | undefined {
  return BUILTIN_MCP_CATALOG.find((e) => e.id === id)
}
