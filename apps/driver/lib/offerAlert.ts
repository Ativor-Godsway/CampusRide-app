import * as Haptics from "expo-haptics";
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from "expo-audio";

/**
 * A new ride offer: one buzz and a short two-note chime (assets/sounds/
 * offer.wav, 0.5 s). expo-audio and expo-haptics both work in Expo Go.
 *
 * Silent mode: on iPhone the chime follows the ring/silent switch
 * (playsInSilentMode false) — silent means buzz only. On Android it plays on
 * the media stream at media volume (Android has no app-level "silent
 * switch"; turning media volume down silences it). It mixes with the
 * driver's music or navigation voice rather than stopping it.
 *
 * Never throws: an offer must show even if sound or vibration fail.
 */
let player: AudioPlayer | null = null;
let modeSet = false;

export function alertNewOffer(): void {
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
  try {
    if (!modeSet) {
      modeSet = true;
      void setAudioModeAsync({
        playsInSilentMode: false,
        shouldPlayInBackground: false,
        interruptionMode: "mixWithOthers",
      }).catch(() => {});
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- bundled asset
    player ??= createAudioPlayer(require("../assets/sounds/offer.wav"));
    void player.seekTo(0);
    player.play();
  } catch {
    // No sound this time; the buzz and the card still happen.
  }
}

/** A lighter tap for the driver's own Accept / Decline. */
export function tapFeedback(): void {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
}
