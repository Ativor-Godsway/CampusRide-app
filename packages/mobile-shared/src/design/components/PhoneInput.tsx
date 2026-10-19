import { StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { formatGhanaSubscriber, ghanaSubscriberDigits } from "@rida/shared";
import { colors, spacing } from "../tokens";
import { Input, type InputProps } from "./Input";
import { Text } from "./Text";

export interface PhoneInputProps extends Omit<
  InputProps,
  "value" | "onChangeText" | "prefix" | "keyboardType" | "maxLength"
> {
  /** The 9-digit subscriber number, without +233 or the local 0 ("548608146"). */
  digits: string;
  onChangeDigits: (digits: string) => void;
}

/**
 * A Ghana phone number: fixed flag + "+233", the rest shown as "54 860 8146"
 * while typing. A pasted "054…" or "+233…" is read with the shared parser
 * (@rida/shared ghanaSubscriberDigits), so `+233${digits}` is the number.
 */
export function PhoneInput({
  digits,
  onChangeDigits,
  label = "Phone number",
  placeholder = "54 123 4567",
  ...rest
}: PhoneInputProps) {
  return (
    <Input
      label={label}
      placeholder={placeholder}
      keyboardType="phone-pad"
      textContentType="telephoneNumber"
      autoComplete="tel"
      doneAccessory
      {...rest}
      value={formatGhanaSubscriber(digits)}
      onChangeText={(text) => onChangeDigits(ghanaSubscriberDigits(text))}
      prefix={<PhonePrefix />}
    />
  );
}

/** The Ghana flag (red, gold, green, black star) and +233, then a divider. */
function PhonePrefix() {
  return (
    <View style={styles.prefix} accessible={false} importantForAccessibility="no-hide-descendants">
      <View style={styles.flag}>
        <View style={[styles.stripe, { backgroundColor: GHANA.red }]} />
        <View style={[styles.stripe, { backgroundColor: GHANA.gold }]} />
        <View style={[styles.stripe, { backgroundColor: GHANA.green }]} />
        <View style={styles.star}>
          <Ionicons name="star" size={7} color={GHANA.star} />
        </View>
      </View>
      <Text variant="bodyStrong" style={styles.code}>
        +233
      </Text>
      <View style={styles.divider} />
    </View>
  );
}

/** The flag's own colours (not brand tokens). */
const GHANA = { red: "#CE1126", gold: "#FCD116", green: "#006B3F", star: "#000000" } as const;

const styles = StyleSheet.create({
  prefix: {
    flexDirection: "row",
    alignItems: "center",
    marginRight: spacing[3],
  },
  flag: {
    width: 22,
    height: 15,
    borderRadius: 2,
    overflow: "hidden",
  },
  stripe: {
    flex: 1,
  },
  star: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
  },
  code: {
    marginLeft: spacing[2],
    fontSize: 17,
  },
  divider: {
    width: 1,
    height: 24,
    backgroundColor: colors.lineStrong,
    marginLeft: spacing[3],
  },
});
