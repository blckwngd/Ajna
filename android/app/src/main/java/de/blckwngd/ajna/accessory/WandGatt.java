package de.blckwngd.ajna.accessory;

import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanResult;
import android.content.Context;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import java.nio.charset.StandardCharsets;
import java.util.UUID;

/**
 * Encapsulates a single Nordic-UART (NUS) GATT connection to the wand.
 *
 * Deliberately knows nothing about Capacitor or the foreground service, so the
 * same pattern can be reused for an independent UWB BLE node later (the wand and
 * UWB are decoupled features that may share one foreground service).
 *
 * Connects either by MAC address (preferred, fast) or by advertised name (scan).
 * Requests a larger ATT MTU so our JSON events fit in a single notification.
 */
@SuppressLint("MissingPermission") // callers ensure BLUETOOTH_SCAN/CONNECT are granted
public class WandGatt {

    public interface Listener {
        void onConnected(String address);
        void onDisconnected();
        void onMessage(String json);
        void onLog(String message);
    }

    private static final String TAG = "WandGatt";

    // Nordic UART Service (must match the wand's CompBLE.h)
    static final UUID NUS_SERVICE = UUID.fromString("6e400001-b5a3-f393-e0a9-e50e24dcca9e");
    static final UUID NUS_RX      = UUID.fromString("6e400002-b5a3-f393-e0a9-e50e24dcca9e"); // write
    static final UUID NUS_TX      = UUID.fromString("6e400003-b5a3-f393-e0a9-e50e24dcca9e"); // notify
    static final UUID CCCD        = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");

    private static final int REQUESTED_MTU = 247;
    private static final long SCAN_TIMEOUT_MS = 12000;

    private final Context appContext;
    private final BluetoothAdapter adapter;
    private final Listener listener;
    private final Handler main = new Handler(Looper.getMainLooper());

    private BluetoothGatt gatt;
    private BluetoothGattCharacteristic rxChar;
    private BluetoothLeScanner scanner;
    private ScanCallback scanCallback;
    private boolean wantConnected = false;
    private boolean connected = false;   // fully connected (NUS ready) — guards duplicate status emits

    public WandGatt(Context context, Listener listener) {
        this.appContext = context.getApplicationContext();
        this.listener = listener;
        BluetoothManager bm = (BluetoothManager) appContext.getSystemService(Context.BLUETOOTH_SERVICE);
        this.adapter = bm != null ? bm.getAdapter() : null;
    }

    public boolean isBluetoothAvailable() {
        return adapter != null && adapter.isEnabled();
    }

    /** Connect by MAC address (e.g. "AA:BB:CC:DD:EE:FF"). */
    public void connectByAddress(String address) {
        if (!isBluetoothAvailable()) { listener.onLog("Bluetooth off/unavailable"); return; }
        wantConnected = true;
        BluetoothDevice device = adapter.getRemoteDevice(address);
        listener.onLog("Connecting to " + address);
        openGatt(device);
    }

    /** Discover by advertised name, then connect to the first match. */
    public void connectByName(final String name) {
        if (!isBluetoothAvailable()) { listener.onLog("Bluetooth off/unavailable"); return; }
        wantConnected = true;
        scanner = adapter.getBluetoothLeScanner();
        if (scanner == null) { listener.onLog("No BLE scanner"); return; }
        listener.onLog("Scanning for '" + name + "'");
        scanCallback = new ScanCallback() {
            @Override public void onScanResult(int callbackType, ScanResult result) {
                BluetoothDevice d = result.getDevice();
                String adv = result.getScanRecord() != null ? result.getScanRecord().getDeviceName() : null;
                String dn = adv != null ? adv : d.getName();
                if (dn != null && dn.equals(name)) {
                    stopScan();
                    listener.onLog("Found " + name + " @ " + d.getAddress());
                    openGatt(d);
                }
            }
            @Override public void onScanFailed(int errorCode) {
                listener.onLog("Scan failed: " + errorCode);
            }
        };
        scanner.startScan(scanCallback);
        main.postDelayed(() -> {
            if (gatt == null && wantConnected) {
                stopScan();
                listener.onLog("Scan timeout for '" + name + "'");
            }
        }, SCAN_TIMEOUT_MS);
    }

    private void stopScan() {
        if (scanner != null && scanCallback != null) {
            try { scanner.stopScan(scanCallback); } catch (Exception ignored) {}
        }
        scanCallback = null;
    }

    private void openGatt(BluetoothDevice device) {
        gatt = device.connectGatt(appContext, false, gattCallback, BluetoothDevice.TRANSPORT_LE);
    }

    public boolean isConnected() {
        return gatt != null && rxChar != null;
    }

    /** Send a JSON command line to the wand's RX characteristic. */
    public boolean write(String json) {
        if (gatt == null || rxChar == null) return false;
        byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            int r = gatt.writeCharacteristic(rxChar, bytes,
                    BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
            return r == BluetoothGatt.GATT_SUCCESS;
        } else {
            rxChar.setValue(bytes);
            rxChar.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
            return gatt.writeCharacteristic(rxChar);
        }
    }

    public void close() {
        wantConnected = false;
        connected = false;
        stopScan();
        if (gatt != null) {
            try { gatt.disconnect(); } catch (Exception ignored) {}
            try { gatt.close(); } catch (Exception ignored) {}
            gatt = null;
        }
        rxChar = null;
    }

    private final BluetoothGattCallback gattCallback = new BluetoothGattCallback() {
        @Override public void onConnectionStateChange(BluetoothGatt g, int status, int newState) {
            if (newState == BluetoothGatt.STATE_CONNECTED) {
                listener.onLog("GATT connected (status=" + status + "), requesting MTU");
                g.requestMtu(REQUESTED_MTU);
            } else if (newState == BluetoothGatt.STATE_DISCONNECTED) {
                // status != 0 here means "connection attempt failed" (e.g. 133/8/19)
                // — happens on every failed 2 s reconnect while the wand reboots.
                listener.onLog("GATT disconnected (status=" + status + ")");
                rxChar = null;
                boolean wasConnected = connected;
                connected = false;
                // Only report a REAL connection loss — not each failed retry (those
                // never became "connected"). Prevents the "getrennt getrennt …" storm.
                if (wasConnected) listener.onDisconnected();
                // Auto-reconnect if the user still wants the wand bound.
                if (wantConnected) {
                    main.postDelayed(() -> { if (wantConnected) g.connect(); }, 2000);
                } else {
                    try { g.close(); } catch (Exception ignored) {}
                }
            }
        }

        @Override public void onMtuChanged(BluetoothGatt g, int mtu, int status) {
            listener.onLog("MTU = " + mtu + ", discovering services");
            g.discoverServices();
        }

        @Override public void onServicesDiscovered(BluetoothGatt g, int status) {
            if (status != BluetoothGatt.GATT_SUCCESS || g.getService(NUS_SERVICE) == null) {
                listener.onLog("NUS service not found");
                return;
            }
            rxChar = g.getService(NUS_SERVICE).getCharacteristic(NUS_RX);
            BluetoothGattCharacteristic tx = g.getService(NUS_SERVICE).getCharacteristic(NUS_TX);
            if (tx != null) {
                g.setCharacteristicNotification(tx, true);
                BluetoothGattDescriptor cccd = tx.getDescriptor(CCCD);
                if (cccd != null) {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        g.writeDescriptor(cccd, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                    } else {
                        cccd.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                        g.writeDescriptor(cccd);
                    }
                }
            }
            connected = true;
            listener.onConnected(g.getDevice().getAddress());
        }

        // API 33+
        @Override public void onCharacteristicChanged(BluetoothGatt g,
                BluetoothGattCharacteristic ch, byte[] value) {
            if (NUS_TX.equals(ch.getUuid())) {
                listener.onMessage(new String(value, StandardCharsets.UTF_8));
            }
        }

        // API < 33
        @Override public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic ch) {
            if (NUS_TX.equals(ch.getUuid())) {
                listener.onMessage(new String(ch.getValue(), StandardCharsets.UTF_8));
            }
        }
    };
}
