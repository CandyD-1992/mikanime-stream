// MKV -> fMP4 无损转封装验证（Mediabunny）
// 用法: node scripts/test-mkv-remux.mjs [path.mkv]
// 输出: scripts/testdata/<name>.fmp4（含 ftyp+moov+若干 moof/mdat 分片）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  Input, Output, Conversion, MATROSKA,
  Mp4OutputFormat, NullTarget, BufferSource,
} from 'mediabunny'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)
const argFile = process.argv[2]
const src = argFile
  ? path.resolve(argFile)
  : path.join(root, 'scripts', 'testdata', 'annex-b-avc.mkv')
const name = path.basename(src, path.extname(src))
const outPath = path.join(root, 'scripts', 'testdata', name + '.fmp4')

const buf = fs.readFileSync(src)
const input = new Input({
  formats: [MATROSKA],
  source: new BufferSource(buf),
})

const tracks = await input.getTracks()
console.log('[mkv] tracks:', tracks.length)
for (const t of tracks) {
  const type = t.type
  const codec = await t.codec
  console.log('  -', type, '| codec:', codec,
    type === 'video'
      ? `| ${await t.getCodedWidth()}x${await t.getCodedHeight()}`
      : `| ${await t.getSampleRate()} Hz / ${await t.getNumberOfChannels()} ch`)
}
const dur = await input.computeDuration()
console.log('[mkv] duration:', dur, 's')

// ---------- 输出 fMP4 ----------
let initBytes = 0
let frags = 0
let fragBytes = 0
let outParts = []
const flush = (part) => { outParts.push(part) }
const format = new Mp4OutputFormat({
  fastStart: 'fragmented',
  minimumFragmentDuration: 1,
  onFtyp: (data) => { initBytes += data.length; flush(data) },
  onMoov: (data) => { initBytes += data.length; flush(data) },
  onMoof: (data, pos, ts) => {
    frags++
    fragBytes += data.length
    flush(data)
  },
  onMdat: (data) => { fragBytes += data.length; flush(data) },
})
const output = new Output({ format, target: new NullTarget() })
const conversion = await Conversion.init({
  input,
  output,
  tracks: 'primary',
  video: {}, // 与源相同编码 -> 直拷（无损封装，不重编码）
  audio: {},
  showWarnings: false,
})
console.log('[conv] isValid:', conversion.isValid,
  '| discarded:', conversion.discardedTracks.map((d) => d.track.number + ':' + d.reason).join(',') || 'none')
if (!conversion.isValid) {
  console.error('[conv] FAILED: cannot transmux')
  process.exit(1)
}
conversion.onProgress = (p) => {
  if (Math.floor(p * 100) % 10 === 0) process.stdout.write(`\r[conv] ${Math.round(p * 100)}%`)
}
await conversion.execute()
process.stdout.write('\n')

fs.writeFileSync(outPath, Buffer.concat(outParts))
console.log('[fmp4] init:', initBytes, 'B | fragments:', frags, '| media bytes:', fragBytes,
  '| total:', fs.statSync(outPath).size, 'B ->', outPath)
await input.dispose()
