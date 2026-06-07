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
import { verifyOtp, type OtpPurpose } from "../../lib/auth/api";

export default function OtpScreen() {
  const router = useRouter();
  const { completeLogin } = useAuth();
  const { phone, purpose } = useLocalSearchParams<{ phone: string; purpose: OtpPurpose }>();
  const [code, setCode] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleVerify() {
    if (code.length !== 6) {
      setError("Enter the 6-digit code");
      return;
    }

    setError(null);
    setIsSubmitting(true);
    try {
      const { verifiedToken } = await verifyOtp(phone, code, purpose);

      if (purpose === "SIGNUP") {
        router.push({ pathname: "/auth/signup", params: { phone, verifiedToken } });
      } else {
        await completeLogin({ phone, verifiedToken });
        router.replace("/");
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Enter the code</Text>
      <Text style={styles.subtitle}>We sent a 6-digit code to {phone}</Text>

      <TextInput
        style={styles.input}
        placeholder="000000"
        keyboardType="number-pad"
        maxLength={6}
        value={code}
        onChangeText={setCode}
      />

      {error && <Text style={styles.error}>{error}</Text>}

      {isSubmitting ? (
        <ActivityIndicator style={styles.spinner} />
      ) : (
        <Pressable style={styles.button} onPress={() => void handleVerify()}>
          <Text style={styles.buttonText}>Continue</Text>
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
    marginBottom: 8,
    textAlign: "center",
  },
  subtitle: {
    fontSize: 14,
    color: "#666",
    marginBottom: 24,
    textAlign: "center",
  },
  input: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 8,
    padding: 14,
    fontSize: 24,
    textAlign: "center",
    letterSpacing: 8,
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
