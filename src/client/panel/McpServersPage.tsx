import { useSyncExternalStore, type ReactElement } from 'react'
import type { McpServersApiClient } from '../api.ts'
import type { McpPanelController } from '../controller.ts'
import { ServerEditorTab } from './ServerEditorTab.tsx'
import { ServersListTab } from './ServersListTab.tsx'
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

  return (
    <div className={css.pageContainer} data-dsh-plugin="mcp-adapter">
      {snapshot.viewMode === 'editor' ? (
        <div data-view="editor" className={css.fullView}>
          <ServerEditorTab
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
    </div>
  )
}
