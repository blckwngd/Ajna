// English texts. The KEY is the German sentence — see core/i18n.js for why.
//
// A missing entry is not an error: the German sentence is shown instead. Add
// what you meet, in any order. In the browser console, `ajnaFehlendeTexte()`
// lists everything that was displayed untranslated during the session, and
// `node scripts/texte-pruefen.mjs` finds text that does not go through `t()`
// yet.
//
// Server messages appear here too, keyed by their `code` (see the block at the
// end). The server does not translate; it names the situation, the client says
// it in the reader's language.
//
// Placeholders in braces must survive translation — `{n}`, `{grund}`. Unknown
// ones are left visible on screen rather than silently dropped.

export const texte = {
  // ── Aufträge: Liste und Zustände ────────────────────────────────────
  'Verfügbar': 'Available',
  'Aktiv': 'Active',
  'Prüfen': 'Review',
  'Meine': 'Mine',
  'Offen': 'Open',
  'Angeboten': 'Offered',
  'Angenommen': 'Accepted',
  'Wird geprüft': 'Under review',
  'Zu prüfen': 'To review',
  'Erledigt': 'Done',
  'Abgelaufen': 'Expired',
  'Entwurf': 'Draft',

  'Aufträge werden geladen …': 'Loading quests …',
  'Die Liste konnte nicht geladen werden.': 'The list could not be loaded.',
  'Noch nichts geladen.': 'Nothing loaded yet.',
  'Hier gibt es gerade nichts zu tun.': 'Nothing to do here right now.',
  'Du hast keinen Auftrag angenommen.': 'You have not accepted a quest.',
  'Du hast noch keinen Auftrag ausgeschrieben.': 'You have not posted a quest yet.',
  'Nichts zu prüfen.': 'Nothing to review.',

  // ── Aufträge: Aktionen ──────────────────────────────────────────────
  'Annehmen': 'Accept',
  'Erledigt melden': 'Report as done',
  'Aufgeben': 'Give up',
  'Bestätigen': 'Confirm',
  'Ablehnen': 'Reject',
  'Zurück': 'Back',
  'Absenden': 'Submit',
  'Auftrag annehmen': 'Accept quest',
  'Auftrag erledigen': 'Complete quest',
  'Auftrag bearbeiten': 'Edit quest',
  'Neuer Auftrag': 'New quest',
  'Auftrag hier erzeugen': 'Create quest here',
  'Schließen': 'Close',

  // ── Aufträge: Melden und Abnahme ────────────────────────────────────
  'Was hast du getan?': 'What did you do?',
  'Kurz beschreiben, was erledigt ist.': 'Briefly describe what is done.',
  'Beizulegen': 'To attach',
  'Bilder (bis zu drei)': 'Images (up to three)',
  'Beigelegte Bilder': 'Attached images',
  'Beweisbild': 'Evidence photo',
  'Bilder werden vorbereitet …': 'Preparing images …',
  'Bilder konnten nicht gesendet werden.': 'The images could not be sent.',
  '{n} Bild(er) gesendet.': '{n} image(s) sent.',
  '{n} Bild(er) gesendet, {zuviel} zu viel — es gehen höchstens {max}.':
    '{n} image(s) sent, {zuviel} too many — the limit is {max}.',
  'Kein verwertbares Bild dabei.': 'No usable image among them.',
  'Ein Vorher-Bild hilft bei der Abnahme, ist aber nicht nötig. Standort und Aufnahmezeit werden vor dem Senden aus den Bildern entfernt.':
    'A "before" shot helps the review but is not required. Location and capture time are stripped from the images before sending.',
  'Anmerkung (freiwillig)': 'Note (optional)',
  'Warum reicht das nicht?': 'Why is this not enough?',

  // ── Aufträge: Nachweis und Abnahme-Verfahren ────────────────────────
  'Foto-Beweis': 'Photo evidence',
  'Bis zu drei Bilder. Ein Vorher-Bild hilft der Abnahme, ist aber nicht Pflicht.':
    'Up to three images. A "before" shot helps the review but is not required.',
  'Anwesenheit am Einsatzort': 'Presence at the site',
  'Der Bearbeiter meldet sich am Ort. NFC-Marke oder Beacon machen das belastbar, GPS allein nicht.':
    'The worker checks in on site. An NFC tag or beacon makes that solid; GPS alone does not.',
  'Geforderten Gegenstand dabeihaben': 'Carry the required item',
  'Der Server prüft beim Abschluss das Inventar. Die Gattung legst du unten unter „Geforderte Gegenstände" fest.':
    'The server checks your inventory on completion. Set the kind below under "Required items".',
  'Übergabe an die Figur': 'Hand over to the character',
  'Der Server prüft die geforderten Gegenstände.': 'The server checks the required items.',
  'Stichprobe (Auftraggeber)': 'Spot check (issuer)',
  'Stichprobe durch den Auftraggeber': 'Spot check by the issuer',
  'Du siehst dir einen Teil der Einreichungen an.': 'You look at some of the submissions.',
  'Prüfgruppe': 'Review group',
  'Eine benannte Gruppe nimmt ab.': 'A named group signs off.',
  'Abnahme durch die Prüfgruppe': 'Sign-off by the review group',
  'Schwarm — x von y': 'Swarm — x of y',
  'Andere Spieler bestätigen vor Ort.': 'Other players confirm on site.',
  'Schwarm — {ja} von {noetig} Bestätigungen': 'Swarm — {ja} of {noetig} confirmations',
  'Schwarm — {noetig} Bestätigungen nötig': 'Swarm — {noetig} confirmations needed',

  // ── Aufträge: Editor ────────────────────────────────────────────────
  'Kurz — eine Zeile für die Liste': 'Summary — one line for the list',
  'Aufgabe': 'Task',
  'Ort — Beschreibung für die Liste': 'Place — description for the list',
  'Müll sammeln am Rheinufer': 'Pick up litter along the river',
  'Uferweg zwischen Brücke und Bootshaus, ein Sack reicht.':
    'Riverside path between the bridge and the boathouse, one bag is enough.',
  'Was genau ist zu tun? Wo liegt Werkzeug?': 'What exactly is to be done? Where are the tools?',
  'Rheinufer, Höhe Bootshaus': 'Riverside, level with the boathouse',
  'Server wählen': 'Choose server',
  'Ein bestehender Auftrag bleibt auf seinem Server.': 'An existing quest stays on its server.',
  'Reicht für {mal}× erledigen': 'Enough for {mal} completion(s)',
  '({rest} bleibt übrig)': '({rest} left over)',
  'Ein Auftrag ohne Beschreibung.': 'A quest without a description.',
  'Noch keine Belohnung hinterlegt': 'No reward escrowed yet',
  'Belohnung: {pro} pro Durchlauf · wiederholbar, noch {rest}× möglich':
    'Reward: {pro} per run · repeatable, {rest} more possible',

  'Jemand arbeitet daran. Änderbar sind nur noch Frist und Belohnung — und beide nur nach oben.':
    'Someone is working on it. Only the deadline and the reward can still change — and both only upwards.',
  'Veröffentlicht. Die Belohnung lässt sich erhöhen, nicht kürzen.':
    'Published. The reward can be raised, not reduced.',
  'Abgeschlossen — nur noch zum Nachlesen.': 'Finished — for reference only.',

  // ── Aufträge: Prüfmeldungen ─────────────────────────────────────────
  'Die Belohnung muss eine Zahl ab 0 sein.': 'The reward must be a number of at least 0.',
  'Beim Schwarm sind 1 bis 9 Bestätigungen sinnvoll.': 'For a swarm, 1 to 9 confirmations make sense.',
  'Wähle die Gruppe, die abnehmen soll.': 'Choose the group that signs off.',
  'Wähle die Gruppe, die den Auftrag sehen soll.': 'Choose the group that may see the quest.',
  'Für die Regionsliste braucht es eine Kurzbeschreibung.': 'The regional list needs a short summary.',
  'Jede Forderung braucht eine Gattung — sonst zählt jeder beliebige Gegenstand.':
    'Every requirement needs a kind — otherwise any item counts.',
  'Der Vorrat muss mindestens 1 sein.': 'The stock must be at least 1.',
  'Der Vorrat kann nicht kleiner sein als die Belohnung für einen Durchlauf.':
    'The stock cannot be smaller than the reward for a single run.',
  'Auftrag ohne Kennung': 'Quest without an id',
  'Ohne bekannte Position lässt sich kein Auftrag anlegen.': 'A quest needs a known position.',
  'Kein verbundener Server — der Auftrag kann nirgends angelegt werden.':
    'No connected server — the quest cannot be created anywhere.',
  'Der Auftrag wurde nicht angelegt.': 'The quest was not created.',
  'Ohne Belohnung lässt sich kein Auftrag ausschreiben.': 'A quest cannot be posted without a reward.',

  // ── Karma ───────────────────────────────────────────────────────────
  'Auftrag erledigt': 'Quest completed',
  'Erledigung von jemandem abgenommen': 'Signed off someone else’s work',
  'Abnahme für andere übernommen': 'Reviewed for others',
  'Höchste Stufe erreicht.': 'Highest level reached.',
  '{n} Punkte bis Karma {stufe}.': '{n} points to karma {stufe}.',

  // ── Objekte und Aktionen ────────────────────────────────────────────
  'Untersuchen': 'Examine',
  'Sprechen': 'Talk',
  'Angreifen': 'Attack',
  'Rufen': 'Call',
  'Füttern': 'Feed',
  'Einsammeln': 'Pick up',
  'Löschen': 'Delete',
  'Interaktionen': 'Interactions',
  'Auf der Karte zeigen': 'Show on map',
  'Keine Objekte in der Nähe.': 'No objects nearby.',
  'Warte auf Position …': 'Waiting for a position …',
  'Unbenanntes Objekt': 'Unnamed object',
  'Auswahl aufgehoben': 'Selection cleared',
  'Angriff — {was} getötet': 'Attack — {was} killed',
  'Füttern — {was} gefüttert': 'Feed — {was} fed',
  '{name} eingesammelt': '{name} picked up',
  'Standort-Freigabe nötig': 'location sharing required',
  'zu weit weg': 'too far away',
  'Keine Position verfügbar.': 'No position available.',
  'Aktion nicht möglich: {grund}': 'Action not possible: {grund}',
  'Aufnehmen nicht möglich: {grund}': 'Cannot pick up: {grund}',
  'Löschen fehlgeschlagen: {grund}': 'Delete failed: {grund}',

  // ── Objekte erzeugen ────────────────────────────────────────────────
  '{was} hier erzeugen': 'Create {was} here',
  'Zufällig hier erzeugen': 'Create something random here',
  'Zufälliges Objekt': 'Random object',
  'Keine Position — Erzeugen braucht deinen Standort': 'No position — creating needs your location',
  'Zum Erzeugen bitte anmelden': 'Sign in to create',
  'Das Auftrags-Fenster gibt es in dieser Ansicht nicht.': 'The quest window is not available in this view.',

  // ── Standort und Privatsphäre ───────────────────────────────────────
  'Verborgen': 'Hidden',
  'Gegend': 'Area',
  'Nähe': 'Proximity',
  'Genau': 'Exact',
  'Standort-Freigabe': 'Location sharing',
  'Wer sieht mich hier': 'Who can see me here',
  'Nur angemeldete Spieler': 'Signed-in players only',
  'Alle Besucher, auch nicht angemeldete': 'All visitors, including signed-out',
  'Gilt nur bei Standort-Freigabe „Genau".': 'Only applies at location sharing "Exact".',
  'Alle Server folgen diesem Standard.': 'All servers follow this default.',
  'Eigene Einstellung für diesen Server.': 'Custom setting for this server.',
  'Folgt dem Standard aus den Einstellungen.': 'Follows the default from Settings.',
  'Wieder dem Standard folgen': 'Follow the default again',

  // ── Rechte ──────────────────────────────────────────────────────────
  'Angemeldete Spieler': 'Signed-in players',
  'Nicht angemeldete Besucher': 'Signed-out visitors',
  'Bitte auswählen, für wen die Regel gilt': 'Choose who the rule applies to',
  'Einzelne Spieler lassen sich noch nicht zuweisen — dafür Gruppen benutzen.':
    'Individual players cannot be assigned yet — use groups instead.',
  'Hinzufügen fehlgeschlagen: {grund}': 'Adding failed: {grund}',

  // ── Einstellungen und Server ────────────────────────────────────────
  'Audio': 'Audio',
  'Sichtweite': 'View distance',
  'Sprache': 'Language',
  'Verwaltung': 'Administration',
  'Neuer Name für diesen Server:': 'New name for this server:',
  'Kein erreichbarer Server konfiguriert — bitte zuerst unter Einstellungen → Verwaltung → Server eintragen.':
    'No reachable server configured — add one under Settings → Administration → Servers first.',
  'Anmeldung läuft …': 'Signing in …',
  'Anmeldung fehlgeschlagen': 'Sign-in failed',
  'E-Mail und Passwort erforderlich': 'Email and password required',
  'Editor nicht verfügbar.': 'Editor not available.',
  'Die AR-Ansicht konnte nicht geladen werden.': 'The AR view could not be loaded.',
  'Ort unbekannt': 'Place unknown',
  'Keine Quelle hat sich angemeldet. Ohne laufende Agents gibt es nichts zu filtern.':
    'No source has registered. With no agents running there is nothing to filter.',
  'Zurücksetzen (alles anzeigen)': 'Reset (show everything)',
  'Teilen fehlgeschlagen': 'Sharing failed',
  'Sprachausgabe steht in dieser Ansicht nicht zur Verfügung.': 'Speech output is not available in this view.',
  'Audio-Diagnose eingeschaltet': 'Audio diagnostics on',

  // ── Chat ────────────────────────────────────────────────────────────
  'Nachricht …': 'Message …',
  'Leeren': 'Clear',
  'Verlauf leeren': 'Clear history',
  'Verlauf wirklich leeren?': 'Really clear the history?',
  'Diese Figur hat kein Konto — niemand kann antworten.': 'This character has no account — nobody can reply.',
  'Antippen zum Antworten': 'Tap to reply',

  // ── Zauberstab und UWB ──────────────────────────────────────────────
  'Zauberstab verbinden': 'Connect wand',
  'Zauberstab trennen': 'Disconnect wand',
  'UWB verbinden': 'Connect UWB',
  'UWB trennen': 'Disconnect UWB',
  'Verbinde …': 'Connecting …',
  'Verbindung fehlgeschlagen': 'Connection failed',
  'Nur in der App (Capacitor) verfügbar': 'Only available in the app',
  'Orientierung: —': 'Orientation: —',
  'Orientierung: (Stab nicht verbunden)': 'Orientation: (wand not connected)',
  'Kalibriere … Stab senkrecht halten': 'Calibrating … hold the wand upright',
  'Name (z. B. Wohnzimmer)': 'Name (e.g. living room)',
  'PANS-Netz-ID (aus DRTLS, z. B. 0x89AB)': 'PANS network id (from DRTLS, e.g. 0x89AB)',
  'PANS-Netz-ID erforderlich (aus der DRTLS-App)': 'PANS network id required (from the DRTLS app)',
  'PANS-Netz-ID: {id} — diese ID in DRTLS für weitere Anker verwenden':
    'PANS network id: {id} — use this id in DRTLS for further anchors',
  'Lege Netz an …': 'Creating network …',
  'Lege Anker an …': 'Creating anchor …',
  'Anlegen fehlgeschlagen': 'Creating failed',
  'Anker anlegen fehlgeschlagen': 'Creating the anchor failed',
  'Zum Anlegen bitte anmelden': 'Sign in to create',
  'Erst ein Netz auswählen, dann den Anker beitragen': 'Choose a network first, then contribute the anchor',
  'Keine Position — Anker braucht seinen genauen Standort': 'No position — an anchor needs its exact location',
  'Node-ID erforderlich (uint16, aus DRTLS)': 'Node id required (uint16, from DRTLS)',
  'Ungültige Node-ID (0…65535)': 'Invalid node id (0…65535)',

  // ── Editor, Gruppen, Server-Verwaltung ──────────────────────────────
  'Neues Objekt': 'New object',
  'Objekt bearbeiten': 'Edit object',
  'UWB-Anker bearbeiten': 'Edit UWB anchor',
  'Objekt gespeichert': 'Object saved',
  'Objekt gelöscht': 'Object deleted',
  'Objekte geladen': 'Objects loaded',
  'Objekt-ID kopiert': 'Object id copied',
  'Objekt-ID — zum Kopieren anklicken': 'Object id — click to copy',
  'Noch nicht ausgeschrieben.': 'Not posted yet.',
  'Externe URL…': 'External URL…',
  'Externe URLs sind oben ausgeschaltet.': 'External URLs are switched off above.',
  'Zum Anlegen bitte anmelden.': 'Sign in to create.',
  'Anmeldung erfolgreich': 'Signed in',
  'Anmeldung fehlgeschlagen: ': 'Sign-in failed: ',
  'Zustand (JSON) ist ungültig: ': 'The state (JSON) is invalid: ',
  'Der Zustand muss ein JSON-Objekt sein.': 'The state must be a JSON object.',
  'Breite und Länge müssen Zahlen sein.': 'Latitude and longitude must be numbers.',
  'Speichern fehlgeschlagen: ': 'Saving failed: ',
  'AR-Moduswechsel fehlgeschlagen': 'Switching the AR mode failed',

  'Bitte zuerst anmelden.': 'Please sign in first.',
  'Neue Gruppe (Name)': 'New group (name)',
  'Konnte Daten nicht laden: ': 'Could not load the data: ',
  'Anlegen fehlgeschlagen: ': 'Creating failed: ',
  'Umbenennen fehlgeschlagen: ': 'Renaming failed: ',
  'Löschen fehlgeschlagen: ': 'Deleting failed: ',
  'Einladung fehlgeschlagen: ': 'The invitation failed: ',
  'Annehmen fehlgeschlagen: ': 'Accepting failed: ',
  'Ablehnen fehlgeschlagen: ': 'Declining failed: ',
  'Einladung wirklich zurückziehen?': 'Really withdraw the invitation?',
  'Zurückziehen fehlgeschlagen: ': 'Withdrawing failed: ',
  'Mitglied entfernen fehlgeschlagen: ': 'Removing the member failed: ',
  'Untergruppe hinzufügen fehlgeschlagen: ': 'Adding the subgroup failed: ',
  'Untergruppe entfernen fehlgeschlagen: ': 'Removing the subgroup failed: ',
  'Gruppe kann nicht sich selbst enthalten': 'A group cannot contain itself',
  'Austreten folgt im nächsten Schritt': 'Leaving comes in a later step',

  'Label (optional)': 'Label (optional)',
  'Hinzugefügt: {name}': 'Added: {name}',
  'Standard-Server — neue Objekte landen hier.': 'Default server — new objects go here.',
  'Angemeldet, Live-Verbindung steht.': 'Signed in, live connection up.',
  'Angemeldet, aber ohne Live-Verbindung.': 'Signed in, but without a live connection.',
  'Token (offline)': 'Token (offline)',
  'Zugang liegt lokal vor, der Server hat ihn nicht bestätigt.':
    'The credentials are stored locally but the server has not confirmed them.',
  'Gültiges Token (lokal).': 'Valid token (local).',
  'Wird gegen den Server verifiziert …': 'Verifying against the server …',

  'Alle, auch nicht angemeldete': 'Everyone, including signed-out',
  'Bestimmter Spieler': 'A specific player',
  'Bestimmte Gruppe': 'A specific group',
  'Mindestens ein Recht wählen.': 'Choose at least one right.',
  'Identischer Eintrag existiert bereits.': 'An identical entry already exists.',
  'Hinzugefügt — vergiss nicht zu speichern.': 'Added — remember to save.',
  'Eintrag entfernt — vergiss nicht zu speichern.': 'Entry removed — remember to save.',

  // ── AR-Ansicht und Karte ────────────────────────────────────────────
  'SLAM nicht verfügbar — Kompass': 'SLAM unavailable — using the compass',
  'Kamera nicht verfügbar': 'Camera unavailable',
  'Änderungen übernommen': 'Changes applied',
  'Speichern fehlgeschlagen': 'Saving failed',
  'Aktion nicht möglich': 'Action not possible',
  'Platzieren fehlgeschlagen: ': 'Placing failed: ',
  'Neues Objekt…': 'New object…',
  'Zufälliges Objekt (mir gehörend)…': 'Random object (owned by me)…',
  'Erzeugen fehlgeschlagen': 'Creating failed',
  'Karte hell': 'Light map',
  'Karte dunkel': 'Dark map',
  'Auftrag ohne Beschreibung': 'Quest without a description',
  'Bitte anmelden — die Objekt-Werkzeuge brauchen Bearbeitungsrechte.':
    'Please sign in — the object tools need edit rights.',
  'Zum Verschieben fehlt dir das Recht.': 'You do not have the right to move this.',
  'Pfeile verschieben · Ring dreht · Würfel skalieren. Esc beendet.':
    'Arrows move · ring rotates · cubes scale. Esc finishes.',

  // ── Peilen ──────────────────────────────────────────────────────────
  'Halten und zeigen': 'Hold and point',
  'Jemand': 'Someone',
  'Ansprechen': 'Talk to',
  'nah': 'near',
  'mittel': 'medium',
  'fern': 'far',
  '{label} < {max} m': '{label} < {max} m',

  'Zeigen … loslassen zum Festhalten': 'Pointing … release to lock',
  '{name} — kurz tippen zum Lösen': '{name} — tap briefly to release',
  'Kein Kompass — Peilen nicht möglich': 'No compass — pointing unavailable',
  'Objekt': 'Object',

  // ── Server-Meldungen (Schlüssel = code aus der Antwort) ─────────────
  'fehler.proof_not_found': 'Those images could not be found.',
  'fehler.proof_foreign': 'Those images belong to someone else.',
  'fehler.proof_other_call': 'Those images belong to a different quest.',
  'fehler.proof_empty': 'No image was attached.',
  'fehler.reward_reduced': 'Someone is working on this quest — the reward may be raised, not reduced.',
}

export default texte
