const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { createHash } = require('node:crypto')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')

const execute = promisify(execFile)
const repository = path.resolve(__dirname, '../..')
const electron = require('electron')
const fixture = path.join(__dirname, 'fixtures/session-migration.js')
const localPython = path.join(repository, '.venv', 'Scripts', 'python.exe')
const python = process.env.RIPPLE_TEST_PYTHON || (fsSync.existsSync(localPython) ? localPython : 'python')
const preferences = { 'rssreader.theme': 'dark', 'ui-language': 'zh-CN' }

async function runElectron(args, prefix = 'RIPPLE_TEST:') {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.RIPPLE_PROFILE_PROBE
  const { stdout } = await execute(electron, args, { cwd: repository, env, windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 })
  const record = stdout.split(/\r?\n/).find(line => line.startsWith(prefix))
  assert.ok(record, `Electron did not return ${prefix}: ${stdout}`)
  return JSON.parse(record.slice(prefix.length))
}

async function snapshot(directory) {
  const hashes = {}
  async function visit(relative) {
    for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name)
      if (entry.isDirectory()) await visit(name)
      else if (entry.isFile()) hashes[name] = createHash('sha256').update(await fs.readFile(path.join(directory, name))).digest('hex')
    }
  }
  await visit('')
  return hashes
}

async function prepare(root, source) {
  const installation = path.join(root, 'Ripple 安装')
  await fs.mkdir(installation)
  const script = `from pathlib import Path
import json, sqlite3, sys
from app.services.installation_data import prepare_installation_data
source = Path(sys.argv[1])
with sqlite3.connect(source / 'app.db') as connection:
    connection.executescript("CREATE TABLE feeds(id INTEGER PRIMARY KEY, title TEXT); CREATE TABLE entries(id INTEGER PRIMARY KEY, title TEXT); INSERT INTO feeds VALUES(1, 'Original feed'); INSERT INTO entries VALUES(1, 'Original article');")
connection.close()
print(json.dumps(prepare_installation_data(Path(sys.argv[2]), [source])))`
  const { stdout } = await execute(python, ['-c', script, source, installation], { cwd: path.join(repository, 'backend'), windowsHide: true, timeout: 30000 })
  return { ...JSON.parse(stdout.trim()), installation }
}

async function seed(root, mode = 'seed') {
  const source = path.join(root, 'legacy')
  await fs.mkdir(source)
  // A prior process commits VERSION before the preference-only WAL write.
  await runElectron([fixture, 'bootstrap', source])
  const result = await runElectron([fixture, mode, source])
  assert.equal(result.electron, '33.4.11', 'This regression must use the reported Electron runtime')
  const database = path.join(source, 'Local Storage', 'leveldb')
  const names = await fs.readdir(database)
  assert.ok(names.includes('CURRENT'))
  assert.ok(names.includes('LOCK'))
  assert.ok(names.some(name => /^MANIFEST-\d+$/.test(name)))
  // Locate a real Chromium-written physical record containing the seeded key.
  // Alter only its payload; leave the checksum, lengths, MANIFEST and LOCK intact.
  for (const name of names.filter(name => /^\d+\.log$/.test(name))) {
    const filename = path.join(database, name)
    const data = await fs.readFile(filename)
    for (let block = 0; block < data.length; block += 32768) {
      const end = Math.min(block + 32768, data.length)
      for (let offset = block; offset + 7 <= end;) {
        const length = data.readUInt16LE(offset + 4)
        if (data[offset + 6] === 0 && length === 0) break
        assert.ok(offset + 7 + length <= end, 'Seeded WAL must contain complete physical records')
        const payload = data.subarray(offset + 7, offset + 7 + length)
        const key = payload.indexOf(Buffer.from('rssreader.theme'))
        if (key !== -1) return { source, filename, offset, corruptOffset: offset + 7 + key, data }
        offset += 7 + length
      }
    }
  }
  assert.fail('Electron must persist the seeded preference in a numeric .log WAL')
}

test('valid Electron preferences migrate before source cleanup', { timeout: 180000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ripple-wal-valid-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const seeded = await seed(root, 'seed-large')
  const prepared = await prepare(root, seeded.source)
  const backupBefore = await snapshot(prepared.backup)
  const result = await runElectron([fixture, 'verify', prepared.sessionData, prepared.backup, prepared.installation, python])
  assert.deepEqual(result, { accepted: true })
  const restored = await runElectron([path.join(repository, 'electron/main.js'), `--ripple-read-profile=${prepared.sessionData}`], 'RIPPLE_PROFILE:')
  assert.deepEqual(restored, { 'rssreader.large': 'x'.repeat(70000), ...preferences }, 'The control must retain nonempty known preferences across WAL fragments')
  assert.deepEqual(await snapshot(prepared.backup), backupBefore)
  assert.equal(JSON.parse(await fs.readFile(path.join(prepared.userData, 'ripple-state.json'), 'utf8')).state, 'active')
  assert.equal(fsSync.existsSync(path.join(seeded.source, 'app.db')), false)
})

test('matching corrupted Electron WALs reject migration and preserve source and backup', { timeout: 180000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ripple-wal-corrupt-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const seeded = await seed(root)
  // Legal preallocation padding moves any later persistence probe to a new
  // block. Chromium can skip this corrupted block while still persisting it.
  const corrupted = Buffer.alloc(Math.ceil(seeded.data.length / 32768) * 32768)
  seeded.data.copy(corrupted)
  corrupted[seeded.corruptOffset] ^= 1
  await fs.writeFile(seeded.filename, corrupted)
  const prepared = await prepare(root, seeded.source)
  const relative = path.relative(seeded.source, seeded.filename)
  assert.deepEqual(await fs.readFile(path.join(prepared.backup, relative)), corrupted)
  assert.deepEqual(await fs.readFile(path.join(prepared.sessionData, relative)), corrupted)
  const sourceBefore = await snapshot(seeded.source)
  const backupBefore = await snapshot(prepared.backup)
  const targetBefore = await snapshot(prepared.sessionData)
  const result = await runElectron([fixture, 'verify', prepared.sessionData, prepared.backup, prepared.installation, python])
  assert.equal(result.accepted, false, 'Matching damaged profiles must not authorize source cleanup')
  assert.match(result.error, /Local Storage WAL.*\d+\.log.*offset.*checksum/i)
  await assert.rejects(runElectron([path.join(repository, 'electron/main.js'), `--ripple-read-profile=${prepared.sessionData}`], 'RIPPLE_PROFILE:'), error => {
    assert.equal(error.code, 1, 'The synchronous pre-ready guard must exit without an Electron error dialog')
    assert.equal(error.killed, false)
    assert.match(error.stderr, /Local Storage WAL.*\d+\.log.*offset.*checksum/i)
    return true
  })
  assert.deepEqual(await snapshot(seeded.source), sourceBefore, 'Every source file, including SQLite and WAL, must remain byte-identical')
  assert.deepEqual(await snapshot(prepared.backup), backupBefore, 'Every backup file must remain byte-identical')
  assert.deepEqual(await snapshot(prepared.sessionData), targetBefore, 'Reject before Chromium changes the target')
  assert.equal(JSON.parse(await fs.readFile(path.join(prepared.userData, 'ripple-state.json'), 'utf8')).state, 'awaiting-session')
})

test('a valid backup cannot authorize opening a corrupted migration target', { timeout: 180000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ripple-wal-target-corrupt-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const seeded = await seed(root)
  const prepared = await prepare(root, seeded.source)
  const targetWal = path.join(prepared.sessionData, path.relative(seeded.source, seeded.filename))
  const corrupted = Buffer.from(seeded.data)
  corrupted[seeded.offset] ^= 1
  await fs.writeFile(targetWal, corrupted)
  const sourceBefore = await snapshot(seeded.source)
  const backupBefore = await snapshot(prepared.backup)
  const targetBefore = await snapshot(prepared.sessionData)
  const result = await runElectron([fixture, 'verify', prepared.sessionData, prepared.backup, prepared.installation, python])
  assert.equal(result.accepted, false)
  assert.match(result.error, /Local Storage WAL.*\d+\.log.*offset.*checksum/i)
  assert.deepEqual(await snapshot(seeded.source), sourceBefore)
  assert.deepEqual(await snapshot(prepared.backup), backupBefore)
  assert.deepEqual(await snapshot(prepared.sessionData), targetBefore)
  assert.equal(JSON.parse(await fs.readFile(path.join(prepared.userData, 'ripple-state.json'), 'utf8')).state, 'awaiting-session')
})
