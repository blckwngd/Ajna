#!/usr/bin/env node
// Ersatz fuer `cap run android`: Auf Windows ruft Capacitor intern `./gradlew`
// ueber cross-spawn auf, was die .bat nicht findet ("Befehl gradlew nicht
// gefunden"). Wir bauen+installieren daher direkt ueber den Gradle-Wrapper und
// starten die App per adb aus dem Android-SDK.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const androidDir = join(root, 'android');
const isWin = process.platform === 'win32';
const APP_ID = 'de.blckwngd.ajna';

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) {
    console.error(`\n[mobile-run] Schritt fehlgeschlagen: ${cmd} ${args.join(' ')}`);
    process.exit(r.status ?? 1);
  }
}

function findAdb() {
  if (process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT) {
    const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
    const p = join(sdk, 'platform-tools', isWin ? 'adb.exe' : 'adb');
    if (existsSync(p)) return p;
  }
  const local = process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe');
  if (local && existsSync(local)) return local;
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) {
    const candidates = isWin
      ? [join(home, 'AppData', 'Local', 'Android', 'Sdk', 'platform-tools', 'adb.exe')]
      : [join(home, 'Library', 'Android', 'sdk', 'platform-tools', 'adb'), join(home, 'Android', 'Sdk', 'platform-tools', 'adb')];
    for (const c of candidates) if (existsSync(c)) return c;
  }
  return 'adb'; // Fallback: aus PATH
}

const gradlew = join(androidDir, isWin ? 'gradlew.bat' : 'gradlew');

// 1) Web-Assets in das native Projekt kopieren
run('npx', ['cap', 'sync', 'android'], { cwd: root, shell: isWin });
// 2) Bauen + auf verbundenes Geraet installieren (Gradle nutzt SDK-eigenes adb)
//    shell:true noetig, weil Node .bat-Dateien nicht direkt als Prozess startet.
run(gradlew, ['-p', androidDir, 'installDebug', '--console=plain'], { shell: isWin });
// 3) App starten
const adb = findAdb();
run(adb, ['shell', 'monkey', '-p', APP_ID, '-c', 'android.intent.category.LAUNCHER', '1']);
console.log('\n[mobile-run] Fertig — App gestartet.');
