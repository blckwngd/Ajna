package de.blckwngd.ajna;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import de.blckwngd.ajna.accessory.WandPlugin;
import de.blckwngd.ajna.accessory.UwbPlugin;
import de.blckwngd.ajna.localserver.LocalServerPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local (non-npm) Capacitor plugins must be registered before super.onCreate().
        registerPlugin(WandPlugin.class);
        registerPlugin(UwbPlugin.class);   // independent of the wand
        registerPlugin(LocalServerPlugin.class);   // lokaler Asset-Server für WebXR-in-Chrome
        super.onCreate(savedInstanceState);
    }
}
