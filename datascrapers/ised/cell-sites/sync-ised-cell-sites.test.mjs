import assert from 'node:assert/strict'
import { test } from 'node:test'
import { gunzipSync } from 'node:zlib'

import { buildSites, csvRecords, deterministicGzip, operatorFor } from './sync-ised-cell-sites.mjs'

async function collect(chunks) {
  const rows = []
  for await (const row of csvRecords(chunks)) rows.push(row)
  return rows
}

test('csvRecords reads quoted commas, escaped quotes and newlines across chunks', async () => {
  const rows = await collect(['"a,b","say ""hi', '""",x\r\n"multi\nline",', 'y\n'])
  assert.deepEqual(rows, [
    ['a,b', 'say "hi"', 'x'],
    ['multi\nline', 'y'],
  ])
})

test('csvRecords keeps a quote inside an unquoted field literal', async () => {
  const rows = await collect(['12" dish,next\n"q",z\n'])
  assert.deepEqual(rows, [
    ['12" dish', 'next'],
    ['q', 'z'],
  ])
})

test('operatorFor folds filed licensee names into brands', () => {
  assert.equal(operatorFor('FIDO SOLUTIONS INC.'), 'Rogers')
  assert.equal(operatorFor('Telus – Regulatory Affairs'), 'TELUS')
  assert.equal(operatorFor('Bell MTS, a division of Bell Canada'), 'Bell')
  assert.equal(operatorFor('Videotron Ltd. dba Freedom Mobile'), 'Freedom')
  assert.equal(operatorFor('Vidéotron Itée'), 'Vidéotron')
  assert.equal(operatorFor('Sasktel (PCS) Eng. Manager - Wireless Network'), 'SaskTel')
  assert.equal(operatorFor('SSI Micro Ltd.'), 'SSI Micro Ltd.')
})

test('buildSites groups rows by coordinate and rejects slid rows', async () => {
  const header = 'licensee_name*,latitude,longitude,site_type,technology,licence_category*,location,province_code,structure_type,structure_height,date_last_changed'
  const rows = [
    header,
    'Bell Mobility Inc.,53.917060,-122.749300,O,LTE,PCS,1 Main St,BC,T,40,2024-01-02',
    'TELUS Communications Inc.,53.917060,-122.749300,O,5GNR,3500B,....,BC,T,45,2025-03-04',
    'Bell Mobility Inc.,53.917061,-122.749300,O,LTE,AWS,1 Main St,BC,T,40,2024-01-02',
    'Bell Mobility Inc.,53.917160,-122.749300,O,LTE,AWS,2 Main St,BC,R,10,2024-01-02',
    'Bell Mobility Inc.,,-122.7,O,LTE,AWS,x,BC,R,10,2024-01-02',
    'Bell Mobility Inc.,53.9,-122.7,BC,LTE,AWS,x,BC,R,10,2024-01-02',
  ]
  const { sites, read, rejected } = await buildSites(csvRecords([`${rows.join('\n')}\n`]))
  assert.equal(read, 6)
  assert.deepEqual(Object.fromEntries(rejected), { coordinates: 1, 'site-type': 1 })
  assert.equal(sites.size, 2)
  const shared = sites.get('53.91706,-122.74930')
  assert.deepEqual([...shared.operators.keys()].sort(), ['Bell', 'TELUS'])
  assert.equal(shared.heightM, 45)
  assert.equal(shared.lastChanged, '2025-03-04')
  assert.deepEqual([...shared.locations.keys()], ['1 Main St'])
})

test('deterministicGzip pins the header and round-trips', () => {
  const gz = deterministicGzip(Buffer.from('{"a":1}'))
  assert.equal(gz.readUInt32LE(4), 0)
  assert.equal(gz[9], 0xff)
  assert.equal(gunzipSync(gz).toString(), '{"a":1}')
})
