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

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * BLE driver for a Decawave/Qorvo DWM1001 (PANS) UWB node — the "Network Node
 * Service". Deliberately independent of the wand: UWB positioning must work
 * without any wand, and the wand without UWB. A wand with an integrated UWB
 * node is just a special case (two logical drivers, possibly one device).
 *
 * Model A (onboard Location Engine): we read the precomputed tag position from
 * the Location Data characteristic. We set mode = POSITION+DISTANCES so the raw
 * ranges are also available for a future model B (on-device multilateration).
 *
 * The DWM1001 specifics are isolated here; newer UWB modules can be added as
 * sibling drivers emitting the same {@link Listener} callbacks.
 *
 * Reference (verified against the LEAPS/Qorvo PANS BLE doc):
 *   Service               680c21d9-c946-4c1f-9c11-baa1c21329e7
 *   Location Data (notify)003bbdf2-c634-4b3d-ab56-7ec889b89a37
 *   Location Data Mode    a02b947e-df97-4516-996a-1882521e0ead  (0/1/2)
 *   Position: int32 x,y,z (mm, little-endian) + uint8 quality
 */
@SuppressLint("MissingPermission") // callers ensure BLUETOOTH_SCAN/CONNECT are granted
public class UwbGatt {

    public static final class Distance {
        public final int nodeId;     // uint16
        public final int distanceMm; // int32
        public final int quality;    // uint8
        Distance(int nodeId, int distanceMm, int quality) {
            this.nodeId = nodeId; this.distanceMm = distanceMm; this.quality = quality;
        }
    }

    public interface Listener {
        void onConnected(String address);
        void onDisconnected();
        /** Tag position in the DWM-local frame, millimetres. */
        void onPosition(int xMm, int yMm, int zMm, int quality);
        /** Raw ranges to anchors (for future on-device multilateration). */
        void onDistances(List<Distance> distances);
        void onLog(String message);
    }

    static final UUID NN_SERVICE = UUID.fromString("680c21d9-c946-4c1f-9c11-baa1c21329e7");
    static final UUID LOCATION_DATA = UUID.fromString("003bbdf2-c634-4b3d-ab56-7ec889b89a37");
    static final UUID LOCATION_DATA_MODE = UUID.fromString("a02b947e-df97-4516-996a-1882521e0ead");
    static final UUID CCCD = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");

    // 0=position, 1=distances, 2=position+distances. We want both (B-ready).
    private static final byte MODE_POSITION_AND_DISTANCES = 2;
    private static final int REQUESTED_MTU = 247;
    private static final long SCAN_TIMEOUT_MS = 12000;

    private final Context appContext;
    private final BluetoothAdapter adapter;
    private final Listener listener;
    private final Handler main = new Handler(Looper.getMainLooper());

    private BluetoothGatt gatt;
    private BluetoothLeScanner scanner;
    private ScanCallback scanCallback;
    private boolean wantConnected = false;

    public UwbGatt(Context context, Listener listener) {
        this.appContext = context.getApplicationContext();
        this.listener = listener;
        BluetoothManager bm = (BluetoothManager) appContext.getSystemService(Context.BLUETOOTH_SERVICE);
        this.adapter = bm != null ? bm.getAdapter() : null;
    }

    public boolean isBluetoothAvailable() { return adapter != null && adapter.isEnabled(); }
    public boolean isConnected() { return gatt != null; }

    public void connectByAddress(String address) {
        if (!isBluetoothAvailable()) { listener.onLog("Bluetooth off/unavailable"); return; }
        wantConnected = true;
        listener.onLog("UWB: connecting to " + address);
        openGatt(adapter.getRemoteDevice(address));
    }

    public void connectByName(final String name) {
        if (!isBluetoothAvailable()) { listener.onLog("Bluetooth off/unavailable"); return; }
        wantConnected = true;
        scanner = adapter.getBluetoothLeScanner();
        if (scanner == null) { listener.onLog("No BLE scanner"); return; }
        listener.onLog("UWB: scanning for '" + name + "'");
        scanCallback = new ScanCallback() {
            @Override public void onScanResult(int callbackType, ScanResult result) {
                BluetoothDevice d = result.getDevice();
                String adv = result.getScanRecord() != null ? result.getScanRecord().getDeviceName() : null;
                String dn = adv != null ? adv : d.getName();
                if (dn != null && (dn.equals(name) || dn.startsWith(name))) {
                    stopScan();
                    listener.onLog("UWB: found " + dn + " @ " + d.getAddress());
                    openGatt(d);
                }
            }
            @Override public void onScanFailed(int errorCode) { listener.onLog("UWB scan failed: " + errorCode); }
        };
        scanner.startScan(scanCallback);
        main.postDelayed(() -> {
            if (gatt == null && wantConnected) { stopScan(); listener.onLog("UWB scan timeout"); }
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

    public void close() {
        wantConnected = false;
        stopScan();
        if (gatt != null) {
            try { gatt.disconnect(); } catch (Exception ignored) {}
            try { gatt.close(); } catch (Exception ignored) {}
            gatt = null;
        }
    }

    private void writeLocationDataMode(BluetoothGatt g) {
        BluetoothGattCharacteristic mode = g.getService(NN_SERVICE).getCharacteristic(LOCATION_DATA_MODE);
        if (mode == null) { listener.onLog("UWB: mode char missing"); return; }
        byte[] v = { MODE_POSITION_AND_DISTANCES };
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            g.writeCharacteristic(mode, v, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
        } else {
            mode.setValue(v);
            mode.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
            g.writeCharacteristic(mode);
        }
    }

    private void enableLocationNotifications(BluetoothGatt g) {
        BluetoothGattCharacteristic loc = g.getService(NN_SERVICE).getCharacteristic(LOCATION_DATA);
        if (loc == null) { listener.onLog("UWB: location char missing"); return; }
        g.setCharacteristicNotification(loc, true);
        BluetoothGattDescriptor cccd = loc.getDescriptor(CCCD);
        if (cccd != null) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                g.writeDescriptor(cccd, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
            } else {
                cccd.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                g.writeDescriptor(cccd);
            }
        }
    }

    /** Parse the Location Data value: [type][position?][distances?]. */
    private void parseLocation(byte[] v) {
        if (v == null || v.length < 1) return;
        ByteBuffer bb = ByteBuffer.wrap(v).order(ByteOrder.LITTLE_ENDIAN);
        int type = bb.get() & 0xFF; // 0=pos, 1=dist, 2=both
        if ((type == 0 || type == 2) && bb.remaining() >= 13) {
            int x = bb.getInt(), y = bb.getInt(), z = bb.getInt();
            int q = bb.get() & 0xFF;
            listener.onPosition(x, y, z, q);
        }
        if ((type == 1 || type == 2) && bb.remaining() >= 1) {
            int count = bb.get() & 0xFF;
            List<Distance> out = new ArrayList<>();
            for (int i = 0; i < count && bb.remaining() >= 7; i++) {
                int nodeId = bb.getShort() & 0xFFFF;
                int dist = bb.getInt();
                int q = bb.get() & 0xFF;
                out.add(new Distance(nodeId, dist, q));
            }
            if (!out.isEmpty()) listener.onDistances(out);
        }
    }

    private final BluetoothGattCallback gattCallback = new BluetoothGattCallback() {
        @Override public void onConnectionStateChange(BluetoothGatt g, int status, int newState) {
            if (newState == BluetoothGatt.STATE_CONNECTED) {
                listener.onLog("UWB GATT connected, requesting MTU");
                g.requestMtu(REQUESTED_MTU);
            } else if (newState == BluetoothGatt.STATE_DISCONNECTED) {
                listener.onDisconnected();
                if (wantConnected) main.postDelayed(() -> { if (wantConnected) g.connect(); }, 2000);
                else try { g.close(); } catch (Exception ignored) {}
            }
        }

        @Override public void onMtuChanged(BluetoothGatt g, int mtu, int status) {
            listener.onLog("UWB MTU = " + mtu + ", discovering services");
            g.discoverServices();
        }

        @Override public void onServicesDiscovered(BluetoothGatt g, int status) {
            if (status != BluetoothGatt.GATT_SUCCESS || g.getService(NN_SERVICE) == null) {
                listener.onLog("UWB: Network Node Service not found");
                return;
            }
            writeLocationDataMode(g);
            enableLocationNotifications(g);
            listener.onConnected(g.getDevice().getAddress());
        }

        @Override public void onCharacteristicChanged(BluetoothGatt g,
                BluetoothGattCharacteristic ch, byte[] value) {
            if (LOCATION_DATA.equals(ch.getUuid())) parseLocation(value);
        }

        @Override public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic ch) {
            if (LOCATION_DATA.equals(ch.getUuid())) parseLocation(ch.getValue());
        }
    };
}
