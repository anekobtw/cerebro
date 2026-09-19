import { CameraView, useCameraPermissions } from "expo-camera";
import { StatusBar } from "expo-status-bar";
import { AudioManager } from "react-native-audio-api";
import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from "react-native";

import { TARGET_LONG_EDGE_PX, choosePictureSize } from "./src/camera/capture-policy";
import { DiagnosticsScreen } from "./src/diagnostics/DiagnosticsScreen";
import {
  NavigationSessionController,
  type NavigationSessionSnapshot,
} from "./src/session/controller";

export default function App(): JSX.Element {
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView | null>(null);
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

  useEffect(() => {
    setSnapshot(controller.getSnapshot());
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active" && controller.getSnapshot().active) {
        void controller.pause();
      }
    });
    return () => {
      subscription.remove();
      void controller.dispose();
    };
  }, [controller]);

  const start = useCallback(async () => {
    const permission = cameraPermission?.granted
      ? cameraPermission
      : await requestCameraPermission();
    if (!permission.granted) {
      await controller.start(false);
      return;
    }
    // Android permission dialogs can background the activity. Finish them before
    // activating the session, whose background handler pauses capture.
    if (await AudioManager.checkRecordingPermissions() !== "Granted") {
      await AudioManager.requestRecordingPermissions();
    }
    await controller.start(permission.granted);
  }, [cameraPermission, controller, requestCameraPermission]);

  const cameraReady = useCallback(async () => {
    const sizes = (await cameraRef.current?.getAvailablePictureSizesAsync()) ?? [];
    setPictureSize(choosePictureSize(sizes, TARGET_LONG_EDGE_PX) ?? undefined);
  }, []);

  if (showDiagnostics && snapshot?.active !== true) {
    return (
      <SafeAreaView style={styles.container}>
        <DiagnosticsScreen onClose={() => setShowDiagnostics(false)} />
        <StatusBar style="dark" />
      </SafeAreaView>
    );
  }

  const active = snapshot?.active === true;
  const paused = snapshot?.paused === true;

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={styles.title}>Blind Maps</Text>
        <Text accessibilityLiveRegion="none" style={styles.status}>
          {snapshot?.status ?? "Not connected"}
        </Text>
        <Text style={styles.destination}>
          {snapshot?.destination ? `Destination: ${snapshot.destination}` : "Tell the assistant where you want to go"}
        </Text>
        {active && (
          <Text style={styles.destination}>
            Say "pause" to pause or resume, "repeat" to choose a destination again, or "end assistant".
          </Text>
        )}

        {active && cameraPermission?.granted && (
          <CameraView
            active={!paused}
            animateShutter={false}
            mute
            onCameraReady={() => void cameraReady()}
            pictureSize={pictureSize}
            ref={cameraRef}
            style={styles.camera}
          />
        )}

        {!active ? (
          <Pressable
            accessibilityHint="Requests camera and microphone access, then asks for your destination"
            accessibilityRole="button"
            onPress={() => void start()}
            style={styles.primaryButton}
          >
            <Text style={styles.primaryButtonText}>Start assistant</Text>
          </Pressable>
        ) : (
          null
        )}

        <View accessibilityLabel="Session diagnostics" style={styles.diagnostics}>
          <Text accessibilityRole="header" style={styles.diagnosticsTitle}>Session diagnostics</Text>
          <Diagnostic label="Connection" value={snapshot?.connection ?? "idle"} />
          <Diagnostic label="Provider" value={snapshot?.provider ?? "none"} />
          {snapshot?.lastUserText && <Diagnostic label="Heard" value={snapshot.lastUserText} />}
          <Diagnostic
            label="Frame age"
            value={snapshot?.frameAgeMs == null ? "none" : `${snapshot.frameAgeMs} ms`}
          />
          <Diagnostic
            label="Microphone"
            value={snapshot?.microphone.running ? "streaming" : snapshot?.microphone.starting ? "starting" : "stopped"}
          />
          <Diagnostic label="Microphone chunks" value={String(snapshot?.microphone.chunksEmitted ?? 0)} />
          <Diagnostic label="Microphone level" value={(snapshot?.microphone.lastPeakLevel ?? 0).toFixed(3)} />
          {snapshot?.microphone.lastError && <Text style={styles.error}>{snapshot.microphone.lastError}</Text>}
          <Diagnostic label="Camera" value={snapshot?.camera.running ? "capturing" : "stopped"} />
          <Diagnostic label="Frames captured" value={String(snapshot?.camera.framesCaptured ?? 0)} />
          <Diagnostic label="Frames sent" value={String(snapshot?.framesSent ?? 0)} />
          <Diagnostic label="Audio chunks sent" value={String(snapshot?.audioChunksSent ?? 0)} />
          {snapshot?.camera.lastError && <Text style={styles.error}>{snapshot.camera.lastError}</Text>}
          <Diagnostic
            label="Audio"
            value={snapshot?.playback.queuedMs ? `playing ${snapshot.playback.queuedMs} ms` : "idle"}
          />
          <Diagnostic label="Audio chunks queued" value={String(snapshot?.playback.chunksQueued ?? 0)} />
          {snapshot?.playback.lastError && <Text style={styles.error}>{snapshot.playback.lastError}</Text>}
          {snapshot?.lastError && <Text style={styles.error}>{snapshot.lastError}</Text>}
        </View>

        {!active && (
          <Pressable
            accessibilityHint="Opens detailed microphone, camera, and location checks"
            accessibilityRole="button"
            onPress={() => setShowDiagnostics(true)}
            style={styles.secondaryButton}
          >
            <Text style={styles.secondaryButtonText}>Developer diagnostics</Text>
          </Pressable>
        )}
      </ScrollView>
      <StatusBar style="dark" />
    </SafeAreaView>
  );
}

function Diagnostic({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <View style={styles.diagnosticRow}>
      <Text style={styles.diagnosticLabel}>{label}</Text>
      <Text style={styles.diagnosticValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#ffffff" },
  content: { flexGrow: 1, gap: 18, padding: 24, paddingBottom: 48 },
  title: { color: "#111111", fontSize: 34, fontWeight: "800" },
  status: { color: "#111111", fontSize: 22, fontWeight: "600", lineHeight: 30 },
  destination: { color: "#444444", fontSize: 17 },
  camera: { alignSelf: "center", borderRadius: 12, height: 220, overflow: "hidden", width: "100%" },
  primaryButton: { backgroundColor: "#111111", borderRadius: 10, padding: 19 },
  primaryButtonText: { color: "#ffffff", fontSize: 21, fontWeight: "700", textAlign: "center" },
  secondaryButton: { borderColor: "#111111", borderRadius: 10, borderWidth: 2, padding: 17 },
  secondaryButtonText: { color: "#111111", fontSize: 19, fontWeight: "700", textAlign: "center" },
  diagnostics: { backgroundColor: "#f2f2f2", borderRadius: 10, gap: 8, padding: 16 },
  diagnosticsTitle: { color: "#111111", fontSize: 18, fontWeight: "700" },
  diagnosticRow: { flexDirection: "row", justifyContent: "space-between", gap: 16 },
  diagnosticLabel: { color: "#444444", fontSize: 15 },
  diagnosticValue: { color: "#111111", flexShrink: 1, fontFamily: "monospace", fontSize: 14, textAlign: "right" },
  error: { color: "#a10f0f", fontSize: 15, marginTop: 4 },
});
