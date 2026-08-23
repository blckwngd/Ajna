#!/usr/bin/env node
//
// tests/run-quests.mjs — E2E-Regressionsnetz für Quests/Handel.
//
//   npm run test:quests            (Stack muss laufen: npm run stack)
//   AJNA_TEST_PB=http://host:8090 npm run test:quests
//
// Prüft die server-autoritative Kette (pb_hooks/quests.js + die quest/*-Routen):
// gedeckte Belohnungen, Treuhand, atomarer Tausch, Gattungs-Forderungen,
// Agent-Verifikation, Wiederholbarkeit, Selbstheilung verwaister Bindungen.
//
// Wichtig: PocketBase lädt pb_hooks NICHT neu — nach Hook-Änderungen den Stack
// neu starten, sonst testet man gegen alten Code.

import { runSuites } from './_runner.mjs'

import * as basic from './quests/basic.mjs'
import * as requires from './quests/requires.mjs'
import * as repeat from './quests/repeat.mjs'
import * as self from './quests/self.mjs'
import * as orphan from './quests/orphan.mjs'
import * as save from './quests/save.mjs'
import * as revive from './quests/revive.mjs'
import * as fristKarma from './quests/frist-karma.mjs'
import * as schwarm from './quests/schwarm.mjs'
import * as nachweisListe from './quests/nachweis-liste.mjs'
import * as pruefgruppe from './quests/pruefgruppe.mjs'
import * as gruppenrechte from './quests/gruppenrechte.mjs'
import * as aufgebenListe from './quests/aufgeben-liste.mjs'
import * as umlaute from './quests/umlaute.mjs'
import * as karmaBonus from './quests/karma-bonus.mjs'

await runSuites('Quests', 'qtest', [basic, requires, repeat, self, orphan, save, revive, fristKarma, schwarm, nachweisListe, pruefgruppe, gruppenrechte, aufgebenListe, umlaute, karmaBonus])
