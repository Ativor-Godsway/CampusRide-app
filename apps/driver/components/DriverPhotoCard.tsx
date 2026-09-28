import { ActivityIndicator, Image, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  Button,
  Card,
  ProgressBar,
  Text,
  colors,
  describeDriverPhotoError,
  radii,
  spacing,
} from "@rida/mobile-shared";
import type { DriverPhotoState, PhotoSource } from "../lib/useDriverPhotoUpload";

const AVATAR = 148;

export interface DriverPhotoCardProps {
  state: DriverPhotoState;
  canRetry: boolean;
  onPick: (source: PhotoSource) => void;
  onRetry: () => void;
}

/**
 * The onboarding photo step: a large preview, a live progress bar while the
 * photo uploads, and a clear error with "Try again" when it doesn't.
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
    <Card style={styles.card}>
      <View style={styles.avatarWrap}>
        {previewUri ? (
          <Image
            source={{ uri: previewUri }}
            style={styles.avatar}
            accessibilityLabel="Your photo"
          />
        ) : (
          <View style={[styles.avatar, styles.placeholder]}>
            <Ionicons name="person" size={64} color={colors.primary[300]} />
          </View>
        )}

        {uploading && (
          <View style={styles.overlay}>
            <ActivityIndicator color={colors.white} />
            {percent !== null && (
              <Text variant="bodyMedium" color="inverse">
                {percent}%
              </Text>
            )}
          </View>
        )}

        {state.status === "done" && (
          <View style={[styles.statusBadge, styles.successBadge]}>
            <Ionicons name="checkmark" size={18} color={colors.white} />
          </View>
        )}
        {state.status === "error" && (
          <View style={[styles.statusBadge, styles.errorBadge]}>
            <Ionicons name="alert" size={18} color={colors.white} />
          </View>
        )}
      </View>

      {uploading && (
        <View style={styles.progress} accessibilityLiveRegion="polite">
          <ProgressBar progress={state.progress ?? 0.05} />
          <Text variant="bodySmall" color="muted" style={styles.centered}>
            {percent === null ? "Preparing your upload…" : `Uploading your photo… ${percent}%`}
          </Text>
        </View>
      )}

      {state.status === "done" && (
        <Text variant="bodySmall" color="success" style={styles.centered}>
          Photo uploaded
        </Text>
      )}

      {state.status === "error" && <PhotoErrorBox state={state} />}

      {state.status === "idle" && (
        <Text variant="bodySmall" color="muted" style={styles.centered}>
          Face the camera in good light — no sunglasses, hats or filters.
        </Text>
      )}

      <View style={styles.actions}>
        {state.status === "error" && canRetry && <Button label="Try again" onPress={onRetry} />}
        {state.status !== "done" ? (
          <>
            <Button
              label="Take a selfie"
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
        ) : (
          <View style={styles.row}>
            <View style={styles.rowItem}>
              <Button label="Retake" variant="secondary" onPress={() => onPick("camera")} />
            </View>
            <View style={styles.rowItem}>
              <Button
                label="Choose another"
                variant="secondary"
                onPress={() => onPick("library")}
              />
            </View>
          </View>
        )}
      </View>
    </Card>
  );
}

function PhotoErrorBox({ state }: { state: Extract<DriverPhotoState, { status: "error" }> }) {
  const { title, message } = describeDriverPhotoError(state.error);
  return (
    <View style={styles.errorBox} accessibilityRole="alert">
      <Text variant="bodyMedium" color="error">
        {title}
      </Text>
      <Text variant="bodySmall">{message}</Text>
      {/* The raw cause, for whoever is testing a development build. */}
      {__DEV__ && state.error.detail ? (
        <Text variant="caption" color="muted">
          Details: {state.error.detail}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: spacing.lg, alignItems: "stretch" },
  avatarWrap: { alignSelf: "center", width: AVATAR, height: AVATAR },
  avatar: { width: AVATAR, height: AVATAR, borderRadius: radii.full },
  placeholder: {
    backgroundColor: colors.primary[50],
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderStyle: "dashed",
    borderColor: colors.primary[200],
  },
  overlay: {
    ...StyleSheet.absoluteFill,
    borderRadius: radii.full,
    backgroundColor: "rgba(8, 40, 19, 0.55)",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
  },
  statusBadge: {
    position: "absolute",
    right: 4,
    bottom: 4,
    width: 32,
    height: 32,
    borderRadius: radii.full,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 3,
    borderColor: colors.white,
  },
  successBadge: { backgroundColor: colors.success },
  errorBadge: { backgroundColor: colors.error },
  progress: { gap: spacing.sm },
  centered: { textAlign: "center" },
  errorBox: {
    backgroundColor: colors.errorSurface,
    borderRadius: radii.lg,
    padding: spacing.md,
    gap: spacing.xs,
  },
  actions: { gap: spacing.sm },
  row: { flexDirection: "row", gap: spacing.md },
  rowItem: { flex: 1 },
});
