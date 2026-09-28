import { PhoneScreen } from "@rida/mobile-shared";

/** The driver app's front door — worded and badged so it can't be mistaken for the rider app. */
export default function DriverPhoneScreen() {
  return (
    <PhoneScreen
      badge="DRIVER"
      title="Drive with CampusRide"
      subtitle="Log in to start accepting rides — or sign up to become a campus driver."
      signupLabel="Sign up to drive"
    />
  );
}
