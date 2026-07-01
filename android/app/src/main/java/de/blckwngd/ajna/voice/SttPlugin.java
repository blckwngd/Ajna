package de.blckwngd.ajna.voice;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;

/**
 * Offline speech-to-text for push-to-talk voice commands. Wraps Android's
 * SpeechRecognizer in FREE_FORM + PREFER_OFFLINE mode and routes audio to a
 * Bluetooth headset (SCO) when one is connected, so the close mic is used.
 * Partial + final results are emitted as the `sttResult` event consumed by
 * SttEngine.js (NativeStt).
 *
 * JS usage (client/core/SttEngine.js):
 *   const Stt = registerPlugin('Stt');
 *   Stt.addListener('sttResult', e => ...);   // e.text, e.isFinal, e.confidence
 *   Stt.addListener('sttError',  e => ...);   // e.error (SpeechRecognizer code)
 *   await Stt.start({ lang: 'de-DE', offline: true, partial: true });
 *   await Stt.stop();
 *
 * Privacy: recognition is on-device (PREFER_OFFLINE); no audio leaves the phone.
 *
 * NOTE (background mic): on Android 14+ capturing the mic while the app is
 * backgrounded/screen-off needs a foreground service of type `microphone`. The
 * existing AccessoryBleService is `connectedDevice` only, so screen-off voice is
 * reliable when the app is in the foreground; a dedicated mic FGS is the follow-up.
 */
@CapacitorPlugin(
    name = "Stt",
    permissions = {
        @Permission(alias = "mic", strings = { Manifest.permission.RECORD_AUDIO })
    }
)
public class SttPlugin extends Plugin {

    private SpeechRecognizer recognizer;
    private boolean scoStarted = false;
    private String lang = "de-DE";
    private boolean partial = true;
    private boolean preferOffline = true;

    @PluginMethod
    public void start(PluginCall call) {
        lang = call.getString("lang", "de-DE");
        partial = Boolean.TRUE.equals(call.getBoolean("partial", true));
        preferOffline = Boolean.TRUE.equals(call.getBoolean("offline", true));
        if (getPermissionState("mic") != PermissionState.GRANTED) {
            requestPermissionForAlias("mic", call, "micPermsCallback");
            return;
        }
        beginListening(call);
    }

    @PermissionCallback
    private void micPermsCallback(PluginCall call) {
        if (getPermissionState("mic") == PermissionState.GRANTED) {
            beginListening(call);
        } else {
            call.reject("Mikrofon-Berechtigung nicht erteilt");
        }
    }

    private void beginListening(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                if (!SpeechRecognizer.isRecognitionAvailable(getContext())) {
                    call.reject("Spracherkennung nicht verfügbar");
                    return;
                }
                routeToBluetoothMic(true);
                if (recognizer == null) {
                    recognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
                    recognizer.setRecognitionListener(listener);
                }
                Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang);
                intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getContext().getPackageName());
                intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, partial);
                intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 5);
                // Don't cut off too early (push-to-talk: the user may pause briefly).
                intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, 1500);
                intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 1500);
                intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 1500);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    intent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, preferOffline);
                }
                recognizer.startListening(intent);
                call.resolve();
            } catch (Exception e) {
                routeToBluetoothMic(false);
                call.reject("STT start failed: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            // stopListening() finalizes and delivers the captured speech via
            // onResults. cancel() would DISCARD it — so on push-to-talk release we
            // must NOT cancel (that was why nothing was ever recognised).
            try { if (recognizer != null) recognizer.stopListening(); } catch (Exception ignored) {}
        });
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        getActivity().runOnUiThread(() -> {
            try { if (recognizer != null) recognizer.destroy(); } catch (Exception ignored) {}
            recognizer = null;
            routeToBluetoothMic(false);
        });
    }

    // --- Bluetooth headset (SCO) routing ------------------------------------
    // Best-effort: prefer the BT mic when a headset is connected; fall back to the
    // phone mic on any failure.
    private void routeToBluetoothMic(boolean on) {
        try {
            AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
            if (am == null) return;
            if (on) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    AudioDeviceInfo bt = null;
                    for (AudioDeviceInfo d : am.getAvailableCommunicationDevices()) {
                        if (d.getType() == AudioDeviceInfo.TYPE_BLUETOOTH_SCO) { bt = d; break; }
                    }
                    if (bt != null && am.setCommunicationDevice(bt)) scoStarted = true;
                } else {
                    am.setMode(AudioManager.MODE_IN_COMMUNICATION);
                    am.startBluetoothSco();
                    am.setBluetoothScoOn(true);
                    scoStarted = true;
                }
            } else if (scoStarted) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    am.clearCommunicationDevice();
                } else {
                    am.setBluetoothScoOn(false);
                    am.stopBluetoothSco();
                    am.setMode(AudioManager.MODE_NORMAL);
                }
                scoStarted = false;
            }
        } catch (Exception ignored) {}
    }

    // --- recognition events -> JS -------------------------------------------
    private final RecognitionListener listener = new RecognitionListener() {
        @Override public void onResults(Bundle results) {
            emit(results, true);
            routeToBluetoothMic(false);
        }
        @Override public void onPartialResults(Bundle partialResults) {
            if (partial) emit(partialResults, false);
        }
        @Override public void onError(int error) {
            JSObject ev = new JSObject();
            ev.put("error", error);
            notifyListeners("sttError", ev);
            routeToBluetoothMic(false);
        }
        @Override public void onReadyForSpeech(Bundle params) {}
        @Override public void onBeginningOfSpeech() {}
        @Override public void onRmsChanged(float rmsdB) {}
        @Override public void onBufferReceived(byte[] buffer) {}
        @Override public void onEndOfSpeech() {}
        @Override public void onEvent(int eventType, Bundle params) {}
    };

    private void emit(Bundle results, boolean isFinal) {
        if (results == null) return;
        ArrayList<String> texts = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        if (texts == null || texts.isEmpty()) return;
        float conf = 0f;
        float[] scores = results.getFloatArray(SpeechRecognizer.CONFIDENCE_SCORES);
        if (scores != null && scores.length > 0) conf = scores[0];
        JSObject ev = new JSObject();
        ev.put("text", texts.get(0));
        ev.put("isFinal", isFinal);
        ev.put("confidence", conf);
        notifyListeners("sttResult", ev);
    }
}
