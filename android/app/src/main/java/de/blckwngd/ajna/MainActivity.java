package de.blckwngd.ajna;

import android.os.Bundle;
import android.view.KeyEvent;
import android.view.MotionEvent;
import com.getcapacitor.BridgeActivity;
import java.lang.ref.WeakReference;
import de.blckwngd.ajna.aim.AimDevicesPlugin;
import de.blckwngd.ajna.aim.ExternalInput;
import de.blckwngd.ajna.accessory.WandPlugin;
import de.blckwngd.ajna.accessory.UwbPlugin;
import de.blckwngd.ajna.localserver.LocalServerPlugin;
import de.blckwngd.ajna.voice.SttPlugin;

public class MainActivity extends BridgeActivity {

    // Schwache Referenz auf die aktuelle Instanz, damit der AccessoryBleService
    // beim "Beenden" (Notification-Button) die App-Task sauber aus den Recents
    // nehmen kann, bevor der Prozess gekillt wird.
    private static WeakReference<MainActivity> instanceRef;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local (non-npm) Capacitor plugins must be registered before super.onCreate().
        registerPlugin(WandPlugin.class);
        registerPlugin(UwbPlugin.class);   // independent of the wand
        registerPlugin(LocalServerPlugin.class);   // lokaler Asset-Server für WebXR-in-Chrome
        registerPlugin(SttPlugin.class);   // offline speech-to-text (push-to-talk voice)
        registerPlugin(AimDevicesPlugin.class);   // pointing on the go: remote, watch, media keys
        super.onCreate(savedInstanceState);
        instanceRef = new WeakReference<>(this);
    }

    // External input (Bluetooth remote, keyboard) is captured here, BEFORE the
    // WebView — only while pointing on the go asked for it, and only from
    // devices that report themselves as external. See ExternalInput.
    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (ExternalInput.onKey(event)) return true;
        return super.dispatchKeyEvent(event);
    }

    @Override
    public boolean dispatchGenericMotionEvent(MotionEvent event) {
        if (ExternalInput.onMotion(event)) return true;
        return super.dispatchGenericMotionEvent(event);
    }

    @Override
    public boolean dispatchTouchEvent(MotionEvent event) {
        // A remote's touchpad can arrive as touch events too; the phone's own
        // screen is never external, so this does not touch normal use.
        if (ExternalInput.onMotion(event)) return true;
        return super.dispatchTouchEvent(event);
    }

    @Override
    public void onDestroy() {
        if (instanceRef != null && instanceRef.get() == this) instanceRef = null;
        super.onDestroy();
    }

    /**
     * Vom AccessoryBleService beim "Beenden" aufgerufen: entfernt die App-Task
     * aus den Recents, falls die Activity noch lebt. No-op sonst (der Service
     * killt den Prozess anschließend ohnehin).
     */
    public static void finishIfRunning() {
        MainActivity a = instanceRef != null ? instanceRef.get() : null;
        if (a != null) a.runOnUiThread(a::finishAndRemoveTask);
    }
}
