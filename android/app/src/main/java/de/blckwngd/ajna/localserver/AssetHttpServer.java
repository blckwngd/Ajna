package de.blckwngd.ajna.localserver;

import android.content.res.AssetManager;

import java.io.IOException;
import java.io.InputStream;

import fi.iki.elonen.NanoHTTPD;

/**
 * Minimaler lokaler HTTP-Server, der die im APK gebündelten Web-Assets
 * (assets/public — der Capacitor-webDir-Inhalt, also der client/-Ordner) über
 * 127.0.0.1 ausliefert.
 *
 * Zweck: Externes Chrome kann die AR-Seite vom GERÄTE-LOOPBACK laden. Da
 * http://localhost als "secure context" gilt, funktionieren dort WebXR +
 * getUserMedia — OHNE dass die aktuelle Web-App vorher auf den Server deployt
 * werden muss (sie steckt ja schon im APK).
 *
 * Sicherheit: an 127.0.0.1 gebunden (nur on-device erreichbar, nicht vom Netz).
 * Range-Requests sind nicht nötig — die GLB-Modelle lädt der Client weiterhin
 * vom (entfernten) Ajna-Server; hier gehen nur HTML/JS/CSS raus.
 */
public class AssetHttpServer extends NanoHTTPD {

    private final AssetManager assets;
    private final String root;   // z. B. "public"

    public AssetHttpServer(AssetManager assets, String root) {
        super("127.0.0.1", 0);   // Port 0 → das OS wählt einen freien Port
        this.assets = assets;
        this.root = root;
    }

    @Override
    public Response serve(IHTTPSession session) {
        String uri = session.getUri();   // Pfad ohne Query/Hash, z. B. /index-ar.html
        if (uri == null || uri.isEmpty() || uri.equals("/")) {
            uri = "/index.html";
        }
        if (uri.contains("..")) {   // Pfad-Traversal abwehren
            return newFixedLengthResponse(Response.Status.FORBIDDEN, MIME_PLAINTEXT, "Forbidden");
        }

        final String assetPath = root + uri;   // "public/index-ar.html"
        try {
            InputStream is = assets.open(assetPath);   // dekomprimiert transparent
            Response res = newChunkedResponse(Response.Status.OK, mimeFor(uri), is);
            res.addHeader("Cache-Control", "no-cache");
            return res;
        } catch (IOException e) {
            return newFixedLengthResponse(Response.Status.NOT_FOUND, MIME_PLAINTEXT, "Not found: " + uri);
        }
    }

    private static String mimeFor(String uri) {
        String u = uri.toLowerCase();
        if (u.endsWith(".html") || u.endsWith(".htm")) return "text/html";
        if (u.endsWith(".js") || u.endsWith(".mjs"))   return "text/javascript";
        if (u.endsWith(".css"))   return "text/css";
        if (u.endsWith(".json"))  return "application/json";
        if (u.endsWith(".wasm"))  return "application/wasm";
        if (u.endsWith(".svg"))   return "image/svg+xml";
        if (u.endsWith(".png"))   return "image/png";
        if (u.endsWith(".jpg") || u.endsWith(".jpeg")) return "image/jpeg";
        if (u.endsWith(".webp"))  return "image/webp";
        if (u.endsWith(".glb"))   return "model/gltf-binary";
        if (u.endsWith(".gltf"))  return "model/gltf+json";
        if (u.endsWith(".wav"))   return "audio/wav";
        if (u.endsWith(".mp3"))   return "audio/mpeg";
        if (u.endsWith(".ico"))   return "image/x-icon";
        return "application/octet-stream";
    }
}
