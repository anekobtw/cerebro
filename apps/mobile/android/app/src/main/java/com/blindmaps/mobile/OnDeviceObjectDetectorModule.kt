package com.blindmaps.mobile

import android.graphics.BitmapFactory
import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.objects.ObjectDetection
import com.google.mlkit.vision.objects.defaults.ObjectDetectorOptions
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Runs ML Kit's coarse object detector entirely on the device. This module deliberately
 * returns observations rather than safety conclusions; JavaScript decides whether to speak.
 */
class OnDeviceObjectDetectorModule(
  reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
  private val executor: ExecutorService = Executors.newSingleThreadExecutor()
  private val detector = ObjectDetection.getClient(
    ObjectDetectorOptions.Builder()
      .setDetectorMode(ObjectDetectorOptions.SINGLE_IMAGE_MODE)
      .enableMultipleObjects()
      .enableClassification()
      .build(),
  )

  override fun getName() = "BlindMapsObjectDetection"

  @ReactMethod
  fun detectJpeg(base64Jpeg: String, promise: Promise) {
    executor.execute {
      try {
        val bytes = Base64.decode(base64Jpeg, Base64.DEFAULT)
        val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
          ?: throw IllegalArgumentException("Camera frame is not a valid JPEG")
        val image = InputImage.fromBitmap(bitmap, 0)
        detector.process(image)
          .addOnSuccessListener { detected ->
            val objects = Arguments.createArray()
            detected.forEach { item ->
              val box = item.boundingBox
              val labels = Arguments.createArray()
              item.labels.forEach { label ->
                labels.pushString(label.text)
              }
              objects.pushMap(Arguments.createMap().apply {
                putDouble("left", box.left.toDouble() / bitmap.width)
                putDouble("top", box.top.toDouble() / bitmap.height)
                putDouble("right", box.right.toDouble() / bitmap.width)
                putDouble("bottom", box.bottom.toDouble() / bitmap.height)
                putArray("labels", labels)
              })
            }
            promise.resolve(Arguments.createMap().apply {
              putArray("objects", objects)
            })
          }
          .addOnFailureListener { error -> promise.reject("OBJECT_DETECTION_FAILED", error) }
      } catch (error: Exception) {
        promise.reject("OBJECT_DETECTION_FAILED", error)
      }
    }
  }

  override fun invalidate() {
    detector.close()
    executor.shutdownNow()
    super.invalidate()
  }
}
