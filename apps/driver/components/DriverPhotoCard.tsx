import { ActivityIndicator, Image, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  Button,
  Notice,
  ProgressBar,
  Text,
  colors,
  describeDriverPhotoError,
  radii,
  spacing,
} from "@rida/mobile-shared";
import type { DriverPhotoState, PhotoSource } from "../lib/useDriverPhotoUpload";

const AVATAR = 168;

export interface DriverPhotoCardProps {
  state: DriverPhotoState;
  canRetry: boolean;
  onPick: (source: PhotoSource) => void;
  onRetry: () => void;
}

/**
 * The onboarding photo step: a large circle — the guidance inside it until
 * there's a photo — then "Take a selfie" (primary) and "Choose from
 * gallery". While it uploads, a progress bar; once it's up, the photo with
 * "Retake" as a text button (the screen's Continue moves on). A clear error
 * with "Try again" when it doesn't upload.
 */
export function DriverPhotoCard({ state, canRetry, onPick, onRetry }: DriverPhotoCardProps) {
  const previewUri =
    state.status === "done"
      ? (state.localUri ?? state.url)
      : state.status === "uploading" || state.status === "error"
        ? state.localUri
        : null;
  const uploading = state.status === "uploading";
  const percent = uploading && state.progress !== null ? Math.round(state.progress * 100) : null;

  return (
    <View style={styles.wrap}>
      <View style={styles.avatarWrap}>
        {previewUri ? (
          <Image
            source={{ uri: previewUri }}
            style={styles.avatar}
            accessibilityLabel="Your photo"
          />
        ) : (
          <View style={[styles.avatar, styles.placeholder]}>
            <Ionicons name="happy-outline" size={44} color={colors.green500} />
            <Text variant="subhead" color="secondary" style={styles.guide}>
              Face the camera in good light. No sunglasses, hat or filter.
            </Text>
          </View>
        )}

        {uploading ? (
          <View style={styles.overlay}>
            <ActivityIndicator color={colors.onBrand} />
            {percent !== null ? (
              <Text variant="bodyStrong" color="onDark">
                {percent}%
              </Text>
            ) : null}
          </View>
        ) : null}

        {state.status === "done" ? (
          <View style={[styles.statusBadge, styles.successBadge]}>
            <Ionicons name="checkmark" size={18} color={colors.onBrand} />
          </View>
        ) : null}
      </View>

      {uploading ? (
        <View style={styles.progress} accessibilityLiveRegion="polite">
          <ProgressBar progress={state.progress ?? 0.05} height={4} color={colors.green500} />
          <Text variant="subhead" color="secondary" style={styles.centered}>
            {percent === null ? "Preparing your upload…" : `Uploading your photo… ${percent}%`}
          </Text>
        </View>
      ) : null}

      {state.status === "error" ? <PhotoError state={state} /> : null}

      <View style={styles.actions}>
        {state.status === "done" ? (
          <Button
            label="Retake"
            variant="text"
            icon="camera-outline"
            onPress={() => onPick("camera")}
          />
        ) : (
          <>
            {state.status === "error" && canRetry ? (
              <Button label="Try again" onPress={onRetry} />
            ) : null}
            <Button
              label="Take a selfie"
              icon="camera-outline"
              variant={state.status === "error" && canRetry ? "secondary" : "primary"}
              onPress={() => onPick("camera")}
              disabled={uploading}
            />
            <Button
              label="Choose from gallery"
              variant="secondary"
              onPress={() => onPick("library")}
              disabled={uploading}
            />
          </>
        )}
      </View>
    </View>
  );
}

function PhotoError({ state }: { state: Extract<DriverPhotoState, { status: "error" }> }) {
  const { title, message } = describeDriverPhotoError(state.error);
  return (
    <View style={styles.error}>
      <Notice tone="error" icon="alert-circle-outline" message={`${title}. ${message}`} />
      {/* The raw cause, for whoever is testing a development build. */}
      {__DEV__ && state.error.detail ? (
        <Text variant="caption" color="tertiary">
          Details: {state.error.detail}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing[5] },
  avatarWrap: { alignSelf: "center", width: AVATAR, height: AVATAR },
  avatar: { width: AVATAR, height: AVATAR, borderRadius: radii.full },
  placeholder: {
    backgroundColor: colors.green50,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing[2],
    paddingHorizontal: spacing[5],
  },
  guide: { textAlign: "center" },
  overlay: {
    ...StyleSheet.absoluteFill,
    borderRadius: radii.full,
    backgroundColor: colors.scrim,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing[1],
  },
  statusBadge: {
    position: "absolute",
    right: 8,
    bottom: 8,
    width: 32,
    height: 32,
    borderRadius: radii.full,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 3,
    borderColor: colors.surface,
  },
  successBadge: { backgroundColor: colors.green500 },
  progress: { gap: spacing[2] },
  centered: { textAlign: "center" },
  error: { gap: spacing[1] },
  actions: { gap: spacing[2] },
});
