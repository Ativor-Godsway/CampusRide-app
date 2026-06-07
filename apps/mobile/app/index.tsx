import { Redirect } from "expo-router";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useAuth } from "../lib/auth/AuthContext";

export default function HomeScreen() {
  const { isLoading, isAuthenticated, user, signOut } = useAuth();

  if (isLoading) {
    return (
      <View style={styles.container}>
        <ActivityIndicator />
      </View>
    );
  }

  if (!isAuthenticated || !user) {
    return <Redirect href="/auth/phone" />;
  }

  return (
    <View style={styles.container}>
      <Text style={styles.appName}>CampusRide</Text>
      <Text style={styles.welcome}>Welcome, {user.name}</Text>
      <Text style={styles.detail}>Phone: {user.phone}</Text>
      <Text style={styles.detail}>Role: {user.role}</Text>
      <Pressable style={styles.button} onPress={() => void signOut()}>
        <Text style={styles.buttonText}>Log out</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#fff",
    padding: 24,
  },
  appName: {
    fontSize: 36,
    fontWeight: "700",
    marginBottom: 16,
  },
  welcome: {
    fontSize: 18,
    marginBottom: 4,
  },
  detail: {
    fontSize: 14,
    color: "#666",
    marginBottom: 4,
  },
  button: {
    marginTop: 24,
    paddingVertical: 12,
    paddingHorizontal: 24,
    backgroundColor: "#222",
    borderRadius: 8,
  },
  buttonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
});
