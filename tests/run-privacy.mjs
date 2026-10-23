#!/usr/bin/env node
//
// tests/run-privacy.mjs — E2E-Netz für die Privatsphäre-Grenzen.
//
//   npm run test:privacy           (Stack muss laufen: npm run stack)
//
// Prüft, was der SERVER durchlässt. Die Client-Seite (PrivacyPolicy-Stufen,
// Fan-out-Durchsetzung, Umkreis-Rechnung) hängt an localStorage/Position und
// wird hier nicht abgedeckt — dort ist der Server ohnehin nicht die Grenze,
// sondern die letzte Instanz, die „nein" sagen kann.
//
// Wichtig: PocketBase lädt pb_hooks NICHT neu — nach Hook-Änderungen den Stack
// neu starten, sonst testet man gegen alten Code.

import { runSuites } from './_runner.mjs'

import * as proximity from './privacy/proximity.mjs'
import * as agentCommand from './privacy/agent-command.mjs'
import * as gastkonten from './privacy/gastkonten.mjs'
import * as publicSettings from './privacy/public-settings.mjs'
import * as clientzugang from './privacy/clientzugang.mjs'
import * as fluechtig from './privacy/fluechtig.mjs'
import * as quelleBeute from './privacy/quelle-beute.mjs'
import * as aceSchreiben from './privacy/ace-schreiben.mjs'
import * as realtimeThemen from './privacy/realtime-themen.mjs'
import * as postfach from './privacy/postfach.mjs'
import * as freunde from './privacy/freunde.mjs'

await runSuites('Privatsphäre', 'ptest', [proximity, agentCommand, gastkonten, publicSettings, clientzugang, fluechtig, quelleBeute, aceSchreiben, realtimeThemen, postfach, freunde])
