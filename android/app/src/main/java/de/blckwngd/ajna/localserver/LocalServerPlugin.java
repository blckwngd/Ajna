package de.blckwngd.ajna.localserver;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Capacitor-Plugin: startet einen lokalen Asset-Server ({@link AssetHttpServer})
 * über die im APK gebündelten Web-Assets und liefert die http://localhost:PORT-
 * URL zurück.
 *
 * Damit kann externes Chrome die gebündelte AR-Seite vom Loopback laden und
 * dort volles WebXR/ARCore nutzen — ohne dass die aktuelle Web-App vorher auf
 * den primären Server deployt werden muss.
 *
 * JS (siehe client/core/MobileShell.js):
 *   const LocalServer = registerPlugin('LocalServer');
 *   const { url } = await LocalServer.start();        // "http://localhost:43219"
 *   window.open(url + '/index-ar.html#ajna=...', '_blank');
 *
 * Hinweis Lebenszyklus: Der Server läuft im App-Prozess. Solange Chrome die
 * Seite (einmalig) lädt, bleibt der gebackgroundete App-Prozess i. d. R. im
 * Cache am Leben. Wird das unzuverlässig, kann der Server später in den
 * vorhandenen Foreground-Service wandern.
 */
@CapacitorPlugin(name = "LocalServer")
public class LocalServerPlugin extends Plugin {

    private AssetHttpServer server;

    @PluginMethod
    public void start(PluginCall call) {
        try {
            if (server == null) {
                server = new AssetHttpServer(getContext().getAssets(), "public");
            }
            if (!server.isAlive()) {
                server.start();   // Daemon-Thread, OS-gewählter freier Port
            }
            JSObject ret = new JSObject();
            ret.put("url", "http://localhost:" + server.getListeningPort());
            ret.put("port", server.getListeningPort());
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("LocalServer-Start fehlgeschlagen: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (server != null && server.isAlive()) {
            server.stop();
        }
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        if (server != null) {
            server.stop();
            server = null;
        }
    }
}
