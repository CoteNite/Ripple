const { app, BrowserWindow, protocol, session } = require('electron')
const { execFileSync } = require('node:child_process')
const path = require('node:path')

const [mode, directory, backup, installation, python] = process.argv.slice(2)
app.setPath('userData', directory)
app.setPath('sessionData', directory)
app.on('window-all-closed', () => {})

function report(result) {
  process.stdout.write(`RIPPLE_TEST:${JSON.stringify(result)}\n`)
  app.quit()
}

if (mode === 'seed' || mode === 'seed-large' || mode === 'bootstrap') {
  protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true } }])
  app.whenReady().then(async () => {
    protocol.handle('app', () => new Response('<!doctype html><title>Migration regression</title>'))
    const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } })
    await window.loadURL('app://rssreader/index.html')
    const script = mode === 'bootstrap'
      ? `localStorage.setItem('__ripple_test_bootstrap', 'initialized')`
      : `localStorage.setItem('rssreader.theme', 'dark'); localStorage.setItem('ui-language', 'zh-CN')`
    await window.webContents.executeJavaScript(script)
    if (mode === 'seed-large') await window.webContents.executeJavaScript(`localStorage.setItem('rssreader.large', 'x'.repeat(70000))`)
    session.defaultSession.flushStorageData()
    report({ seeded: true, electron: process.versions.electron })
  }).catch(error => { process.stderr.write(`${error.stack}\n`); app.exit(1) })
} else if (mode === 'verify') {
  const { verifyMigratedSession } = require('../../verify-session')
  protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true } }])
  app.whenReady().then(async () => {
    try {
      await verifyMigratedSession(backup)
      // Match main.js: source cleanup is allowed only after session verification.
      execFileSync(python, ['-c', 'from pathlib import Path; import sys; from app.services.installation_data import confirm_installation_data; confirm_installation_data(Path(sys.argv[1]))', installation], { cwd: path.join(__dirname, '../../../backend'), windowsHide: true })
      report({ accepted: true })
    } catch (error) {
      report({ accepted: false, error: error.message })
    }
  }).catch(error => { process.stderr.write(`${error.stack}\n`); app.exit(1) })
} else {
  throw new Error(`Unknown migration fixture mode: ${mode}`)
}
