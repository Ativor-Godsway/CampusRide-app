import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { formatPlateInput } from "@rida/shared";
import { Chip, Input, Text, colors, haptics, radii, spacing } from "@rida/mobile-shared";

/** The makes most drivers on campus have, one tap each. */
const MAKES = ["Toyota", "Honda", "Hyundai", "Kia", "Nissan"] as const;

/** Colour swatches, with the dot each shows. "Other" opens a field. */
const COLOURS: { name: string; dot: string | null }[] = [
  { name: "White", dot: "#FFFFFF" },
  { name: "Silver", dot: "#C3C7CA" },
  { name: "Black", dot: "#16191A" },
  { name: "Grey", dot: "#7C8285" },
  { name: "Red", dot: "#C0392B" },
  { name: "Blue", dot: "#2C5FA8" },
  { name: "Green", dot: "#2E7D4F" },
  { name: "Other", dot: null },
];

export interface CarDetails {
  carMake: string;
  carModel: string;
  carColor: string;
  plate: string;
}

/**
 * The car, as riders will look for it: make (with the common ones as chips),
 * model, colour (swatches, or "Other" to type one) and the plate, put in
 * capitals and formatted like "GR 1234-24" as it's typed.
 */
export function CarDetailsForm({
  value,
  onChange,
}: {
  value: CarDetails;
  onChange: (next: CarDetails) => void;
}) {
  const knownColour = COLOURS.some(
    (c) => c.dot && c.name.toLowerCase() === value.carColor.trim().toLowerCase(),
  );
  const [otherColour, setOtherColour] = useState(Boolean(value.carColor.trim()) && !knownColour);
  const set = (patch: Partial<CarDetails>) => onChange({ ...value, ...patch });

  return (
    <View style={styles.form}>
      <View style={styles.field}>
        <Input
          label="Make"
          placeholder="e.g. Toyota"
          value={value.carMake}
          onChangeText={(carMake) => set({ carMake })}
          autoCapitalize="words"
          returnKeyType="next"
        />
        <View style={styles.chips} accessibilityLabel="Common makes">
          {MAKES.map((make) => (
            <Chip
              key={make}
              kind="choice"
              label={make}
              selected={value.carMake.trim().toLowerCase() === make.toLowerCase()}
              onPress={() => set({ carMake: make })}
            />
          ))}
        </View>
      </View>

      <Input
        label="Model"
        placeholder="e.g. Corolla"
        value={value.carModel}
        onChangeText={(carModel) => set({ carModel })}
        autoCapitalize="words"
        returnKeyType="next"
      />

      <View style={styles.field}>
        <Text variant="subhead" color="secondary" style={styles.label}>
          Colour
        </Text>
        <View style={styles.chips} accessibilityRole="radiogroup" accessibilityLabel="Colour">
          {COLOURS.map((c) => {
            const selected = c.dot
              ? !otherColour && value.carColor.trim().toLowerCase() === c.name.toLowerCase()
              : otherColour;
            return (
              <Pressable
                key={c.name}
                onPress={() => {
                  haptics.selection();
                  if (c.dot) {
                    setOtherColour(false);
                    set({ carColor: c.name });
                  } else {
                    setOtherColour(true);
                    if (knownColour) set({ carColor: "" });
                  }
                }}
                hitSlop={6}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected }}
                accessibilityLabel={c.name}
                style={[styles.swatch, selected && styles.swatchSelected]}
              >
                {c.dot ? <View style={[styles.dot, { backgroundColor: c.dot }]} /> : null}
                <Text
                  variant="subhead"
                  style={selected ? styles.swatchTextSelected : styles.swatchText}
                >
                  {c.name}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {otherColour ? (
          <Input
            label="Which colour?"
            placeholder="e.g. Gold"
            value={value.carColor}
            onChangeText={(carColor) => set({ carColor })}
            autoCapitalize="words"
            autoFocus
          />
        ) : null}
      </View>

      <Input
        label="Licence plate"
        placeholder="GR 1234-24"
        value={value.plate}
        onChangeText={(plate) => set({ plate: formatPlateInput(plate) })}
        autoCapitalize="characters"
        autoCorrect={false}
        returnKeyType="done"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: spacing[5] },
  field: { gap: spacing[2] },
  label: { fontWeight: "600" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing[2] },
  swatch: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[2],
    minHeight: 36,
    paddingHorizontal: spacing[3],
    borderRadius: radii.full,
    borderWidth: 1.5,
    borderColor: colors.surface2,
    backgroundColor: colors.surface2,
  },
  swatchSelected: { borderColor: colors.green500, backgroundColor: colors.green50 },
  swatchText: { color: colors.ink, fontWeight: "600" },
  swatchTextSelected: { color: colors.green700, fontWeight: "700" },
  dot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.ink4,
  },
});
