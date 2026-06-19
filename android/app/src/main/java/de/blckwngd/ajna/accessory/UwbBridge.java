package de.blckwngd.ajna.accessory;

import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * In-process event bus between {@link AccessoryBleService} (owns the UWB BLE
 * connections in the foreground service) and {@link UwbPlugin} (forwards into
 * the Capacitor WebView). Mirrors {@link WandBridge}, but completely independent
 * of the wand.
 *
 * Role-aware: the positioning layer carries N independent UWB tags with named
 * roles ("viewer", "wand-origin", "wand-tip"). Every event is tagged with its
 * role so a single JS hub can route per role while sharing one anchor transform.
 */
public final class UwbBridge {

    public interface Listener {
        void onStatus(String role, boolean connected, String address);
        void onPosition(String role, int xMm, int yMm, int zMm, int quality);
        void onDistances(String role, List<UwbGatt.Distance> distances);
        void onLog(String role, String message);
    }

    private static volatile Listener listener;
    private static final ConcurrentHashMap<String, Boolean> connected = new ConcurrentHashMap<>();
    private static final ConcurrentHashMap<String, String> addresses = new ConcurrentHashMap<>();

    private UwbBridge() {}

    public static void setListener(Listener l) { listener = l; }

    public static boolean isConnected(String role) { return Boolean.TRUE.equals(connected.get(role)); }
    public static boolean anyConnected() { return connected.containsValue(Boolean.TRUE); }
    public static Set<String> roles() { return connected.keySet(); }
    public static String getAddress(String role) { return addresses.get(role); }

    static void emitStatus(String role, boolean isConnected, String addr) {
        connected.put(role, isConnected);
        if (isConnected && addr != null) addresses.put(role, addr); else addresses.remove(role);
        Listener l = listener;
        if (l != null) l.onStatus(role, isConnected, addr);
    }

    static void emitPosition(String role, int x, int y, int z, int q) {
        Listener l = listener;
        if (l != null) l.onPosition(role, x, y, z, q);
    }

    static void emitDistances(String role, List<UwbGatt.Distance> distances) {
        Listener l = listener;
        if (l != null) l.onDistances(role, distances);
    }

    static void emitLog(String role, String message) {
        Listener l = listener;
        if (l != null) l.onLog(role, message);
    }
}
