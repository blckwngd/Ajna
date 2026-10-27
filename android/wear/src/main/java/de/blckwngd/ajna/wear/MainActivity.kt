package de.blckwngd.ajna.wear

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.wear.ambient.AmbientLifecycleObserver
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.material.Chip
import androidx.wear.compose.material.ChipDefaults
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.Text
import androidx.wear.compose.material.ToggleChip
import androidx.wear.compose.material.ToggleChipDefaults

/**
 * What the player sees and touches on the watch.
 *
 * Touch areas send SEMANTIC actions (`{"type":"action"}`); the hardware
 * buttons send raw codes (`stem1`, `stem2`, …) which the phone maps — so
 * their meaning is configurable on the phone, per watch.
 */
class MainActivity : ComponentActivity() {

    private val ambient = mutableStateOf(false)
    private val downAt = HashMap<Int, Long>()

    private val ambientObserver by lazy {
        AmbientLifecycleObserver(this, object : AmbientLifecycleObserver.AmbientLifecycleCallback {
            override fun onEnterAmbient(ambientDetails: AmbientLifecycleObserver.AmbientDetails) { ambient.value = true }
            override fun onExitAmbient() { ambient.value = false }
        })
    }

    private val permissions = ActivityResultContracts.RequestMultiplePermissions()
    private val askPermissions = registerForActivityResult(permissions) { startLink() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        lifecycle.addObserver(ambientObserver)
        setContent { MaterialTheme { Screen(ambient.value) } }
        val needed = buildList {
            if (Build.VERSION.SDK_INT >= 31) { add(Manifest.permission.BLUETOOTH_ADVERTISE); add(Manifest.permission.BLUETOOTH_CONNECT) }
            if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
        }.filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
        if (needed.isEmpty()) startLink() else askPermissions.launch(needed.toTypedArray())
    }

    private fun startLink() {
        ContextCompat.startForegroundService(this, Intent(this, LinkService::class.java))
    }

    // ── hardware buttons: raw codes, the phone decides what they mean ──────

    private fun stemCode(keyCode: Int): String? = when (keyCode) {
        KeyEvent.KEYCODE_STEM_1 -> "stem1"
        KeyEvent.KEYCODE_STEM_2 -> "stem2"
        KeyEvent.KEYCODE_STEM_3 -> "stem3"
        KeyEvent.KEYCODE_NAVIGATE_NEXT -> "next"
        KeyEvent.KEYCODE_NAVIGATE_PREVIOUS -> "previous"
        else -> null   // the primary button (home) stays the system's
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        if (stemCode(keyCode) == null) return super.onKeyDown(keyCode, event)
        if (event.repeatCount == 0) downAt[keyCode] = event.eventTime
        return true
    }

    override fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean {
        val code = stemCode(keyCode) ?: return super.onKeyUp(keyCode, event)
        val since = downAt.remove(keyCode) ?: event.downTime
        LinkService.instance?.sendButton(code, event.eventTime - since >= 600)
        return true
    }
}

@Composable
private fun Screen(ambient: Boolean) {
    val s by LinkService.state.collectAsState()
    val link = LinkService.instance
    val v = s.view
    if (ambient) { AmbientScreen(s); return }
    ScalingLazyColumn(
        modifier = Modifier.fillMaxSize(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        val err = s.error
        item {
            Text(
                when {
                    err != null -> err
                    s.connected -> "Verbunden"
                    s.advertising -> "Warte auf das Telefon"
                    else -> "Starte …"
                },
                fontSize = 12.sp, textAlign = TextAlign.Center,
                color = if (s.error != null) Color(0xFFFFB0A0) else Color(0xFFB0B0B8),
            )
        }
        item { TargetBlock(v) }
        item {
            Chip(
                onClick = { link?.sendAction("aim_toggle") },
                label = { Text(if (v.aiming) "Wählen" else "Peilen") },
                colors = if (v.aiming) ChipDefaults.primaryChipColors() else ChipDefaults.secondaryChipColors(),
                enabled = s.connected,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        v.actions.forEachIndexed { i, a ->
            item {
                Chip(
                    onClick = { link?.sendAction("interact_${i + 1}") },
                    label = { Text(actionLabel(a)) },
                    colors = ChipDefaults.primaryChipColors(),
                    enabled = s.connected && v.locked != null,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Chip(onClick = { link?.sendAction("announce_target") }, label = { Text("Ansagen") }, enabled = s.connected)
                Chip(onClick = { link?.sendAction("cancel") }, label = { Text("Abbr.") }, enabled = s.connected)
            }
        }
        if (s.pointing != null) item {
            Chip(
                onClick = { link?.sendAction("calibrate") },
                label = { Text("Kalibrieren") },
                secondaryLabel = { Text("Auf den eigenen Schatten zeigen") },
                enabled = s.connected,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        item {
            ToggleChip(
                checked = s.leftWrist,
                onCheckedChange = { link?.setLeftWrist(it) },
                label = { Text(if (s.leftWrist) "Linkes Handgelenk" else "Rechtes Handgelenk") },
                toggleControl = { ToggleChipDefaults.switchIcon(s.leftWrist) },
                modifier = Modifier.fillMaxWidth(),
            )
        }
        item {
            Text(
                "Im Telefon eintragen:\n${s.advertisedName}\n" + when (s.pointing) {
                    "absolute" -> "Zeigt mit Kompass"
                    "relative" -> "Zeigt ohne Kompass — kalibrieren"
                    else -> "Kein Zeigesensor — nur Anzeige und Tasten"
                },
                fontSize = 11.sp, textAlign = TextAlign.Center, color = Color(0xFF9090A0),
                modifier = Modifier.padding(top = 4.dp, bottom = 18.dp),
            )
        }
    }
}

@Composable
private fun TargetBlock(v: Protocol.View) {
    val t = v.locked ?: v.target
    Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.padding(horizontal = 8.dp)) {
        Text(
            when { v.aiming -> "Peile …"; v.locked != null -> "Gewählt"; else -> "" },
            fontSize = 11.sp, color = Color(0xFF9FC5FF),
        )
        Text(t?.name ?: "—", fontSize = 18.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center)
        if (t != null) Text(listOfNotNull(typeWord(t.type), t.dist?.let { "$it m" }).joinToString(" · "), fontSize = 12.sp, color = Color(0xFFB0B0B8))
        v.notice?.let { Text(it, fontSize = 11.sp, color = Color(0xFFE0C080), textAlign = TextAlign.Center) }
    }
}

/** Ambient: black, little text, nothing that moves. */
@Composable
private fun AmbientScreen(s: LinkService.State) {
    val t = s.view.locked ?: s.view.target
    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Text(t?.name ?: "Ajna", fontSize = 16.sp, color = Color.White, textAlign = TextAlign.Center)
        Text(if (s.connected) "verbunden" else "getrennt", fontSize = 11.sp, color = Color.Gray)
    }
}

private fun typeWord(type: String) = when (type) {
    "npc", "player" -> "Figur"; "animal" -> "Tier"; "enemy" -> "Gegner"; "dragon" -> "Drache"
    "item", "diamond" -> "Gegenstand"; "call" -> "Auftrag"; "hint" -> "Hinweis"; "poi" -> "Ort"
    else -> type.ifEmpty { null }
}

private fun actionLabel(key: String) = when (key) {
    "examine" -> "Untersuchen"; "talk" -> "Sprechen"; "attack" -> "Angreifen"; "pet" -> "Streicheln"
    "collect", "pickup" -> "Aufheben"; "call" -> "Rufen"; "accept" -> "Annehmen"; "feed" -> "Füttern"
    else -> key
}
