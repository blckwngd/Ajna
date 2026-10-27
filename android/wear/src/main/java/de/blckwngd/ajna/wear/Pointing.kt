package de.blckwngd.ajna.wear

import kotlin.math.asin
import kotlin.math.atan2
import kotlin.math.hypot

/**
 * From a rotation matrix to "where does the arm point" — pure, no Android.
 *
 * The matrix is SensorManager's: device → world, row-major 3×3, world X = east,
 * Y = north, Z = up (for TYPE_ROTATION_VECTOR; for TYPE_GAME_ROTATION_VECTOR
 * the same, except Y is an arbitrary horizontal reference, not north).
 *
 * WHICH DEVICE AXIS IS THE ARM: the forearm runs along the 3-o'clock /
 * 9-o'clock line of the dial. Worn on the LEFT wrist, 3 o'clock (device +X)
 * points to the hand; on the RIGHT wrist it is 9 o'clock (device −X).
 */
object Pointing {

    /** yaw: compass degrees (0 = north, clockwise); pitch: degrees above the horizon. */
    data class Direction(val yaw: Double, val pitch: Double)

    fun fromRotationMatrix(r: FloatArray, leftWrist: Boolean): Direction {
        val s = if (leftWrist) 1.0 else -1.0
        // Column 0 of R is device +X expressed in world coordinates.
        val e = s * r[0]
        val n = s * r[3]
        val u = s * r[6]
        val yaw = ((Math.toDegrees(atan2(e, n)) % 360.0) + 360.0) % 360.0
        val pitch = Math.toDegrees(asin(u.coerceIn(-1.0, 1.0)))
        return Direction(yaw, pitch)
    }

    /** Horizontal length of the pointing axis — near 0 the arm points straight up or down and yaw is meaningless. */
    fun horizontal(r: FloatArray, leftWrist: Boolean): Double {
        val s = if (leftWrist) 1.0 else -1.0
        return hypot(s * r[0].toDouble(), s * r[3].toDouble())
    }

    /**
     * Accuracy in degrees. TYPE_ROTATION_VECTOR may report its own heading
     * accuracy in values[4] (radians, −1 when unknown); otherwise the sensor's
     * status decides.
     */
    fun accuracyDeg(headingAccuracyRad: Float?, status: Int): Double {
        if (headingAccuracyRad != null && headingAccuracyRad > 0f) return Math.toDegrees(headingAccuracyRad.toDouble())
        return when (status) {
            3 -> 5.0     // SENSOR_STATUS_ACCURACY_HIGH
            2 -> 12.0    // MEDIUM
            1 -> 25.0    // LOW
            else -> 45.0 // UNRELIABLE / NO_CONTACT
        }
    }

    /** What this watch can do as a pointing device. */
    fun pointingCapability(hasRotationVector: Boolean, hasGameRotationVector: Boolean): String? = when {
        hasRotationVector -> "absolute"
        hasGameRotationVector -> "relative"
        else -> null
    }
}
