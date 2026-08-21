/// <reference path="../pb_data/types.d.ts" />
//
// JSON-Felder aus dem JSVM lesen — ohne den Text dabei zu zerstören.
//
// DAS PROBLEM
// PocketBase reicht ein JSON-Feld je nach Weg als Objekt, als String ODER als
// Byte-Array (`types.JSONRaw`) an einen Hook. Der naheliegende Weg, aus diesen
// Bytes einen String zu machen, ist falsch:
//
//     String.fromCharCode.apply(null, bytes)
//
// Das nimmt JEDES BYTE als ein Zeichen — also Latin-1. UTF-8 kodiert „ü" aber
// als zwei Bytes (0xC3 0xBC), und die werden so zu „Ã¼". Aus „Bäume gießen"
// wird „BÃ¤ume gieÃ\x9Fen".
//
// WARUM DAS SCHLIMM IST: Ein Hook liest den Stand nicht nur, er schreibt ihn
// meist zurück (Auftrag annehmen, abschliessen, Frist stillegen). Damit wird
// die Verstümmelung GESPEICHERT — und beim nächsten Durchlauf noch einmal
// kodiert. Jeder Durchgang macht es schlimmer, und niemand merkt es, solange
// die Prüfungen nur ASCII verwenden.
//
// Aufgefallen ist es erst, als die Regionsliste die Kurzbeschreibung eines
// Auftrags zurückgab — deutscher Text mit Umlauten, wie ihn ein Mensch tippt.
//
// `TextDecoder` gibt es im JSVM nicht verlässlich, deshalb hier von Hand.
// Zusätzlicher Nebeneffekt: `apply()` mit einem grossen Array kann den Stack
// sprengen; diese Fassung läuft in einer Schleife.

const ERSATZ = "�"

/**
 * Byte-Array als UTF-8 lesen.
 * Ungültige Folgen werden zu U+FFFD — abbrechen wäre schlechter, sonst
 * verschwände ein ganzer Datensatz wegen eines kaputten Zeichens.
 *
 * @param {number[]} bytes
 * @returns {string}
 */
function utf8ToString(bytes) {
  if (!bytes || !bytes.length) return ""
  let out = ""
  let i = 0
  const n = bytes.length
  while (i < n) {
    const b0 = bytes[i++] & 0xff
    if (b0 < 0x80) { out += String.fromCharCode(b0); continue }

    let cp = 0, folge = 0
    if (b0 >= 0xf0 && b0 <= 0xf4) { cp = b0 & 0x07; folge = 3 }
    else if (b0 >= 0xe0) { cp = b0 & 0x0f; folge = 2 }
    else if (b0 >= 0xc2) { cp = b0 & 0x1f; folge = 1 }
    else { out += ERSATZ; continue }          // Folgebyte ohne Anfang, oder Overlong

    if (i + folge > n) { out += ERSATZ; break }
    let ok = true
    for (let k = 0; k < folge; k++) {
      const b = bytes[i] & 0xff
      if ((b & 0xc0) !== 0x80) { ok = false; break }
      cp = (cp << 6) | (b & 0x3f)
      i++
    }
    if (!ok) { out += ERSATZ; continue }

    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) { out += ERSATZ; continue }
    if (cp > 0xffff) {
      cp -= 0x10000
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff))
    } else {
      out += String.fromCharCode(cp)
    }
  }
  return out
}

/**
 * Beliebigen JSON-Feldwert in einen String bringen.
 * Objekt/Array-von-Strings/Byte-Array/String — alles kommt vor.
 */
function jsonText(value) {
  if (value == null) return ""
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    return (value.length && typeof value[0] === "number")
      ? utf8ToString(value)
      : value.join("")
  }
  return ""
}

/**
 * JSON-Feld als Objekt lesen — der Weg, den alle Hooks nehmen sollten.
 *
 * @param {any} value      roher Feldwert (rec.get("state") o. ä.)
 * @param {any} [vorgabe]  was bei unlesbarem Inhalt herauskommt
 */
function jsonObject(value, vorgabe) {
  const leer = vorgabe === undefined ? {} : vorgabe
  if (value && typeof value === "object" && !Array.isArray(value)) return value
  const text = jsonText(value)
  if (!text) return leer
  try {
    const p = JSON.parse(text)
    return (p && typeof p === "object") ? p : leer
  } catch (err) { return leer }
}

/** JSON-Feld als Array lesen (Rechte-Listen, Mitglieder …). */
function jsonArray(value) {
  if (Array.isArray(value) && (!value.length || typeof value[0] !== "number")) return value
  const text = jsonText(value)
  if (!text) return []
  try {
    const p = JSON.parse(text)
    return Array.isArray(p) ? p : []
  } catch (err) { return [] }
}

module.exports = { utf8ToString, jsonText, jsonObject, jsonArray }
