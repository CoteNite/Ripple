const { app, BrowserWindow, session, protocol } = require('electron')
const { execFile } = require('child_process')
const fs = require('fs/promises')
const path = require('path')
const os = require('os')
const { randomUUID } = require('crypto')
const fsSync = require('fs')
const { validateProfileWals } = require('./leveldb-wal')

function captureDatabaseEvidence(directory) {
  const database = path.join(directory, 'Local Storage', 'leveldb')
  let files
  try {
    files = fsSync.readdirSync(database)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  const hasDatabaseFiles = files.some(name => /^(?:MANIFEST-\d+|\d+\.(?:log|ldb|sst))$/.test(name))
  if (hasDatabaseFiles && !files.includes('CURRENT')) throw new Error('Local Storage database is missing CURRENT; migration cannot be verified')
  const lockPath = path.join(database, 'LOCK')
  let descriptor
  try {
    descriptor = fsSync.openSync(lockPath, 'a+')
  } catch (error) {
    if (error.code === 'ENOENT' && !hasDatabaseFiles) return null
    throw error
  }
  const identity = fsSync.fstatSync(descriptor, { bigint: true })
  if (!identity.isFile() || identity.ino === 0n) {
    fsSync.closeSync(descriptor)
    throw new Error('Local Storage database identity cannot be verified')
  }
  return { descriptor, lockPath, identity }
}

async function verifyDatabaseEvidence(evidence) {
  if (!evidence) return
  const current = await fs.stat(evidence.lockPath, { bigint: true }).catch(() => null)
  if (!current || current.dev !== evidence.identity.dev || current.ino !== evidence.identity.ino) {
    throw new Error('Local Storage database was recreated while reading it; migration cannot be verified')
  }
}

async function guardDatabase(directory) {
  validateProfileWals(directory)
  const database = path.join(directory, 'Local Storage', 'leveldb')
  await fs.mkdir(database, { recursive: true })
  const files = await fs.readdir(database)
  if (!files.includes('CURRENT') && files.some(name => /^(?:MANIFEST-\d+|\d+\.(?:log|ldb|sst))$/.test(name))) {
    throw new Error('Local Storage database is missing CURRENT; migration cannot be verified')
  }
  // Chromium opens LOCK without truncating it. Ordinary WAL recovery, manifest
  // rotation and compaction retain it; DestroyDB deletes it during recreation.
  // Keep the old file alive so its identity cannot be reused after deletion.
  const lockPath = path.join(database, 'LOCK')
  const handle = await fs.open(lockPath, 'a+')
  try {
    const identity = await handle.stat({ bigint: true })
    if (!identity.isFile() || identity.ino === 0n) throw new Error('Local Storage database identity cannot be verified')
    return {
      async verify() {
        const current = await fs.stat(lockPath, { bigint: true }).catch(() => null)
        if (!current || current.dev !== identity.dev || current.ino !== identity.ino) {
          throw new Error('Local Storage database was recreated while reading it; migration cannot be verified')
        }
      },
      close: () => handle.close()
    }
  } catch (error) {
    await handle.close()
    throw error
  }
}

async function readPreferences(profile, directory, probe, evidence) {
  if (await profile.protocol.isProtocolHandled('app')) throw new Error('Persistent session was opened before migration validation')
  let database
  try {
    database = await guardDatabase(directory)
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new Error('Local Storage database changed during validation; migration cannot be verified', { cause: error })
    throw error
  }
  let window
  try {
    profile.protocol.handle('app', () => new Response('<!doctype html><title>Ripple profile validation</title>', { headers: { 'Content-Type': 'text/html' } }))
    window = new BrowserWindow({ show: false, webPreferences: { session: profile, contextIsolation: true, nodeIntegration: false } })
    await window.loadURL('app://rssreader/index.html')
    const preferences = await window.webContents.executeJavaScript(`(() => {
      const probe = ${JSON.stringify(probe || null)}
      if (probe) {
        if (probe.consume) {
          const persisted = localStorage.getItem(probe.key)
          localStorage.removeItem(probe.key)
          if (persisted !== probe.value) throw new Error('Local Storage did not persist across processes; migration cannot be verified')
        } else {
          localStorage.setItem(probe.key, probe.value)
        }
      }
      return Object.fromEntries(Object.keys(localStorage).filter(key => key.startsWith('rssreader.') || key === 'ui-language').sort().map(key => [key, localStorage.getItem(key)]))
    })()`)
    profile.flushStorageData()
    await database.verify()
    await verifyDatabaseEvidence(evidence)
    return preferences
  } finally {
    window?.destroy()
    profile.protocol.unhandle('app')
    await database.close()
  }
}

exports.runProfileReader = function runProfileReader(directory) {
  let evidence
  try {
    validateProfileWals(directory)
    app.setPath('userData', directory)
    app.setPath('sessionData', directory)
    evidence = captureDatabaseEvidence(directory)
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    app.exit(1)
    return
  }
  protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true } }])
  app.on('window-all-closed', () => {})
  app.whenReady().then(async () => {
    const probe = process.env.RIPPLE_PROFILE_PROBE ? JSON.parse(process.env.RIPPLE_PROFILE_PROBE) : undefined
    const preferences = await readPreferences(session.defaultSession, directory, probe, evidence)
    process.stdout.write(`RIPPLE_PROFILE:${JSON.stringify(preferences)}\n`)
    app.quit()
  }).catch(error => { process.stderr.write(`${error.message}\n`); app.exit(1) }).finally(() => {
    if (evidence) fsSync.closeSync(evidence.descriptor)
  })
}

async function readProfileInChild(directory, probe) {
  const args = app.isPackaged ? [] : [path.join(__dirname, 'main.js')]
  args.push(`--ripple-read-profile=${directory}`)
  const output = await new Promise((resolve, reject) => execFile(process.execPath, args,
    { windowsHide: true, encoding: 'utf8', timeout: 30000, env: { ...process.env, RIPPLE_PROFILE_PROBE: JSON.stringify(probe) } },
    (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout)))
  const record = output.split(/\r?\n/).find(line => line.startsWith('RIPPLE_PROFILE:'))
  if (!record) throw new Error('Backup reading preferences could not be verified')
  return JSON.parse(record.slice('RIPPLE_PROFILE:'.length))
}

exports.verifyMigratedSession = async function verifyMigratedSession(backup) {
  const directory = app.getPath('sessionData')
  validateProfileWals(backup)
  validateProfileWals(directory)
  const checkDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ripple-session-validation-'))
  const targetCheckDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ripple-session-target-validation-'))
  try {
    await fs.cp(backup, checkDirectory, { recursive: true, errorOnExist: true, force: false })
    // Revalidate copied bytes in the child before its ready event as well.
    await fs.cp(directory, targetCheckDirectory, { recursive: true, errorOnExist: true, force: false })
    const probe = { key: `__ripple_migration_verify_${randomUUID()}`, value: randomUUID() }
    const expected = await readProfileInChild(checkDirectory, probe)
    // A second process must recover a committed value; this rules out an
    // in-memory fallback while leaving both real profiles untouched.
    await readProfileInChild(checkDirectory, { ...probe, consume: true })
    const migrated = await readProfileInChild(targetCheckDirectory, probe)
    await readProfileInChild(targetCheckDirectory, { ...probe, consume: true })
    if (JSON.stringify(expected) !== JSON.stringify(migrated)) throw new Error('Migrated reading preferences do not match the verified backup')
    const restored = await readPreferences(session.defaultSession, directory)
    if (JSON.stringify(expected) !== JSON.stringify(restored)) throw new Error('Migrated reading preferences do not match the verified backup')
  } finally {
    await fs.rm(checkDirectory, { recursive: true })
    await fs.rm(targetCheckDirectory, { recursive: true })
  }
}
