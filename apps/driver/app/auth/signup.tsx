import { SignupScreen } from "@rida/mobile-shared";

export default function DriverSignupScreen() {
  return (
    <SignupScreen
      allowedRoles={["DRIVER"]}
      subtitle="Next: your photo and car details, then our team approves you to drive."
    />
  );
}
