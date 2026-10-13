export {}

declare global {
  interface DesktopMarkdownSaveResult {
    canceled: boolean
    filePath?: string
    settingsWarning?: string
  }

  interface Window {
    rssReaderDesktop?: {
      apiBaseUrl: string
      platform: string
      checkStorage?: () => void
      flushStorage?: () => void
      openExternal?: (url: string) => Promise<{ ok: boolean; message?: string }>
      saveMarkdown?: (payload: { content: string; suggestedFilename: string }) => Promise<DesktopMarkdownSaveResult>
    }
  }
}
