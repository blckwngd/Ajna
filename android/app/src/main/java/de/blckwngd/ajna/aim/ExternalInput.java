package de.blckwngd.ajna.aim;

import android.os.Handler;
import android.os.Looper;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.MotionEvent;

/**
 * Captures input from EXTERNAL devices (a Bluetooth remote, a "Daydream"
 * clone, a keyboard) before the WebView sees it, and turns it into codes for
 * the JS mapping (client/core/aim/inputMapping.js).
 *
 * Why before the WebView: many cheap remotes report their touchpad as a
 * MOUSE. In the WebView that moves a pointer and clicks into the interface.
 * Captured here, a swipe is a swipe and a click is a click.
 *
 * Only active while the JS side asked for it (`setInputCapture`). Built-in
 * keys of the phone (volume rocker, back) are never touched — only devices
 * that report themselves as external.
 *
 * Codes follow KeyboardEvent.key where one exists ("MediaPlayPause",
 * "ArrowLeft", "Enter"), so the same mapping serves the WebView path.
 */
public final class ExternalInput {

    private static volatile boolean enabled = false;
    private static final long LONG_MS = 600;
    private static final Handler main = new Handler(Looper.getMainLooper());

    // touchpad (absolute) gesture state
    private static float downX, downY;
    private static long downAt;
    private static boolean tracking = false;
    // mouse (relative) gesture state
    private static float accX = 0, accY = 0;
    private static final Runnable flushMouse = ExternalInput::flushMouse;

    private ExternalInput() {}

    public static void setEnabled(boolean on) {
        enabled = on;
        if (!on) { tracking = false; accX = accY = 0; main.removeCallbacks(flushMouse); }
    }
    public static boolean isEnabled() { return enabled; }

    /** Is this event from a device we should capture? */
    static boolean isExternal(InputDevice d) {
        if (d == null || d.isVirtual()) return false;
        if (android.os.Build.VERSION.SDK_INT >= 29) return d.isExternal();
        // Before API 29: no isExternal(). A device with a vendor id is a real
        // peripheral; the built-in keys report 0.
        return d.getVendorId() != 0;
    }

    private static String deviceName(InputDevice d) { return d != null ? d.getName() : "?"; }

    /** From Activity.dispatchKeyEvent. Returns true when consumed. */
    public static boolean onKey(KeyEvent ev) {
        if (!enabled || !isExternal(ev.getDevice())) return false;
        if (ev.getAction() == KeyEvent.ACTION_UP) {
            boolean longPress = ev.getEventTime() - ev.getDownTime() >= LONG_MS;
            AimBridge.emitInput(deviceName(ev.getDevice()), codeFor(ev.getKeyCode()), longPress);
        }
        return true;   // down and up, so the WebView never sees half a press
    }

    /** From Activity.dispatchGenericMotionEvent and the pointer-capture listener. */
    public static boolean onMotion(MotionEvent ev) {
        if (!enabled || !isExternal(ev.getDevice())) return false;
        int src = ev.getSource();
        boolean relative = (src & InputDevice.SOURCE_MOUSE_RELATIVE) == InputDevice.SOURCE_MOUSE_RELATIVE
                || ((src & InputDevice.SOURCE_MOUSE) == InputDevice.SOURCE_MOUSE);
        boolean touchpad = (src & InputDevice.SOURCE_TOUCHPAD) == InputDevice.SOURCE_TOUCHPAD;

        // Clicks first — any button press from the remote.
        if (ev.getActionMasked() == MotionEvent.ACTION_BUTTON_PRESS) {
            AimBridge.emitInput(deviceName(ev.getDevice()), "click", false);
            return true;
        }
        if (touchpad && !relative) return onTouchpad(ev);
        if (relative) return onMouse(ev);
        return true;
    }

    private static boolean onTouchpad(MotionEvent ev) {
        switch (ev.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                downX = ev.getX(); downY = ev.getY(); downAt = ev.getEventTime(); tracking = true; break;
            case MotionEvent.ACTION_UP:
                if (!tracking) break;
                tracking = false;
                InputDevice d = ev.getDevice();
                float rx = range(d, MotionEvent.AXIS_X), ry = range(d, MotionEvent.AXIS_Y);
                float dx = (ev.getX() - downX) / rx, dy = (ev.getY() - downY) / ry;
                String g = gesture(dx, dy, 0.15f);
                if (g == null && ev.getEventTime() - downAt < 300) g = "tap";
                if (g != null) AimBridge.emitInput(deviceName(d), g, false);
                break;
            default: break;
        }
        return true;
    }

    private static boolean onMouse(MotionEvent ev) {
        float dx = ev.getAxisValue(MotionEvent.AXIS_RELATIVE_X);
        float dy = ev.getAxisValue(MotionEvent.AXIS_RELATIVE_Y);
        if (dx == 0 && dy == 0) { dx = ev.getX(); dy = ev.getY(); }   // captured pointer reports deltas as x/y
        accX += dx; accY += dy;
        lastMouseDevice = deviceName(ev.getDevice());
        main.removeCallbacks(flushMouse);
        main.postDelayed(flushMouse, 160);   // a swipe ends when the motion pauses
        return true;
    }

    private static String lastMouseDevice = "?";

    private static void flushMouse() {
        // Pixels of a relative pointer: 120 is a deliberate stroke on the
        // small pads these remotes have, not a twitch.
        String g = gesture(accX / 800f, accY / 800f, 0.15f);
        accX = accY = 0;
        if (g != null) AimBridge.emitInput(lastMouseDevice, g, false);
    }

    private static float range(InputDevice d, int axis) {
        InputDevice.MotionRange r = d != null ? d.getMotionRange(axis) : null;
        return r != null && r.getRange() > 0 ? r.getRange() : 1000f;
    }

    /** Normalised movement → swipe direction, or null when too short. */
    static String gesture(float dx, float dy, float threshold) {
        if (Math.abs(dx) < threshold && Math.abs(dy) < threshold) return null;
        if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? "swipe_right" : "swipe_left";
        return dy > 0 ? "swipe_down" : "swipe_up";
    }

    /** Android key code → KeyboardEvent.key-style name. */
    public static String codeFor(int keyCode) {
        switch (keyCode) {
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_HEADSETHOOK:      return "MediaPlayPause";
            case KeyEvent.KEYCODE_MEDIA_PLAY:       return "MediaPlay";
            case KeyEvent.KEYCODE_MEDIA_PAUSE:      return "MediaPause";
            case KeyEvent.KEYCODE_MEDIA_NEXT:       return "MediaTrackNext";
            case KeyEvent.KEYCODE_MEDIA_PREVIOUS:   return "MediaTrackPrevious";
            case KeyEvent.KEYCODE_MEDIA_STOP:       return "MediaStop";
            case KeyEvent.KEYCODE_VOLUME_UP:        return "AudioVolumeUp";
            case KeyEvent.KEYCODE_VOLUME_DOWN:      return "AudioVolumeDown";
            case KeyEvent.KEYCODE_DPAD_LEFT:        return "ArrowLeft";
            case KeyEvent.KEYCODE_DPAD_RIGHT:       return "ArrowRight";
            case KeyEvent.KEYCODE_DPAD_UP:          return "ArrowUp";
            case KeyEvent.KEYCODE_DPAD_DOWN:        return "ArrowDown";
            case KeyEvent.KEYCODE_DPAD_CENTER:
            case KeyEvent.KEYCODE_ENTER:
            case KeyEvent.KEYCODE_BUTTON_A:         return "Enter";
            case KeyEvent.KEYCODE_BACK:
            case KeyEvent.KEYCODE_ESCAPE:
            case KeyEvent.KEYCODE_BUTTON_B:         return "Escape";
            case KeyEvent.KEYCODE_SPACE:            return " ";
            case KeyEvent.KEYCODE_HOME:             return "Home";
            default: {
                String s = KeyEvent.keyCodeToString(keyCode);   // "KEYCODE_BUTTON_X" etc.
                return s.startsWith("KEYCODE_") ? s.substring(8) : s;
            }
        }
    }
}
