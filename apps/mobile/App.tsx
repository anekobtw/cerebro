import { CameraView, useCameraPermissions } from "expo-camera";
import { StatusBar } from "expo-status-bar";
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
        <Text accessibilityLiveRegion="assertive" style={styles.status}>
          {snapshot?.status ?? "Not connected"}
        </Text>
        <Text style={styles.destination}>
          {snapshot?.routeId ? `Surveyed route: ${snapshot.routeId}` : "No surveyed route selected"}
        </Text>
        {active && !snapshot?.routeAvailable && (
          <Text accessibilityLiveRegion="polite" style={styles.routeUnavailable}>
            Live route guidance is locked until the field survey is loaded. Scene questions still work.
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
            accessibilityHint="Requests camera, microphone, and location access, then connects to the scene assistant"
            accessibilityRole="button"
            onPress={() => void start()}
            style={styles.primaryButton}
          >
            <Text style={styles.primaryButtonText}>Start assistant</Text>
          </Pressable>
        ) : (
          <View style={styles.controls}>
            {snapshot?.routeAvailable && snapshot.navigationPhase === "ready" && (
              <Pressable
                accessibilityHint="Requests the surveyed route to the USF Tampa Library"
                accessibilityRole="button"
                onPress={() => controller.requestDestination()}
                style={styles.primaryButton}
              >
                <Text style={styles.primaryButtonText}>Start library route</Text>
              </Pressable>
            )}
            {snapshot?.navigationPhase === "destination_confirmation" && (
              <Pressable
                accessibilityHint="Confirms the displayed destination and checks the supported start area"
                accessibilityRole="button"
                onPress={() => void controller.confirmDestination()}
                style={styles.primaryButton}
              >
                <Text style={styles.primaryButtonText}>Confirm library destination</Text>
              </Pressable>
            )}
            <Pressable
              accessibilityRole="button"
              onPress={() => void (paused ? controller.resume() : controller.pause())}
              style={styles.primaryButton}
            >
              <Text style={styles.primaryButtonText}>{paused ? "Resume" : "Pause"}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => controller.repeat()} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>Repeat</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => void controller.end()} style={styles.endButton}>
              <Text style={styles.endButtonText}>End assistant</Text>
            </Pressable>
          </View>
        )}

        <View accessibilityLabel="Session diagnostics" style={styles.diagnostics}>
          <Text accessibilityRole="header" style={styles.diagnosticsTitle}>Session diagnostics</Text>
          <Diagnostic label="Connection" value={snapshot?.connection ?? "idle"} />
          <Diagnostic label="Provider" value={snapshot?.provider ?? "none"} />
          <Diagnostic label="Navigation phase" value={snapshot?.navigationPhase ?? "unavailable"} />
          <Diagnostic label="Route source" value={snapshot?.routeSource ?? "none"} />
          <Diagnostic label="Route requests" value={String(snapshot?.routeRequestCount ?? 0)} />
          <Diagnostic label="Segment" value={snapshot?.currentSegmentId ?? "none"} />
          {snapshot?.routeFallbackReason && (
            <Diagnostic label="Route fallback" value={snapshot.routeFallbackReason} />
          )}
          {snapshot?.routeFailureDetail && (
            <Diagnostic label="Route failure" value={snapshot.routeFailureDetail} />
          )}
          <Diagnostic
            label="Frame age"
            value={snapshot?.frameAgeMs == null ? "none" : `${snapshot.frameAgeMs} ms`}
          />
          <Diagnostic
            label="Microphone"
            value={snapshot?.microphone.running ? "streaming" : snapshot?.microphone.starting ? "starting" : "stopped"}
          />
          <Diagnostic
            label="Audio"
            value={snapshot?.playback.activeUtteranceId ? `playing ${snapshot.playback.activeUtteranceId}` : "idle"}
          />
          {snapshot?.lastError && <Text style={styles.error}>{snapshot.lastError}</Text>}
          {snapshot?.routeSource === "google_routes" && (
            <Text style={styles.attribution}>Powered by Google, ©2026 Google</Text>
          )}
          {snapshot?.providerWarnings.map((warning) => (
            <Text key={warning} style={styles.warning}>{warning}</Text>
          ))}
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
  routeUnavailable: { backgroundColor: "#fff4d6", color: "#4d3900", fontSize: 16, lineHeight: 23, padding: 12 },
  camera: { alignSelf: "center", borderRadius: 12, height: 220, overflow: "hidden", width: "100%" },
  controls: { gap: 12 },
  primaryButton: { backgroundColor: "#111111", borderRadius: 10, padding: 19 },
  primaryButtonText: { color: "#ffffff", fontSize: 21, fontWeight: "700", textAlign: "center" },
  secondaryButton: { borderColor: "#111111", borderRadius: 10, borderWidth: 2, padding: 17 },
  secondaryButtonText: { color: "#111111", fontSize: 19, fontWeight: "700", textAlign: "center" },
  endButton: { backgroundColor: "#8c1d18", borderRadius: 10, padding: 17 },
  endButtonText: { color: "#ffffff", fontSize: 19, fontWeight: "700", textAlign: "center" },
  diagnostics: { backgroundColor: "#f2f2f2", borderRadius: 10, gap: 8, padding: 16 },
  diagnosticsTitle: { color: "#111111", fontSize: 18, fontWeight: "700" },
  diagnosticRow: { flexDirection: "row", justifyContent: "space-between", gap: 16 },
  diagnosticLabel: { color: "#444444", fontSize: 15 },
  diagnosticValue: { color: "#111111", flexShrink: 1, fontFamily: "monospace", fontSize: 14, textAlign: "right" },
  error: { color: "#a10f0f", fontSize: 15, marginTop: 4 },
  warning: { color: "#6e4c00", fontSize: 14, marginTop: 4 },
  attribution: { color: "#444444", fontSize: 13, marginTop: 4 },
});
