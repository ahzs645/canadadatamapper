// Checks the committed snapshot against its manifest before it is published.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const OUTPUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'output')
const manifest = JSON.parse(readFileSync(path.join(OUTPUT_DIR, 'manifest.json'), 'utf8'))
const gz = readFileSync(path.join(OUTPUT_DIR, manifest.output.path))
const json = gunzipSync(gz)
const collection = JSON.parse(json)

const failures = []
const check = (condition, message) => condition || failures.push(message)

check(createHash('sha256').update(gz).digest('hex') === manifest.output.sha256, 'snapshot sha256 differs from manifest')
check(createHash('sha256').update(json).digest('hex') === manifest.output.uncompressedSha256, 'JSON sha256 differs from manifest')
check(collection.features.length === manifest.sites, `snapshot has ${collection.features.length} sites, manifest ${manifest.sites}`)
// A month-on-month drop this large means a broken extract, not decommissioned sites.
check(manifest.sites > 40_000, `only ${manifest.sites} sites`)
for (const operator of ['Bell', 'Rogers', 'TELUS']) {
  check((manifest.operators[operator] ?? 0) > 5_000, `${operator} has ${manifest.operators[operator] ?? 0} sites`)
}

const seen = new Set()
for (const { geometry, properties } of collection.features) {
  const [lon, lat] = geometry.coordinates
  const key = `${lat},${lon}`
  check(!seen.has(key), `duplicate site ${key}`)
  seen.add(key)
  check(lat >= 41 && lat <= 84 && lon >= -142 && lon <= -52, `site outside Canada ${key}`)
  check(properties.operators.length > 0, `site without operator ${key}`)
}

// Licensee contacts are in the source; none may reach the published file.
const text = json.toString('utf8')
for (const field of manifest.method.droppedFields) check(!text.includes(`"${field}"`), `snapshot contains ${field}`)
check(!/[\w.+-]+@[\w-]+\.[\w.]+/.test(text), 'snapshot contains an email address')

if (failures.length) {
  console.error(failures.slice(0, 20).join('\n'))
  console.error(`[ised] ${failures.length} validation failures`)
  process.exit(1)
}
console.log(`[ised] snapshot valid: ${manifest.sites} sites, extract ${manifest.source.extractDate}`)
