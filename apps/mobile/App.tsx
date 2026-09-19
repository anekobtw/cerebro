import { StatusBar } from "expo-status-bar";
import { type JSX, useState } from "react";
import { Pressable, SafeAreaView, StyleSheet, Text, View } from "react-native";

import { DiagnosticsScreen } from "./src/diagnostics/DiagnosticsScreen";

export default function App(): JSX.Element {
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  if (showDiagnostics) {
    return (
      <SafeAreaView style={styles.container}>
        <DiagnosticsScreen onClose={() => setShowDiagnostics(false)} />
        <StatusBar style="auto" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Text accessibilityRole="header" style={styles.title}>
          Blind Maps
        </Text>
        <Text accessibilityLiveRegion="polite" style={styles.status}>
          Not connected
        </Text>
        <Pressable
          accessibilityHint="Connects to the navigation assistant"
          accessibilityRole="button"
          onPress={() => undefined}
          style={styles.button}
        >
          <Text style={styles.buttonText}>Start navigation</Text>
        </Pressable>
        <Pressable
          accessibilityHint="Opens the microphone, camera, and location measurements used during development"
          accessibilityRole="button"
          onPress={() => setShowDiagnostics(true)}
          style={styles.secondaryButton}
        >
          <Text style={styles.secondaryButtonText}>Developer diagnostics</Text>
        </Pressable>
      </View>
      <StatusBar style="auto" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#ffffff" },
  content: { flex: 1, justifyContent: "center", padding: 24, gap: 24 },
  title: { color: "#111111", fontSize: 32, fontWeight: "700" },
  status: { color: "#333333", fontSize: 20 },
  button: { backgroundColor: "#111111", borderRadius: 8, padding: 18 },
  buttonText: { color: "#ffffff", fontSize: 20, fontWeight: "600", textAlign: "center" },
  secondaryButton: { borderColor: "#111111", borderRadius: 8, borderWidth: 2, padding: 16 },
  secondaryButtonText: { color: "#111111", fontSize: 18, fontWeight: "600", textAlign: "center" },
});
