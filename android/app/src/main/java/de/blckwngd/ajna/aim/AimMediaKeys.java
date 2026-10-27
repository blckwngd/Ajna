package de.blckwngd.ajna.aim;

import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTrack;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.view.KeyEvent;

/**
 * Media keys with the screen off.
 *
 * With the screen off there is no activity in front, so key events from a
 * Bluetooth remote go nowhere — except media keys, which Android routes to a
 * MediaSession. The rule (since Android 8): media buttons go to the session
 * that most recently PLAYED audio. So enabling this plays a fraction of a
 * second of silence once, to become that session; the foreground service
 * keeps the process alive.
 *
 * This is the measured-by-the-player part of the design: whether a given
 * phone and remote deliver here with the screen off is exactly what the
 * settings' "Bildschirm aus" check finds out (docs/geraete-anbindung.md).
 */
public final class AimMediaKeys {

    private static MediaSession session;

    private AimMediaKeys() {}

    public static synchronized boolean isActive() { return session != null; }

    public static synchronized void enable(Context ctx) {
        if (session != null) return;
        Context app = ctx.getApplicationContext();
        session = new MediaSession(app, "AjnaAim");
        session.setCallback(new MediaSession.Callback() {
            @Override public boolean onMediaButtonEvent(Intent intent) {
                KeyEvent ev = intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT);
                if (ev == null) return false;
                if (ev.getAction() == KeyEvent.ACTION_UP) {
                    boolean longPress = ev.getEventTime() - ev.getDownTime() >= 600;
                    AimBridge.emitInput("media", ExternalInput.codeFor(ev.getKeyCode()), longPress);
                }
                return true;
            }
        });
        session.setPlaybackState(new PlaybackState.Builder()
                .setActions(PlaybackState.ACTION_PLAY_PAUSE | PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE
                        | PlaybackState.ACTION_SKIP_TO_NEXT | PlaybackState.ACTION_SKIP_TO_PREVIOUS | PlaybackState.ACTION_STOP)
                .setState(PlaybackState.STATE_PLAYING, 0, 1f)
                .build());
        session.setActive(true);
        playSilence();
        AimBridge.emitLog("Medientasten: Sitzung aktiv");
    }

    public static synchronized void disable() {
        if (session == null) return;
        try { session.setActive(false); session.release(); } catch (Exception ignored) {}
        session = null;
        AimBridge.emitLog("Medientasten: Sitzung beendet");
    }

    /** A quarter second of silence, so Android counts this session as the last one that played. */
    private static void playSilence() {
        new Thread(() -> {
            int rate = 8000, n = rate / 4;
            try {
                AudioTrack t = new AudioTrack.Builder()
                        .setAudioAttributes(new AudioAttributes.Builder()
                                .setUsage(AudioAttributes.USAGE_MEDIA)
                                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
                        .setAudioFormat(new AudioFormat.Builder()
                                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                                .setSampleRate(rate)
                                .setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                        .setBufferSizeInBytes(n * 2)
                        .setTransferMode(AudioTrack.MODE_STATIC)
                        .build();
                t.write(new short[n], 0, n);
                t.play();
                Thread.sleep(400);
                t.stop(); t.release();
            } catch (Exception e) {
                AimBridge.emitLog("Medientasten: Stille nicht abspielbar (" + e.getMessage() + ")");
            }
        }, "ajna-silence").start();
    }
}
