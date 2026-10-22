// Builds one point per cellular site from ISED's Terrestrial Spectrum Licence
// Site Data Extract. The extract has one row per antenna/frequency (about two
// million rows, 1.2 GB of CSV); the deployable snapshot collapses those to the
// ~55k distinct site coordinates and keeps which operators, technologies and
// licence bands are present at each.
//
// Usage:
//   node datascrapers/ised/cell-sites/sync-ised-cell-sites.mjs [--if-changed] [--zip <path>]
//
//   --if-changed  HEAD the source first and exit without work when its
//                 Last-Modified/ETag match the committed manifest.
//   --zip <path>  Use an already-downloaded Site_Data_Extract_FX.zip.

import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SCRIPT_DIR, '../../..')
const OUTPUT_DIR = path.join(SCRIPT_DIR, 'output')
const CACHE_DIR = path.join(REPO_ROOT, 'cache', 'ised')
const MANIFEST_PATH = path.join(OUTPUT_DIR, 'manifest.json')
const SNAPSHOT_NAME = 'cell-sites.geojson.gz'

export const SOURCE_URL = 'https://www.ic.gc.ca/engineering/SMS_TAFL_Files/Site_Data_Extract_FX.zip'
const SOURCE_PAGE_URL = 'https://ised-isde.canada.ca/site/spectrum-management-system/en/spectrum-management-system-data/download-sms-data'
const CSV_ENTRY = 'Site_Data_Extract_FX.csv'

// Five decimal places is about 1 m: rows for one mast agree to the digit, while
// neighbouring masts on one rooftop stay separate.
const KEY_DECIMALS = 5
const CANADA_BOUNDS = { minLat: 41, maxLat: 84, minLon: -142, maxLon: -52 }

// The extract also carries each licensee's contact name, phone and email. They
// are never read, so they cannot reach the snapshot.
const DROPPED_FIELDS = ['contact_name', 'business_telephone', 'email_address']

// Licensee names are as filed, so one operator appears under several legal
// names. Order matters: Freedom is filed as "Videotron Ltd. dba Freedom Mobile".
const OPERATOR_RULES = [
  [/freedom/i, 'Freedom'],
  [/rogers|fido/i, 'Rogers'],
  [/telus/i, 'TELUS'],
  [/\bbell\b/i, 'Bell'],
  [/vid[eé]otron/i, 'Vidéotron'],
  [/sasktel|saskatchewan telecommunications/i, 'SaskTel'],
  [/bragg/i, 'Eastlink'],
  [/xplore/i, 'Xplore'],
  [/tbaytel/i, 'TBayTel'],
  [/railway association/i, 'Railway Association of Canada'],
  [/terago/i, 'TeraGo'],
  [/sogetel/i, 'Sogetel'],
  [/ecotel/i, 'Ecotel'],
  [/^wtc /i, 'WTC Communications'],
  [/x-spectrum/i, 'X-Spectrum'],
]

export function operatorFor(licensee) {
  for (const [pattern, name] of OPERATOR_RULES) if (pattern.test(licensee)) return name
  return licensee.trim()
}

function parseArgs(argv) {
  const args = { ifChanged: false, zip: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--if-changed') args.ifChanged = true
    else if (argv[i] === '--zip') args.zip = argv[++i]
    else throw new Error(`Unknown argument ${argv[i]}`)
  }
  return args
}

function readManifest() {
  return existsSync(MANIFEST_PATH) ? JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) : null
}

async function sourceHeaders(method = 'HEAD') {
  const response = await fetch(SOURCE_URL, { method, headers: method === 'GET' ? {} : { Range: 'bytes=0-0' } })
  if (!response.ok) throw new Error(`${method} ${SOURCE_URL} returned ${response.status}`)
  return response
}

function describeSource(headers, bytes) {
  const lastModified = headers.get('last-modified')
  return {
    url: SOURCE_URL,
    pageUrl: SOURCE_PAGE_URL,
    csvEntry: CSV_ENTRY,
    lastModified,
    extractDate: lastModified ? new Date(lastModified).toISOString().slice(0, 10) : null,
    etag: headers.get('etag'),
    bytes,
  }
}

async function download() {
  mkdirSync(CACHE_DIR, { recursive: true })
  const zipPath = path.join(CACHE_DIR, 'Site_Data_Extract_FX.zip')
  const response = await sourceHeaders('GET')
  console.log(`[ised] downloading ${SOURCE_URL}`)
  await pipeline(Readable.fromWeb(response.body), createWriteStream(zipPath))
  const bytes = statSync(zipPath).size
  const expected = Number(response.headers.get('content-length'))
  if (expected && expected !== bytes) throw new Error(`Downloaded ${bytes} bytes, expected ${expected}`)
  return { zipPath, source: describeSource(response.headers, bytes) }
}

/**
 * Streaming RFC 4180 reader: quoted fields may hold commas, quotes and newlines.
 * A quote opens a quoted field only at the field's start; elsewhere (an inch
 * mark in an unquoted field) it is literal, as Python's csv module reads it.
 * Treating it as an opener swallowed the rest of the file into one field.
 */
export async function* csvRecords(stream) {
  let field = ''
  let record = []
  let inQuotes = false
  let quotePending = false
  let atFieldStart = true
  for await (const chunk of stream) {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    let start = 0
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i)
      if (inQuotes) {
        if (code !== 34) continue
        field += text.slice(start, i)
        start = i + 1
        inQuotes = false
        quotePending = true
        continue
      }
      if (code === 34 && (quotePending || atFieldStart)) {
        // A quote straight after a closing quote is an escaped quote.
        field += text.slice(start, i) + (quotePending ? '"' : '')
        start = i + 1
        inQuotes = true
        quotePending = false
        atFieldStart = false
        continue
      }
      quotePending = false
      if (code === 44) {
        record.push(field + text.slice(start, i))
        field = ''
        start = i + 1
        atFieldStart = true
      } else if (code === 10) {
        record.push((field + text.slice(start, i)).replace(/\r$/, ''))
        yield record
        field = ''
        record = []
        start = i + 1
        atFieldStart = true
      } else {
        atFieldStart = false
      }
    }
    field += text.slice(start)
    if (field.length > 1_000_000) throw new Error('CSV field passed 1 MB; the source likely has an unclosed quote')
  }
  if (field !== '' || record.length) {
    record.push(field)
    yield record
  }
}

function csvStreamFromZip(zipPath) {
  const entries = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' }).split('\n').filter(Boolean)
  if (!entries.includes(CSV_ENTRY)) throw new Error(`${zipPath} has no ${CSV_ENTRY}; entries: ${entries.join(', ')}`)
  const child = spawn('unzip', ['-p', zipPath, CSV_ENTRY], { stdio: ['ignore', 'pipe', 'inherit'] })
  child.stdout.setEncoding('utf8')
  const exited = new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`unzip exited ${code}`))))
  })
  return { stream: child.stdout, exited }
}

function bump(counter, key, by = 1) {
  counter.set(key, (counter.get(key) ?? 0) + by)
}

function mostCommon(counter) {
  let best = null
  let bestCount = -1
  for (const [key, count] of [...counter].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (count > bestCount) [best, bestCount] = [key, count]
  }
  return best
}

const sorted = (values) => [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
const isPlaceholder = (text) => /^[\s.\-_*]*$/.test(text)

export async function buildSites(records) {
  const header = (await records.next()).value.map((name) => name.replace(/^﻿/, '').replace(/\*$/, ''))
  const column = Object.fromEntries(header.map((name, index) => [name, index]))
  for (const required of ['licensee_name', 'latitude', 'longitude', 'site_type', 'technology', 'licence_category']) {
    if (!(required in column)) throw new Error(`Source header has no ${required} column`)
  }
  const get = (row, name) => (row[column[name]] ?? '').trim()

  const sites = new Map()
  const rejected = new Map()
  let read = 0
  for await (const row of records) {
    read++
    if (row.length !== header.length) {
      bump(rejected, 'column-count')
      continue
    }
    const lat = Number(get(row, 'latitude'))
    const lon = Number(get(row, 'longitude'))
    const siteType = get(row, 'site_type')
    if (!get(row, 'latitude') || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      bump(rejected, 'coordinates')
      continue
    }
    if (lat < CANADA_BOUNDS.minLat || lat > CANADA_BOUNDS.maxLat || lon < CANADA_BOUNDS.minLon || lon > CANADA_BOUNDS.maxLon) {
      bump(rejected, 'outside-canada')
      continue
    }
    // Only O/I are valid; anything else is a row whose columns slid.
    if (siteType !== 'O' && siteType !== 'I') {
      bump(rejected, 'site-type')
      continue
    }

    const key = `${lat.toFixed(KEY_DECIMALS)},${lon.toFixed(KEY_DECIMALS)}`
    let site = sites.get(key)
    if (!site) {
      site = {
        lat: Number(lat.toFixed(KEY_DECIMALS)),
        lon: Number(lon.toFixed(KEY_DECIMALS)),
        provinces: new Map(),
        locations: new Map(),
        siteTypes: new Set(),
        structureTypes: new Set(),
        heightM: 0,
        lastChanged: '',
        records: 0,
        operators: new Map(),
      }
      sites.set(key, site)
    }
    site.records++
    bump(site.provinces, get(row, 'province_code'))
    const location = get(row, 'location')
    if (!isPlaceholder(location)) bump(site.locations, location)
    site.siteTypes.add(siteType)
    const structureType = get(row, 'structure_type')
    if (structureType) site.structureTypes.add(structureType)
    const height = Number(get(row, 'structure_height'))
    if (Number.isFinite(height) && height > site.heightM) site.heightM = height
    const changed = get(row, 'date_last_changed')
    if (/^\d{4}-\d{2}-\d{2}$/.test(changed) && changed > site.lastChanged) site.lastChanged = changed

    const licensee = get(row, 'licensee_name')
    const operatorName = operatorFor(licensee)
    let operator = site.operators.get(operatorName)
    if (!operator) {
      operator = { licensees: new Set(), technologies: new Set(), bands: new Set(), records: 0 }
      site.operators.set(operatorName, operator)
    }
    operator.records++
    operator.licensees.add(licensee)
    const technology = get(row, 'technology')
    if (technology) operator.technologies.add(technology)
    const band = get(row, 'licence_category')
    if (band) operator.bands.add(band)
  }
  return { sites, read, rejected }
}

function toFeature(site) {
  // Legal licensee names live once in the manifest; per site the brand is enough.
  const operators = sorted(site.operators.keys())
  const byOperator = Object.fromEntries(
    operators.map((name) => {
      const operator = site.operators.get(name)
      return [name, { technologies: sorted(operator.technologies), bands: sorted(operator.bands) }]
    }),
  )
  const perOperator = Object.values(byOperator)
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [site.lon, site.lat] },
    properties: {
      province: mostCommon(site.provinces),
      location: mostCommon(site.locations),
      siteTypes: sorted(site.siteTypes),
      structureTypes: sorted(site.structureTypes),
      heightM: site.heightM || null,
      lastChanged: site.lastChanged || null,
      operators,
      technologies: sorted(new Set(perOperator.flatMap((entry) => entry.technologies))),
      bands: sorted(new Set(perOperator.flatMap((entry) => entry.bands))),
      records: site.records,
      byOperator,
    },
  }
}

/** gzip output is byte-identical across machines: mtime is already 0, and the OS byte is pinned. */
export function deterministicGzip(buffer) {
  const gz = gzipSync(buffer, { level: 9 })
  gz[9] = 0xff
  return gz
}

function tally(features, valuesOf) {
  const counter = new Map()
  for (const feature of features) for (const value of valuesOf(feature.properties)) bump(counter, value)
  return Object.fromEntries([...counter].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)))
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const previous = readManifest()

  if (args.ifChanged && !args.zip && previous?.source) {
    const head = await sourceHeaders()
    const current = describeSource(head.headers, null)
    if (current.lastModified === previous.source.lastModified && current.etag === previous.source.etag) {
      console.log(`[ised] source unchanged since ${previous.source.extractDate}; nothing to do`)
      return
    }
  }

  let zipPath
  let source
  if (args.zip) {
    zipPath = path.resolve(args.zip)
    const bytes = statSync(zipPath).size
    // The live headers describe this file only if it is the same size as the
    // live extract; otherwise the local copy is an older month.
    const head = await sourceHeaders().catch(() => null)
    const liveBytes = Number(head?.headers.get('content-range')?.split('/')[1])
    source =
      head && liveBytes === bytes
        ? describeSource(head.headers, bytes)
        : { url: SOURCE_URL, pageUrl: SOURCE_PAGE_URL, csvEntry: CSV_ENTRY, lastModified: null, extractDate: null, etag: null, bytes }
  } else {
    ;({ zipPath, source } = await download())
  }

  console.log(`[ised] reading ${CSV_ENTRY}`)
  const { stream, exited } = csvStreamFromZip(zipPath)
  const { sites, read, rejected } = await buildSites(csvRecords(stream))
  await exited

  const features = sorted(sites.keys())
    .map((key) => sites.get(key))
    .sort((a, b) => a.lat - b.lat || a.lon - b.lon)
    .map(toFeature)
  const collection = { type: 'FeatureCollection', features }
  const json = Buffer.from(JSON.stringify(collection))
  const gz = deterministicGzip(json)

  mkdirSync(OUTPUT_DIR, { recursive: true })
  writeFileSync(path.join(OUTPUT_DIR, SNAPSHOT_NAME), gz)

  const used = read - [...rejected.values()].reduce((sum, count) => sum + count, 0)
  const licensees = new Map()
  for (const site of sites.values()) {
    for (const [name, operator] of site.operators) {
      if (!licensees.has(name)) licensees.set(name, new Set())
      for (const licensee of operator.licensees) licensees.get(name).add(licensee)
    }
  }
  const manifest = {
    dataset: 'ised-cell-sites',
    title: 'Canadian cellular and spectrum-licence sites',
    publisher: 'Innovation, Science and Economic Development Canada (ISED)',
    licence: 'Open Government Licence – Canada',
    licenceUrl: 'https://open.canada.ca/en/open-government-licence-canada',
    attribution: 'Contains information licensed under the Open Government Licence – Canada (ISED Spectrum Management System).',
    caveat:
      'Sites are what licensees report to ISED, not measured coverage. One point is one reported coordinate; operators sharing a mast appear on the same point.',
    source,
    method: {
      keyDecimals: KEY_DECIMALS,
      grouping: 'Rows sharing latitude/longitude rounded to keyDecimals form one site.',
      bands: 'ISED licence_category codes (e.g. CELL, PCS, AWS, 600B, MBS, BRS, 3500B, 3800B).',
      siteTypes: 'O outdoor, I indoor.',
      droppedFields: DROPPED_FIELDS,
    },
    rows: {
      read,
      used,
      rejected: Object.fromEntries(sorted(rejected.keys()).map((key) => [key, rejected.get(key)])),
    },
    sites: features.length,
    operators: tally(features, (p) => p.operators),
    licensees: Object.fromEntries(sorted(licensees.keys()).map((name) => [name, sorted(licensees.get(name))])),
    provinces: tally(features, (p) => [p.province]),
    technologies: tally(features, (p) => p.technologies),
    bands: tally(features, (p) => p.bands),
    output: {
      path: SNAPSHOT_NAME,
      bytes: gz.length,
      uncompressedBytes: json.length,
      sha256: createHash('sha256').update(gz).digest('hex'),
      // Node's zlib may compress differently per CPU architecture; the JSON
      // digest is the cross-machine comparison.
      uncompressedSha256: createHash('sha256').update(json).digest('hex'),
    },
  }
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`)

  console.log(
    `[ised] ${features.length} sites from ${used}/${read} rows; ${(gz.length / 1e6).toFixed(2)} MB gz (${(json.length / 1e6).toFixed(1)} MB raw)`,
  )
  if (rejected.size) console.log('[ised] rejected rows', Object.fromEntries(rejected))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
