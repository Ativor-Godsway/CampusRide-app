import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useAuth } from "../../lib/auth/AuthContext";

type SignupRole = "RIDER" | "DRIVER";

export default function SignupScreen() {
  const router = useRouter();
  const { completeSignup } = useAuth();
  const { phone, verifiedToken } = useLocalSearchParams<{ phone: string; verifiedToken: string }>();
  const [name, setName] = useState("");
  const [role, setRole] = useState<SignupRole>("RIDER");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    if (!name.trim()) {
      setError("Enter your name");
      return;
    }

    setError(null);
    setIsSubmitting(true);
    try {
      await completeSignup({ phone, name: name.trim(), role, verifiedToken });
      router.replace("/");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Tell us about you</Text>

      <TextInput
        style={styles.input}
        placeholder="Full name"
        autoComplete="name"
        value={name}
        onChangeText={setName}
      />

      <View style={styles.roleRow}>
        <Pressable
          style={[styles.roleButton, role === "RIDER" && styles.roleButtonSelected]}
          onPress={() => setRole("RIDER")}
        >
          <Text style={[styles.roleButtonText, role === "RIDER" && styles.roleButtonTextSelected]}>
            Rider
          </Text>
        </Pressable>
        <Pressable
          style={[styles.roleButton, role === "DRIVER" && styles.roleButtonSelected]}
          onPress={() => setRole("DRIVER")}
        >
          <Text style={[styles.roleButtonText, role === "DRIVER" && styles.roleButtonTextSelected]}>
            Driver
          </Text>
        </Pressable>
      </View>

      {error && <Text style={styles.error}>{error}</Text>}

      {isSubmitting ? (
        <ActivityIndicator style={styles.spinner} />
      ) : (
        <Pressable style={styles.button} onPress={() => void handleSubmit()}>
          <Text style={styles.buttonText}>Finish</Text>
        </Pressable>
      )}
    </View>
  );
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "response" in err) {
    const response = (err as { response?: { data?: { error?: string } } }).response;
    if (response?.data?.error) return response.data.error;
  }
  return "Something went wrong. Try again.";
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    padding: 24,
    backgroundColor: "#fff",
  },
  title: {
    fontSize: 28,
    fontWeight: "700",
    marginBottom: 24,
    textAlign: "center",
  },
  input: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 8,
    padding: 14,
    fontSize: 16,
    marginBottom: 16,
  },
  roleRow: {
    flexDirection: "row",
    gap: 12,
    marginBottom: 16,
  },
  roleButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: "center",
  },
  roleButtonSelected: {
    backgroundColor: "#222",
    borderColor: "#222",
  },
  roleButtonText: {
    fontSize: 16,
    fontWeight: "600",
    color: "#222",
  },
  roleButtonTextSelected: {
    color: "#fff",
  },
  error: {
    color: "#c0392b",
    marginBottom: 12,
    textAlign: "center",
  },
  button: {
    backgroundColor: "#222",
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: "center",
  },
  buttonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  spinner: {
    marginVertical: 12,
  },
});
