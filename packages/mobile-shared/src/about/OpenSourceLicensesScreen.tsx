import { StyleSheet, View } from "react-native";
import { BackButton, ListRow, Screen, Text, spacing } from "../design";

/** What the apps are built with, and under which licence (checked against each package). */
const NOTICES: { name: string; licence: string; by: string }[] = [
  {
    name: "Figtree (typeface)",
    licence: "SIL Open Font License 1.1",
    by: "The Figtree Project Authors",
  },
  { name: "React", licence: "MIT", by: "Meta Platforms, Inc." },
  { name: "React Native", licence: "MIT", by: "Meta Platforms, Inc." },
  { name: "Expo and Expo Router", licence: "MIT", by: "650 Industries, Inc." },
  { name: "Ionicons (@expo/vector-icons)", licence: "MIT", by: "Ionic and Expo" },
  { name: "react-native-maps", licence: "MIT", by: "react-native-maps contributors" },
  { name: "@gorhom/bottom-sheet", licence: "MIT", by: "Mo Gorhom" },
  {
    name: "Reanimated, Gesture Handler, Worklets",
    licence: "MIT",
    by: "Software Mansion",
  },
  { name: "react-native-svg", licence: "MIT", by: "react-native-svg contributors" },
  { name: "TanStack Query", licence: "MIT", by: "Tanner Linsley" },
  { name: "axios", licence: "MIT", by: "Matt Zabriskie and contributors" },
  { name: "Socket.IO client", licence: "MIT", by: "Guillermo Rauch and contributors" },
  {
    // Routes come from CampusRide's own campus road map (since 2026-10-29),
    // made from OpenStreetMap data: no outside routing service.
    name: "Campus road map (routes)",
    licence: "Open Database License (map data)",
    by: "© OpenStreetMap contributors",
  },
];

/**
 * Account → Open-source licenses (both apps): the typeface and the main
 * libraries CampusRide is built with, and their licences.
 */
export function OpenSourceLicensesScreen() {
  return (
    <Screen scroll style={styles.content}>
      <BackButton />
      <View style={styles.heading}>
        <Text variant="title1" accessibilityRole="header">
          Open-source licenses
        </Text>
        <Text variant="body" color="secondary">
          CampusRide is built with these open-source projects. Thank you to everyone who makes them.
        </Text>
      </View>
      <View>
        {NOTICES.map((n, i) => (
          <ListRow
            key={n.name}
            divider={i > 0}
            title={n.name}
            subtitle={`${n.licence} · ${n.by}`}
            showChevron={false}
          />
        ))}
      </View>
      <Text variant="caption" color="secondary">
        Each project&apos;s full licence text is included with its package.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { gap: spacing[5], paddingBottom: spacing[10] },
  heading: { gap: spacing[2] },
});
