package de.blckwngd.ajna.accessory;

import android.Manifest;
import android.content.Intent;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.List;

/**
 * Capacitor plugin exposing a UWB node (DWM1001) to the JS layer — independent
 * of the wand. Position math (DWM-local → world alignment) lives in JS
 * (client/core/UwbManager.js); this plugin only ships parsed measurements.
 *
 * Role-aware: N independent UWB tags keyed by role ("viewer", "wand-origin",
 * "wand-tip"). Every event carries `role` so one JS hub routes per role.
 *
 * JS usage:
 *   const Uwb = registerPlugin('Uwb');
 *   await Uwb.connect({ role: 'viewer', name: 'DW' });  // or { address }
 *   Uwb.addListener('uwbPosition',  e => ...);          // e.role, e.x/e.y/e.z (mm), e.quality
 *   Uwb.addListener('uwbDistances', e => ...);          // e.role, e.distances[] (future model B)
 *   Uwb.addListener('uwbStatus',    e => ...);          // e.role, e.connected, e.address
 */
@CapacitorPlugin(
    name = "Uwb",
    permissions = {
        @Permission(
            alias = "ble",
            strings = {
                Manifest.permission.BLUETOOTH_SCAN,
                Manifest.permission.BLUETOOTH_CONNECT,
                Manifest.permission.ACCESS_FINE_LOCATION
            }
        )
    }
)
public class UwbPlugin extends Plugin implements UwbBridge.Listener {

    @Override
    public void load() {
        UwbBridge.setListener(this);
    }

    @PluginMethod
    public void connect(PluginCall call) {
        if (getPermissionState("ble") != com.getcapacitor.PermissionState.GRANTED) {
            requestPermissionForAlias("ble", call, "blePermsCallback");
            return;
        }
        startService(call);
    }

    @PermissionCallback
    private void blePermsCallback(PluginCall call) {
        if (getPermissionState("ble") == com.getcapacitor.PermissionState.GRANTED) {
            startService(call);
        } else {
            call.reject("Bluetooth-Berechtigungen nicht erteilt");
        }
    }

    private void startService(PluginCall call) {
        Intent i = new Intent(getContext(), AccessoryBleService.class);
        i.setAction(AccessoryBleService.ACTION_UWB_START);
        i.putExtra(AccessoryBleService.EXTRA_ROLE, roleOf(call));
        if (call.getData().has("address")) i.putExtra(AccessoryBleService.EXTRA_ADDRESS, call.getString("address"));
        if (call.getData().has("name")) i.putExtra(AccessoryBleService.EXTRA_NAME, call.getString("name"));
        ContextCompat.startForegroundService(getContext(), i);
        call.resolve();
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        Intent i = new Intent(getContext(), AccessoryBleService.class);
        i.setAction(AccessoryBleService.ACTION_UWB_STOP);
        i.putExtra(AccessoryBleService.EXTRA_ROLE, roleOf(call));
        getContext().startService(i);
        call.resolve();
    }

    @PluginMethod
    public void isConnected(PluginCall call) {
        JSObject ret = new JSObject();
        if (call.getData().has("role")) {
            String role = roleOf(call);
            ret.put("connected", UwbBridge.isConnected(role));
            ret.put("address", UwbBridge.getAddress(role));
        } else {
            ret.put("connected", UwbBridge.anyConnected());
        }
        call.resolve(ret);
    }

    private static String roleOf(PluginCall call) {
        String r = call.getString("role");
        return (r != null && !r.isEmpty()) ? r : "viewer";
    }

    // --- UwbBridge.Listener -> JS events (all tagged with role) --------------

    @Override public void onStatus(String role, boolean connected, String address) {
        JSObject ev = new JSObject();
        ev.put("role", role);
        ev.put("connected", connected);
        ev.put("address", address);
        notifyListeners("uwbStatus", ev);
    }

    @Override public void onPosition(String role, int xMm, int yMm, int zMm, int quality) {
        JSObject ev = new JSObject();
        ev.put("role", role);
        ev.put("x", xMm);
        ev.put("y", yMm);
        ev.put("z", zMm);
        ev.put("quality", quality);
        notifyListeners("uwbPosition", ev);
    }

    @Override public void onDistances(String role, List<UwbGatt.Distance> distances) {
        JSArray arr = new JSArray();
        for (UwbGatt.Distance d : distances) {
            JSObject o = new JSObject();
            o.put("nodeId", d.nodeId);
            o.put("distance", d.distanceMm);
            o.put("quality", d.quality);
            arr.put(o);
        }
        JSObject ev = new JSObject();
        ev.put("role", role);
        ev.put("distances", arr);
        notifyListeners("uwbDistances", ev);
    }

    @Override public void onLog(String role, String message) {
        JSObject ev = new JSObject();
        ev.put("role", role);
        ev.put("message", message);
        notifyListeners("uwbLog", ev);
    }
}
