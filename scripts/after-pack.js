const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function collectFiles(root, relative = '') {
  const files = []
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const entryRelative = path.join(relative, entry.name)
    if (relative === '' && ['ripple-data', 'ripple-migration-backup', 'ripple-program-files.json'].includes(entry.name)) continue
    if (entry.isSymbolicLink()) throw new Error(`Packaged program tree contains a symbolic link: ${entryRelative}`)
    if (entry.isDirectory()) files.push(...collectFiles(root, entryRelative))
    else if (entry.isFile()) files.push(entryRelative.split(path.sep).join('/'))
  }
  return files
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return
  const files = collectFiles(context.appOutDir)
  const manifest = {
    version: 1,
    files: Object.fromEntries(files.map(relative => [relative, hashFile(path.join(context.appOutDir, relative))]))
  }
  fs.writeFileSync(path.join(context.appOutDir, 'ripple-program-files.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}
