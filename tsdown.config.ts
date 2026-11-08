import { clientBundle } from './shared/tsdown.client.ts'

// `shared/` is a vendored copy of the dsh-web repository preset, not a workspace reference: this
// package is published from its own repository, where `../../shared` does not exist. Same rule the
// other plugin repositories in the family follow.

export default clientBundle('@ruoxhub/dsh-mcp-adapter', ['src/index.ts'], {
  libExternal: [
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-slots',
    // `appendPluginRecord` brand-checks its argument with a private field, so it MUST come from the
    // same module instance the persistence reader uses — the host's copy. Inlining a second copy here
    // would make every marker write throw and silently lose the panel's data.
    '@deepseek-ai/dsh-session',
  ],
})
