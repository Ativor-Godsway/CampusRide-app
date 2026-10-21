import { useEffect, useRef, useState } from "react";
import { Redirect, useRouter } from "expo-router";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import {
  BackButton,
  Button,
  DriverPhotoError,
  Screen,
  Text,
  colors,
  describeDriverPhotoError,
  describeProfileSaveError,
  radii,
  spacing,
  submitDriverProfile,
  useAuth,
  SessionRestoringScreen,
} from "@rida/mobile-shared";
import { CarDetailsForm, type CarDetails } from "../components/CarDetailsForm";
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

  // The saved profile can arrive after this screen opens (the app restarting
  // straight into onboarding): fill the steps from it once, unless the driver
  // has already started.
  const seededRef = useRef(Boolean(saved));
  useEffect(() => {
    if (seededRef.current || !saved) return;
    seededRef.current = true;
    if (saved.photoUrl && photo.state.status === "idle") photo.reset(saved.photoUrl);
    setCarMake((v) => v || (saved.carMake ?? ""));
    setCarModel((v) => v || (saved.carModel ?? ""));
    setCarColor((v) => v || (saved.carColor ?? ""));
    setPlate((v) => v || (saved.plate ?? ""));
  }, [saved, photo]);

  useEffect(() => {
    if (submitted && user && driverSetupRoute(user) !== "/onboarding") {
      router.replace("/");
    }
  }, [submitted, user, router]);

  if (isLoading) return <SessionRestoringScreen />;

  if (!isAuthenticated || !user) {
    return <Redirect href="/auth/welcome" />;
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
  const car: CarDetails = { carMake, carModel, carColor, plate };
  const setCar = (next: CarDetails) => {
    setCarMake(next.carMake);
    setCarModel(next.carModel);
    setCarColor(next.carColor);
    setPlate(next.plate);
  };

  return (
    <Screen edges={["top", "bottom"]} noPadding>
      <View style={styles.top}>
        {step === "car" ? (
          <BackButton onPress={() => setStep("photo")} />
        ) : (
          <View style={styles.backSpace} />
        )}
        <View
          style={styles.progress}
          accessible
          accessibilityLabel={`Step ${stepIndex + 1} of ${STEPS.length}`}
        >
          {STEPS.map((s, i) => (
            <View key={s} style={[styles.bar, i <= stepIndex && styles.barDone]} />
          ))}
        </View>
        <Text variant="subhead" color="secondary">
          Step {stepIndex + 1} of {STEPS.length}
        </Text>
      </View>

      <ScrollView
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        {step === "photo" ? (
          <>
            <View style={styles.heading}>
              <Text variant="title1" accessibilityRole="header">
                Add your photo
              </Text>
              <Text variant="body" color="secondary">
                Our team uses it to confirm who you are before approving you, and riders see it when
                you pick them up.
              </Text>
            </View>
            <DriverPhotoCard
              state={photo.state}
              canRetry={photo.canRetry}
              onPick={(source) => void photo.pick(source)}
              onRetry={() => void photo.retry()}
            />
          </>
        ) : (
          <>
            <View style={styles.heading}>
              <Text variant="title1" accessibilityRole="header">
                Your car
              </Text>
              <Text variant="body" color="secondary">
                So riders know which car to look for. You can change these later.
              </Text>
            </View>
            <CarDetailsForm value={car} onChange={setCar} />
          </>
        )}
        <SignOutLink />
      </ScrollView>

      {/* The one primary action, pinned above the keyboard. */}
      {step === "car" || photo.photoUrl ? (
        <View style={styles.footer}>
          {step === "photo" ? (
            <Button label="Continue" onPress={goToCarStep} disabled={photo.isUploading} />
          ) : (
            <Button
              label="Submit for approval"
              onPress={() => void handleSubmit()}
              loading={saving}
            />
          )}
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  top: { paddingHorizontal: spacing.gutter, paddingTop: spacing[2], gap: spacing[3] },
  backSpace: { height: 44 },
  progress: { flexDirection: "row", gap: spacing[2] },
  bar: { flex: 1, height: 4, borderRadius: radii.full, backgroundColor: colors.surface3 },
  barDone: { backgroundColor: colors.green500 },
  body: {
    paddingHorizontal: spacing.gutter,
    paddingTop: spacing[5],
    paddingBottom: spacing[6],
    gap: spacing[6],
  },
  heading: { gap: spacing[2] },
  footer: {
    paddingHorizontal: spacing.gutter,
    paddingTop: spacing[3],
    paddingBottom: spacing[2],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    backgroundColor: colors.surface,
  },
});
