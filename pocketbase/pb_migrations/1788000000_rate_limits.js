/// <reference path="../pb_data/types.d.ts" />
//
// Ratenbegrenzung — für ANONYMEN Verkehr.
//
// ANLASS: Seit `POST /api/agents/{source}/command` auch ohne Anmeldung
// angenommen wird (anonyme Kommandos aus E-Mail-Links, siehe main.pb.js), gibt
// es einen Endpunkt, den jeder ohne Konto aufrufen kann. Dazu ist
// `users.createRule` offen — Registrierung ist Absicht, aber ohne Grenze kann
// jemand die Konto-Tabelle vollschreiben.
//
// PocketBase 0.36 bringt die Ratenbegrenzung mit; sie war schlicht
// ausgeschaltet.
//
// DIE ENTSCHEIDUNG, DIE HIER STECKT: Begrenzt wird, was OHNE ANMELDUNG
// hereinkommt (`audience: "@guest"`). Angemeldeter Verkehr bleibt unbegrenzt —
// aus zwei Gründen:
//
//   • Agents schreiben im Sekundentakt. Der World-Director allein bewegt
//     Dutzende Objekte pro Minute; eine pauschale Grenze über `/api/` hätte
//     ihn gedrosselt und die Welt einfrieren lassen. Genau deshalb ist die
//     mitgelieferte Vorgabe (300/10 s für ALLE) hier auf Gäste eingeengt.
//   • Missbrauch mit Konto ist zurechenbar. Wer angemeldet flutet, ist
//     bekannt und kann gesperrt werden; wer anonym flutet, nicht.
//
// Anmeldeversuche bleiben unbegrenzt — die Begründung steht bei den Regeln.

migrate((app) => {
  const s = app.settings()
  if (!s || !s.rateLimits) {
    console.log("[migration] Ratenbegrenzung: settings.rateLimits nicht vorhanden — übersprungen")
    return
  }

  s.rateLimits.enabled = true
  s.rateLimits.rules = [
    // ANMELDEVERSUCHE BLEIBEN UNBEGRENZT — bewusst, und schweren Herzens.
    //
    // PocketBase liefert dafür 2 Versuche / 3 s. Für Menschen richtig, für
    // diese Instanz falsch: `npm run stack` meldet mehrere Agents GLEICHZEITIG
    // von derselben Adresse an, und die Testsuite loggt sich dutzendfach in
    // Folge ein. Gemessen: erst 15, nach dem Lockern auf 10/10 s immer noch 13
    // Fehlschläge — die Grenze passte nicht, egal wie ich sie drehte.
    //
    // Ich habe dann aufgehört, an der Zahl zu drehen. Ein Bremsen der Anmeldung
    // war nicht Teil des Auftrags (der nannte anonyme Kommandos und
    // users:create); es hier mitzunehmen hiesse, eine eigene Frage nebenbei zu
    // beantworten. Sie verdient eine eigene: Welche Zahl schützt wirklich, wie
    // unterscheidet man Agent-Schübe von Angriffen (getrennte Instanz? eigenes
    // Konto-Kontingent?), und was passiert beim Stack-Start.
    //
    // Bis dahin ist die Anmeldung so unbegrenzt wie bisher — kein Rückschritt,
    // nur keine Verbesserung.

    // Konten anlegen: Die Regel ist offen, damit man sich ohne Einladung
    // registrieren kann.
    //
    // DIE ZAHL WAR ZUERST ZU KLEIN (10/Stunde), mit der Begründung, Gäste einer
    // Veranstaltung kämen aus verschiedenen Netzen. Das ist gerade dort falsch:
    // gemeinsames WLAN, dieselbe Funkzelle, CGNAT — eine IP kann für einen
    // ganzen Hof stehen. Aufgefallen ist es, weil dieselbe Grenze die eigene
    // Testsuite erschlug (15 Fehlschläge, alle „Konto anlegen").
    //
    // 100 pro Stunde: Ein Hof mit fünfzig Ständen kommt damit aus, auch wenn
    // alle im selben WLAN hängen. Ein Bot schafft rechnerisch 2400 Konten am
    // Tag — das Schadensbild ist ein voller Konto-Tisch, und dagegen wirkt das
    // Aufräumen ungenutzter Gastkonten (signup.guest_ttl_days), nicht eine
    // Grenze, die ehrliche Nutzer aussperrt.
    //
    // Wer sie enger zieht, muss den Testlauf im Blick behalten: Die Suite legt
    // je Durchgang rund vierzig Konten an. Das Harness wartet inzwischen bei
    // 429 und wiederholt — aber eine Grenze, die die eigenen Tests erschlägt,
    // wird abgeschaltet und schützt dann gar nichts mehr.
    { label: "users:create", audience: "@guest", duration: 3600, maxRequests: 100 },

    // Anonyme Agent-Kommandos: Ein Freigabe-Link wird einmal geklickt,
    // nicht dreissigmal pro Minute.
    { label: "/api/agents/", audience: "@guest", duration: 60, maxRequests: 30 },

    // Alles Übrige ohne Anmeldung — grosszügig, aber nicht unbegrenzt.
    // Anonyme Betrachter lesen Objekte und Kacheln; 120 Anfragen in 10 s
    // deckt das Laden einer vollen Karte ab.
    { label: "/api/", audience: "@guest", duration: 10, maxRequests: 120 },
  ]

  app.save(s)
  console.log("[migration] Ratenbegrenzung aktiv (nur anonymer Verkehr)")
}, (app) => {
  // Zurück auf den Auslieferungszustand: Regeln stehen wieder da, aber aus.
  try {
    const s = app.settings()
    if (!s || !s.rateLimits) return
    s.rateLimits.enabled = false
    app.save(s)
  } catch (err) {
    console.log("[migration] Rücknahme der Ratenbegrenzung: " + (err && err.message))
  }
})
