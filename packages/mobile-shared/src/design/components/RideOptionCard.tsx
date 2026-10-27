import {
  Animated,
  Image,
  Pressable,
  StyleSheet,
  View,
  type ImageSourcePropType,
  type PressableProps,
} from "react-native";
import { haptics } from "../haptics";
import { colors, radii, spacing } from "../tokens";
import { StatusChip, type StatusTone } from "./Chip";
import { usePressScale } from "./Motion";
import { Text } from "./Text";

export interface RideOptionCardProps extends Omit<PressableProps, "style" | "children"> {
  /** The car render (illustrations.carShared / carStandard), drawn 96×72. */
  image: ImageSourcePropType;
  /** "Shared", "Ride alone". */
  title: string;
  /** "3 min · up to 4 riders". */
  subtitle?: string;
  /** "GH₵7". */
  price: string;
  selected?: boolean;
  /** Optional status chip beside the title, e.g. "Best value". */
  badge?: string;
  badgeTone?: StatusTone;
}

/**
 * docs/design-system.md, "Card" › Ride option: car left, name + optional
 * chip, subtitle, price right. Selected: green-50 fill, 2px green-500
 * border, price in green-700. Unselected: no fill, no border.
 */
export function RideOptionCard({
  image,
  title,
  subtitle,
  price,
  selected = false,
  badge,
  badgeTone = "brand",
  onPress,
  onPressIn,
  onPressOut,
  ...rest
}: RideOptionCardProps) {
  const { scale, pressIn, pressOut } = usePressScale();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={[title, badge, subtitle, price].filter(Boolean).join(", ")}
      onPress={(e) => {
        if (!selected) haptics.selection();
        onPress?.(e);
      }}
      onPressIn={(e) => {
        pressIn();
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        pressOut();
        onPressOut?.(e);
      }}
      {...rest}
    >
      <Animated.View style={[styles.card, selected && styles.selected, { transform: [{ scale }] }]}>
        <Image source={image} style={styles.image} resizeMode="contain" />
        <View style={styles.body}>
          <View style={styles.titleRow}>
            <Text variant="title3" numberOfLines={1} style={styles.title}>
              {title}
            </Text>
            {badge ? (
              <StatusChip
                label={badge}
                tone={badgeTone}
                // On the selected card's green-50 fill, a green-50 chip would vanish.
                style={selected ? styles.badgeOnSelected : undefined}
              />
            ) : null}
          </View>
          {subtitle ? (
            <Text variant="subhead" color="secondary" numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        <Text
          variant="plate"
          tabular
          style={[styles.price, selected && styles.priceSelected]}
          numberOfLines={1}
        >
          {price}
        </Text>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[3],
    padding: spacing[3],
    borderRadius: radii.lg,
    // Always 2px, transparent when unselected, so selecting doesn't shift it.
    borderWidth: 2,
    borderColor: "transparent",
  },
  selected: {
    backgroundColor: colors.green50,
    borderColor: colors.green500,
  },
  image: {
    width: 96,
    height: 72,
  },
  body: {
    flex: 1,
    gap: 2,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[2],
  },
  title: {
    flexShrink: 1,
  },
  // 20/800, the spec's ride-option price; tracking off (plate's is for plates).
  price: {
    letterSpacing: 0,
    color: colors.ink,
  },
  priceSelected: {
    color: colors.green700,
  },
  badgeOnSelected: {
    backgroundColor: colors.surface,
  },
});
