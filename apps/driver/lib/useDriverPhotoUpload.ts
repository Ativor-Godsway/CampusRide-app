import { useCallback, useRef, useState } from "react";
import * as ImagePicker from "expo-image-picker";
import { DriverPhotoError, uploadDriverPhoto, type PickedPhoto } from "@rida/mobile-shared";

export type PhotoSource = "camera" | "library";

export type DriverPhotoState =
  | { status: "idle" }
  /** `progress` is 0–1, or null while the upload is being prepared. */
  | { status: "uploading"; localUri: string; progress: number | null }
  | { status: "done"; url: string; localUri: string | null }
  | { status: "error"; error: DriverPhotoError; localUri: string | null };

/** `null` means the driver cancelled the picker; nothing changed. */
export type DriverPhotoResult = { url: string } | { error: DriverPhotoError } | null;

/**
 * Pick-and-upload flow for the driver's profile photo, used by BOTH the
 * onboarding photo step and the Account screen. The upload itself is
 * `uploadDriverPhoto` in @rida/mobile-shared; this hook adds the picker,
 * permissions, progress and retry state around it.
 */
export function useDriverPhotoUpload(initialUrl: string | null) {
  const [state, setState] = useState<DriverPhotoState>(
    initialUrl ? { status: "done", url: initialUrl, localUri: null } : { status: "idle" },
  );
  // The last photo picked, so "Try again" re-sends it without re-picking.
  const lastPicked = useRef<PickedPhoto | null>(null);

  const upload = useCallback(async (photo: PickedPhoto): Promise<DriverPhotoResult> => {
    setState({ status: "uploading", localUri: photo.uri, progress: null });
    try {
      const url = await uploadDriverPhoto(photo, {
        onProgress: (progress) =>
          setState((s) => (s.status === "uploading" ? { ...s, progress } : s)),
      });
      setState({ status: "done", url, localUri: photo.uri });
      return { url };
    } catch (e) {
      const error =
        e instanceof DriverPhotoError
          ? e
          : new DriverPhotoError("upload_failed", {
              detail: e instanceof Error ? e.message : String(e),
            });
      setState({ status: "error", error, localUri: photo.uri });
      return { error };
    }
  }, []);

  const pick = useCallback(
    async (source: PhotoSource): Promise<DriverPhotoResult> => {
      const permission =
        source === "camera"
          ? await ImagePicker.requestCameraPermissionsAsync()
          : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        const error = new DriverPhotoError("permission_denied");
        setState((s) => ({
          status: "error",
          error,
          localUri: "localUri" in s ? s.localUri : null,
        }));
        return { error };
      }

      const options: ImagePicker.ImagePickerOptions = {
        mediaTypes: ["images"],
        allowsEditing: true,
        aspect: [1, 1],
        // < 1 also makes iOS hand back a JPEG rather than a HEIC original.
        quality: 0.7,
      };
      let result: ImagePicker.ImagePickerResult;
      try {
        result =
          source === "camera"
            ? await ImagePicker.launchCameraAsync({
                ...options,
                cameraType: ImagePicker.CameraType.front,
              })
            : await ImagePicker.launchImageLibraryAsync(options);
      } catch (e) {
        const error = new DriverPhotoError("upload_failed", {
          detail: `Couldn't open the ${source === "camera" ? "camera" : "photo library"}: ${e instanceof Error ? e.message : String(e)}`,
        });
        setState({ status: "error", error, localUri: null });
        return { error };
      }
      const asset = result.canceled ? undefined : result.assets?.[0];
      if (!asset) return null;

      const photo: PickedPhoto = {
        uri: asset.uri,
        fileSize: asset.fileSize ?? undefined,
        mimeType: asset.mimeType ?? undefined,
      };
      lastPicked.current = photo;
      return upload(photo);
    },
    [upload],
  );

  const retry = useCallback(
    async (): Promise<DriverPhotoResult> =>
      lastPicked.current ? upload(lastPicked.current) : null,
    [upload],
  );

  /** Resets to a saved URL (or none) — e.g. when an edit is cancelled. */
  const reset = useCallback((url: string | null) => {
    lastPicked.current = null;
    setState(url ? { status: "done", url, localUri: null } : { status: "idle" });
  }, []);

  return {
    state,
    photoUrl: state.status === "done" ? state.url : null,
    isUploading: state.status === "uploading",
    /** True when "Try again" has a photo to re-send. */
    canRetry:
      state.status === "error" &&
      state.error.kind !== "permission_denied" &&
      state.localUri !== null &&
      lastPicked.current !== null,
    pick,
    retry,
    reset,
  };
}
