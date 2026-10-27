package de.blckwngd.ajna.wear

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PointingTest {

    // Identity: device axes = world axes. Device +X = east.
    private val identity = floatArrayOf(1f, 0f, 0f, 0f, 1f, 0f, 0f, 0f, 1f)

    @Test fun leftWristPointsAlongPlusX() {
        val d = Pointing.fromRotationMatrix(identity, leftWrist = true)
        assertEquals(90.0, d.yaw, 1e-6)      // east
        assertEquals(0.0, d.pitch, 1e-6)
    }

    @Test fun rightWristPointsTheOtherWay() {
        val d = Pointing.fromRotationMatrix(identity, leftWrist = false)
        assertEquals(270.0, d.yaw, 1e-6)     // west
    }

    @Test fun armRaisedGivesPitch() {
        // Device rotated so +X points 45° up towards north: column 0 = (0, cos45, sin45)
        val c = Math.cos(Math.PI / 4).toFloat()
        val r = floatArrayOf(0f, 0f, 0f, c, 0f, 0f, c, 0f, 0f)
        val d = Pointing.fromRotationMatrix(r, leftWrist = true)
        assertEquals(0.0, d.yaw, 1e-4)
        assertEquals(45.0, d.pitch, 1e-4)
    }

    @Test fun accuracyFromSensorOrStatus() {
        assertEquals(10.0, Pointing.accuracyDeg(Math.toRadians(10.0).toFloat(), 3), 1e-4)
        assertEquals(5.0, Pointing.accuracyDeg(-1f, 3), 1e-9)
        assertEquals(45.0, Pointing.accuracyDeg(null, 0), 1e-9)
    }

    @Test fun capabilityWithoutCompassOrGyro() {
        assertEquals("absolute", Pointing.pointingCapability(true, true))
        assertEquals("relative", Pointing.pointingCapability(false, true))
        assertNull(Pointing.pointingCapability(false, false))
    }

    @Test fun protocolRoundTrip() {
        assertEquals("{\"type\":\"o\",\"y\":123.5,\"p\":-4.0,\"a\":8}", Protocol.orientation(123.46, -4.0, 8.0))
        val v = Protocol.parse("{\"cmd\":\"view\",\"aiming\":true,\"target\":{\"name\":\"Bank\",\"type\":\"poi\",\"dist\":12},\"actions\":[\"examine\"],\"acc\":9}")
        v as Protocol.Command.Show
        assertEquals("Bank", v.view.target?.name)
        assertEquals(12, v.view.target?.dist)
        assertEquals(listOf("examine"), v.view.actions)
        val h = Protocol.parse("{\"cmd\":\"haptic\",\"p\":[0,25,60,25]}") as Protocol.Command.Haptic
        assertEquals(4, h.pattern.size)
        assertEquals(Protocol.Command.Unknown, Protocol.parse("not json"))
    }
}
