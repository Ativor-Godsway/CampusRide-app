import { WelcomeScreen } from "@rida/mobile-shared";

/** The driver app's front door, badged DRIVER so it can't be mistaken for the rider app. */
export default function Welcome() {
  return (
    <WelcomeScreen
      badge="DRIVER"
      title="Drive with CampusRide"
      body="Get ride requests around campus and keep 85% of every fare."
    />
  );
}
