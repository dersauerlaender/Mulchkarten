# Mulchkarten

Offline-Web-App (PWA) für Geo-PDF-Karten (z. B. ArcGIS-Exporte von Hessen Forst):

- **Kartenliste nach GPS**: Karte, auf der man steht, ganz oben („📍 Hier“), alle anderen nach Entfernung
- **GPS-Position** auf der Karte, Hinweis „x m außerhalb“ und Sprung zur Nachbarkarte
- **Malen** (Freihand) und **GPS-Tracks aufnehmen** in drei Farben: Erledigt (grün), Offen (rot), Hinweis (gelb, gestrichelt)
- Linien antippen → Farbe ändern oder löschen; „Zurück“ macht die letzte eigene Linie rückgängig
- **Status je Karte**: Offen / In Arbeit / Fertig (mit Datum + Name). Ein Track setzt „Offen“ automatisch auf „In Arbeit“
- **Saison** (Juli–Juni, z. B. 26/27) und optionales **Revier** je Karte, Filter in der Liste
- **Arbeitsstand teilen** über WhatsApp (kleine .txt-Datei), Import beim Kollegen führt die Stände zusammen
- **Zeiterfassung pro Karte** mit Zählstellen-Wechsel (siehe unten), Zeiten nachtragen und korrigieren
- **Auswertung**: Stunden je Revier, Karte und Person, km aus den Tracks, Export als CSV
- **Übersichtskarte** (🗺): alle Kartenrahmen nach Status gefärbt, mit den PDF-Karten als Vorschaubild (auch offline), dazu OpenStreetMap als Hintergrund, wenn Internet da ist (▦ schaltet ihn ab). Antippen zeigt die Karten an dieser Stelle mit „Öffnen“, „Nach vorn“, „Transparent“ und „Ausblenden“. Über ◫ Ebenen lassen sich alle Karten auf Sichtbar, Transparent oder Aus stellen. Das gilt nur für die Übersicht auf dem eigenen Gerät.
- **⤢ Ganze Karte**: holt die Ansicht zurück auf die komplette Karte. „Position“ springt nicht mehr ins Leere, wenn man mehr als 3 km entfernt ist.

Alle Daten liegen nur auf dem jeweiligen Handy (IndexedDB). Es gibt keinen Server und kein Konto.

## Installation (einmalig)

Die App muss über **HTTPS** erreichbar sein (wegen GPS und Offline-Funktion). Am einfachsten geht das kostenlos so:

**GitHub Pages**
1. Auf github.com ein neues öffentliches Repository anlegen, z. B. `mulchkarten`.
2. Den Inhalt dieses Ordners hochladen (*Add file → Upload files*, alle Dateien und Ordner hineinziehen).
3. *Settings → Pages → Branch: main / root → Save*.
4. Nach etwa einer Minute ist die App unter `https://<name>.github.io/mulchkarten/` erreichbar.

**Alternativ Netlify Drop**: app.netlify.com/drop öffnen und den Ordner hineinziehen. Mit einem kostenlosen Konto bleibt die Seite dauerhaft online.

Danach auf jedem Handy die Adresse öffnen und die App auf den Startbildschirm legen:
- **Android (Chrome)**: Menü ⋮ → „App installieren“ / „Zum Startbildschirm hinzufügen“
- **iPhone (Safari)**: Teilen-Symbol → „Zum Home-Bildschirm“

Erst danach erscheint „Mulchkarten“ auf Android im WhatsApp-Teilen-Menü, und der Speicher ist vor dem Aufräumen durch den Browser geschützt.

## Bedienung

- **Unten** wechselt die Leiste zwischen den drei Bereichen: 📋 **Karten** (Liste), 🗺 **Übersicht** und ⏱ **Zeiten**.
- **＋ unten rechts** öffnet die passenden Aktionen: Karten/Stand importieren und Stand teilen, in der Übersicht zusätzlich „POI an meiner Position“, bei den Zeiten „Zeit nachtragen“ und den CSV-Export.
- **⚙ oben rechts**: Name, Saison, Updates, „Über & Lizenzen“.
- **Android-Zurück** schließt zuerst Menüs und Dialoge, dann die Karte. Aus der Übersicht oder den Zeiten geht es zurück zur Liste.

## Arbeitsablauf

**Karten bekommen (WhatsApp)**
- Android: PDF in WhatsApp antippen → Teilen → *Mulchkarten*
- iPhone: PDF öffnen → Teilen → *In Dateien sichern*, dann in der App ＋ → *Karten / Stand importieren*

Die Karte bekommt automatisch die eingestellte Saison. Revier, Name und Notiz trägt man über ✎ in der Kartenansicht ein.

**Arbeitsstand weitergeben**
1. Nach der Schicht ＋ → *Stand teilen* → Saison wählen → *Teilen* → WhatsApp-Gruppe auswählen.
2. Der Nächste öffnet die Datei genauso wie eine PDF (Android: Teilen → Mulchkarten, iPhone: sichern + ＋ → Importieren).
3. Beim Zusammenführen gewinnt pro Karte und pro Linie die neueste Änderung. Gelöschte Linien werden auch beim Kollegen gelöscht. Ein Stand kann gefahrlos mehrfach importiert werden.

Ein neuer Kollege ohne Karten setzt beim Teilen den Haken *Karten-PDFs mitschicken*. Kommt ein Stand für eine Karte an, deren PDF noch fehlt, erscheint sie als „PDF fehlt“. Sobald die PDF importiert ist, werden die Linien automatisch zugeordnet. Erkannt wird die Karte am Dateiinhalt, nicht am Dateinamen.

## POIs und Navigation

- **Punkt antippen** in der Übersichtskarte, oder **lange drücken** in einer Karte. Es öffnet sich ein Fenster mit Koordinaten und Entfernung sowie den Knöpfen:
  - **🧭 Navigation**: Android fragt, mit welcher Navi-App (Google Maps, OsmAnd, Waze …) navigiert werden soll. Am iPhone öffnet sich Apple Karten.
  - **Google Maps**: öffnet direkt die Routenplanung zum Punkt.
  - **Teilen**: schickt einen Google-Maps-Link, z. B. per WhatsApp.
  - **Als POI speichern**: legt einen dauerhaften Punkt an.
- **＋ → „POI an meiner Position“** in der Übersicht legt einen POI an der eigenen GPS-Position an (z. B. „hier ist der Parkplatz“).
- **Arten**: Parkplatz, Wendemöglichkeit, Schranke/Sperre, Gefahr/Hindernis, Treffpunkt, Sonstiges. Dazu Name und Notiz.
- POIs erscheinen in der Übersicht und in jeder Karte. Antippen zeigt Notiz, Navigation und Bearbeiten.
- POIs gehen beim **Stand teilen** immer mit, unabhängig von der gewählten Saison. Auch Änderungen und Löschungen kommen bei den anderen an.

## Zeiterfassung

- In der Kartenansicht **⏱ Zeit** antippen: Die Zeit läuft ab jetzt für diese Karte und damit auch für ihr Revier. Die blaue Leiste oben zeigt die laufende Zeit; mit „Stopp“ endet sie.
- Ist man auf einer anderen Karte als der laufenden Zählstelle, steht auf dem Knopf „Wechseln“.
- **Automatische Abfrage**: Fährt man bei laufender Zeit auf eine andere Karte der aktuellen Saison, die nicht „Fertig“ ist, und bleibt etwa 15 Sekunden dort, fragt die App:
  - **Wechseln mit Anfahrt**: Die neue Karte zählt ab dem Moment, in dem man die alte verlassen hat. Die Anfahrt gehört also zum Ziel. Typischer Fall: auf Karte A parken, zu Karte B fahren.
  - **Ab jetzt**: Die Anfahrt bleibt bei der alten Karte.
  - **Nicht wechseln**: Die Fahrt gehört zur alten Karte, z. B. bei der Rückfahrt zum Parkplatz. Für diese Karte fragt die App dann 30 Minuten nicht mehr.
- Die Abfrage kommt nur, wenn die App offen ist. Hatte man das Handy weggelegt, erscheint sie beim nächsten Öffnen. „Mit Anfahrt“ rechnet trotzdem ab dem richtigen Zeitpunkt, weil sich die App den letzten Moment auf der alten Karte merkt.
- Im Bereich ⏱ Zeiten lassen sich Einträge mit ✎ korrigieren oder löschen. Vergessene Zeiten trägt man über ＋ → „Zeit nachtragen“ nach.
- Beim Teilen des Arbeitsstands gehen die abgeschlossenen Zeiteinträge mit. Jeder Eintrag trägt den Namen der Person.

## Grenzen

- **Browser:** Auf Android die App über **Chrome** installieren. Firefox kann aus Web-Apps keine Dateien an WhatsApp übergeben und taucht auch nicht im WhatsApp-Teilen-Menü auf. Firefox kann trotzdem Standardbrowser bleiben. Auf dem iPhone Safari verwenden.

- **Track-Aufnahme nur bei eingeschaltetem Bildschirm.** Web-Apps bekommen kein GPS, solange der Bildschirm aus ist oder die App im Hintergrund läuft. Die App hält den Bildschirm während der Aufnahme wach (Wake Lock). Wird sie trotzdem beendet, wird der Track beim nächsten Start gespeichert.
- Die Karte wird beim Import einmal als Bild mit bis zu 4096 px Kantenlänge gespeichert. Bei sehr großen Karten (A0) wird sie beim starken Hineinzoomen unscharf.
- Unterstützt werden Geo-PDFs nach ISO-Standard (ArcGIS, QGIS, Avenza-Exporte). Das alte TerraGo-Format wird nicht erkannt.

## Updates einspielen

Dateien ändern und in `sw.js` die Zeile `const VERSION = 'mk-…'` hochzählen. Dann holen sich die Handys beim nächsten Öffnen mit Netz die neue Version. Die Daten bleiben erhalten.

## Technik

Reines HTML/JS ohne Build-Schritt. Bibliotheken liegen in `vendor/`:
[pdf.js](https://github.com/mozilla/pdf.js) (Apache-2.0, rendert die Karte), [pdf-lib](https://github.com/Hopding/pdf-lib) (MIT, liest die Georeferenz `/VP → /Measure → GPTS/LPTS`), [d3](https://d3js.org) (ISC, Zoom/Pan per Touch, Linien).
Code in `js/`: `georef.js` (Koordinaten), `pdfimport.js`, `model.js` (Daten, Import/Export), `app.js` (Oberfläche), `db.js` (IndexedDB). `sw.js` ist der Service Worker (Offline-Cache und Empfang geteilter Dateien).

## Lizenz & Entstehung

Der Code der App steht unter der **MIT-Lizenz** (siehe `LICENSE`): Jeder darf ihn nutzen, ändern und weitergeben, solange der Urheberhinweis erhalten bleibt.
Die Bibliotheken in `vendor/` haben eigene freie Lizenzen (Apache-2.0, MIT, ISC), die vollständigen Texte stehen in `THIRD_PARTY_LICENSES.md`. In der App gibt es dazu ⚙ → „Über & Lizenzen“.

Entstanden per *Vibe Coding* mit Claude (Anthropic).

**Wichtig:** Keine Forstkarten (PDFs) oder Arbeitsstände in dieses öffentliche Repository hochladen. Die Karten gehören dem Herausgeber und bleiben nur auf den Handys.
