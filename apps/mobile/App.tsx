import { CameraView, useCameraPermissions } from "expo-camera";
import * as Location from "expo-location";
import { StatusBar } from "expo-status-bar";
import { AudioManager } from "react-native-audio-api";
import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, SafeAreaView, StyleSheet, Text, View } from "react-native";

import { TARGET_LONG_EDGE_PX, choosePictureSize } from "./src/camera/capture-policy";
import {
  NavigationSessionController,
  type NavigationSessionSnapshot,
} from "./src/session/controller";

export default function App(): JSX.Element {
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView | null>(null);
  const launchStarted = useRef(false);
  const [pictureSize, setPictureSize] = useState<string | undefined>();
  const [snapshot, setSnapshot] = useState<NavigationSessionSnapshot | null>(null);
  const controller = useMemo(
    () =>
      new NavigationSessionController({
        getCamera: () => cameraRef.current,
        onSnapshot: setSnapshot,
      }),
    [],
  );

  const start = useCallback(async () => {
    if (launchStarted.current || controller.getSnapshot().active) return;
    launchStarted.current = true;

    const permission = await requestCameraPermission();
    if (!permission.granted) {
      await controller.start(false);
      return;
    }

    // Android permission dialogs can background the activity. Resolve every
    // permission before starting the session so it is not immediately paused.
    if (await AudioManager.checkRecordingPermissions() !== "Granted") {
      await AudioManager.requestRecordingPermissions();
    }
    if (!(await Location.getForegroundPermissionsAsync()).granted) {
      await Location.requestForegroundPermissionsAsync();
    }
    await controller.start(true);
  }, [controller, requestCameraPermission]);

  useEffect(() => {
    setSnapshot(controller.getSnapshot());
    void start();
    return () => {
      void controller.dispose();
    };
  }, [controller, start]);

  const retry = useCallback(() => {
    launchStarted.current = false;
    void start();
  }, [start]);

  const cameraReady = useCallback(async () => {
    const sizes = (await cameraRef.current?.getAvailablePictureSizesAsync()) ?? [];
    setPictureSize(choosePictureSize(sizes, TARGET_LONG_EDGE_PX) ?? undefined);
  }, []);

  const active = snapshot?.active === true;
  const paused = snapshot?.paused === true;
  const failed = snapshot?.connection === "failed";
  const status = snapshot?.status ?? "Starting Blind Maps";

  return (
    <View style={styles.container}>
      {cameraPermission?.granted && (
        <CameraView
          active={!paused}
          animateShutter={false}
          mute
          onCameraReady={() => void cameraReady()}
          pictureSize={pictureSize}
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
        />
      )}

      <View pointerEvents="none" style={styles.topShade} />
      <SafeAreaView pointerEvents="box-none" style={styles.overlay}>
        <View accessibilityLiveRegion="polite" style={styles.statusCard}>
          <View style={[styles.signal, active && !paused && styles.signalActive]} />
          <View style={styles.statusCopy}>
            <Text style={styles.brand}>BLIND MAPS</Text>
            <Text accessibilityRole="header" numberOfLines={3} style={styles.status}>
              {status}
            </Text>
          </View>
        </View>

        {failed && (
          <View style={styles.failureCard}>
            <Text style={styles.failureTitle}>Assistant stopped</Text>
            <Text style={styles.failureMessage}>{snapshot.lastError ?? status}</Text>
            <Pressable
              accessibilityHint="Requests access again and restarts navigation"
              accessibilityRole="button"
              onPress={retry}
              style={({ pressed }) => [styles.retryButton, pressed && styles.retryPressed]}
            >
              <Text style={styles.retryText}>Try again</Text>
            </Pressable>
          </View>
        )}
      </SafeAreaView>
      <StatusBar style="light" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: "#090c0f",
    flex: 1,
  },
  topShade: {
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
    backgroundColor: "transparent",
    borderTopColor: "rgba(3, 8, 12, 0.68)",
    borderTopWidth: 190,
  },
  overlay: {
    flex: 1,
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingBottom: 24,
  },
  statusCard: {
    alignItems: "flex-start",
    alignSelf: "stretch",
    flexDirection: "row",
    gap: 12,
    marginTop: 12,
  },
  signal: {
    backgroundColor: "#8c969e",
    borderColor: "rgba(255, 255, 255, 0.5)",
    borderRadius: 8,
    borderWidth: 2,
    height: 16,
    marginTop: 4,
    width: 16,
  },
  signalActive: {
    backgroundColor: "#ffbd33",
    borderColor: "#fff2ce",
  },
  statusCopy: {
    flex: 1,
    gap: 5,
  },
  brand: {
    color: "#ffcc62",
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 2.2,
  },
  status: {
    color: "#ffffff",
    fontSize: 26,
    fontWeight: "800",
    letterSpacing: -0.5,
    lineHeight: 31,
    textShadowColor: "rgba(0, 0, 0, 0.55)",
    textShadowOffset: { height: 1, width: 0 },
    textShadowRadius: 8,
  },
  failureCard: {
    alignSelf: "stretch",
    backgroundColor: "rgba(9, 12, 15, 0.92)",
    borderColor: "rgba(255, 255, 255, 0.18)",
    borderRadius: 22,
    borderWidth: 1,
    gap: 10,
    padding: 20,
  },
  failureTitle: {
    color: "#ffffff",
    fontSize: 23,
    fontWeight: "800",
  },
  failureMessage: {
    color: "#d7dde2",
    fontSize: 17,
    lineHeight: 24,
  },
  retryButton: {
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: "#ffbd33",
    borderRadius: 999,
    marginTop: 4,
    paddingHorizontal: 22,
    paddingVertical: 13,
  },
  retryPressed: {
    backgroundColor: "#e7a313",
  },
  retryText: {
    color: "#16120a",
    fontSize: 17,
    fontWeight: "800",
  },
});
