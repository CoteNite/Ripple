import { ElMessage } from 'element-plus'

function report(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error)
  ElMessage.error(`Ripple 偏好读写失败，原有数据未替换：${message}`)
  throw error
}

export const persistentStorage = {
  getItem(key: string): string | null {
    try {
      window.rssReaderDesktop?.checkStorage?.()
      return localStorage.getItem(key)
    } catch (error) { return report(error) }
  },
  setItem(key: string, value: string): void {
    let previous: string | null = null
    try {
      previous = localStorage.getItem(key)
      window.rssReaderDesktop?.checkStorage?.()
      localStorage.setItem(key, value)
      window.rssReaderDesktop?.flushStorage?.()
    } catch (error) {
      if (previous === null) localStorage.removeItem(key)
      else localStorage.setItem(key, previous)
      report(error)
    }
  }
}
