import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import type { EarningsDay } from "@rida/shared";
import { Text, colors, formatCedis, spacing, spokenCedis } from "@rida/mobile-shared";

const CHART_HEIGHT = 96;
/** A bar's top corners (docs: 4px rounded data-ends, anchored to the baseline). */
const RADIUS = 4;
/** An empty day still shows a sliver, so "nothing" reads as zero, not missing. */
const MIN_BAR = 2;

/** A bar from the baseline up, with only its top corners rounded. */
function barPath(x: number, width: number, height: number): string {
  const top = CHART_HEIGHT - height;
  const r = Math.min(RADIUS, width / 2, height);
  return [
    `M${x},${CHART_HEIGHT}`,
    `V${top + r}`,
    `Q${x},${top} ${x + r},${top}`,
    `H${x + width - r}`,
    `Q${x + width},${top} ${x + width},${top + r}`,
    `V${CHART_HEIGHT}`,
    "Z",
  ].join(" ");
}

/**
 * This week, Monday to Sunday: one green bar a day for what the driver
 * earned after commission, today's in the darker green. Tap a bar for that
 * day's amount (today's is shown to start). One series, so no legend; the
 * day labels and the amount above say what the bars mean.
 */
export function WeekBars({ days }: { days: readonly EarningsDay[] }) {
  const todayIndex = Math.max(
    0,
    days.findIndex((d) => d.isToday),
  );
  const [selected, setSelected] = useState(todayIndex);
  const [width, setWidth] = useState(0);
  const max = Math.max(1, ...days.map((d) => Math.max(0, d.netPesewas)));
  const slot = width / Math.max(1, days.length);
  const barWidth = Math.max(8, slot * 0.56);
  const shown = days[selected] ?? days[todayIndex];

  return (
    <View
      style={styles.wrap}
      accessible
      accessibilityLabel={`This week: ${days
        .map((d) => `${d.label} ${spokenCedis(d.netPesewas)}`)
        .join(", ")}`}
    >
      {shown ? (
        <Text variant="subhead" color="secondary" tabular>
          {shown.isToday ? "Today" : shown.label} · {formatCedis(shown.netPesewas)} · {shown.trips}{" "}
          trip{shown.trips === 1 ? "" : "s"}
        </Text>
      ) : null}
      <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={styles.plot}>
        {width > 0 ? (
          <Svg width={width} height={CHART_HEIGHT}>
            {days.map((d, i) => {
              const h = Math.max(MIN_BAR, (Math.max(0, d.netPesewas) / max) * (CHART_HEIGHT - 4));
              return (
                <Path
                  key={d.label}
                  d={barPath(i * slot + (slot - barWidth) / 2, barWidth, h)}
                  fill={d.isToday ? colors.green500 : colors.chartBar}
                />
              );
            })}
          </Svg>
        ) : null}
        {/* Hit areas bigger than the bars: the whole column. */}
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
          <View style={styles.hits}>
            {days.map((d, i) => (
              <Pressable
                key={d.label}
                style={styles.hit}
                onPress={() => setSelected(i)}
                accessibilityElementsHidden
                importantForAccessibility="no"
              />
            ))}
          </View>
        </View>
      </View>
      <View style={styles.labels}>
        {days.map((d, i) => (
          <Text
            key={d.label}
            variant="caption"
            color={d.isToday || i === selected ? "default" : "tertiary"}
            style={[styles.label, (d.isToday || i === selected) && styles.labelStrong]}
          >
            {d.label}
          </Text>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing[2] },
  plot: { height: CHART_HEIGHT },
  hits: { flex: 1, flexDirection: "row" },
  hit: { flex: 1 },
  labels: { flexDirection: "row" },
  label: { flex: 1, textAlign: "center" },
  labelStrong: { fontWeight: "700" },
});
