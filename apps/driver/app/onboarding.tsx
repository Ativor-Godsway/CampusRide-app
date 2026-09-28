import { useEffect, useState } from "react";
import { Redirect, useRouter } from "expo-router";
import { Alert, Image, Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  Button,
  Card,
  DriverPhotoError,
  Illustration,
  Input,
  LoadingState,
  Screen,
  Text,
  colors,
  describeDriverPhotoError,
  describeProfileSaveError,
  radii,
  spacing,
  submitDriverProfile,
  useAuth,
} from "@rida/mobile-shared";
import { cloudinaryAvatar } from "@rida/shared";
import { DriverPhotoCard } from "../components/DriverPhotoCard";
import { SignOutLink } from "../components/SignOutLink";
import { driverSetupRoute } from "../lib/driverGate";
import { useDriverPhotoUpload } from "../lib/useDriverPhotoUpload";

type Step = "photo" | "car";
const STEPS: Step[] = ["photo", "car"];

/**
 * Driver onboarding, in two steps:
 *   1. Profile photo — required. Admins verify who the driver is from it
 *      before approving, so the driver cannot move on until it has uploaded.
 *   2. Car details — then "Submit for approval".
 *
 * Also reached from the waiting-for-approval screen to correct details, in
 * which case everything is pre-filled from the saved profile.
 */
export default function OnboardingScreen() {
  const router = useRouter();
  const { isLoading, isAuthenticated, user, refreshMe } = useAuth();
  const saved = user?.driver ?? null;

  const [step, setStep] = useState<Step>("photo");
  const photo = useDriverPhotoUpload(saved?.photoUrl ?? null);
  const [carMake, setCarMake] = useState(saved?.carMake ?? "");
  const [carModel, setCarModel] = useState(saved?.carModel ?? "");
  const [carColor, setCarColor] = useState(saved?.carColor ?? "");
  const [plate, setPlate] = useState(saved?.plate ?? "");
  const [saving, setSaving] = useState(false);
  // Set after a successful save; the effect below waits until the
  // AuthContext user reflects it before navigating, so the start screen never
  // renders with the stale user and bounces the driver back here.
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (submitted && user && driverSetupRoute(user) !== "/onboarding") {
      router.replace("/");
    }
  }, [submitted, user, router]);

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

  if (user.role !== "DRIVER") {
    return <Redirect href="/" />;
  }

  function goToCarStep() {
    if (photo.isUploading) {
      Alert.alert("Still uploading", "Please wait for your photo to finish uploading.");
      return;
    }
    if (!photo.photoUrl) {
      const { title, message } = describeDriverPhotoError(new DriverPhotoError("no_photo"));
      Alert.alert(title, message);
      return;
    }
    setStep("car");
  }

  async function handleSubmit() {
    if (!photo.photoUrl) {
      // Belt and braces: step 1 already requires it.
      setStep("photo");
      return;
    }
    if (!carMake.trim() || !carModel.trim() || !carColor.trim() || !plate.trim()) {
      Alert.alert("Car details needed", "Please fill in your car's make, model, colour and plate.");
      return;
    }
    setSaving(true);
    try {
      await submitDriverProfile({
        carMake: carMake.trim(),
        carModel: carModel.trim(),
        carColor: carColor.trim(),
        plate: plate.trim().toUpperCase(),
        photoUrl: photo.photoUrl,
      });
      await refreshMe();
      setSubmitted(true);
    } catch (error) {
      const { title, message } = describeProfileSaveError(error);
      Alert.alert(title, message);
    } finally {
      setSaving(false);
    }
  }

  const stepIndex = STEPS.indexOf(step);

  return (
    <Screen scroll>
      <View style={styles.topBar}>
        {step === "car" ? (
          <Pressable
            onPress={() => setStep("photo")}
            accessibilityRole="button"
            accessibilityLabel="Back to photo"
            hitSlop={8}
            style={styles.back}
          >
            <Ionicons name="arrow-back" size={20} color={colors.ink[800]} />
            <Text variant="bodyMedium">Back</Text>
          </Pressable>
        ) : (
          <View />
        )}
        <SignOutLink variant="compact" />
      </View>

      <View style={styles.stepper} accessibilityLabel={`Step ${stepIndex + 1} of ${STEPS.length}`}>
        {STEPS.map((s, i) => (
          <View key={s} style={[styles.stepDot, i <= stepIndex && styles.stepDotActive]} />
        ))}
      </View>
      <Text variant="label" color="muted">
        STEP {stepIndex + 1} OF {STEPS.length}
      </Text>

      {step === "photo" ? (
        <>
          <View style={styles.header}>
            <Text variant="h1">Add your photo</Text>
            <Text variant="bodySmall" color="muted" style={styles.subtitle}>
              Our team uses this photo to confirm who you are before approving you, and riders see
              it when you pick them up.
            </Text>
          </View>

          <DriverPhotoCard
            state={photo.state}
            canRetry={photo.canRetry}
            onPick={(source) => void photo.pick(source)}
            onRetry={() => void photo.retry()}
          />

          <View style={styles.cta}>
            <Button label="Continue" size="lg" onPress={goToCarStep} disabled={!photo.photoUrl} />
          </View>
        </>
      ) : (
        <>
          <View style={styles.header}>
            <Illustration name="driverOnboarding" size={120} float style={styles.hero} />
            <Text variant="h1">Your car</Text>
            <Text variant="bodySmall" color="muted" style={styles.subtitle}>
              So riders know which car to look for. You can change these later.
            </Text>
          </View>

          {photo.photoUrl ? (
            <Pressable
              onPress={() => setStep("photo")}
              accessibilityRole="button"
              accessibilityLabel="Change your photo"
              style={styles.photoSummary}
            >
              <Image
                source={{ uri: cloudinaryAvatar(photo.photoUrl, 44) }}
                style={styles.photoThumb}
              />
              <View style={styles.photoSummaryText}>
                <Text variant="bodyMedium">Photo added</Text>
                <Text variant="caption" color="muted">
                  Tap to change
                </Text>
              </View>
              <Ionicons name="checkmark-circle" size={22} color={colors.success} />
            </Pressable>
          ) : null}

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
              label="Car colour"
              placeholder="e.g. White"
              value={carColor}
              onChangeText={setCarColor}
              autoCapitalize="words"
              returnKeyType="next"
            />
            <Input
              label="Licence plate"
              placeholder="e.g. GN-1234-22"
              value={plate}
              onChangeText={setPlate}
              autoCapitalize="characters"
              returnKeyType="done"
              onSubmitEditing={() => void handleSubmit()}
            />
          </Card>

          <View style={styles.cta}>
            <Button
              label="Submit for approval"
              onPress={() => void handleSubmit()}
              loading={saving}
              size="lg"
            />
          </View>
        </>
      )}

      <SignOutLink />
    </Screen>
  );
}

const styles = StyleSheet.create({
  topBar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacing.lg,
    minHeight: 32,
  },
  back: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  stepper: { flexDirection: "row", gap: spacing.xs, marginBottom: spacing.sm },
  stepDot: { flex: 1, height: 4, borderRadius: radii.full, backgroundColor: colors.surfaceSunken },
  stepDotActive: { backgroundColor: colors.primary[500] },
  hero: { alignSelf: "center", marginBottom: spacing.md },
  header: { gap: spacing.sm, marginTop: spacing.sm, marginBottom: spacing.xl },
  subtitle: { maxWidth: 320 },
  photoSummary: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radii.lg,
    backgroundColor: colors.successSurface,
    marginBottom: spacing.md,
  },
  photoThumb: { width: 44, height: 44, borderRadius: radii.full },
  photoSummaryText: { flex: 1 },
  formCard: { gap: spacing.lg, marginBottom: spacing.md },
  cta: { marginTop: spacing.lg, marginBottom: spacing.sm },
});
