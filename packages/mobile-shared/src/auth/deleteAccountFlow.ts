import { Alert } from "react-native";

/**
 * Two-step confirmation for permanent account deletion, shared by the rider
 * and driver account screens so the wording and the number of taps match.
 *
 * Two prompts, not one: this is irreversible and sits in a list next to
 * ordinary settings rows, so a single mis-tap must not be able to close
 * someone's account. The first prompt explains what is kept and what is
 * lost; the second is the point of no return.
 *
 * `onError` receives anything the server refuses with — most importantly the
 * 409 raised while a ride is still in flight — so the caller can show the
 * real reason rather than a generic failure.
 */
export function confirmDeleteAccount(options: {
  deleteAccount: () => Promise<void>;
  onDeleted?: () => void;
  onError?: (error: unknown) => void;
}): void {
  const { deleteAccount, onDeleted, onError } = options;

  Alert.alert(
    "Delete account",
    "This permanently closes your CampusRide account. Your name and phone number are removed and you'll be signed out on every device.\n\nCompleted trips are kept as records, but you won't be able to sign in with this number again.",
    [
      { text: "Cancel", style: "cancel" },
      {
        text: "Continue",
        style: "destructive",
        onPress: () => {
          Alert.alert("Are you sure?", "This can't be undone.", [
            { text: "Keep my account", style: "cancel" },
            {
              text: "Delete account",
              style: "destructive",
              onPress: () => {
                void (async () => {
                  try {
                    await deleteAccount();
                    onDeleted?.();
                  } catch (error) {
                    onError?.(error);
                  }
                })();
              },
            },
          ]);
        },
      },
    ],
  );
}

/**
 * Turns a failed deletion into a message worth showing. The server answers
 * 409 with an explanation when a ride is still in flight; anything else is
 * reported generically rather than leaking a raw error string into a dialog.
 */
export function describeDeleteAccountError(error: unknown): string {
  const status = (error as { response?: { status?: number; data?: { error?: string } } })?.response
    ?.status;
  const serverMessage = (error as { response?: { data?: { error?: string } } })?.response?.data
    ?.error;

  if (status === 409 && serverMessage) return serverMessage;
  return "We couldn't delete your account. Please check your connection and try again.";
}
