import { useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { BottomSheet } from "./components/BottomSheet";
import { Button } from "./components/Button";
import { Card } from "./components/Card";
import { Chip, StatusChip } from "./components/Chip";
import { IconButton } from "./components/IconButton";
import { Input } from "./components/Input";
import { Illustration } from "./components/Illustration";
import { ListRow } from "./components/ListRow";
import { OtpInput } from "./components/OtpInput";
import { PhoneInput } from "./components/PhoneInput";
import { PulseRings } from "./components/PulseRings";
import { RideOptionCard } from "./components/RideOptionCard";
import { Screen } from "./components/Screen";
import { SlideToConfirm } from "./components/SlideToConfirm";
import { Text, type TextVariant } from "./components/Text";
import { Notice, useToast } from "./components/Toast";
import { illustrations } from "./illustrations";
import { colors, radii, shadows, spacing, textStyles, type TextStyleName } from "./tokens";

/**
 * Dev-only: every design-system component and text style on one screen, to
 * screenshot and compare with docs/design-system.md. Each app's
 * app/dev/design-gallery.tsx shows it in __DEV__ only.
 */
export function DesignGalleryScreen() {
  const router = useRouter();
  const { showToast, toast } = useToast();
  const [filter, setFilter] = useState("All");
  const [choices, setChoices] = useState<string[]>(["Driver was late"]);
  const [ride, setRide] = useState<"shared" | "alone">("shared");
  const [digits, setDigits] = useState("548608146");
  const [name, setName] = useState("");
  const [code, setCode] = useState("4166");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [slides, setSlides] = useState(0);

  return (
    <View style={styles.root}>
      <Screen scroll edges={["top"]} style={styles.content}>
        <View style={styles.header}>
          <IconButton
            variant="map"
            icon="arrow-back"
            accessibilityLabel="Back"
            onPress={() => router.back()}
          />
          <Text variant="title2">Design gallery</Text>
        </View>
        <Text variant="subhead" color="secondary">
          docs/design-system.md, built from tokens.ts. Dev builds only.
        </Text>

        <Section title="Colour">
          <View style={styles.swatches}>
            {SWATCHES.map((name) => (
              <View key={name} style={styles.swatch}>
                <View style={[styles.swatchColor, { backgroundColor: colors[name] }]} />
                <Text variant="caption">{name}</Text>
                <Text variant="caption" color="tertiary">
                  {colors[name]}
                </Text>
              </View>
            ))}
          </View>
        </Section>

        <Section title="Type">
          {TYPE_SAMPLES.map(([variant, sample]) => (
            <View key={variant} style={styles.typeRow}>
              <Text variant="caption" color="tertiary">
                {variant} · {textStyles[variant].fontSize}/{textStyles[variant].lineHeight}
              </Text>
              <Text variant={variant as TextVariant} tabular={variant === "display"}>
                {sample}
              </Text>
            </View>
          ))}
          <View style={styles.plateFrame}>
            <Text variant="plate">GR 1234-24</Text>
          </View>
          <Text variant="subhead" color="secondary">
            Tabular: <Text tabular>GH₵11.11 · GH₵88.88</Text> · proportional: GH₵11.11 · GH₵88.88
          </Text>
        </Section>

        <Section title="Button">
          <Button label="Request Shared" />
          <Button label="Switch to Ride alone" variant="secondary" />
          <Button label="Edit profile" variant="neutral" />
          <Button label="Resend code" variant="text" />
          <Button label="Cancel ride" variant="danger" />
          <Button label="Continue" disabled />
          <Text variant="subhead" color="tertiary">
            Tick the box to continue
          </Text>
          <Button label="Request Shared" loading />
          <Button label="Pay in cash" icon="cash-outline" size="md" />
          <View style={styles.wrapRow}>
            <Button label="Add stop" size="pill" variant="neutral" icon="add" />
            <Button label="Share" size="pill" variant="secondary" icon="share-outline" />
          </View>
          <View style={styles.wrapRow}>
            <Button label="Go online" size="go" icon="power" />
            <Button label="Go offline" size="go" variant="neutral" icon="power" />
          </View>
        </Section>

        <Section title="IconButton">
          <View style={styles.spreadRow}>
            <IconButton
              icon="navigate-outline"
              label="Navigate"
              variant="brand"
              accessibilityLabel="Navigate"
            />
            <IconButton icon="call-outline" label="Call" accessibilityLabel="Call Kwame" />
            <IconButton icon="chatbox-outline" label="Message" accessibilityLabel="Message Kwame" />
            <IconButton icon="share-outline" label="Share trip" accessibilityLabel="Share trip" />
            <IconButton
              icon="shield-checkmark-outline"
              label="Safety"
              accessibilityLabel="Safety"
            />
          </View>
          <View style={[styles.mapLand, styles.wrapRow]}>
            <IconButton variant="map" icon="arrow-back" accessibilityLabel="Back" />
            <IconButton variant="map" icon="locate" accessibilityLabel="Recentre the map" />
          </View>
        </Section>

        <Section title="Input">
          <Input
            label="Full name"
            placeholder="Ama Mensah"
            value={name}
            onChangeText={setName}
            helper="As on your student ID."
          />
          <Input
            label="Code"
            value="12345"
            error="That code didn't match. Check the SMS and try again."
            onChangeText={() => undefined}
          />
          <PhoneInput
            digits={digits}
            onChangeDigits={setDigits}
            helper="You can paste 054… or +233… too."
          />
        </Section>

        <Section title="Chip">
          <View style={styles.wrapRow}>
            {["All", "Shared", "Private"].map((label) => (
              <Chip
                key={label}
                label={label}
                selected={filter === label}
                onPress={() => setFilter(label)}
              />
            ))}
          </View>
          <View style={styles.wrapRow}>
            {["Driver was late", "Wrong pickup", "Changed my plans"].map((label) => (
              <Chip
                key={label}
                kind="choice"
                label={label}
                selected={choices.includes(label)}
                onPress={() =>
                  setChoices((c) =>
                    c.includes(label) ? c.filter((x) => x !== label) : [...c, label],
                  )
                }
              />
            ))}
          </View>
          <View style={styles.wrapRow}>
            <Chip kind="place" label="Main Gate" />
            <Chip kind="place" label="Balme Library" />
          </View>
          <View style={styles.wrapRow}>
            <StatusChip label="Best value" tone="brand" />
            <StatusChip label="Shared · 1 seat" tone="neutral" />
            <StatusChip label="Waiting" tone="warn" />
            <StatusChip label="Cancelled" tone="danger" />
            <StatusChip label="DRIVER" tone="amber" />
          </View>
        </Section>

        <Section title="ListRow">
          <View>
            <ListRow
              title="Balme Library"
              subtitle="University of Ghana"
              leading={<ListRow.Icon name="time-outline" />}
              onPress={() => undefined}
            />
            <ListRow
              divider
              title="Emergency contact"
              subtitle="Not set up yet"
              leading={<ListRow.Icon name="shield-checkmark-outline" tone="brand" />}
              onPress={() => undefined}
            />
            <ListRow
              divider
              title="Cash trips"
              trailing={
                <Text variant="bodyStrong" tabular>
                  GH₵17.50
                </Text>
              }
              leading={<ListRow.Icon name="cash-outline" />}
            />
            <ListRow
              divider
              tone="danger"
              title="Delete account"
              leading={<ListRow.Icon name="trash-outline" tone="danger" />}
              onPress={() => undefined}
              showChevron={false}
            />
          </View>
        </Section>

        <Section title="Card">
          <Card variant="filled">
            <Text variant="title3">Filled card</Text>
            <Text variant="subhead" color="secondary">
              surface-2 on a white page, radius 20.
            </Text>
          </Card>
          <View style={styles.mapLand}>
            <Card variant="float">
              <Text variant="title3">Float card</Text>
              <Text variant="subhead" color="secondary">
                White with shadow-float, only on the map.
              </Text>
            </Card>
          </View>
          <Card variant="dark" style={styles.darkCard}>
            <Text variant="eyebrow" color="greenOnDark">
              Cash collected
            </Text>
            <Text variant="display" color="onDark" tabular>
              GH₵15
            </Text>
            <View style={styles.kv}>
              <Text variant="subhead" color="onDark2">
                Trip fare
              </Text>
              <Text variant="subhead" color="onDark" tabular>
                GH₵15.00
              </Text>
            </View>
          </Card>
          <RideOptionCard
            image={illustrations.carShared}
            title="Shared"
            badge="Best value"
            subtitle="3 min · up to 4 riders"
            price="GH₵5"
            selected={ride === "shared"}
            onPress={() => setRide("shared")}
          />
          <RideOptionCard
            image={illustrations.carStandard}
            title="Ride alone"
            subtitle="3 min · just you"
            price="GH₵15"
            selected={ride === "alone"}
            onPress={() => setRide("alone")}
          />
        </Section>

        <Section title="Toast and Notice">
          <Button
            label="Show a toast"
            variant="neutral"
            onPress={() =>
              showToast({ message: "Kwame is in the car", subtitle: "Heading to Maison Française" })
            }
          />
          <Button
            label="Show a warning toast"
            variant="neutral"
            onPress={() =>
              showToast({
                message: "No connection",
                tone: "warning",
                action: { label: "Retry", onPress: () => undefined },
              })
            }
          />
          <Notice message="This pickup is outside the CampusRide area. Move the pin onto campus." />
          <Notice
            tone="error"
            message="We couldn't send the code. Check your connection and try again."
          />
        </Section>

        <Section title="OtpInput">
          <Text variant="subhead" color="secondary">
            Typing (tap to edit; six digits check at once)
          </Text>
          <OtpInput value={code} onChange={setCode} autoFocus={false} />
          <Text variant="subhead" color="secondary">
            Wrong code
          </Text>
          <OtpInput
            value=""
            onChange={() => undefined}
            error="That code didn't match. Check the SMS and try again."
            autoFocus={false}
          />
          <Text variant="subhead" color="secondary">
            Verified
          </Text>
          <OtpInput value="416641" onChange={() => undefined} verified autoFocus={false} />
        </Section>

        <Section title="SlideToConfirm">
          <SlideToConfirm
            label="Slide when Kwame is in"
            doneLabel="Picked up"
            onConfirm={() => setSlides((n) => n + 1)}
          />
          <SlideToConfirm
            label="Cash collected from Ama"
            doneLabel="Cash collected"
            tone="dark"
            onConfirm={() => setSlides((n) => n + 1)}
          />
          <Text variant="caption" color="tertiary">
            Completed {slides} time{slides === 1 ? "" : "s"}. Slide, hold 600 ms, or use the screen
            reader&apos;s activate action.
          </Text>
        </Section>

        <Section title="PulseRings">
          <View style={[styles.mapLand, styles.pulse]}>
            <PulseRings size={180}>
              <Illustration name="pinPickup" size={56} />
            </PulseRings>
          </View>
        </Section>

        <Section title="BottomSheet">
          <Button label="Open a modal sheet" variant="neutral" onPress={() => setSheetOpen(true)} />
          <Text variant="caption" color="tertiary">
            Dims the screen; tap outside or pull down to close. Map sheets use the same component
            without `modal`.
          </Text>
        </Section>

        <Section title="Radius and shadow">
          <View style={[styles.mapLand, styles.wrapRow]}>
            {(["sm", "md", "lg", "xl", "full"] as const).map((r) => (
              <View key={r} style={[styles.radius, { borderRadius: radii[r] }]}>
                <Text variant="caption">{r}</Text>
              </View>
            ))}
          </View>
          <View style={[styles.mapLand, styles.wrapRow]}>
            <View style={[styles.radius, shadows.float]}>
              <Text variant="caption">float</Text>
            </View>
            <View style={[styles.radius, shadows.sheet]}>
              <Text variant="caption">sheet</Text>
            </View>
          </View>
        </Section>
      </Screen>
      <BottomSheet
        modal
        visible={sheetOpen}
        onDismiss={() => setSheetOpen(false)}
        accessibilityLabel="Example sheet"
        footer={<Button label="Done" onPress={() => setSheetOpen(false)} />}
      >
        <Text variant="eyebrow" color="secondary">
          Modal sheet
        </Text>
        <Text variant="title2">Cancel this ride?</Text>
        <Text variant="body" color="secondary">
          Handle, eyebrow, title, content, then one action pinned above the safe area.
        </Text>
      </BottomSheet>
      {toast}
    </View>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text variant="eyebrow" color="secondary">
        {title}
      </Text>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

const SWATCHES = [
  "surface",
  "surface2",
  "surface3",
  "line",
  "lineStrong",
  "ink",
  "ink2",
  "ink3",
  "ink4",
  "green50",
  "green100",
  "green500",
  "green600",
  "green700",
  "greenOnDark",
  "amber400",
  "amber50",
  "amber700",
  "red600",
  "red50",
  "surfaceDark",
  "surfaceDark2",
  "onDark2",
  "mapLand",
] as const;

const TYPE_SAMPLES: [TextStyleName, string][] = [
  ["display", "3 min"],
  ["title1", "What's your number?"],
  ["title2", "Choose a ride"],
  ["title3", "Kwame"],
  ["body", "We'll text you a code. New here? We'll set up your account next."],
  ["bodyStrong", "Balme Library"],
  ["button", "Request Shared"],
  ["subhead", "3 min · up to 4 riders"],
  ["caption", "Arrives 6:38 PM"],
  ["eyebrow", "Driver on the way"],
];

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.surface,
  },
  content: {
    paddingBottom: spacing[10] * 2,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[3],
    marginBottom: spacing[2],
  },
  section: {
    marginTop: spacing[8],
    gap: spacing[3],
  },
  sectionBody: {
    gap: spacing[3],
  },
  swatches: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing[3],
  },
  swatch: {
    width: 96,
    gap: 2,
  },
  swatchColor: {
    height: 48,
    borderRadius: radii.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
  },
  typeRow: {
    gap: 2,
  },
  plateFrame: {
    alignSelf: "flex-start",
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.ink,
    borderRadius: radii.sm,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[1],
  },
  wrapRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: spacing[2],
  },
  spreadRow: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  mapLand: {
    backgroundColor: colors.mapLand,
    borderRadius: radii.lg,
    padding: spacing[4],
  },
  pulse: {
    alignItems: "center",
  },
  darkCard: {
    gap: spacing[1],
  },
  kv: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: spacing[2],
  },
  radius: {
    width: 64,
    height: 48,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.md,
  },
});
