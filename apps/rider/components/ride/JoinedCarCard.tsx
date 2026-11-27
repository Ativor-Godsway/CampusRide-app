import { StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { carWords, firstName, joinedCarText } from "@rida/shared";
import { FadeIn, IconButton, Text, colors, radii, shadows, spacing } from "@rida/mobile-shared";

/**
 * The rider joined a car already on its way (fill moving cars first): no
 * search, straight to "You've joined Kofi's car, already on the way. Pickup
 * in about 4 min", with the car to look out for.
 */
export function JoinedCarCard({
  driver,
  pickupEtaMinutes,
  top,
  onClose,
}: {
  driver: { name: string; carColor: string | null; carMake: string | null; carModel: string | null; plate: string | null };
  pickupEtaMinutes: number;
  top: number;
  onClose: () => void;
}) {
  const car = carWords({ color: driver.carColor, make: driver.carMake, model: driver.carModel });
  const line = joinedCarText(firstName(driver.name), pickupEtaMinutes);
  return (
    <FadeIn style={[styles.wrap, { top }]}>
      <View style={styles.card} accessibilityRole="alert" accessibilityLiveRegion="polite" testID="joined-car">
        <View style={styles.icon}>
          <Ionicons name="car" size={20} color={colors.onBrand} />
        </View>
        <View style={styles.text}>
          <Text variant="bodyStrong">{line}</Text>
          {car || driver.plate ? (
            <Text variant="subhead" color="secondary">
              {[car ? car.replace(/^an? /, "").replace(/^./, (c) => c.toUpperCase()) : null, driver.plate].filter(Boolean).join(" · ")}
            </Text>
          ) : null}
        </View>
        <IconButton icon="close" variant="compact" accessibilityLabel="Close" onPress={onClose} />
      </View>
    </FadeIn>
  );
}

const styles = StyleSheet.create({
  wrap: { position: "absolute", left: spacing[3], right: spacing[3], zIndex: 20 },
  card: { flexDirection: "row", alignItems: "center", gap: spacing[3], padding: spacing[4], borderRadius: radii.lg, backgroundColor: colors.surface, ...shadows.float },
  icon: { width: 40, height: 40, borderRadius: radii.full, backgroundColor: colors.green500, alignItems: "center", justifyContent: "center" },
  text: { flex: 1, gap: 2 },
});
