/// <reference path="../pb_data/types.d.ts" />
// Helfer für die Freundesliste — per require() IM Callback geladen, weil
// Hook-Callbacks im JSVM keinen Modul-Scope teilen: Eine Funktion oben in
// main.pb.js ist in einem Callback schlicht nicht definiert (gemessen beim
// ersten Lauf der Suite: „anzeigenameVon is not defined").

/** Anzeigename eines Kontos: Handle vor Name, nie die E-Mail. */
function anzeigenameVon(userRec) {
  if (!userRec) return ""
  return String(userRec.get("username") || userRec.get("name") || "")
}

module.exports = { anzeigenameVon }
