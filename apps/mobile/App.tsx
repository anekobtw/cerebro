import { StatusBar } from "expo-status-bar";
import { Pressable, SafeAreaView, StyleSheet, Text, View } from "react-native";

export default function App() {
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
});
