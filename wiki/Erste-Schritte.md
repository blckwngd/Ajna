# Erste Schritte

<!-- nav -->
[← Inhalt](Home.md#inhalt) · Benutzen: **Erste Schritte** · [Die App](Die-App.md) · [Privatsphäre](Privatsphaere.md)
<!-- /nav -->

Für alle, die Ajna **benutzen** wollen. Einen eigenen Server brauchst du dafür nicht — nur die Adresse einer Instanz.

## Was du brauchst

- Ein Smartphone oder einen Rechner mit aktuellem Browser
- Die Adresse einer Ajna-Instanz, z. B. `https://ajna.example.com`
- Für AR: Android mit Chrome und ARCore-Unterstützung. Ohne das bleibt die 3D-Ansicht nutzbar, nur ohne Kamerabild.

> **Standortfreigabe:** Ohne Standort weiß der Client nicht, wo du bist, und zeigt nichts Sinnvolles. Der Browser fragt beim ersten Start. Was davon den Server erreicht, entscheidest **du** — siehe [Privatsphäre](Privatsphaere.md).

## Losgehen

**1. Adresse öffnen.** Rufe die Instanz im Browser auf. Du landest im Haupt-Client mit vier Reitern: Karte, AR, Objekte, Einstellungen.

**2. Umsehen ohne Konto.** Viele Instanzen zeigen anonym schon etwas — alles, was für „alle" freigegeben ist. Zum Anlegen und Interagieren brauchst du ein Konto.

**3. Anmelden.** *Einstellungen → Zugang*. Ob du dich selbst registrieren kannst oder Zugangsdaten vom Betreiber bekommst, entscheidet die Instanz — PocketBase erlaubt Selbstregistrierung per Voreinstellung.

**4. Standort-Stufe wählen.** *Einstellungen → Privatsphäre*. Voreinstellung für neue Server ist **Verborgen** — bewusst die zurückhaltendste. Solange sie steht, erfährt der Server deine Position nicht, und Agents bevölkern die Welt nicht um dich herum. Wer belebte Umgebung will, stellt mindestens auf **Gegend**. Die vier Stufen erklärt [Privatsphäre](Privatsphaere.md).

**5. Zur AR-Ansicht wechseln.** Reiter *AR*. Meldet das Gerät kein immersives WebXR, bietet die App an, die Seite in Chrome zu öffnen (dort funktioniert ARCore) oder eine 3D-Vorschau ohne Kamerabild anzuzeigen.

## Wenn etwas nicht klappt

| Symptom | Ursache und Abhilfe |
|---|---|
| Karte leer, keine Objekte | Nicht angemeldet, oder nichts in der Nähe für „alle" freigegeben. Anmelden und die Objektliste prüfen. |
| Alles steht am selben Fleck | Kein Standort-Fix. Standortfreigabe im Browser prüfen; in Gebäuden dauert der erste Fix. |
| AR zeigt kein Kamerabild | Kein immersives WebXR in diesem Browser. In Chrome öffnen (die App bietet den Wechsel an und nimmt Anmeldung und Filter mit). |
| Welt ist nord-süd verdreht | Kompass-Versatz. *Einstellungen → AR-Ansicht → Nord-Offset*, Knopf „↺ 180°". |
| Objekte liegen schräg im Bild | *Einstellungen → AR-Ansicht → Blickfeld (FOV)* nachziehen. Der Wert gilt pro Gerät. |
| Es ruckelt | *Einstellungen → Sichtweite*: Kulisse und Gelände kleiner stellen. |

## Weiter

- [Die App](Die-App.md) — was die vier Reiter können
- [Privatsphäre](Privatsphaere.md) — welche Daten das Gerät verlassen

<!-- navfuss -->
---

← [Start](Home.md) · [Inhalt](Home.md#inhalt) · [Die App](Die-App.md) →
<!-- /navfuss -->
