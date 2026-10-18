import { Button, EmptyState, LoadingState, Screen } from "../../design";
import { useAuth } from "../AuthContext";

/**
 * What a screen shows while the app works out whether this phone is signed
 * in (useAuth().isLoading). Normally a moment's spinner; if the server can't
 * be reached it says so and keeps trying — the person stays signed in, and
 * is never shown the sign-in screen for a connection problem.
 */
export function SessionRestoringScreen() {
  const { sessionProblem, retrySession } = useAuth();
  return (
    <Screen>
      {sessionProblem === "unreachable" ? (
        <EmptyState
          title="Can't reach CampusRide"
          message="Check your internet connection. You're still signed in — we'll keep trying."
          action={<Button label="Try again" variant="secondary" onPress={retrySession} />}
        />
      ) : (
        <LoadingState />
      )}
    </Screen>
  );
}
