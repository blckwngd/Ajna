package de.blckwngd.ajna.accessory;

import android.Manifest;
import android.content.Intent;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Capacitor plugin exposing the wand (BLE accessory) to the JS layer.
 *
 * JS usage (see client/core/WandManager.js):
 *   const Wand = registerPlugin('Wand');
 *   await Wand.connect({ name: 'WizardStaff' });          // or { address }
 *   Wand.addListener('wandEvent',  e => ...);             // e.json = wand JSON line
 *   Wand.addListener('wandStatus', e => ...);             // e.connected, e.address
 *   await Wand.send({ json: '{"cmd":"led","state":"on"}' });
 *
 * The actual BLE work runs in {@link AccessoryBleService} (foreground service),
 * so it survives screen-off. This plugin is just the JS <-> service surface.
 */
@CapacitorPlugin(
    name = "Wand",
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
public class WandPlugin extends Plugin implements WandBridge.Listener {

    @Override
    public void load() {
        WandBridge.setListener(this);
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
        i.setAction(AccessoryBleService.ACTION_START);
        if (call.getData().has("address")) {
            i.putExtra(AccessoryBleService.EXTRA_ADDRESS, call.getString("address"));
        }
        if (call.getData().has("name")) {
            i.putExtra(AccessoryBleService.EXTRA_NAME, call.getString("name"));
        }
        ContextCompat.startForegroundService(getContext(), i);
        call.resolve();
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        Intent i = new Intent(getContext(), AccessoryBleService.class);
        i.setAction(AccessoryBleService.ACTION_STOP);
        getContext().startService(i);
        call.resolve();
    }

    @PluginMethod
    public void send(PluginCall call) {
        String json = call.getString("json");
        if (json == null) { call.reject("missing 'json'"); return; }
        Intent i = new Intent(getContext(), AccessoryBleService.class);
        i.setAction(AccessoryBleService.ACTION_SEND);
        i.putExtra(AccessoryBleService.EXTRA_JSON, json);
        getContext().startService(i);
        call.resolve();
    }

    @PluginMethod
    public void isConnected(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("connected", WandBridge.isConnected());
        ret.put("address", WandBridge.getAddress());
        call.resolve(ret);
    }

    // --- WandBridge.Listener -> JS events ------------------------------------

    @Override public void onStatus(boolean connected, String address) {
        JSObject ev = new JSObject();
        ev.put("connected", connected);
        ev.put("address", address);
        notifyListeners("wandStatus", ev);
    }

    @Override public void onMessage(String json) {
        JSObject ev = new JSObject();
        ev.put("json", json);
        notifyListeners("wandEvent", ev);
    }

    @Override public void onLog(String message) {
        JSObject ev = new JSObject();
        ev.put("message", message);
        notifyListeners("wandLog", ev);
    }
}
