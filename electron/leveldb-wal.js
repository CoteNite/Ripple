const fs = require('fs')
const path = require('path')

// Primary format and recovery behavior:
// https://github.com/google/leveldb/blob/main/doc/log_format.md
// https://github.com/google/leveldb/blob/main/db/log_reader.cc
// https://github.com/google/leveldb/blob/main/db/log_writer.cc
// Unlike recovery, migration must not skip a damaged or incomplete commit.
const BLOCK_SIZE = 32768
const HEADER_SIZE = 7
const crcTable = new Uint32Array(256)
for (let index = 0; index < crcTable.length; index++) {
  let crc = index
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0)
  crcTable[index] = crc >>> 0
}

function maskedChecksum(buffer, start, end) {
  let crc = 0xffffffff
  for (let index = start; index < end; index++) crc = crcTable[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8)
  crc = (crc ^ 0xffffffff) >>> 0
  // https://github.com/google/leveldb/blob/main/util/crc32c.h
  return (((crc >>> 15) | (crc << 17)) + 0xa282ead8) >>> 0
}

// WAL logical records are WriteBatches, not arbitrary byte strings. Recovery
// ignores malformed batches with paranoid_checks=false, even with a valid CRC.
// https://github.com/google/leveldb/blob/main/db/write_batch.cc
// https://github.com/google/leveldb/blob/main/db/db_impl.cc (RecoverLogFile)
// Stream the grammar and skip key/value bytes without retaining their contents.
class BatchValidator {
  constructor(fail) {
    this.fail = fail
    this.header = Buffer.allocUnsafe(12)
  }

  begin() {
    this.headerLength = 0
    this.stage = 'header'
    this.count = 0
    this.found = 0
    this.remaining = 0
    this.varint = 0
    this.shift = 0
  }

  feed(buffer, start, end) {
    while (start < end) {
      if (this.stage === 'header') {
        const length = Math.min(12 - this.headerLength, end - start)
        buffer.copy(this.header, this.headerLength, start, start + length)
        this.headerLength += length
        start += length
        if (this.headerLength === 12) {
          this.count = this.header.readUInt32LE(8)
          this.stage = 'tag'
        }
      } else if (this.stage === 'tag') {
        this.tag = buffer[start++]
        if (this.tag !== 0 && this.tag !== 1) this.fail('unknown WriteBatch tag')
        if (++this.found > this.count) this.fail('WriteBatch count mismatch')
        this.stage = 'keyLength'
      } else if (this.stage === 'keyLength' || this.stage === 'valueLength') {
        const byte = buffer[start++]
        if (this.shift === 28 && byte > 15) this.fail('malformed WriteBatch length')
        this.varint += (byte & 0x7f) * (2 ** this.shift)
        if (byte & 0x80) {
          this.shift += 7
        } else {
          this.remaining = this.varint
          this.varint = 0
          this.shift = 0
          this.stage = this.stage === 'keyLength' ? 'key' : 'value'
          if (this.remaining === 0) this.finishString()
        }
      } else {
        const length = Math.min(this.remaining, end - start)
        start += length
        this.remaining -= length
        if (this.remaining === 0) this.finishString()
      }
    }
  }

  finishString() {
    this.stage = this.stage === 'key' && this.tag === 1 ? 'valueLength' : 'tag'
  }

  finish() {
    if (this.stage !== 'tag') this.fail('incomplete WriteBatch')
    if (this.found !== this.count) this.fail('WriteBatch count mismatch')
  }
}

function validateWal(filename, buffer) {
  const descriptor = fs.openSync(filename, 'r')
  let blockOffset = 0
  let recordOffset = 0
  let fragmented = false
  let emptyFirstContinuation = -1
  const fail = reason => { throw new Error(`Local Storage WAL ${path.basename(filename)} at offset ${recordOffset}: ${reason}; migration cannot be verified`) }
  const batch = new BatchValidator(fail)
  try {
    while (true) {
      let size = 0
      while (size < BLOCK_SIZE) {
        const length = fs.readSync(descriptor, buffer, size, BLOCK_SIZE - size, null)
        if (length === 0) break
        size += length
      }
      if (size === 0) break
      let offset = 0
      while (offset < size) {
        recordOffset = blockOffset + offset
        if (size - offset < HEADER_SIZE) {
          // Only the final six positions of a physical block are a trailer.
          // A short header elsewhere at EOF is an incomplete commit.
          if (offset < BLOCK_SIZE - 6) fail('incomplete physical record header')
          for (let index = offset; index < size; index++) if (buffer[index] !== 0) fail('nonzero block trailer')
          break
        }
        const length = buffer.readUInt16LE(offset + 4)
        const type = buffer[offset + 6]
        if (type === 0 && length === 0) {
          // The reader allows mmap preallocation padding, but ignores the
          // whole remaining block. Require every skipped byte to be zero.
          for (let index = offset; index < size; index++) if (buffer[index] !== 0) fail('nonzero block padding')
          if (fragmented) fail('incomplete fragmented record before padding')
          break
        }
        if (offset + HEADER_SIZE + length > size) fail('invalid or incomplete physical record length')
        if (type < 1 || type > 4) fail('unknown physical record type')
        if (buffer.readUInt32LE(offset) !== maskedChecksum(buffer, offset + 6, offset + HEADER_SIZE + length)) fail('checksum mismatch')
        if (type === 1 || type === 2) {
          // log_reader.cc preserves a historical writer quirk: an empty
          // FIRST in the last seven block bytes can precede FULL/FIRST in
          // the next block without discarding any logical payload.
          if (fragmented && recordOffset !== emptyFirstContinuation) fail('fragmented record missing LAST')
          batch.begin()
        } else if (!fragmented) {
          fail('fragmented record missing FIRST')
        }
        batch.feed(buffer, offset + HEADER_SIZE, offset + HEADER_SIZE + length)
        if (type === 1 || type === 4) {
          batch.finish()
          fragmented = false
        } else {
          fragmented = true
        }
        emptyFirstContinuation = type === 2 && length === 0 && offset === BLOCK_SIZE - HEADER_SIZE
          ? blockOffset + BLOCK_SIZE : -1
        offset += HEADER_SIZE + length
      }
      blockOffset += size
      if (size < BLOCK_SIZE) break
    }
    if (fragmented) fail('incomplete fragmented record at EOF')
  } finally {
    fs.closeSync(descriptor)
  }
}

exports.validateProfileWals = function validateProfileWals(directory) {
  const database = path.join(directory, 'Local Storage', 'leveldb')
  let files
  try {
    files = fs.readdirSync(database)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  const logs = files.filter(name => /^\d+\.log$/.test(name)).sort()
  if (logs.length === 0) return
  const buffer = Buffer.allocUnsafe(BLOCK_SIZE)
  for (const name of logs) validateWal(path.join(database, name), buffer)
}
