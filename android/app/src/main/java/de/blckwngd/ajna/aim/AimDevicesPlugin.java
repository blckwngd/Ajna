package de.blckwngd.ajna.aim;

import android.content.Context;
import android.content.Intent;
import android.hardware.input.InputManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.view.InputDevice;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;

import de.blckwngd.ajna.accessory.AccessoryBleService;

/**
 * The native side of pointing on the go (client/core/aim/devices.js).
 *
 *   setInputCapture({enabled})   capture external input before the WebView (ExternalInput)
 *   setMediaKeys({enabled})      media keys with the screen off (AimMediaKeys)
 *   vibrate({pattern})           off/on timings — also with the screen off
 *   connectNus({id, name|address}) / disconnectNus({id}) / sendNus({id, json})
 *                                watches and the combo device (BLE, Nordic UART)
 *   listInputDevices()           what is attached, for the settings
 *   startProbe({hz, seconds})    measurement: native ticks into the WebView
 *
 * Events: 'input' {device, code, long} · 'nus' {id, json} ·
 *         'nusStatus' {id, connected, address} · 'probe' {seq, t} · 'log' {message}
 *
 * Everything that must survive the screen going off (BLE, media keys) is
 * anchored in AccessoryBleService, which this plugin keeps in the
 * foreground while any of it is on.
 */
@CapacitorPlugin(name = "AimDevices")
public class AimDevicesPlugin extends Plugin implements AimBridge.Listener {

    private HandlerThread probeThread;
    private boolean mediaKeysOn = false;

    @Override public void load() { AimBridge.setListener(this); }

    // ── input capture ──────────────────────────────────────────────────────

    @PluginMethod
    public void setInputCapture(PluginCall call) {
        boolean on = call.getBoolean("enabled", false);
        ExternalInput.setEnabled(on);
        getActivity().runOnUiThread(() -> {
            // Pointer capture hides the system cursor and routes a mouse-like
            // touchpad to us as relative motion — no pointer, no stray clicks.
            if (Build.VERSION.SDK_INT >= 26 && getBridge().getWebView() != null) {
                if (on) {
                    getBridge().getWebView().setOnCapturedPointerListener((v, ev) -> ExternalInput.onMotion(ev));
                    getBridge().getWebView().requestPointerCapture();
                } else {
                    getBridge().getWebView().releasePointerCapture();
                    getBridge().getWebView().setOnCapturedPointerListener(null);
                }
            }
        });
        call.resolve();
    }

    @PluginMethod
    public void setMediaKeys(PluginCall call) {
        boolean on = call.getBoolean("enabled", false);
        mediaKeysOn = on;
        if (on) AimMediaKeys.enable(getContext()); else AimMediaKeys.disable();
        keepService(on);
        call.resolve();
    }

    // ── haptics ────────────────────────────────────────────────────────────

    @PluginMethod
    public void vibrate(PluginCall call) {
        JSArray arr = call.getArray("pattern");
        long[] timings;
        try {
            timings = new long[arr.length()];
            for (int i = 0; i < arr.length(); i++) timings[i] = Math.max(0, arr.getLong(i));
        } catch (Exception e) { call.reject("pattern must be an array of milliseconds"); return; }
        Vibrator v;
        if (Build.VERSION.SDK_INT >= 31) {
            VibratorManager vm = (VibratorManager) getContext().getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
            v = vm != null ? vm.getDefaultVibrator() : null;
        } else {
            v = (Vibrator) getContext().getSystemService(Context.VIBRATOR_SERVICE);
        }
        if (v != null && v.hasVibrator() && timings.length > 0) {
            if (Build.VERSION.SDK_INT >= 26) v.vibrate(VibrationEffect.createWaveform(timings, -1));
            else v.vibrate(timings, -1);
        }
        call.resolve();
    }

    // ── BLE devices (watch, combo device) ──────────────────────────────────

    @PluginMethod
    public void connectNus(PluginCall call) {
        String id = call.getString("id");
        if (id == null) { call.reject("missing 'id'"); return; }
        Intent i = new Intent(getContext(), AccessoryBleService.class).setAction(AccessoryBleService.ACTION_NUS_START);
        i.putExtra(AccessoryBleService.EXTRA_ROLE, id);
        if (call.getData().has("address")) i.putExtra(AccessoryBleService.EXTRA_ADDRESS, call.getString("address"));
        if (call.getData().has("name")) i.putExtra(AccessoryBleService.EXTRA_NAME, call.getString("name"));
        ContextCompat.startForegroundService(getContext(), i);
        call.resolve();
    }

    @PluginMethod
    public void disconnectNus(PluginCall call) {
        Intent i = new Intent(getContext(), AccessoryBleService.class).setAction(AccessoryBleService.ACTION_NUS_STOP);
        i.putExtra(AccessoryBleService.EXTRA_ROLE, call.getString("id"));
        getContext().startService(i);
        call.resolve();
    }

    @PluginMethod
    public void sendNus(PluginCall call) {
        Intent i = new Intent(getContext(), AccessoryBleService.class).setAction(AccessoryBleService.ACTION_NUS_SEND);
        i.putExtra(AccessoryBleService.EXTRA_ROLE, call.getString("id"));
        i.putExtra(AccessoryBleService.EXTRA_JSON, call.getString("json"));
        getContext().startService(i);
        call.resolve();
    }

    // ── what is attached ───────────────────────────────────────────────────

    @PluginMethod
    public void listInputDevices(PluginCall call) {
        InputManager im = (InputManager) getContext().getSystemService(Context.INPUT_SERVICE);
        JSArray out = new JSArray();
        if (im != null) {
            for (int id : im.getInputDeviceIds()) {
                InputDevice d = im.getInputDevice(id);
                if (d == null || !ExternalInput.isExternal(d)) continue;
                JSObject o = new JSObject();
                o.put("name", d.getName());
                o.put("sources", sourceNames(d.getSources()));
                out.put(o);
            }
        }
        JSObject ret = new JSObject();
        ret.put("devices", out);
        call.resolve(ret);
    }

    private static JSONArray sourceNames(int s) {
        JSONArray a = new JSONArray();
        if ((s & InputDevice.SOURCE_KEYBOARD) == InputDevice.SOURCE_KEYBOARD) a.put("keyboard");
        if ((s & InputDevice.SOURCE_DPAD) == InputDevice.SOURCE_DPAD) a.put("dpad");
        if ((s & InputDevice.SOURCE_GAMEPAD) == InputDevice.SOURCE_GAMEPAD) a.put("gamepad");
        if ((s & InputDevice.SOURCE_MOUSE) == InputDevice.SOURCE_MOUSE) a.put("mouse");
        if ((s & InputDevice.SOURCE_TOUCHPAD) == InputDevice.SOURCE_TOUCHPAD) a.put("touchpad");
        return a;
    }

    // ── measurement ────────────────────────────────────────────────────────

    /**
     * Native ticks into the WebView at `hz` for `seconds`. The JS side
     * counts what arrives and how late — with the screen on, then off. This
     * answers whether target selection in JS keeps up with the screen off.
     * The service stays in the foreground for the duration (wake lock), as
     * it would during real use.
     */
    @PluginMethod
    public void startProbe(PluginCall call) {
        int hz = Math.max(1, Math.min(60, call.getInt("hz", 20)));
        int seconds = Math.max(1, Math.min(600, call.getInt("seconds", 60)));
        stopProbe();
        keepService(true);
        probeThread = new HandlerThread("ajna-probe");
        probeThread.start();
        Handler h = new Handler(probeThread.getLooper());
        long period = 1000L / hz;
        int total = hz * seconds;
        final long start = android.os.SystemClock.uptimeMillis();
        for (int k = 0; k < total; k++) {
            final int seq = k;
            h.postAtTime(() -> AimBridge.emitProbe(seq, System.currentTimeMillis()), start + 200 + k * period);
        }
        h.postAtTime(() -> { if (!mediaKeysOn) keepService(false); }, start + 400 + total * period);
        JSObject ret = new JSObject();
        ret.put("expected", total);
        call.resolve(ret);
    }

    private void stopProbe() {
        if (probeThread != null) { probeThread.quitSafely(); probeThread = null; }
    }

    private void keepService(boolean on) {
        Intent i = new Intent(getContext(), AccessoryBleService.class).setAction(AccessoryBleService.ACTION_AIM_KEEPALIVE);
        i.putExtra(AccessoryBleService.EXTRA_ENABLED, on);
        if (on) ContextCompat.startForegroundService(getContext(), i);
        else getContext().startService(i);
    }

    // ── AimBridge → JS ─────────────────────────────────────────────────────

    @Override public void onInput(String device, String code, boolean longPress) {
        JSObject e = new JSObject(); e.put("device", device); e.put("code", code); e.put("long", longPress);
        notifyListeners("input", e);
    }
    @Override public void onNus(String id, String json) {
        JSObject e = new JSObject(); e.put("id", id); e.put("json", json);
        notifyListeners("nus", e);
    }
    @Override public void onNusStatus(String id, boolean connected, String address) {
        JSObject e = new JSObject(); e.put("id", id); e.put("connected", connected); e.put("address", address);
        notifyListeners("nusStatus", e);
    }
    @Override public void onProbe(int seq, long tNative) {
        JSObject e = new JSObject(); e.put("seq", seq); e.put("t", tNative);
        notifyListeners("probe", e);
    }
    @Override public void onLog(String message) {
        JSObject e = new JSObject(); e.put("message", message);
        notifyListeners("log", e);
    }
}
