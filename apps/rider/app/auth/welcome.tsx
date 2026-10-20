import { WelcomeScreen } from "@rida/mobile-shared";

/** The rider app's front door: one button, "Continue with phone number". */
export default function Welcome() {
  return (
    <WelcomeScreen
      title="Rides around Legon in minutes"
      body="Shared trips from GH₵5. Pay your driver in cash."
    />
  );
}
