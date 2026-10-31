import { clientBundle } from '../../shared/tsdown.client.ts'

export default clientBundle('dsh-mcp-adapter', ['src/index.ts'], {
  libExternal: [
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-slots',
    // `appendPluginRecord` brand-checks its argument with a private field, so it MUST come from the
    // same module instance the persistence reader uses — the host's copy. Inlining a second copy here
    // would make every marker write throw and silently lose the panel's data.
    '@deepseek-ai/dsh-session',
  ],
})
