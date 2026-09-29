// i18n — Oberflächentexte in mehreren Sprachen, ohne Zwang.
//
// DER ENTWURFSGEDANKE: DER DEUTSCHE SATZ IST DER SCHLÜSSEL.
//
//   t('Erledigt melden')        → "Report as done" / "Erledigt melden"
//   'Erledigt melden'           → funktioniert weiter, eben nur auf Deutsch
//
// Kein `t('quest.submit.label')`. Schlüsselnamen sind eine zweite Sprache, die
// man ebenfalls pflegen muss, und im Code sieht man dann nicht mehr, was
// dasteht. Mit dem Klartext als Schlüssel ist eine nicht übersetzte Stelle kein
// Fehler, sondern einfach Deutsch — das System bleibt jederzeit lauffähig, auch
// halb übersetzt.
//
// Folge, die man kennen muss: Wird der deutsche Satz geändert, verliert er
// seine Übersetzung und fällt auf Deutsch zurück. Das ist der Preis, und er ist
// billiger als der umgekehrte Fehler — ein Schlüssel, dessen Übersetzung
// stillschweigend etwas anderes sagt als das Original. `fehlende()` listet auf,
// was nachzutragen ist.
//
// WARUM DER ZUSTAND AN `window` HÄNGT
//
// Ajna wird in VIER Bündel gepackt (ar, map, agent, mobile). Jedes bekommt
// seine EIGENE Instanz jedes Moduls. Läge die aktive Sprache in einer
// Modulvariablen, hätte die Shell (mobile) eine andere als die Karte (map): Das
// Umstellen in den Einstellungen wirkte dann nur auf die Einstellungen selbst,
// und sonst nirgends. Genau das ist beim ersten Anlauf passiert.
//
// Derselbe Grund wie bei `window.ajnaLog` — ein geteilter Zustand über
// Bündelgrenzen hinweg braucht einen gemeinsamen Ort, und den gibt es hier nur
// am globalen Objekt.
//
// EINSETZUNGEN mit benannten Platzhaltern:
//
//   t('{n} Punkte bis Karma {stufe}.', { n: 4, stufe: 3 })
//
// PLURAL bleibt bewusst außen vor. Eine echte Pluralregel (Polnisch hat drei
// Formen) gehört in eine Bibliothek, nicht in 40 Zeilen. Bis dahin: Sätze so
// formulieren, dass die Zahl davorsteht („3 Objekte"), nicht mitgebeugt wird.
//
// WAS HIER NICHT ÜBERSETZT WIRD
//   • Inhalte von Menschen — Auftragstexte, Objektnamen, Nachrichten. Niemals.
//   • Inhalte von Agents — Beschreibungen, POI-Namen, Dialoge. Das sind DATEN;
//     dafür gibt es core/Sprachwahl.js (Sprachkarten am Datensatz).
//   • Server-Meldungen. Die kommen mit einem stabilen `code`; die Zuordnung
//     Code → Satz steht in der jeweiligen Sprachdatei wie jeder andere Text.

/** Sprachen, für die eine Datei vorliegt. Deutsch ist die Quellsprache. */
export const SPRACHEN = [
  { code: 'de', label: 'Deutsch' },
  { code: 'en', label: 'English' },
]

const SPEICHER = 'ajna.sprache'

/** Geteilter Zustand — einer für alle Bündel (siehe Kopf). */
const zustand = (() => {
  const g = (typeof window !== 'undefined' ? window : globalThis)
  if (!g.__ajnaI18n) {
    g.__ajnaI18n = { aktiv: 'de', katalog: {}, fehlend: new Set(), hoerer: new Set(), laedt: null }
  }
  return g.__ajnaI18n
})()

/**
 * Gewünschte Sprache: Einstellung des Nutzers, sonst die des Browsers, sonst
 * Deutsch. Nur Sprachen, für die es eine Datei gibt — sonst zeigten wir eine
 * halb leere Oberfläche statt einer ganzen deutschen.
 */
export function gewuenschteSprache() {
  try {
    const gesetzt = localStorage.getItem(SPEICHER)
    if (gesetzt && SPRACHEN.some(s => s.code === gesetzt)) return gesetzt
  } catch { /* gesperrt → weiter unten */ }
  try {
    for (const w of (navigator.languages || [navigator.language || ''])) {
      const kurz = String(w).slice(0, 2).toLowerCase()
      if (SPRACHEN.some(s => s.code === kurz)) return kurz
    }
  } catch {}
  return 'de'
}

/** Aktuell gesetzte Sprache. */
export const sprache = () => zustand.aktiv

/**
 * Sprache laden und aktiv setzen. Deutsch braucht keine Datei — es IST der
 * Katalog, weil die Schlüssel schon deutsch sind.
 *
 * Mehrfach aufzurufen ist billig: Lädt bereits dieselbe Sprache, wird auf den
 * laufenden Vorgang gewartet statt ein zweiter gestartet. Vier Bündel rufen das
 * beim Start jeweils selbst auf.
 */
export async function setzeSprache(code) {
  const ziel = SPRACHEN.some(s => s.code === code) ? code : 'de'
  if (zustand.aktiv === ziel && (ziel === 'de' || Object.keys(zustand.katalog).length)) return ziel
  if (zustand.laedt?.ziel === ziel) return zustand.laedt.p

  const p = (async () => {
    if (ziel === 'de') {
      zustand.katalog = {}
    } else {
      try {
        const mod = await import(`../lang/${ziel}.js`)
        zustand.katalog = mod?.texte || mod?.default || {}
      } catch (err) {
        console.warn(`[i18n] "${ziel}" nicht ladbar (${err?.message || err}) — es bleibt bei Deutsch`)
        zustand.katalog = {}
        zustand.aktiv = 'de'
        melde()
        return 'de'
      }
    }
    zustand.aktiv = ziel
    try { localStorage.setItem(SPEICHER, ziel) } catch {}
    melde()
    return ziel
  })()

  zustand.laedt = { ziel, p }
  try { return await p } finally { if (zustand.laedt?.p === p) zustand.laedt = null }
}

/** Beim Start rufen: lädt die gewünschte Sprache. Gibt ein Versprechen zurück. */
export const starteSprache = () => setzeSprache(gewuenschteSprache())

/**
 * Übersetzen. Ohne Eintrag kommt der Schlüssel selbst zurück — deshalb ist ein
 * fehlender Eintrag nie ein leerer Knopf.
 *
 * @param {string} text  der deutsche Satz
 * @param {object} [werte]  benannte Platzhalter
 */
export function t(text, werte = null) {
  const roh = String(text ?? '')
  let out = zustand.katalog[roh]
  if (out === undefined) {
    out = roh
    // Nur merken, was in einer FREMDEN Sprache fehlt. Auf Deutsch fehlt nichts.
    if (zustand.aktiv !== 'de' && roh) zustand.fehlend.add(roh)
  }
  return werte ? einsetzen(out, werte) : out
}

/**
 * Server-Fehlercode → deutscher Satz.
 *
 * WARUM DIE TABELLE HIER STEHT UND NICHT IN DER SPRACHDATEI: Der Entwurf sah
 * Einträge namens `fehler.<code>` im Katalog vor — das funktioniert für jede
 * Sprache ausser der eigenen. Der deutsche Satz IST hier der Schlüssel; ein
 * Katalog mit `'fehler.auth_locked'` hätte auf Deutsch nichts nachzuschlagen
 * und der Spieler sähe „fehler.auth_locked" oder den englischen Server-Text.
 *
 * Also andersherum: Der Code wird hier zu einem deutschen Satz, und der geht
 * durch `t()` wie jeder andere. Damit gilt wieder die Regel des Hauses — und
 * die Übersetzung steht in `client/lang/en.js` an derselben Stelle wie alles
 * andere.
 */
export const FEHLER_TEXT = {
  auth_locked: 'Zu viele Fehlversuche. Warte einen Moment und versuch es erneut.',
  reward_reduced: 'Jemand arbeitet an diesem Auftrag — die Belohnung darf erhöht, nicht gekürzt werden.',
  proof_not_found: 'Diese Bilder wurden nicht gefunden.',
  proof_foreign: 'Diese Bilder gehören jemand anderem.',
  proof_other_call: 'Diese Bilder gehören zu einem anderen Auftrag.',
  proof_empty: 'Es war kein Bild dabei.',
}

/**
 * Einen Server-Fehler in einen Satz übersetzen.
 *
 * Der Server übersetzt nicht (docs/mehrsprachigkeit.md): Er benennt die Lage
 * mit einem `code` und schickt einen englischen Text, der im Log lesbar sein
 * soll. Diese Funktion ist die eine Stelle, die daraus einen Satz macht.
 *
 * PocketBase verpackt Fehlerdaten je nach Route verschieden — mal `data.code`,
 * mal `data.<feld>.code`. Beides wird angesehen, weil der Aufrufer sonst wissen
 * müsste, welche Route er gerade gerufen hat, und das ist nicht seine Sache.
 *
 * @param {any} err           Fehler aus dem SDK
 * @param {string} rueckfall  was ohne erkennbaren Code angezeigt wird
 */
export function serverFehler(err, rueckfall = 'Da ist etwas schiefgegangen.') {
  const daten = err?.response?.data ?? err?.data ?? null
  let code = typeof daten?.code === 'string' ? daten.code : ''
  if (!code && daten && typeof daten === 'object') {
    for (const wert of Object.values(daten)) {
      if (wert && typeof wert === 'object' && typeof wert.code === 'string'
          && wert.code !== 'validation_invalid_value') { code = wert.code; break }
    }
  }
  const satz = FEHLER_TEXT[code]
  // Unbekannter Code: lieber die Meldung des Servers als ein Achselzucken. Sie
  // ist englisch, aber sie sagt wenigstens etwas.
  return satz ? t(satz) : (err?.message || t(rueckfall))
}

/** Platzhalter `{name}` ersetzen. Unbekannte bleiben stehen — sichtbarer Fehler. */
export function einsetzen(vorlage, werte) {
  return String(vorlage).replace(/\{(\w+)\}/g, (ganz, name) =>
    Object.prototype.hasOwnProperty.call(werte, name) ? String(werte[name]) : ganz)
}

/**
 * Was in der aktiven Sprache noch fehlt — gesammelt, während die Oberfläche
 * lief. Ein Extraktor, der den Quelltext liest, findet nur, was statisch
 * dasteht; das hier findet, was tatsächlich angezeigt wurde.
 */
export const fehlende = () => [...zustand.fehlend].sort()

/** Auf Sprachwechsel hören (Oberflächen neu zeichnen). */
export function beiSprachwechsel(fn) {
  zustand.hoerer.add(fn)
  return () => zustand.hoerer.delete(fn)
}

function melde() {
  for (const h of zustand.hoerer) { try { h(zustand.aktiv) } catch {} }
  try { window.dispatchEvent(new CustomEvent('ajna:sprache', { detail: zustand.aktiv })) } catch {}
}
