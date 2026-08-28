// BildAufbereitung — ein Foto sendefertig machen, bevor es das Gerät verlässt.
//
// ZWEI GRÜNDE, EINE MASSNAHME
//
// 1. AUFNAHME-METADATEN MÜSSEN WEG. Ein Handy-Foto trägt EXIF: GPS-Koordinate,
//    Aufnahmezeit, Gerätemodell, oft die Seriennummer der Kamera. Ajna treibt
//    einigen Aufwand mit vier Standort-Stufen — und ein Beweisfoto würde die
//    exakte Position trotzdem mitliefern. Das wäre nicht „unsauber", das wäre
//    ein Loch im Konzept.
//
// 2. GRÖSSE. Ein aktuelles Handy liefert 4–12 MB je Bild. Drei davon je
//    Einreichung, mal viele Aufträge, ergibt eine Datenmenge, die niemand
//    braucht: Für die Abnahme durch einen Menschen reicht die lange Kante mit
//    1600 Pixeln.
//
// BEIDES ERLEDIGT DASSELBE: Das Bild wird auf eine Leinwand gezeichnet und neu
// kodiert. Was dabei entsteht, hat kein EXIF — nicht weil wir es entfernen,
// sondern weil es nie geschrieben wird. Das ist verlässlicher als eine
// Metadaten-Bibliothek, die ein Feld übersehen kann.
//
// EINE EIGENHEIT, DIE MAN KENNEN MUSS: Die EXIF-Orientierung geht damit
// ebenfalls verloren — ein hochkant aufgenommenes Bild läge quer. Deshalb wird
// sie über `createImageBitmap(..., { imageOrientation: 'from-image' })`
// ANGEWANDT, bevor gezeichnet wird. Der Browser dreht das Bild, wir speichern
// die gedrehten Pixel. Die Information ist dann im Bild statt daneben.

/** Lange Kante nach dem Verkleinern (Pixel). */
export const MAX_KANTE = 1600

/** JPEG-Qualität. 0,82 ist die Stelle, an der Artefakte anfangen aufzufallen. */
export const QUALITAET = 0.82

/** Mehr als das nimmt die Sammelstelle nicht an (siehe Migration quest_proofs). */
export const MAX_BILDER = 3

/**
 * Ein Bild verkleinern und neu kodieren.
 *
 * @param {File|Blob} datei
 * @param {{maxKante?: number, qualitaet?: number}} [opts]
 * @returns {Promise<File>} JPEG ohne Metadaten
 */
export async function bereiteBildAuf(datei, { maxKante = MAX_KANTE, qualitaet = QUALITAET } = {}) {
  if (!datei) throw new Error('kein Bild')
  const bitmap = await ladeBitmap(datei)
  const { width, height } = passeGroesseAn(bitmap.width, bitmap.height, maxKante)

  const leinwand = document.createElement('canvas')
  leinwand.width = width
  leinwand.height = height
  const ctx = leinwand.getContext('2d')
  // Weißer Grund: Ein PNG mit Transparenz würde als JPEG sonst schwarz.
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(bitmap, 0, 0, width, height)
  try { bitmap.close?.() } catch {}

  const blob = await new Promise((fertig, fehler) => {
    leinwand.toBlob(b => (b ? fertig(b) : fehler(new Error('Bild konnte nicht kodiert werden'))),
      'image/jpeg', qualitaet)
  })
  const name = String(datei.name || 'bild').replace(/\.[^.]+$/, '') + '.jpg'
  return new File([blob], name, { type: 'image/jpeg', lastModified: Date.now() })
}

/**
 * Mehrere Bilder aufbereiten. Deckelt auf MAX_BILDER — lieber hier als mit
 * einer Fehlermeldung des Servers, nachdem alles hochgeladen wurde.
 *
 * @returns {Promise<{bilder: File[], uebersprungen: number, fehler: string[]}>}
 */
export async function bereiteBilderAuf(dateien, opts = {}) {
  const liste = Array.from(dateien || [])
  const nehmen = liste.slice(0, MAX_BILDER)
  const bilder = []
  const fehler = []
  for (const d of nehmen) {
    try { bilder.push(await bereiteBildAuf(d, opts)) }
    catch (err) { fehler.push(`${d?.name || 'Bild'}: ${err?.message || err}`) }
  }
  return { bilder, uebersprungen: Math.max(0, liste.length - nehmen.length), fehler }
}

/**
 * Neue Größe unter Beibehaltung des Seitenverhältnisses. Kleinere Bilder werden
 * NICHT vergrößert — das brächte nur Dateigröße ohne Bildinformation.
 */
export function passeGroesseAn(breite, hoehe, maxKante) {
  const lang = Math.max(breite, hoehe)
  if (!Number.isFinite(lang) || lang <= 0) return { width: 1, height: 1 }
  if (lang <= maxKante) return { width: breite, height: hoehe }
  const faktor = maxKante / lang
  return {
    width: Math.max(1, Math.round(breite * faktor)),
    height: Math.max(1, Math.round(hoehe * faktor)),
  }
}

/**
 * Bitmap MIT angewandter EXIF-Orientierung. Ohne `from-image` läge jedes
 * hochkant aufgenommene Foto quer, sobald die Metadaten fehlen.
 */
async function ladeBitmap(datei) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(datei, { imageOrientation: 'from-image' }) }
    catch { /* ältere Fassung ohne die Option → unten weiter */ }
    try { return await createImageBitmap(datei) } catch { /* → <img> */ }
  }
  // Rückfall für Browser ohne createImageBitmap: <img> wendet die Orientierung
  // beim Zeichnen ebenfalls an (image-orientation: from-image ist Vorgabe).
  const url = URL.createObjectURL(datei)
  try {
    const bild = await new Promise((fertig, fehler) => {
      const i = new Image()
      i.onload = () => fertig(i)
      i.onerror = () => fehler(new Error('kein lesbares Bild'))
      i.src = url
    })
    return bild
  } finally {
    URL.revokeObjectURL(url)
  }
}
