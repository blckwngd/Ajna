# Ajna

## Vision

Ajna ist ein experimentelles Multiplayer Projekt, das geospatiale Daten mit einer 3D Engine kombiniert. Ziel ist es, reale GPS Koordinaten in eine virtuelle Welt zu übertragen und Interaktionen zwischen Spielern auf Basis ihrer physischen Umgebung zu ermöglichen.

Der Fokus liegt auf einer modularen Architektur, klarer Trennung von Verantwortlichkeiten und der Option, Datenschutz und Spielmechanik flexibel auszubalancieren.

---

## Kernidee

Spielobjekte und Spielerpositionen basieren auf realen GPS Koordinaten. Diese werden clientseitig erfasst und in relative Weltkoordinaten transformiert, sodass sie in einer 3D Szene dargestellt werden können.

Der Server übernimmt primär folgende Aufgaben:

- Verwaltung verbundener Spieler
- Interest Management
- Synchronisation von Zuständen
- Temporäre Speicherung von Positionsdaten im Arbeitsspeicher

Eine persistente Speicherung exakter Positionsdaten ist aktuell nicht vorgesehen.

---

## Architekturüberblick

### Client

- Erfasst GPS Koordinaten
- Transformiert geografische Koordinaten in lokale 3D Koordinaten
- Rendert Szene und Spielobjekte
- Kommuniziert Positionsupdates über WebSockets

Die Welt ist relativ zum eigenen Spieler aufgebaut. Andere Spieler werden als Differenzvektoren zur eigenen Position dargestellt.

### Server

- Node.js basierter Multiplayer Server
- In Memory Speicherung aktueller Positionen
- Abstrakte PositionProvider Schnittstelle zur späteren Erweiterung
- Keine Persistenz von Bewegungsdaten

Die Positionslogik ist bewusst gekapselt, sodass später problemlos auf regionenbasierte oder datenschutzorientierte Modelle umgestellt werden kann.

---

## Aktueller Stand

- Grundlegende Multiplayer Kommunikation
- In Memory Positionsverwaltung
- Radiusbasierte Näheberechnung
- Transformationslogik von GPS zu Weltkoordinaten
- Modularisierte Serverarchitektur

Nicht implementiert:

- Persistente Speicherung
- Regionale Aggregation über Geohash oder Grid Systeme
- Anti Cheat Mechanismen
- Peer to Peer Positionsfreigabe

---

## Datenschutzstrategie

Aktuell werden exakte Positionen nur im Arbeitsspeicher des Servers gehalten und nicht persistiert. Die Architektur erlaubt es, zukünftig auf ein Modell umzusteigen, bei dem der Server nur ungefähre Regionen speichert oder exakte Koordinaten ausschließlich clientseitig verbleiben.

Damit bleibt die Option offen, Ajna stärker privacy by design auszurichten.

---

## Nächste Schritte

- Skalierbares Interest Management
- Performanceoptimierung bei vielen gleichzeitigen Spielern
- Optionale Validierung gegen GPS Spoofing
- Evaluierung von WebRTC für direkte Peer Interaktionen

---

## Projektstatus

Ajna befindet sich im experimentellen Entwicklungsstadium. Architekturentscheidungen werden bewusst so getroffen, dass zukünftige Anpassungen ohne tiefgreifende Refactorings möglich bleiben.

