import { useEffect, useState } from "react";
import { Redirect, useRouter } from "expo-router";
import { Alert, StyleSheet, View } from "react-native";
import {
  Button,
  Card,
  Input,
  LoadingState,
  Screen,
  Text,
  colors,
  spacing,
  submitDriverProfile,
  useAuth,
} from "@rida/mobile-shared";

export default function OnboardingScreen() {
  const router = useRouter();
  const { isLoading, isAuthenticated, user, refreshMe } = useAuth();

  const [carMake, setCarMake] = useState("");
  const [carModel, setCarModel] = useState("");
  const [carColor, setCarColor] = useState("");
  const [plate, setPlate] = useState("");
  const [saving, setSaving] = useState(false);
  // Set to true after a successful save; the effect below waits until the
  // AuthContext user state has updated (carMake non-null) before navigating,
  // preventing a race where index.tsx renders with stale user and bounces back.
  const [profileSaved, setProfileSaved] = useState(false);

  useEffect(() => {
    if (profileSaved && user?.driver?.carMake) {
      router.replace("/");
    }
  }, [profileSaved, user?.driver?.carMake, router]);

  if (isLoading) {
    return (
      <Screen>
        <LoadingState />
      </Screen>
    );
  }

  if (!isAuthenticated || !user) {
    return <Redirect href="/auth/phone" />;
  }

  async function handleSave() {
    if (!carMake.trim() || !carModel.trim() || !carColor.trim() || !plate.trim()) {
      Alert.alert("Required", "Please fill in all car details.");
      return;
    }
    setSaving(true);
    try {
      await submitDriverProfile({
        carMake: carMake.trim(),
        carModel: carModel.trim(),
        carColor: carColor.trim(),
        plate: plate.trim().toUpperCase(),
      });
      await refreshMe();
      // Signal the useEffect above; it navigates once user state has updated.
      setProfileSaved(true);
    } catch {
      Alert.alert("Couldn't save profile", "Please check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Screen scroll>
      <View style={styles.header}>
        <Text variant="h1">Set up your profile</Text>
        <Text variant="bodySmall" color="muted" style={styles.subtitle}>
          Provide your car details so riders know what to look for. You can update these later.
        </Text>
      </View>

      <Card style={styles.formCard}>
        <Text variant="label" color="muted">
          CAR DETAILS
        </Text>

        <Input
          label="Car make"
          placeholder="e.g. Toyota"
          value={carMake}
          onChangeText={setCarMake}
          autoCapitalize="words"
          returnKeyType="next"
        />

        <Input
          label="Car model"
          placeholder="e.g. Corolla"
          value={carModel}
          onChangeText={setCarModel}
          autoCapitalize="words"
          returnKeyType="next"
        />

        <Input
          label="Car color"
          placeholder="e.g. White"
          value={carColor}
          onChangeText={setCarColor}
          autoCapitalize="words"
          returnKeyType="next"
        />

        <Input
          label="License plate"
          placeholder="e.g. GN-1234-22"
          value={plate}
          onChangeText={setPlate}
          autoCapitalize="characters"
          returnKeyType="done"
          onSubmitEditing={() => void handleSave()}
        />
      </Card>

      <View style={styles.note}>
        <Text variant="caption" color="muted">
          Photo upload coming soon — your initials are shown to riders for now.
        </Text>
      </View>

      <View style={styles.cta}>
        <Button
          label="Save and continue"
          onPress={() => void handleSave()}
          loading={saving}
          size="lg"
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    gap: spacing.sm,
    marginBottom: spacing.xl,
  },
  subtitle: {
    maxWidth: 300,
  },
  formCard: {
    gap: spacing.lg,
    marginBottom: spacing.md,
  },
  note: {
    paddingHorizontal: spacing.xs,
    marginBottom: spacing.lg,
  },
  cta: {
    marginTop: spacing.sm,
  },
});
