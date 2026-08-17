#!/usr/bin/env node
//
// Leaflet steht an DREI Stellen: als <script>/<link> in `index.html` und
// `index-map.html`, und als Nachlade-Adresse in `Minimap.js` (die reine
// 3D-Seite bindet Leaflet nicht ein). Laufen die auseinander, lädt eine Seite
// zwei Leaflet-Versionen gleichzeitig oder der SRI-Hash schlägt fehl und die
// Minimap bleibt grau — beides fällt beim Entwickeln nicht auf, weil die
// jeweils ANDERE Seite weiter funktioniert.
//
// Zusammenlegen geht nicht: die HTML-Seiten brauchen echte Tags, ein
// JS-Konstante kann das nicht liefern. Also wird die Gleichheit geprüft.

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), '..')
const lies = (f) => readFileSync(join(CLIENT, f), 'utf8')

const ergebnisse = []
const pruefe = (name, ok, detail = '') => {
  ergebnisse.push({ name, ok: !!ok })
  console.log(`   ${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
}

// Aus einer Quelle alle Leaflet-Adressen samt Integrity-Hash ziehen.
const funde = (text) => {
  const out = []
  for (const m of text.matchAll(/(https:\/\/unpkg\.com\/leaflet@[\d.]+\/dist\/leaflet\.(?:js|css))/g)) out.push(m[1])
  return [...new Set(out)].sort()
}
const hashes = (text) => [...new Set(
  [...text.matchAll(/integrity\s*[:=]\s*["']?(sha\d+-[A-Za-z0-9+/=]+)["']?/g)].map(m => m[1])
)].sort()

const quellen = {
  'index.html': lies('index.html'),
  'index-map.html': lies('index-map.html'),
  'core/Minimap.js': lies('core/Minimap.js'),
}

for (const [name, text] of Object.entries(quellen)) {
  pruefe(`${name} nennt Leaflet-CSS und -JS`, funde(text).length === 2, funde(text).join(' '))
}

const [a, b, c] = Object.values(quellen).map(funde)
pruefe('alle drei Stellen nennen dieselben Leaflet-Adressen',
  JSON.stringify(a) === JSON.stringify(b) && JSON.stringify(b) === JSON.stringify(c),
  [...new Set([...a, ...b, ...c])].join(' '))

const [ha, hb, hc] = Object.values(quellen).map(hashes)
pruefe('alle drei Stellen nennen dieselben SRI-Hashes',
  JSON.stringify(ha) === JSON.stringify(hb) && JSON.stringify(hb) === JSON.stringify(hc),
  `${ha.length} Hash(es)`)

// Die reine 3D-Seite darf Leaflet NICHT fest einbinden — sonst zahlt jeder
// AR-Start den Download, obwohl die Minimap vielleicht nie geöffnet wird.
pruefe('index-ar.html bindet Leaflet nicht ein', funde(lies('index-ar.html')).length === 0)

const fehler = ergebnisse.filter(r => !r.ok)
console.log(fehler.length ? `\n❌ ${fehler.length} Prüfung(en) fehlgeschlagen` : '\nPASS ✅')
process.exit(fehler.length ? 1 : 0)
