package de.blckwngd.ajna.aim;

/**
 * In-process event bus for the pointing devices: the foreground service (BLE
 * connections to watches, media keys), the activity (captured external input)
 * and the probe all emit here; {@link AimDevicesPlugin} forwards into the
 * WebView. Same pattern as WandBridge — one listener is enough.
 */
public final class AimBridge {

    public interface Listener {
        void onInput(String device, String code, boolean longPress);
        void onNus(String id, String json);
        void onNusStatus(String id, boolean connected, String address);
        void onProbe(int seq, long tNative);
        void onLog(String message);
    }

    private static volatile Listener listener;

    private AimBridge() {}

    public static void setListener(Listener l) { listener = l; }

    public static void emitInput(String device, String code, boolean longPress) {
        Listener l = listener; if (l != null) l.onInput(device, code, longPress);
    }
    public static void emitNus(String id, String json) {
        Listener l = listener; if (l != null) l.onNus(id, json);
    }
    public static void emitNusStatus(String id, boolean connected, String address) {
        Listener l = listener; if (l != null) l.onNusStatus(id, connected, address);
    }
    public static void emitProbe(int seq, long tNative) {
        Listener l = listener; if (l != null) l.onProbe(seq, tNative);
    }
    public static void emitLog(String message) {
        Listener l = listener; if (l != null) l.onLog(message);
    }
}
