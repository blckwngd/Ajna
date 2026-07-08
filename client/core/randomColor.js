// Angenehme Zufallsfarbe als Hex (#rrggbb): zufälliger Farbton bei fester
// Sättigung/Helligkeit — so wird nichts matschig oder zu grell. Wird beim
// Erzeugen von Objekten genutzt, damit untexturierte 3D-Modelle (Blob/Slime …)
// ein farbiges Material bekommen (GameObject.#applyModelColor).

function hslToHex(h, s, l) {
  s /= 100; l /= 100
  const k = n => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = n => {
    const col = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
    return Math.round(255 * col).toString(16).padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
}

export function randomHexColor() {
  return hslToHex(Math.floor(Math.random() * 360), 65, 55)
}
