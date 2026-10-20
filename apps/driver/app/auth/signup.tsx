import { SignupScreen } from "@rida/mobile-shared";

/** A new number's one step: name and the 18+ tick, then onboarding (photo and car). */
export default function DriverSignupScreen() {
  return (
    <SignupScreen
      role="DRIVER"
      subtitle="Next: your photo and car details, then our team approves you to drive."
    />
  );
}
