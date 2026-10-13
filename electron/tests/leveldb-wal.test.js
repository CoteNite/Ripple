const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { validateProfileWals } = require('../leveldb-wal')

// Independent bit-at-a-time CRC writer for format fixtures; no production
// parser/CRC is used to manufacture the input. The real Electron regression
// separately supplies Chromium-written records.
function physical(type, payload) {
  const record = Buffer.alloc(7 + payload.length)
  record.writeUInt16LE(payload.length, 4)
  record[6] = type
  payload.copy(record, 7)
  let crc = 0xffffffff
  for (const byte of record.subarray(6)) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0)
  }
  crc = (crc ^ 0xffffffff) >>> 0
  record.writeUInt32LE((((crc >>> 15) | (crc << 17)) + 0xa282ead8) >>> 0)
  return record
}

// sequence=1, count=1, Put('k', 'v'), according to WriteBatch's public format.
const put = Buffer.from('01000000000000000100000001016b0176', 'hex')
const empty = Buffer.from('010000000000000000000000', 'hex')

function profile(t, logs) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ripple-wal-shape-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const database = path.join(directory, 'Local Storage', 'leveldb')
  fs.mkdirSync(database, { recursive: true })
  for (const [name, contents] of Object.entries(logs)) fs.writeFileSync(path.join(database, name), contents)
  return directory
}

function rejected(t, data, reason) {
  const directory = profile(t, { '000003.log': data })
  assert.throws(() => validateProfileWals(directory), error => {
    assert.match(error.message, /Local Storage WAL 000003\.log at offset \d+:/)
    assert.match(error.message, reason)
    return true
  })
}

test('accepts empty WALs, complete batches, zero block padding and short trailers', t => {
  const padded = Buffer.alloc(32768)
  physical(1, put).copy(padded)
  // A single valid deletion with a 32743-byte key leaves two trailer bytes.
  const deletion = Buffer.concat([Buffer.from('01000000000000000100000000', 'hex'), Buffer.from([0xe7, 0xff, 0x01]), Buffer.alloc(32743)])
  assert.equal(deletion.length, 32759)
  const legalTrailer = Buffer.concat([physical(1, deletion), Buffer.alloc(2), physical(1, empty)])
  const directory = profile(t, { '000003.log': Buffer.alloc(0), '000004.log': Buffer.concat([padded, physical(1, put)]), '000005.log': legalTrailer, 'LOG': Buffer.from('diagnostic log') })
  assert.doesNotThrow(() => validateProfileWals(directory))
})

test('accepts batches spanning FIRST/MIDDLE/LAST and an empty FIRST at block end', t => {
  const payload = Buffer.concat([Buffer.from('01000000000000000100000001016b', 'hex'), Buffer.from([0xf0, 0xa2, 0x04]), Buffer.alloc(70000)])
  const fragmented = Buffer.concat([physical(2, payload.subarray(0, 32761)), physical(3, payload.subarray(32761, 65522)), physical(4, payload.subarray(65522))])
  // Empty first fragment is legal when only its seven-byte header fits.
  const key = Buffer.alloc(32738)
  const preceding = Buffer.concat([Buffer.from('01000000000000000100000000', 'hex'), Buffer.from([0xe2, 0xff, 0x01]), key])
  assert.equal(preceding.length, 32761 - 7)
  const marginal = Buffer.concat([physical(1, preceding), physical(2, Buffer.alloc(0)), physical(4, put)])
  assert.doesNotThrow(() => validateProfileWals(profile(t, { '000003.log': fragmented, '000004.log': marginal })))
})

test('accepts historical empty FIRST at block tail before FULL or another FIRST', t => {
  const preceding = Buffer.concat([Buffer.from('01000000000000000100000000', 'hex'), Buffer.from([0xe2, 0xff, 0x01]), Buffer.alloc(32738)])
  const tail = Buffer.concat([physical(1, preceding), physical(2, Buffer.alloc(0))])
  assert.equal(tail.length, 32768)
  const payload = Buffer.concat([Buffer.from('01000000000000000100000001016b', 'hex'), Buffer.from([0xf0, 0xa2, 0x04]), Buffer.alloc(70000)])
  const nextFirst = Buffer.concat([physical(2, payload.subarray(0, 32761)), physical(3, payload.subarray(32761, 65522)), physical(4, payload.subarray(65522))])
  assert.doesNotThrow(() => validateProfileWals(profile(t, {
    '000003.log': Buffer.concat([tail, physical(1, put)]),
    '000004.log': Buffer.concat([tail, nextFirst])
  })))
})

test('rejects checksum mismatches in every numeric WAL', t => {
  const damaged = physical(1, put)
  damaged[damaged.length - 1] ^= 1
  const directory = profile(t, { '000003.log': physical(1, put), '000009.log': damaged })
  assert.throws(() => validateProfileWals(directory), /000009\.log at offset 0: checksum mismatch/)
})

test('rejects records Chromium could silently discard', async t => {
  const wrongCount = Buffer.from(put)
  wrongCount.writeUInt32LE(2, 8)
  const unknownBatchTag = Buffer.from(put)
  unknownBatchTag[12] = 9
  const deletion = Buffer.concat([Buffer.from('01000000000000000100000000', 'hex'), Buffer.from([0xe7, 0xff, 0x01]), Buffer.alloc(32743)])
  const cases = [
    ['unknown type', physical(9, put), /unknown physical record type/],
    ['missing FIRST', physical(3, put), /missing FIRST/],
    ['unexpected LAST', physical(4, put), /missing FIRST/],
    ['missing LAST', physical(2, put), /incomplete fragmented record/],
    ['interrupted fragment', Buffer.concat([physical(2, put), physical(1, put)]), /missing LAST/],
    ['replacement FIRST', Buffer.concat([physical(2, put), physical(2, put)]), /missing LAST/],
    ['empty FIRST away from block tail', Buffer.concat([physical(2, Buffer.alloc(0)), physical(1, put)]), /missing LAST/],
    ['empty FIRST at EOF', physical(2, Buffer.alloc(0)), /incomplete fragmented record/],
    ['truncated header', Buffer.from([0, 0, 0]), /incomplete physical record header/],
    ['truncated payload', physical(1, put).subarray(0, 12), /physical record length/],
    ['cross-block length', Buffer.concat([physical(1, put).subarray(0, 7), Buffer.alloc(32761)]).map((byte, index) => index === 5 ? 0xff : byte), /physical record length/],
    ['short batch', physical(1, Buffer.alloc(11)), /incomplete WriteBatch/],
    ['count mismatch', physical(1, wrongCount), /count mismatch/],
    ['unknown batch tag', physical(1, unknownBatchTag), /unknown WriteBatch tag/],
    ['incomplete varstring', physical(1, put.subarray(0, put.length - 1)), /incomplete WriteBatch/],
    ['missing varint', physical(1, put.subarray(0, 13)), /incomplete WriteBatch/],
    ['nonzero trailer', Buffer.concat([physical(1, deletion), Buffer.from([0, 1])]), /nonzero block trailer/],
    ['fragment before padding', Buffer.concat([physical(2, put), Buffer.alloc(7)]), /incomplete fragmented record before padding/],
    ['overflow varint', physical(1, Buffer.concat([put.subarray(0, 13), Buffer.from([255, 255, 255, 255, 16])])), /malformed WriteBatch length/],
    ['unterminated varint', physical(1, Buffer.concat([put.subarray(0, 13), Buffer.from([128, 128, 128, 128, 128])])), /malformed WriteBatch length/],
    ['hidden data after padding', Buffer.concat([Buffer.alloc(7), physical(1, put)]), /nonzero block padding/]
  ]
  for (const [name, data, reason] of cases) await t.test(name, child => rejected(child, data, reason))
})
