// Tilt-kompensierter Kompasskurs aus deviceorientation(-absolute)-Events.
//
// Die naive Näherung `heading = 360 − alpha` stimmt NUR bei flach liegendem
// Gerät: alpha misst die Drehung um die Bildschirm-Normale. Wird das Gerät
// aufrecht gehalten, liegt diese Achse waagerecht, und nahe der Senkrechten
// geraten alpha/gamma in eine Gimbal-Singularität — beide schwingen wild,
// nur ihre Kombination ist stabil. Deshalb hier die volle Rotationsmatrix
// (W3C-Konvention: intrinsisch Z-X'-Y'', Erdframe X=Ost/Y=Nord/Z=oben):
//
//   • Erd-Horizontalprojektion der GERÄTE-OBERKANTE (Spalte y):
//       (E,N) = (−sinα·cosβ, cosα·cosβ)          — Gewicht |cosβ| (flach stark)
//   • Erd-Horizontalprojektion der RÜCKKAMERA (−Spalte z):
//       (E,N) = (−(cosα·sinγ + sinα·sinβ·cosγ),
//                  cosα·sinβ·cosγ − sinα·sinγ)   — Gewicht ~|sinβ| (aufrecht stark)
//
// Die 2D-Vektorsumme beider Projektionen zeigt in JEDER üblichen Haltung in
// die gleiche „wohin schaue/zeige ich"-Richtung, ist nie degeneriert und
// hebt die alpha/gamma-Schwingungen der Senkrecht-Haltung exakt auf.
// heading = atan2(E, N) → 0° = Nord, im Uhrzeigersinn.

const RAD = Math.PI / 180

/**
 * Kompasskurs (Grad 0–360, 0 = Nord, im Uhrzeigersinn) aus einem
 * deviceorientation-Event — tilt-kompensiert, inkl. Bildschirm-Rotation.
 * @returns {number|null} null, wenn das Event keinen absoluten Kurs trägt.
 */
export function compassHeadingDeg(ev) {
  // iOS: webkitCompassHeading ist bereits geräteseitig kompensiert.
  if (typeof ev.webkitCompassHeading === 'number') {
    const so = (screen.orientation && screen.orientation.angle) || 0
    return ((ev.webkitCompassHeading + so) % 360 + 360) % 360
  }
  // Android: nur ABSOLUTE Events sind Nord-referenziert (deviceorientation
  // allein ist seit Chrome ~50 der relative Game-Rotation-Vector).
  if (!ev.absolute || typeof ev.alpha !== 'number') return null
  const a = ev.alpha * RAD
  const b = (ev.beta || 0) * RAD
  const g = (ev.gamma || 0) * RAD
  const sa = Math.sin(a), ca = Math.cos(a)
  const sb = Math.sin(b), cb = Math.cos(b)
  const sg = Math.sin(g), cg = Math.cos(g)
  const E = (-sa * cb) + (-(ca * sg + sa * sb * cg))
  const N = (ca * cb) + (ca * sb * cg - sa * sg)
  let h = Math.atan2(E, N) / RAD
  const so = (screen.orientation && screen.orientation.angle) || 0
  return ((h + so) % 360 + 360) % 360
}
