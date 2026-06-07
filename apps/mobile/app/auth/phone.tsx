import { useRouter } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { requestOtp } from "../../lib/auth/api";

export default function PhoneScreen() {
  const router = useRouter();
  const [phone, setPhone] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleContinue(purpose: "SIGNUP" | "LOGIN") {
    if (!phone) {
      setError("Enter your phone number");
      return;
    }

    setError(null);
    setIsSubmitting(true);
    try {
      await requestOtp(phone, purpose);
      router.push({ pathname: "/auth/otp", params: { phone, purpose } });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>CampusRide</Text>
      <Text style={styles.subtitle}>Enter your phone number</Text>

      <TextInput
        style={styles.input}
        placeholder="+233 ..."
        keyboardType="phone-pad"
        autoComplete="tel"
        value={phone}
        onChangeText={setPhone}
      />

      {error && <Text style={styles.error}>{error}</Text>}

      {isSubmitting ? (
        <ActivityIndicator style={styles.spinner} />
      ) : (
        <>
          <Pressable style={styles.button} onPress={() => void handleContinue("LOGIN")}>
            <Text style={styles.buttonText}>Log in</Text>
          </Pressable>
          <Pressable
            style={[styles.button, styles.secondaryButton]}
            onPress={() => void handleContinue("SIGNUP")}
          >
            <Text style={styles.buttonText}>Sign up</Text>
          </Pressable>
        </>
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
    fontSize: 32,
    fontWeight: "700",
    marginBottom: 8,
    textAlign: "center",
  },
  subtitle: {
    fontSize: 16,
    color: "#666",
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
    marginBottom: 12,
  },
  secondaryButton: {
    backgroundColor: "#555",
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
