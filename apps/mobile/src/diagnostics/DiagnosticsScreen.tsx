import { CameraView, useCameraPermissions } from "expo-camera";
import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { PcmPlayer, type PlayerStats } from "../audio/player";
import { FrameCaptureLoop, type FrameCaptureStats } from "../camera/frame-capture";
import { TARGET_LONG_EDGE_PX, choosePictureSize } from "../camera/capture-policy";
import { LocationTracker, type LocationStats } from "../location/tracking";
import { AudioCheckRunner, CHECK_TITLES, type CheckResult } from "./audio-checks";

const CHECK_IDS = CHECK_TITLES.map((_, index) => index + 1);

function formatStats(stats: object): string {
  return Object.entries(stats)
    .map(([key, value]) => `${key}: ${value === null ? "none" : String(value)}`)
    .join("\n");
}

export function DiagnosticsScreen({ onClose }: { onClose: () => void }): JSX.Element {
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView | null>(null);
  const player = useMemo(() => new PcmPlayer(), []);
  const runner = useMemo(() => new AudioCheckRunner(player), [player]);

  const [results, setResults] = useState<CheckResult[]>([]);
  const [runningCheck, setRunningCheck] = useState<number | null>(null);
  const [playerStats, setPlayerStats] = useState<PlayerStats>(() => player.getStats());
  const [cameraStats, setCameraStats] = useState<FrameCaptureStats | null>(null);
  const [locationStats, setLocationStats] = useState<LocationStats | null>(null);
  const [pictureSize, setPictureSize] = useState<string | undefined>(undefined);

  const capture = useMemo(
    () =>
      new FrameCaptureLoop({
        getCamera: () => cameraRef.current,
        onStats: setCameraStats,
      }),
    [],
  );

  const tracker = useMemo(() => new LocationTracker({ onStats: setLocationStats }), []);

  useEffect(() => {
    const interval = setInterval(() => setPlayerStats(player.getStats()), 500);

    return () => {
      clearInterval(interval);
      capture.stop();
      tracker.stop();
      void player.close();
    };
  }, [capture, player, tracker]);

  const runCheck = useCallback(
    async (id: number) => {
      setRunningCheck(id);
      const result = await runner.run(id);
      setResults((previous) => [...previous.filter((entry) => entry.id !== id), result].sort((a, b) => a.id - b.id));
      setRunningCheck(null);
    },
    [runner],
  );

  const runAllChecks = useCallback(async () => {
    for (const id of CHECK_IDS) {
      await runCheck(id);
    }
  }, [runCheck]);

  const startCamera = useCallback(async () => {
    if (cameraPermission?.granted !== true) {
      await requestCameraPermission();
    }

    const sizes = (await cameraRef.current?.getAvailablePictureSizesAsync()) ?? [];
    setPictureSize(choosePictureSize(sizes, TARGET_LONG_EDGE_PX) ?? undefined);
    capture.start();
  }, [cameraPermission?.granted, capture, requestCameraPermission]);

  return (
    <ScrollView contentContainerStyle={styles.content} style={styles.screen}>
      <Text accessibilityRole="header" style={styles.title}>
        Developer diagnostics
      </Text>
      <Text style={styles.note}>
        Mock and measurement surface for phase 1. Nothing here is live perception or a provider session.
      </Text>

      <Pressable accessibilityRole="button" onPress={onClose} style={styles.secondaryButton}>
        <Text style={styles.secondaryButtonText}>Back to main screen</Text>
      </Pressable>

      <Text accessibilityRole="header" style={styles.sectionTitle}>
        Audio checks
      </Text>
      <Pressable
        accessibilityHint="Runs the eight audio checks in order. Takes about thirty seconds."
        accessibilityRole="button"
        disabled={runningCheck !== null}
        onPress={() => void runAllChecks()}
        style={[styles.button, runningCheck !== null && styles.buttonDisabled]}
      >
        <Text style={styles.buttonText}>
          {runningCheck === null ? "Run all audio checks test" : `Running check ${runningCheck}`}
        </Text>
      </Pressable>

      {CHECK_IDS.map((id) => {
        const result = results.find((entry) => entry.id === id);

        return (
          <View key={id} style={styles.card}>
            <Pressable
              accessibilityRole="button"
              disabled={runningCheck !== null}
              onPress={() => void runCheck(id)}
              style={styles.checkHeader}
            >
              <Text style={styles.checkTitle}>{`${id}. ${CHECK_TITLES[id - 1]}`}</Text>
              <Text style={[styles.status, statusStyle(result?.status)]}>
                {runningCheck === id ? "running" : (result?.status ?? "not run")}
              </Text>
            </Pressable>
            {result !== undefined && <Text style={styles.detail}>{result.detail}</Text>}
          </View>
        );
      })}

      <Text style={styles.mono}>{formatStats(playerStats)}</Text>

      <Text accessibilityRole="header" style={styles.sectionTitle}>
        Continuous camera
      </Text>
      <View style={styles.previewRow}>
        <CameraView
          active
          animateShutter={false}
          mute
          pictureSize={pictureSize}
          ref={cameraRef}
          style={styles.preview}
        />
        <View style={styles.previewControls}>
          <Pressable accessibilityRole="button" onPress={() => void startCamera()} style={styles.button}>
            <Text style={styles.buttonText}>Start capture loop</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={() => capture.stop()} style={styles.secondaryButton}>
            <Text style={styles.secondaryButtonText}>Stop capture loop</Text>
          </Pressable>
          <Text style={styles.detail}>{`picture size: ${pictureSize ?? "device default"}`}</Text>
        </View>
      </View>
      <Text style={styles.mono}>{cameraStats === null ? "capture loop not started" : formatStats(cameraStats)}</Text>

      <Text accessibilityRole="header" style={styles.sectionTitle}>
        Location
      </Text>
      <Pressable accessibilityRole="button" onPress={() => void tracker.start()} style={styles.button}>
        <Text style={styles.buttonText}>Start location updates</Text>
      </Pressable>
      <Pressable accessibilityRole="button" onPress={() => tracker.stop()} style={styles.secondaryButton}>
        <Text style={styles.secondaryButtonText}>Stop location updates</Text>
      </Pressable>
      <Text style={styles.mono}>
        {locationStats === null ? "location updates not started" : formatStats(locationStats)}
      </Text>
      <Text style={styles.note}>
        Travel heading comes from GPS course over ground and is null below walking speed. The device heading below it is
        where the phone points, which is not the direction the person walks.
      </Text>
    </ScrollView>
  );
}

function statusStyle(status: CheckResult["status"] | undefined): { color: string } {
  switch (status) {
    case "pass":
      return { color: "#0a7d33" };
    case "fail":
      return { color: "#b00020" };
    case "check-by-ear":
      return { color: "#8a5a00" };
    default:
      return { color: "#444444" };
  }
}

const styles = StyleSheet.create({
  screen: { backgroundColor: "#ffffff", flex: 1 },
  content: { gap: 12, padding: 16, paddingBottom: 48 },
  title: { color: "#111111", fontSize: 26, fontWeight: "700" },
  sectionTitle: { color: "#111111", fontSize: 20, fontWeight: "700", marginTop: 12 },
  note: { color: "#444444", fontSize: 14 },
  button: { backgroundColor: "#111111", borderRadius: 8, padding: 14 },
  buttonDisabled: { backgroundColor: "#666666" },
  buttonText: { color: "#ffffff", fontSize: 17, fontWeight: "600", textAlign: "center" },
  secondaryButton: { borderColor: "#111111", borderRadius: 8, borderWidth: 2, padding: 12 },
  secondaryButtonText: { color: "#111111", fontSize: 16, fontWeight: "600", textAlign: "center" },
  card: { backgroundColor: "#f4f4f4", borderRadius: 8, gap: 6, padding: 12 },
  checkHeader: { gap: 4 },
  checkTitle: { color: "#111111", fontSize: 16, fontWeight: "600" },
  status: { fontSize: 14, fontWeight: "700" },
  detail: { color: "#333333", fontSize: 14 },
  mono: { color: "#222222", fontFamily: "monospace", fontSize: 12 },
  previewRow: { flexDirection: "row", gap: 12 },
  preview: { borderRadius: 8, height: 160, width: 120 },
  previewControls: { flex: 1, gap: 8 },
});
