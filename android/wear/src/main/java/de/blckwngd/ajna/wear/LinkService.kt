package de.blckwngd.ajna.wear

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothStatusCodes
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.BatteryManager
import android.os.Build
import android.os.IBinder
import android.os.ParcelUuid
import android.os.PowerManager
import android.os.SystemClock
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.wear.input.WearableButtons
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.util.ArrayDeque
import java.util.UUID

/**
 * The watch's link to the phone, as a foreground service.
 *
 *   BLE peripheral  a GATT server with the Nordic UART service — the same
 *                   service the wand offers, so the phone connects with the
 *                   code it already has (WandGatt). Advertises the service;
 *                   the device name goes in the scan response.
 *   sensors         rotation vector → yaw/pitch of the forearm, ONLY while
 *                   the phone asked for a stream, at the rate it asked for.
 *   haptics         plays the timings the phone sends.
 *
 * The UI (MainActivity) reads `state` and calls `sendButton` / `sendAction`.
 */
@SuppressLint("MissingPermission")   // MainActivity requests the permissions before starting us
class LinkService : Service(), SensorEventListener {

    data class State(
        val running: Boolean = false,
        val connected: Boolean = false,
        val advertisedName: String = "",
        val advertising: Boolean = false,
        val error: String? = null,
        val pointing: String? = null,          // absolute | relative | null
        val streaming: Boolean = false,
        val view: Protocol.View = Protocol.View(),
        val leftWrist: Boolean = true,
    )

    companion object {
        val NUS_SERVICE: UUID = UUID.fromString("6e400001-b5a3-f393-e0a9-e50e24dcca9e")
        val NUS_RX: UUID = UUID.fromString("6e400002-b5a3-f393-e0a9-e50e24dcca9e")   // phone writes
        val NUS_TX: UUID = UUID.fromString("6e400003-b5a3-f393-e0a9-e50e24dcca9e")   // we notify
        val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
        private const val CHANNEL = "ajna_link"
        private const val NOTIFICATION_ID = 7711
        private const val PREFS = "ajna_wear"

        private val _state = MutableStateFlow(State())
        val state: StateFlow<State> = _state

        @Volatile var instance: LinkService? = null
            private set
    }

    private lateinit var bt: BluetoothManager
    private var server: BluetoothGattServer? = null
    private var tx: BluetoothGattCharacteristic? = null
    private var device: BluetoothDevice? = null
    private var subscribed = false
    private var mtu = 23
    private val outbox = ArrayDeque<ByteArray>()
    private var sending = false

    private lateinit var sensors: SensorManager
    private var sensor: Sensor? = null
    private var sensorStatus = 2
    private var streamHz = 25
    private var lastSentAt = 0L
    private val rot = FloatArray(9)
    private var wakeLock: PowerManager.WakeLock? = null

    // ── lifecycle ──────────────────────────────────────────────────────────

    override fun onCreate() {
        super.onCreate()
        instance = this
        bt = getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
        sensors = getSystemService(Context.SENSOR_SERVICE) as SensorManager
        val rv = sensors.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)
        val grv = sensors.getDefaultSensor(Sensor.TYPE_GAME_ROTATION_VECTOR)
        sensor = rv ?: grv
        val left = getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean("leftWrist", true)
        _state.value = _state.value.copy(
            running = true,
            pointing = Pointing.pointingCapability(rv != null, grv != null),
            leftWrist = left,
        )
        startInForeground()
        openServer()
        advertise()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        stopStream()
        try { bt.adapter?.bluetoothLeAdvertiser?.stopAdvertising(advertiseCallback) } catch (_: Exception) {}
        try { server?.close() } catch (_: Exception) {}
        server = null
        instance = null
        _state.value = State()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun startInForeground() {
        // Channels exist from Android 8 (API 26); Wear OS 2 on 7.1 has none.
        val builder = if (Build.VERSION.SDK_INT >= 26) {
            getSystemService(NotificationManager::class.java)
                .createNotificationChannel(NotificationChannel(CHANNEL, "Ajna", NotificationManager.IMPORTANCE_LOW))
            Notification.Builder(this, CHANNEL)
        } else @Suppress("DEPRECATION") Notification.Builder(this)
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val n: Notification = builder
            .setContentTitle("Ajna")
            .setContentText("Verbindung zum Telefon")
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setContentIntent(open)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        else startForeground(NOTIFICATION_ID, n)
    }

    // ── BLE peripheral ─────────────────────────────────────────────────────

    private fun openServer() {
        val s = bt.openGattServer(this, gattCallback)
        if (s == null) { fail("Bluetooth-Server nicht verfügbar"); return }
        val svc = BluetoothGattService(NUS_SERVICE, BluetoothGattService.SERVICE_TYPE_PRIMARY)
        val rx = BluetoothGattCharacteristic(NUS_RX,
            BluetoothGattCharacteristic.PROPERTY_WRITE or BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
            BluetoothGattCharacteristic.PERMISSION_WRITE)
        val t = BluetoothGattCharacteristic(NUS_TX,
            BluetoothGattCharacteristic.PROPERTY_NOTIFY, BluetoothGattCharacteristic.PERMISSION_READ)
        t.addDescriptor(BluetoothGattDescriptor(CCCD, BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE))
        svc.addCharacteristic(rx); svc.addCharacteristic(t)
        s.addService(svc)
        server = s; tx = t
    }

    /** The service UUID in the advertisement, the name in the scan response (it would not fit next to a 128-bit UUID). */
    private fun advertise() {
        val adapter = bt.adapter
        val adv = adapter?.bluetoothLeAdvertiser
        if (adv == null) {
            fail("Diese Uhr kann nicht als Bluetooth-Gerät werben — sie kann das Telefon so nicht erreichen")
            return
        }
        val name = adapter.name ?: "Watch"
        val settings = AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_BALANCED)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
            .setConnectable(true).build()
        val data = AdvertiseData.Builder().addServiceUuid(ParcelUuid(NUS_SERVICE)).setIncludeDeviceName(false).build()
        val scan = AdvertiseData.Builder().setIncludeDeviceName(true).build()
        _state.value = _state.value.copy(advertisedName = name)
        try { adv.startAdvertising(settings, data, scan, advertiseCallback) }
        catch (e: Exception) { fail("Werben fehlgeschlagen: ${e.message}") }
    }

    private val advertiseCallback = object : AdvertiseCallback() {
        override fun onStartSuccess(settingsInEffect: AdvertiseSettings?) {
            _state.value = _state.value.copy(advertising = true, error = null)
        }
        override fun onStartFailure(errorCode: Int) {
            // DATA_TOO_LARGE (1) means the name does not fit even in the scan response.
            fail(if (errorCode == ADVERTISE_FAILED_DATA_TOO_LARGE) "Name der Uhr zu lang zum Werben" else "Werben fehlgeschlagen ($errorCode)")
        }
    }

    private fun fail(msg: String) { _state.value = _state.value.copy(error = msg, advertising = false) }

    private val gattCallback = object : BluetoothGattServerCallback() {
        override fun onConnectionStateChange(d: BluetoothDevice, status: Int, newState: Int) {
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                device = d
                _state.value = _state.value.copy(connected = true)
            } else if (d == device) {
                device = null; subscribed = false; mtu = 23
                synchronized(outbox) { outbox.clear(); sending = false }
                stopStream()
                _state.value = _state.value.copy(connected = false, view = Protocol.View())
            }
        }

        override fun onMtuChanged(d: BluetoothDevice, m: Int) { mtu = m }

        override fun onCharacteristicWriteRequest(d: BluetoothDevice, requestId: Int, ch: BluetoothGattCharacteristic,
                                                  preparedWrite: Boolean, responseNeeded: Boolean, offset: Int, value: ByteArray?) {
            if (responseNeeded) server?.sendResponse(d, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
            if (ch.uuid == NUS_RX && value != null) handle(String(value, Charsets.UTF_8))
        }

        override fun onDescriptorWriteRequest(d: BluetoothDevice, requestId: Int, desc: BluetoothGattDescriptor,
                                              preparedWrite: Boolean, responseNeeded: Boolean, offset: Int, value: ByteArray?) {
            if (responseNeeded) server?.sendResponse(d, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
            if (desc.uuid == CCCD) {
                subscribed = value != null && value.isNotEmpty() && (value[0].toInt() and 1) == 1
                if (subscribed) sendHello()
            }
        }

        override fun onNotificationSent(d: BluetoothDevice, status: Int) { sendNext() }
    }

    private fun sendHello() {
        val buttons = try { WearableButtons.getButtonCount(this) } catch (_: Exception) { 0 }
        val vib = vibrator()
        send(Protocol.hello("${Build.MANUFACTURER} ${Build.MODEL}", _state.value.pointing, buttons, Build.VERSION.SDK_INT >= 26 && vib?.hasAmplitudeControl() == true))
        battery()?.let { send(Protocol.status(it)) }
    }

    /** One message per notification; they are serialised — one in flight at a time. */
    fun send(json: String) {
        if (!subscribed || device == null) return
        val bytes = json.toByteArray(Charsets.UTF_8)
        if (bytes.size > mtu - 3) return   // would be cut — the phone asks for MTU 247, this is a safeguard
        synchronized(outbox) {
            if (sending) { if (outbox.size >= 16) outbox.pollFirst(); outbox.addLast(bytes); return }
            sending = true
        }
        if (!notifyNow(bytes)) sendNext()
    }

    private fun sendNext() {
        val next: ByteArray
        synchronized(outbox) {
            next = outbox.pollFirst() ?: run { sending = false; return }
        }
        if (!notifyNow(next)) sendNext()
    }

    private fun notifyNow(bytes: ByteArray): Boolean {
        val d = device ?: return false
        val t = tx ?: return false
        val s = server ?: return false
        return if (Build.VERSION.SDK_INT >= 33) {
            s.notifyCharacteristicChanged(d, t, false, bytes) == BluetoothStatusCodes.SUCCESS
        } else {
            @Suppress("DEPRECATION")
            run { t.value = bytes; s.notifyCharacteristicChanged(d, t, false) }
        }
    }

    // ── from the phone ─────────────────────────────────────────────────────

    private fun handle(json: String) {
        when (val c = Protocol.parse(json)) {
            is Protocol.Command.Stream -> if (c.on) startStream(c.hz) else stopStream()
            is Protocol.Command.Haptic -> vibrate(c.pattern)
            is Protocol.Command.Show -> _state.value = _state.value.copy(view = c.view)
            is Protocol.Command.Notice -> _state.value = _state.value.copy(view = _state.value.view.copy(notice = c.text))
            Protocol.Command.Unknown -> {}
        }
    }

    // ── to the phone (from the UI) ─────────────────────────────────────────

    fun sendButton(code: String, long: Boolean) = send(Protocol.button(code, long))
    fun sendAction(name: String) = send(Protocol.action(name))

    fun setLeftWrist(left: Boolean) {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("leftWrist", left).apply()
        _state.value = _state.value.copy(leftWrist = left)
    }

    // ── sensors: only while asked ──────────────────────────────────────────

    private fun startStream(hz: Int) {
        val s = sensor ?: return
        streamHz = hz
        if (_state.value.streaming) return
        sensors.registerListener(this, s, SensorManager.SENSOR_DELAY_GAME)
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ajna:aim").also { it.acquire(10 * 60_000L) }
        _state.value = _state.value.copy(streaming = true)
    }

    private fun stopStream() {
        try { sensors.unregisterListener(this) } catch (_: Exception) {}
        try { wakeLock?.let { if (it.isHeld) it.release() } } catch (_: Exception) {}
        wakeLock = null
        _state.value = _state.value.copy(streaming = false)
    }

    override fun onSensorChanged(e: SensorEvent) {
        val now = SystemClock.elapsedRealtime()
        if (now - lastSentAt < 1000L / streamHz) return
        lastSentAt = now
        SensorManager.getRotationMatrixFromVector(rot, e.values)
        val left = _state.value.leftWrist
        val dir = Pointing.fromRotationMatrix(rot, left)
        val headingAcc = if (e.sensor.type == Sensor.TYPE_ROTATION_VECTOR && e.values.size > 4) e.values[4] else null
        send(Protocol.orientation(dir.yaw, dir.pitch, Pointing.accuracyDeg(headingAcc, sensorStatus)))
    }

    override fun onAccuracyChanged(s: Sensor?, accuracy: Int) { sensorStatus = accuracy }

    // ── haptics, battery ───────────────────────────────────────────────────

    private fun vibrator(): Vibrator? = if (Build.VERSION.SDK_INT >= 31)
        (getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
    else @Suppress("DEPRECATION") (getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator)

    private fun vibrate(pattern: LongArray) {
        val v = vibrator() ?: return
        if (!v.hasVibrator() || pattern.isEmpty()) return
        // Same timing format either way: off, on, off, on … in ms.
        if (Build.VERSION.SDK_INT >= 26) v.vibrate(VibrationEffect.createWaveform(pattern, -1))
        else @Suppress("DEPRECATION") v.vibrate(pattern, -1)
    }

    private fun battery(): Int? = try {
        (getSystemService(Context.BATTERY_SERVICE) as BatteryManager).getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
    } catch (_: Exception) { null }
}
