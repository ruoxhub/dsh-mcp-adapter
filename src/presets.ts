// Curated known MCP server presets. Standard, general-purpose servers that require no paid setup.

export interface KnownServerPreset {
  id: string
  name: string
  summary: string
  category: string
  entry: Record<string, unknown>
  requiredEnv?: string[]
}

export const KNOWN_SERVER_PRESETS: KnownServerPreset[] = [
  {
    id: 'github',
    name: 'GitHub',
    category: 'system',
    summary: 'GitHub repositories, issues, pull requests and code search via official GitHub MCP.',
    entry: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: {
        GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_PERSONAL_ACCESS_TOKEN:-}',
      },
    },
    requiredEnv: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
  },
  {
    id: 'chrome-devtools',
    name: 'Chrome DevTools',
    category: 'browser',
    summary: 'Chrome DevTools protocol automation for DOM inspection, network debugging and screenshots.',
    entry: {
      command: 'npx',
      args: ['-y', 'chrome-devtools-mcp@1.6.0'],
    },
  },
  {
    id: 'context7',
    name: 'Context7',
    category: 'document',
    summary: 'Up-to-date documentation and code reference for third-party libraries and frameworks.',
    entry: {
      url: 'https://mcp.context7.com/mcp',
    },
  },
  {
    id: 'parallel-search',
    name: 'Parallel Search',
    category: 'custom',
    summary: 'Keyless web search and page fetch without requiring an external API key.',
    entry: {
      url: 'https://search.parallel.fi/mcp',
      headers: {
        'User-Agent': 'dsh-mcp-adapter',
      },
    },
  },
  {
    id: 'deepwiki',
    name: 'DeepWiki',
    category: 'document',
    summary: 'Wikipedia and knowledge base query server.',
    entry: {
      url: 'https://mcp.deepwiki.org/mcp',
    },
  },
  {
    id: 'tavily-search',
    name: 'Tavily Search',
    category: 'custom',
    summary: 'Tavily search engine with keyless mode or custom API key.',
    entry: {
      url: 'https://mcp.tavily.com/mcp',
      headers: {
        'X-Tavily-Access-Mode': 'keyless',
      },
    },
  },
]

export function listKnownPresets(): KnownServerPreset[] {
  return [...KNOWN_SERVER_PRESETS]
}

export function getKnownPreset(id: string): KnownServerPreset | undefined {
  return KNOWN_SERVER_PRESETS.find((p) => p.id === id)
}
