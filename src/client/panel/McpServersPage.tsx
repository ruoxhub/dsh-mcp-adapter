import { useSyncExternalStore, type ReactElement } from 'react'
import type { McpServersApiClient } from '../api.ts'
import type { McpPanelController } from '../controller.ts'
import { ServerEditorTab } from './ServerEditorTab.tsx'
import { ServersListTab } from './ServersListTab.tsx'
import { McpMarketPanel } from './McpMarketPanel.tsx'
import css from './panel.module.css'

export interface McpServersPageProps {
  controller: McpPanelController
  api: McpServersApiClient
  cwd?: string
}

export function McpServersPage({ controller, api, cwd }: McpServersPageProps): ReactElement {
  const snapshot = useSyncExternalStore(
    controller.subscribe.bind(controller),
    controller.getSnapshot.bind(controller),
    controller.getSnapshot.bind(controller),
  )

  // The market replaces the page; the create/edit sheet floats over the list it was opened from,
  // so the servers the user was comparing stay visible behind it.
  return (
    <div className={css.pageContainer} data-dsh-plugin="mcp-adapter">
      {snapshot.viewMode === 'market' ? (
        <div data-view="market" className={css.fullView}>
          <McpMarketPanel
            controller={controller}
            api={api}
            cwd={cwd}
          />
        </div>
      ) : (
        <div data-view="list" className={css.fullView}>
          <ServersListTab
            controller={controller}
            api={api}
            cwd={cwd}
          />
        </div>
      )}
      {snapshot.viewMode === 'editor' && (
        <ServerEditorTab
          controller={controller}
          api={api}
          cwd={cwd}
        />
      )}
    </div>
  )
}
