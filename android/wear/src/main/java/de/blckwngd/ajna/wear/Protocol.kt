package de.blckwngd.ajna.wear

import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

/**
 * The watch side of the protocol (docs/geraete-protokoll.md) — message
 * shapes in one place. JSON lines, one message per BLE write / notification,
 * kept small: a notification carries at most MTU − 3 bytes.
 *
 * Watch → phone:  hello, o (orientation), button, action, status
 * Phone → watch:  stream, haptic, view, notice
 */
object Protocol {

    fun hello(model: String, pointing: String?, buttons: Int, amplitude: Boolean): String =
        JSONObject()
            .put("type", "hello").put("dev", "watch").put("v", 1).put("model", model.take(40))
            .put("caps", JSONObject()
                .put("pointing", pointing ?: JSONObject.NULL)
                .put("haptics", true).put("display", true)
                .put("buttons", buttons).put("amplitude", amplitude))
            .toString()

    /** Compact on purpose: 25 times a second. */
    fun orientation(yaw: Double, pitch: Double, accuracy: Double): String =
        String.format(Locale.ROOT, "{\"type\":\"o\",\"y\":%.1f,\"p\":%.1f,\"a\":%.0f}", yaw, pitch, accuracy)

    fun button(code: String, long: Boolean): String =
        JSONObject().put("type", "button").put("code", code).put("long", long).toString()

    fun action(name: String): String = JSONObject().put("type", "action").put("name", name).toString()

    fun status(battery: Int): String = JSONObject().put("type", "status").put("battery", battery).toString()

    /** What the phone shows us. */
    data class Target(val name: String, val type: String, val dist: Int?)
    data class View(
        val aiming: Boolean = false,
        val target: Target? = null,
        val locked: Target? = null,
        val actions: List<String> = emptyList(),
        val accuracy: Int? = null,
        val notice: String? = null,
    )

    sealed class Command {
        data class Stream(val on: Boolean, val hz: Int) : Command()
        data class Haptic(val pattern: LongArray) : Command()
        data class Show(val view: View) : Command()
        data class Notice(val text: String) : Command()
        object Unknown : Command()
    }

    fun parse(json: String): Command = try {
        val o = JSONObject(json)
        when (o.optString("cmd")) {
            "stream" -> Command.Stream(o.optBoolean("on", false), o.optInt("hz", 25).coerceIn(1, 50))
            "haptic" -> {
                val a = o.optJSONArray("p") ?: JSONArray()
                Command.Haptic(LongArray(a.length()) { i -> a.optLong(i).coerceAtLeast(0) })
            }
            "view" -> Command.Show(View(
                aiming = o.optBoolean("aiming", false),
                target = target(o.optJSONObject("target")),
                locked = target(o.optJSONObject("locked")),
                actions = o.optJSONArray("actions")?.let { a -> List(a.length()) { a.optString(it) } } ?: emptyList(),
                accuracy = if (o.has("acc") && !o.isNull("acc")) o.optInt("acc") else null,
                notice = o.optString("notice").takeIf { it.isNotEmpty() && it != "null" },
            ))
            "notice" -> Command.Notice(o.optString("text"))
            else -> Command.Unknown
        }
    } catch (e: Exception) { Command.Unknown }

    private fun target(o: JSONObject?): Target? = o?.let {
        Target(it.optString("name").ifEmpty { "?" }, it.optString("type"), if (it.has("dist") && !it.isNull("dist")) it.optInt("dist") else null)
    }
}
