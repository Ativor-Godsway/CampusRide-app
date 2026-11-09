import { Modal, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Button, Text, colors, formatCedis, radii, shadows, spacing } from "@rida/mobile-shared";
import type { CommissionBlock } from "../../lib/presence";

/**
 * "Go online" was refused: the driver owes CampusRide the commission limit
 * or more (enforcement on, admin site). Says how much, with Pay now. Only
 * ever shown when going online: never during a trip, never taking a driver
 * offline.
 */
export function CommissionBlockModal({ block, onPay, onClose }: { block: CommissionBlock | null; onPay: () => void; onClose: () => void }) {
  return (
    <Modal visible={block !== null} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.scrim}>
        <View style={styles.card} accessibilityViewIsModal accessibilityRole="alert">
          <View style={styles.icon}>
            <Ionicons name="wallet-outline" size={28} color={colors.red600} />
          </View>
          <Text variant="title2" accessibilityRole="header" style={styles.centered}>
            Pay to go online
          </Text>
          {block ? (
            <>
              <Text variant="display" tabular style={styles.centered} accessibilityLabel={`You owe ${formatCedis(block.owedPesewas)}`}>
                {formatCedis(block.owedPesewas)}
              </Text>
              <Text variant="body" color="secondary" style={styles.centered}>
                {block.message}
                {block.limitPesewas > 0 ? ` Drivers can owe up to ${formatCedis(block.limitPesewas)}.` : ""}
              </Text>
            </>
          ) : null}
          <Button label="Pay now" icon="phone-portrait-outline" onPress={onPay} fullWidth />
          <Button label="Not now" variant="text" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: colors.scrim, justifyContent: "center", padding: spacing.gutter },
  card: { backgroundColor: colors.surface, borderRadius: radii.xl, padding: spacing[6], gap: spacing[3], alignItems: "stretch", ...shadows.float },
  icon: { alignSelf: "center", width: 56, height: 56, borderRadius: radii.full, backgroundColor: colors.red50, alignItems: "center", justifyContent: "center" },
  centered: { textAlign: "center" },
});
