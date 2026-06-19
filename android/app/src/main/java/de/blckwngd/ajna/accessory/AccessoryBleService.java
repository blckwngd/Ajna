package de.blckwngd.ajna.accessory;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Foreground service that owns BLE accessory connections so they keep running
 * with the screen off / app backgrounded (the WebView alone cannot).
 *
 * Hosts logically independent connections that share this one service +
 * notification:
 *   • the wand (one connection), and
 *   • N UWB nodes keyed by ROLE ("viewer", "wand-origin", "wand-tip").
 *
 * Any of them can run without the others (wand without UWB, UWB without wand,
 * viewer without wand-origin …). The service stays alive while at least one
 * connection is active and stops when all are stopped.
 */
public class AccessoryBleService extends Service {

    // Wand actions
    public static final String ACTION_START = "de.blckwngd.ajna.accessory.START";
    public static final String ACTION_STOP  = "de.blckwngd.ajna.accessory.STOP";
    public static final String ACTION_SEND  = "de.blckwngd.ajna.accessory.SEND";
    // UWB actions (carry EXTRA_ROLE)
    public static final String ACTION_UWB_START = "de.blckwngd.ajna.accessory.UWB_START";
    public static final String ACTION_UWB_STOP  = "de.blckwngd.ajna.accessory.UWB_STOP";

    public static final String EXTRA_ADDRESS = "address";
    public static final String EXTRA_NAME    = "name";
    public static final String EXTRA_JSON    = "json";
    public static final String EXTRA_ROLE    = "role";

    private static final String CHANNEL_ID = "ajna_accessory";
    private static final int NOTIFICATION_ID = 4711;
    private static final String DEFAULT_UWB_ROLE = "viewer";

    private WandGatt wand;
    private boolean wandActive = false;
    private boolean wandConnected = false;

    private final Map<String, UwbGatt> uwbNodes = new HashMap<>();
    private PowerManager.WakeLock wakeLock;

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
        wand = new WandGatt(this, wandListener);
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ajna:accessory");
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (action == null) return START_STICKY;

        switch (action) {
            case ACTION_STOP:
                wandActive = false;
                if (wand != null) wand.close();
                wandConnected = false;
                WandBridge.emitStatus(false, null);
                break;
            case ACTION_SEND:
                if (wand != null && intent.hasExtra(EXTRA_JSON)) wand.write(intent.getStringExtra(EXTRA_JSON));
                break;
            case ACTION_START:
                wandActive = true;
                ensureForeground();
                connectWand(intent);
                break;
            case ACTION_UWB_START:
                ensureForeground();
                connectUwb(intent);
                break;
            case ACTION_UWB_STOP:
                stopUwb(roleOf(intent));
                break;
            default:
                break;
        }

        if (!isAnyActive()) {
            stopEverything();
            return START_NOT_STICKY;
        }
        refreshNotification();
        return START_STICKY;
    }

    private boolean isAnyActive() { return wandActive || !uwbNodes.isEmpty(); }

    private String roleOf(Intent intent) {
        String r = intent != null ? intent.getStringExtra(EXTRA_ROLE) : null;
        return (r != null && !r.isEmpty()) ? r : DEFAULT_UWB_ROLE;
    }

    private void connectWand(Intent intent) {
        String address = intent.getStringExtra(EXTRA_ADDRESS);
        String name = intent.getStringExtra(EXTRA_NAME);
        if (address != null && !address.isEmpty()) wand.connectByAddress(address);
        else wand.connectByName(name != null && !name.isEmpty() ? name : "WizardStaff");
    }

    private void connectUwb(Intent intent) {
        String role = roleOf(intent);
        String address = intent.getStringExtra(EXTRA_ADDRESS);
        String name = intent.getStringExtra(EXTRA_NAME);
        UwbGatt node = uwbNodes.get(role);
        if (node == null) {
            node = new UwbGatt(this, uwbListenerFor(role));
            uwbNodes.put(role, node);
        }
        if (address != null && !address.isEmpty()) node.connectByAddress(address);
        else node.connectByName(name != null && !name.isEmpty() ? name : "DW");
    }

    private void stopUwb(String role) {
        UwbGatt node = uwbNodes.remove(role);
        if (node != null) node.close();
        UwbBridge.emitStatus(role, false, null);
    }

    private void ensureForeground() {
        startForegroundCompat(statusText());
        if (wakeLock != null && !wakeLock.isHeld()) wakeLock.acquire();
    }

    private void stopEverything() {
        if (wand != null) wand.close();
        for (UwbGatt n : uwbNodes.values()) n.close();
        uwbNodes.clear();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        if (wand != null) wand.close();
        for (UwbGatt n : uwbNodes.values()) n.close();
        uwbNodes.clear();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }

    @Nullable @Override public IBinder onBind(Intent intent) { return null; }

    // --- driver listeners ----------------------------------------------------

    private final WandGatt.Listener wandListener = new WandGatt.Listener() {
        @Override public void onConnected(String address) {
            wandConnected = true; WandBridge.emitStatus(true, address); refreshNotification();
        }
        @Override public void onDisconnected() {
            wandConnected = false; WandBridge.emitStatus(false, null); refreshNotification();
        }
        @Override public void onMessage(String json) { WandBridge.emitMessage(json); }
        @Override public void onLog(String message) { WandBridge.emitLog(message); }
    };

    /** One listener per UWB role, capturing the role so emissions are tagged. */
    private UwbGatt.Listener uwbListenerFor(final String role) {
        return new UwbGatt.Listener() {
            @Override public void onConnected(String address) {
                UwbBridge.emitStatus(role, true, address); refreshNotification();
            }
            @Override public void onDisconnected() {
                UwbBridge.emitStatus(role, false, null); refreshNotification();
            }
            @Override public void onPosition(int x, int y, int z, int q) { UwbBridge.emitPosition(role, x, y, z, q); }
            @Override public void onDistances(List<UwbGatt.Distance> d) { UwbBridge.emitDistances(role, d); }
            @Override public void onLog(String message) { UwbBridge.emitLog(role, message); }
        };
    }

    // --- notification --------------------------------------------------------

    private String statusText() {
        StringBuilder sb = new StringBuilder();
        if (wandActive) sb.append("Stab: ").append(wandConnected ? "verbunden" : "verbinde …");
        if (!uwbNodes.isEmpty()) {
            int up = 0;
            for (String role : uwbNodes.keySet()) if (UwbBridge.isConnected(role)) up++;
            if (sb.length() > 0) sb.append(" · ");
            sb.append("UWB ").append(up).append('/').append(uwbNodes.size());
        }
        return sb.length() > 0 ? sb.toString() : "aktiv";
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID, "Ajna Zubehör", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Hält die Verbindung zu Zauberstab/UWB im Hintergrund.");
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.createNotificationChannel(ch);
        }
    }

    private Notification buildNotification(String text) {
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("Ajna · Zubehör aktiv")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();
    }

    private void startForegroundCompat(String text) {
        Notification n = buildNotification(text);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
        } else {
            startForeground(NOTIFICATION_ID, n);
        }
    }

    private void refreshNotification() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) nm.notify(NOTIFICATION_ID, buildNotification(statusText()));
    }
}
