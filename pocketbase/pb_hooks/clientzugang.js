/// <reference path="../pb_data/types.d.ts" />
//
// clientzugang.js — wer darf den Web-Client (Karte, AR, Editor) überhaupt
// öffnen?
//
// WARUM: Eine Instanz kann Ajna als Unterbau einer anderen Anwendung fahren
// (erste: HeimatRadar). Deren Nutzer:innen sehen die eigene Oberfläche; der
// volle Ajna-Client bleibt der Verwaltung vorbehalten. Andere Szenarien
// wollen ihn für alle angemeldeten Konten oder für eine Gruppe. Das ist eine
// Betriebsentscheidung — ein `settings`-Schlüssel, zur Laufzeit änderbar.
//
// WIE: Der Client besteht aus statischen Dateien, die Caddy ausliefert. Caddy
// fragt vor jeder Auslieferung hier nach (`forward_auth` → GET
// /api/client-access). Die Antwort entscheidet: 204 = ausliefern, alles
// andere wird dem Browser durchgereicht — ein 302 zur Anmeldeseite
// (/zugang.html) bei Seitenaufrufen, ein 401 mit Code bei allem anderen.
//
// Die Identität kommt aus einem COOKIE (`ajna_zugang` = PocketBase-Token):
// Ein Seitenaufruf trägt keinen Authorization-Header, und Caddy kennt keine
// PocketBase-Konten. /zugang.html setzt das Cookie nach einer Anmeldung
// (Konto oder Superuser), der Server prüft es hier wie jedes Token. Das
// Cookie gilt nur für diese Auslieferungsfrage — die API (/api/*) schützt
// weiterhin ihre Regeln, und ein abgelaufenes oder widerrufenes Token ist
// hier ebenso wertlos wie dort.
//
// EINSTELLUNG `client.access` (settings, nicht öffentlich):
//   "everyone"        Vorgabe — wie bisher, jeder darf den Client öffnen
//   "authenticated"   jedes angemeldete Konto (Gäste eingeschlossen)
//   "superusers"      nur PocketBase-Superuser (die Verwaltung)
//   "group:<Name>"    Mitglieder der Gruppe <Name> (transitiv), Superuser immer
//
// Superuser dürfen bei jeder Einstellung hinein — wer die Instanz verwaltet,
// muss ihren Client sehen können.

const COOKIE = "ajna_zugang"
const EINSTELLUNG = "client.access"
const ANMELDESEITE = "/zugang.html"

/** Wert eines Cookies aus dem Cookie-Header (ohne Bibliothek, ohne Ausnahmen). */
function cookieWert(header, name) {
  if (!header) return ""
  const teile = String(header).split(";")
  for (let i = 0; i < teile.length; i++) {
    const t = teile[i].trim()
    if (t.indexOf(name + "=") === 0) {
      try { return decodeURIComponent(t.slice(name.length + 1)) } catch (err) { return t.slice(name.length + 1) }
    }
  }
  return ""
}

/** Regel der Instanz, normalisiert. Unbekanntes → "everyone" (kein Aussperren durch Tippfehler — aber im Log). */
function regel(app) {
  const { einstellung } = require(`${__hooks}/gastkonten.js`)
  const roh = String(einstellung(app, EINSTELLUNG, "everyone") || "everyone").trim()
  if (roh === "everyone" || roh === "authenticated" || roh === "superusers") return roh
  if (roh.indexOf("group:") === 0 && roh.length > 6) return roh
  console.log(`[client-access] unbekannte Einstellung ${EINSTELLUNG}="${roh}" — behandle wie "everyone"`)
  return "everyone"
}

function istSuperuser(rec) {
  try { if (typeof rec.isSuperuser === "function" && rec.isSuperuser()) return true } catch (err) { /* weiter */ }
  try { return rec.collection().name === "_superusers" } catch (err) { return false }
}

/** Konto zum Token — oder null. Superuser-Tokens sind auth-Tokens wie alle anderen. */
function kontoZu(app, token) {
  if (!token) return null
  try { return app.findAuthRecordByToken(token, "auth") } catch (err) { return null }
}

/** Ist das Konto (transitiv) Mitglied der Gruppe mit diesem Namen? */
function inGruppe(app, userId, gruppenName) {
  let gruppe = null
  try { gruppe = app.findFirstRecordByFilter("groups", "name = {:n}", { n: gruppenName }) } catch (err) { return false }
  if (!gruppe) return false
  try {
    const { transitiveGroupsOf } = require(`${__hooks}/permissions.js`)
    const ids = transitiveGroupsOf(userId) || []
    for (let i = 0; i < ids.length; i++) if (String(ids[i]) === String(gruppe.id)) return true
  } catch (err) {
    console.log("[client-access] Gruppenauflösung fehlgeschlagen: " + (err && err.message ? err.message : err))
  }
  return false
}

/**
 * Entscheidung für ein Konto (oder keines) unter der Regel.
 * @returns {{ok: boolean, grund: string}}
 */
function entscheide(app, r, rec) {
  if (r === "everyone") return { ok: true, grund: "everyone" }
  if (!rec) return { ok: false, grund: "kein Konto" }
  if (istSuperuser(rec)) return { ok: true, grund: "superuser" }
  if (r === "superusers") return { ok: false, grund: "nur Superuser" }
  if (r === "authenticated") return { ok: true, grund: "angemeldet" }
  const name = r.slice(6)
  return inGruppe(app, rec.id, name) ? { ok: true, grund: "Gruppe " + name } : { ok: false, grund: "nicht in Gruppe " + name }
}

/** Route GET /api/client-access — Ziel von Caddys forward_auth; `?info=1` für die Anmeldeseite. */
function route(e) {
  const app = $app
  const r = regel(app)
  const token = cookieWert(e.request.header.get("Cookie"), COOKIE)
  const rec = kontoZu(app, token)
  const ent = entscheide(app, r, rec)

  if (e.request.url.query().get("info")) {
    return e.json(200, {
      policy: r,
      ok: ent.ok,
      account: rec ? { id: rec.id, superuser: istSuperuser(rec) } : null,
    })
  }

  if (ent.ok) {
    if (rec) e.response.header().set("X-Ajna-Konto", rec.id)
    return e.noContent(204)
  }

  // Seitenaufruf im Browser → zur Anmeldeseite, danach zurück. Alles andere
  // (Bundles, fetch, Modelle) bekommt einen Code, den ein Client versteht.
  const methode = e.request.header.get("X-Forwarded-Method") || e.request.method
  const accept = e.request.header.get("Accept") || ""
  const ziel = e.request.header.get("X-Forwarded-Uri") || "/"
  if (methode === "GET" && accept.indexOf("text/html") >= 0 && ziel.indexOf(ANMELDESEITE) !== 0) {
    return e.redirect(302, ANMELDESEITE + "?weiter=" + encodeURIComponent(ziel))
  }
  return e.json(401, { code: "client_access_denied", policy: r, message: "Der Web-Client ist auf dieser Instanz nicht für dieses Konto freigegeben (" + ent.grund + ")." })
}

module.exports = { COOKIE, EINSTELLUNG, ANMELDESEITE, cookieWert, regel, entscheide, route }
