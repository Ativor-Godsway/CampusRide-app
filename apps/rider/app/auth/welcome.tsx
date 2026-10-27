import { WelcomeScreen } from "@rida/mobile-shared";
import { formatCedis, getSharedFarePerRider } from "@rida/shared";

/** The rider app's front door: one button, "Continue with phone number". */
export default function Welcome() {
  return (
    <WelcomeScreen
      title="Rides around Legon in minutes"
      body={`Shared trips from ${formatCedis(getSharedFarePerRider(1))}. Pay your driver in cash.`}
    />
  );
}
