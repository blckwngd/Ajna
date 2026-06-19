package de.blckwngd.ajna.accessory;

/**
 * Tiny in-process event bus between {@link AccessoryBleService} (which owns the
 * BLE connection and survives the WebView being backgrounded) and
 * {@link WandPlugin} (which forwards events into the Capacitor WebView).
 *
 * Single-listener is enough: the plugin is the only consumer.
 */
public final class WandBridge {

    public interface Listener {
        void onStatus(boolean connected, String address);
        void onMessage(String json);
        void onLog(String message);
    }

    private static volatile Listener listener;
    private static volatile boolean connected = false;
    private static volatile String address = null;

    private WandBridge() {}

    public static void setListener(Listener l) {
        listener = l;
    }

    public static boolean isConnected() { return connected; }
    public static String getAddress() { return address; }

    static void emitStatus(boolean isConnected, String addr) {
        connected = isConnected;
        address = isConnected ? addr : null;
        Listener l = listener;
        if (l != null) l.onStatus(isConnected, addr);
    }

    static void emitMessage(String json) {
        Listener l = listener;
        if (l != null) l.onMessage(json);
    }

    static void emitLog(String message) {
        Listener l = listener;
        if (l != null) l.onLog(message);
    }
}
