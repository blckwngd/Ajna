// Gebäudehöhe aus OSM-Tags — EINE Quelle für alle, die sie brauchen.
//
// Genutzt vom 3D-Wireframe (client/engine/environment/OSMContext.js) UND von der
// Drachen-Landung (agents/lib/landing-spots.mjs). Vorher hatte jede Seite ihre
// eigene Rechnung — mit unterschiedlicher Geschosshöhe (3,0 vs 3,2 m), sodass
// der Drache knapp neben dem Dach aufsetzte, das man sieht. Deshalb hier
// zentral (Muster wie wifiStyle.js/animalNames.js: von Client und Node-Agents
// gemeinsam importiert).
//
// EHRLICHKEIT ZUR DATENLAGE: OSM kennt die echte Höhe nur selten — `height` und
// `building:levels` sind in vielen Gegenden gar nicht getaggt. Ohne Angabe wäre
// jedes Haus gleich hoch (das war der Ausgangspunkt). Darum wird in dem Fall aus
// der GEBÄUDEART geschätzt (`building=church|garage|apartments|…`), die fast
// immer vorhanden ist. Das ist bewusst eine Schätzung, keine Messung — aber eine
// typologisch begründete, und weit besser als ein Einheitswert.

const LEVEL_HEIGHT_M = 3.2     // Geschosshöhe inkl. Decke (Wohn-/Bürobau, grob)
const ROOF_LEVEL_M   = 2.5     // ein Dachgeschoss zählt weniger als ein Vollgeschoss
export const DEFAULT_BUILDING_HEIGHT_M = 8

// Typische Höhen je `building=*`. Grobe, aber plausible Werte — sie sollen die
// Silhouette differenzieren (Kirche überragt Garage), keine Statik begründen.
const TYPE_HEIGHT_M = {
  // Wohnen
  house: 7, detached: 7, semidetached_house: 7, terrace: 8, bungalow: 4,
  apartments: 14, residential: 12, dormitory: 14,
  // Neben-/Kleinbauten
  garage: 3, garages: 3, carport: 3, shed: 3, hut: 3, cabin: 3.5,
  roof: 3, greenhouse: 4, kiosk: 3, toilets: 3, service: 3,
  // Gewerbe/Industrie
  industrial: 10, warehouse: 10, hangar: 12, factory: 11,
  retail: 7, commercial: 9, supermarket: 8, office: 16,
  // Öffentlich
  school: 11, university: 14, hospital: 15, public: 12, civic: 12,
  train_station: 12, museum: 13, sports_hall: 10, stadium: 20,
  // Sakral/Sonder
  church: 18, cathedral: 28, chapel: 9, mosque: 15, synagogue: 14, temple: 14,
  tower: 25, water_tower: 25, silo: 18, storage_tank: 12,
  // Landwirtschaft
  farm: 8, farm_auxiliary: 6, barn: 9, stable: 5, cowshed: 5,
}

const num = v => {
  // Tags wie "12 m", "12.5", "12;15" → erster Float. parseFloat kann das,
  // liefert aber auch für "ja"/"" NaN — beides fangen wir ab.
  const n = parseFloat(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Woher stammt die Höhe? Für Debug/Transparenz — und um im Zweifel zu sehen,
 * ob eine Gegend überhaupt getaggt ist.
 * @returns {'height'|'levels'|'type'|'default'}
 */
export function heightSource(tags = {}) {
  if (num(tags.height) || num(tags['building:height']) || num(tags.est_height)) return 'height'
  if (num(tags['building:levels'])) return 'levels'
  if (TYPE_HEIGHT_M[String(tags.building || '').toLowerCase()]) return 'type'
  return 'default'
}

/**
 * Höhe eines Gebäudes in Metern. Reihenfolge: explizite Höhe → Geschosse →
 * Gebäudeart → Default.
 * @param {object} tags  OSM-Tags des Ways
 * @returns {number} Meter (> 0)
 */
export function buildingHeightM(tags = {}) {
  // 1) Explizit getaggte Höhe gewinnt immer.
  const h = num(tags.height) || num(tags['building:height']) || num(tags.est_height)
  if (h) return h

  // 2) Geschosse (+ Dachgeschosse, falls getaggt).
  const lv = num(tags['building:levels'])
  if (lv) {
    const roofLv = num(tags['roof:levels']) || 0
    return lv * LEVEL_HEIGHT_M + roofLv * ROOF_LEVEL_M
  }

  // 3) Aus der Gebäudeart schätzen — der Fall, der die Silhouette überhaupt
  //    erst differenziert, weil die meisten Gebäude keine Höhenangabe haben.
  const type = TYPE_HEIGHT_M[String(tags.building || '').toLowerCase()]
  if (type) return type

  return DEFAULT_BUILDING_HEIGHT_M
}
