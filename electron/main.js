const { app, BrowserWindow, Menu, dialog, ipcMain, net: electronNet, protocol, shell, session } = require('electron')
const { spawn, spawnSync } = require('child_process')
const fs = require('fs/promises')
const fsSync = require('fs')
const http = require('http')
const nodeNet = require('net')
const path = require('path')
const { pathToFileURL } = require('url')

const profileReadArgument = process.argv.find(argument => argument.startsWith('--ripple-read-profile='))
if (profileReadArgument) {
  require('./verify-session').runProfileReader(profileReadArgument.slice('--ripple-read-profile='.length))
} else {

const useBuiltFrontend = process.env.RSSREADER_USE_BUILT_FRONTEND === '1'
const isDev = !app.isPackaged && !useBuiltFrontend
let backendProcess = null
let apiBaseUrl = process.env.RSSREADER_BACKEND_URL || ''

app.setName('Ripple')
if (process.platform === 'win32') {
  app.setAppUserModelId('io.github.ripple.desktop')
}

const installedWindows = process.platform === 'win32' && app.isPackaged
const installationDirectory = installedWindows ? path.dirname(process.execPath) : null
let installationDataError = null
let installationDataReady = true
let preparedBackup = null
let validatingSession = false
if (installedWindows) {
  installationDataReady = app.requestSingleInstanceLock()
  if (installationDataReady) {
    try {
      const legacyDirectories = [app.getPath('userData'), path.join(app.getPath('appData'), 'RSSReader')]
        .filter((directory, index, all) => all.findIndex(value => path.resolve(value) === path.resolve(directory)) === index)
      const prepared = spawnSync(getBackendExecutablePath(), ['--prepare-installation-data', installationDirectory, ...legacyDirectories], { encoding: 'utf8', windowsHide: true })
      if (prepared.status !== 0) throw new Error((prepared.stderr || prepared.error?.message || 'Ripple user data could not be prepared').trim())
      const location = JSON.parse(prepared.stdout)
      const dataDirectory = path.join(installationDirectory, 'ripple-data')
      if (path.resolve(location.userData) !== path.resolve(dataDirectory) || path.resolve(location.sessionData) !== path.resolve(dataDirectory)) throw new Error('Ripple data preparation selected an unexpected location')
      app.setPath('userData', dataDirectory)
      app.setPath('sessionData', dataDirectory)
      preparedBackup = location.backup
    } catch (error) {
      installationDataError = error
      installationDataReady = false
    }
  }
}

const applicationMenu = Menu.buildFromTemplate([
  ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
  { role: 'editMenu' },
  { role: 'viewMenu' },
  { role: 'windowMenu' }
])
Menu.setApplicationMenu(applicationMenu)

function appIconPath() {
  const iconName = process.platform === 'win32' ? 'icon.ico' : 'icon.png'
  return app.isPackaged
    ? path.join(app.getAppPath(), 'build', iconName)
    : path.join(__dirname, '..', 'build', iconName)
}

function settingsFilePath() {
  return path.join(app.getPath('userData'), 'desktop-settings.json')
}

async function readDesktopSettings() {
  try {
    const raw = await fs.readFile(settingsFilePath(), 'utf8')
    return JSON.parse(raw)
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw new Error(`Ripple 桌面设置读取失败：${error.message}`)
  }
}

async function writeDesktopSettings(settings) {
  await fs.writeFile(settingsFilePath(), JSON.stringify(settings, null, 2), 'utf8')
}

async function fileExists(targetPath) {
  try {
    await fs.access(targetPath)
    return true
  } catch (error) {
    return false
  }
}

function ensureMarkdownExtension(targetPath) {
  return path.extname(targetPath).toLowerCase() === '.md' ? targetPath : `${targetPath}.md`
}

async function makeUniqueFilePath(targetPath) {
  const normalizedTargetPath = ensureMarkdownExtension(targetPath)
  if (!(await fileExists(normalizedTargetPath))) {
    return normalizedTargetPath
  }

  const extension = path.extname(normalizedTargetPath)
  const directory = path.dirname(normalizedTargetPath)
  const baseName = path.basename(normalizedTargetPath, extension)
  let suffix = 2

  while (true) {
    const candidatePath = path.join(directory, `${baseName}-${suffix}${extension}`)
    if (!(await fileExists(candidatePath))) {
      return candidatePath
    }
    suffix += 1
  }
}
function storageProbePath(directory) {
  return path.join(directory, `.ripple-storage-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
}

function probeWritableDirectory(directory) {
  fsSync.accessSync(directory, fsSync.constants.R_OK | fsSync.constants.W_OK)
  const probe = storageProbePath(directory)
  let descriptor
  try {
    descriptor = fsSync.openSync(probe, 'wx', 0o600)
  } finally {
    if (descriptor !== undefined) fsSync.closeSync(descriptor)
  }
  fsSync.unlinkSync(probe)
}

function nearestExistingDirectory(targetPath) {
  let directory = path.resolve(targetPath)
  while (true) {
    try {
      if (!fsSync.statSync(directory).isDirectory()) throw new Error(`不是目录：${directory}`)
      return directory
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      const parent = path.dirname(directory)
      if (parent === directory) throw error
      directory = parent
    }
  }
}

function probePersistentSessionStorage() {
  const persistentSession = session.defaultSession
  const storagePath = typeof persistentSession.getStoragePath === 'function'
    ? persistentSession.getStoragePath()
    : app.getPath('sessionData')
  if (!storagePath) throw new Error('持久会话没有存储目录')

  const localStoragePath = path.join(storagePath, 'Local Storage')
  const levelDbPath = path.join(localStoragePath, 'leveldb')
  let levelDbExists = false
  try {
    levelDbExists = fsSync.statSync(levelDbPath).isDirectory()
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  if (!levelDbExists) {
    probeWritableDirectory(nearestExistingDirectory(levelDbPath))
    return
  }

  probeWritableDirectory(levelDbPath)
  for (const entry of fsSync.readdirSync(levelDbPath, { withFileTypes: true })) {
    if (entry.name === 'LOCK' || !entry.isFile()) continue
    const filePath = path.join(levelDbPath, entry.name)
    fsSync.accessSync(filePath, fsSync.constants.R_OK | fsSync.constants.W_OK)
    const descriptor = fsSync.openSync(filePath, fsSync.constants.O_WRONLY)
    fsSync.closeSync(descriptor)
  }
}

function registerDesktopIpcHandlers() {
  ipcMain.on('rssreader:check-storage', event => {
    try {
      if (installedWindows) {
        const directory = app.getPath('userData')
        fsSync.accessSync(path.join(directory, 'app.db'), fsSync.constants.R_OK | fsSync.constants.W_OK)
        const probe = path.join(directory, `.ripple-preference-${process.pid}`)
        const descriptor = fsSync.openSync(probe, 'wx')
        fsSync.closeSync(descriptor)
        fsSync.unlinkSync(probe)
      }
      probePersistentSessionStorage()
      event.returnValue = null
    } catch (error) { event.returnValue = `Ripple 数据目录不可读写：${error.message}` }
  })
  ipcMain.on('rssreader:flush-storage', event => {
    try {
      session.defaultSession.flushStorageData()
      probePersistentSessionStorage()
      event.returnValue = null
    } catch (error) { event.returnValue = `Ripple 偏好刷新失败：${error.message}` }
  })
  ipcMain.handle('rssreader:open-external', async (_event, url) => {
    if (!isExternalUrl(url)) {
      return { ok: false, message: 'Unsupported external URL' }
    }
    await shell.openExternal(url)
    return { ok: true }
  })

  ipcMain.handle('rssreader:save-markdown', async (_event, payload) => {
    const content = typeof payload?.content === 'string' ? payload.content : ''
    const suggestedFilename = typeof payload?.suggestedFilename === 'string' && payload.suggestedFilename
      ? payload.suggestedFilename
      : 'digest.md'
    const settings = await readDesktopSettings()
    const initialDirectory = settings.lastExportDirectory || app.getPath('documents') || app.getPath('home')
    const defaultPath = await makeUniqueFilePath(path.join(initialDirectory, suggestedFilename))
    const result = await dialog.showSaveDialog({
      title: 'Export Markdown',
      defaultPath,
      filters: [
        { name: 'Markdown', extensions: ['md'] }
      ]
    })

    if (result.canceled || !result.filePath) {
      return { canceled: true }
    }

    const finalPath = await makeUniqueFilePath(result.filePath)
    await fs.writeFile(finalPath, content, 'utf8')
    try {
      await writeDesktopSettings({ ...settings, lastExportDirectory: path.dirname(finalPath) })
      return { canceled: false, filePath: finalPath }
    } catch (error) {
      return { canceled: false, filePath: finalPath, settingsWarning: `Markdown 已导出，但上次导出位置未保存：${error.message}` }
    }
  })
}

function isExternalUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return false
  try {
    const parsed = new URL(url)
    return ['http:', 'https:', 'mailto:'].includes(parsed.protocol)
  } catch (error) {
    return false
  }
}

function openExternalUrl(url) {
  if (!isExternalUrl(url)) return false
  shell.openExternal(url).catch((error) => {
    console.error(`Failed to open external URL ${url}:`, error)
  })
  return true
}

function isSameOriginUrl(left, right) {
  try {
    return new URL(left).origin === new URL(right).origin
  } catch (error) {
    return false
  }
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true
    }
  }
])

function getBackendExecutablePath() {
  const executableName = process.platform === 'win32' ? 'RSSReaderBackend.exe' : 'RSSReaderBackend'
  return app.isPackaged
    ? path.join(process.resourcesPath, 'backend', 'RSSReaderBackend', executableName)
    : path.join(__dirname, '..', 'backend', 'desktop_server.py')
}

function findFreePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = nodeNet.createServer()
    server.once('error', reject)
    server.listen(0, host, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 8000
      server.close(() => resolve(port))
    })
  })
}

function waitForHealth(baseUrl, retries = 60) {
  return new Promise((resolve, reject) => {
    let attempts = 0

    const check = () => {
      attempts += 1
      const request = http.get(`${baseUrl}/api/health`, (response) => {
        response.resume()
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
          resolve()
          return
        }
        retry()
      })

      request.on('error', retry)
      request.setTimeout(1000, () => {
        request.destroy()
        retry()
      })
    }

    const retry = () => {
      if (attempts >= retries) {
        reject(new Error(`Backend did not become healthy at ${baseUrl}`))
        return
      }
      setTimeout(check, 500)
    }

    check()
  })
}

function waitForUrl(url, retries = 60) {
  return new Promise((resolve, reject) => {
    let attempts = 0

    const check = () => {
      attempts += 1
      const request = http.get(url, (response) => {
        response.resume()
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 500) {
          resolve()
          return
        }
        retry()
      })

      request.on('error', retry)
      request.setTimeout(1000, () => {
        request.destroy()
        retry()
      })
    }

    const retry = () => {
      if (attempts >= retries) {
        reject(new Error(`URL did not become available: ${url}`))
        return
      }
      setTimeout(check, 500)
    }

    check()
  })
}

function registerFrontendProtocol() {
  const frontendRoot = path.join(app.getAppPath(), 'frontend', 'dist')

  protocol.handle('app', (request) => {
    const requestUrl = new URL(request.url)
    const requestPath = decodeURIComponent(requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname)
    const filePath = path.normalize(path.join(frontendRoot, requestPath))

    if (!filePath.startsWith(frontendRoot)) {
      return new Response('Forbidden', { status: 403 })
    }

    return electronNet.fetch(pathToFileURL(filePath).toString())
  })
}

async function startBackend() {
  if (apiBaseUrl) {
    await waitForHealth(apiBaseUrl)
    return
  }

  const host = '127.0.0.1'
  const port = await findFreePort(host)
  apiBaseUrl = `http://${host}:${port}`
  const backendPath = getBackendExecutablePath()
  const env = {
    ...process.env,
    RSSREADER_HOST: host,
    RSSREADER_PORT: String(port),
    RSSREADER_DB_PATH: path.join(app.getPath('userData'), 'app.db')
  }

  if (app.isPackaged) {
    backendProcess = spawn(backendPath, [], { env, windowsHide: true, stdio: 'ignore' })
  } else {
    backendProcess = spawn(process.env.PYTHON || 'python', [backendPath], {
      cwd: path.join(__dirname, '..', 'backend'),
      env,
      windowsHide: true,
      stdio: 'inherit'
    })
  }

  backendProcess.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`RSSReader backend exited with code ${code}`)
    }
  })

  await waitForHealth(apiBaseUrl)
}

async function createWindow() {
  const mainWindow = new BrowserWindow({
    title: 'Ripple',
    icon: appIconPath(),
    autoHideMenuBar: true,
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
      additionalArguments: [`--rssreader-api-base-url=${apiBaseUrl}`]
    }
  })

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl) => {
    console.error(`Renderer failed to load ${validatedUrl}: ${errorCode} ${errorDescription}`)
  })

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error(`Renderer process gone: ${details.reason}`)
  })

  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`)
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const currentUrl = mainWindow.webContents.getURL()
    if (!isSameOriginUrl(url, currentUrl) && openExternalUrl(url)) {
      return { action: 'deny' }
    }
    return { action: 'allow' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const currentUrl = mainWindow.webContents.getURL()
    if (url !== currentUrl && !isSameOriginUrl(url, currentUrl) && openExternalUrl(url)) {
      event.preventDefault()
    }
  })

  if (isDev) {
    const frontendUrl = process.env.RSSREADER_FRONTEND_URL || 'http://127.0.0.1:5173'
    await waitForUrl(frontendUrl)
    await mainWindow.loadURL(frontendUrl)
  } else {
    await mainWindow.loadURL('app://rssreader/index.html')
  }

  if (process.env.RSSREADER_OPEN_DEVTOOLS === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }
}

function stopBackend() {
  if (backendProcess && !backendProcess.killed) {
    backendProcess.kill()
    backendProcess = null
  }
}

app.whenReady().then(async () => {
  if (!installationDataReady) {
    if (installationDataError) dialog.showErrorBox('Ripple 数据准备失败', `${installationDataError.message}\n原有数据未作为空账号打开，请修复目录或数据后重试。`)
    app.quit()
    return
  }
  if (installedWindows && preparedBackup) {
    validatingSession = true
    try {
      await require('./verify-session').verifyMigratedSession(preparedBackup)
      const confirmed = spawnSync(getBackendExecutablePath(), ['--confirm-installation-data', installationDirectory], { encoding: 'utf8', windowsHide: true })
      if (confirmed.status !== 0) throw new Error((confirmed.stderr || confirmed.error?.message || 'Ripple migration confirmation failed').trim())
    } finally {
      validatingSession = false
    }
  }
  if (!isDev || useBuiltFrontend) {
    registerFrontendProtocol()
  }
  registerDesktopIpcHandlers()
  await startBackend()
  if (installedWindows) {
    const confirmed = spawnSync(getBackendExecutablePath(), ['--confirm-installation-data', installationDirectory], { encoding: 'utf8', windowsHide: true })
    if (confirmed.status !== 0) throw new Error((confirmed.stderr || 'Ripple database state could not be confirmed').trim())
  }
  await createWindow()

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow()
    }
  })
}).catch(error => {
  dialog.showErrorBox('Ripple 启动失败', error.message)
  app.quit()
})

app.on('before-quit', stopBackend)

app.on('window-all-closed', () => {
  if (validatingSession) return
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
}
