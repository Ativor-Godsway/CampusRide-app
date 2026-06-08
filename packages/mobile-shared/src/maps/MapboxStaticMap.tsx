import { Image, Pressable, StyleSheet, View } from "react-native";
import { colors, radii } from "../design/tokens";
import { Text } from "../design/components/Text";
import { projectToPixel, type LatLng } from "./projection";

export interface MapMarker extends LatLng {
  id: string;
  label?: string;
  selected?: boolean;
}

export interface MapboxStaticMapProps {
  /** Mapbox public access token (pk.*). If missing, renders nothing — caller should show a list-only fallback. */
  accessToken: string | undefined;
  center: LatLng;
  zoom?: number;
  width: number;
  height: number;
  markers: MapMarker[];
  onMarkerPress?: (id: string) => void;
  userLocation?: LatLng | null;
}

const DEFAULT_ZOOM = 14.5;
const PIN_SIZE = 28;
const USER_DOT_SIZE = 14;

/**
 * Campus map "display" surface: a Mapbox Static Images API tile with
 * tappable marker overlays positioned via Web Mercator projection. Static
 * images need no native map SDK, so this works in Expo Go. Display only —
 * no routing/directions calls.
 */
export function MapboxStaticMap({
  accessToken,
  center,
  zoom = DEFAULT_ZOOM,
  width,
  height,
  markers,
  onMarkerPress,
  userLocation,
}: MapboxStaticMapProps) {
  if (!accessToken) {
    return null;
  }

  const w = Math.round(width);
  const h = Math.round(height);
  const uri = `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/${center.longitude},${center.latitude},${zoom}/${w}x${h}@2x?access_token=${accessToken}`;

  return (
    <View style={[styles.container, { width: w, height: h }]}>
      <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="cover" />

      {userLocation
        ? (() => {
            const { x, y } = projectToPixel(center, userLocation, zoom, w, h);
            if (x < 0 || x > w || y < 0 || y > h) return null;
            return (
              <View
                pointerEvents="none"
                style={[
                  styles.userDot,
                  { left: x - USER_DOT_SIZE / 2, top: y - USER_DOT_SIZE / 2 },
                ]}
              />
            );
          })()
        : null}

      {markers.map((marker) => {
        const { x, y } = projectToPixel(center, marker, zoom, w, h);
        if (x < -PIN_SIZE || x > w + PIN_SIZE || y < -PIN_SIZE || y > h + PIN_SIZE) return null;

        return (
          <Pressable
            key={marker.id}
            accessibilityRole="button"
            accessibilityLabel={marker.label ?? marker.id}
            onPress={() => onMarkerPress?.(marker.id)}
            style={[
              styles.pin,
              { left: x - PIN_SIZE / 2, top: y - PIN_SIZE },
              marker.selected && styles.pinSelected,
            ]}
          >
            <Text variant="caption" color={marker.selected ? "inverse" : "default"}>
              ●
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    overflow: "hidden",
    borderRadius: radii.lg,
    backgroundColor: colors.surface,
  },
  pin: {
    position: "absolute",
    width: PIN_SIZE,
    height: PIN_SIZE,
    borderRadius: radii.full,
    backgroundColor: colors.white,
    borderWidth: 2,
    borderColor: colors.primary[500],
    alignItems: "center",
    justifyContent: "center",
  },
  pinSelected: {
    backgroundColor: colors.primary[500],
    borderColor: colors.primary[700],
  },
  userDot: {
    position: "absolute",
    width: USER_DOT_SIZE,
    height: USER_DOT_SIZE,
    borderRadius: radii.full,
    backgroundColor: colors.primary[500],
    borderWidth: 2,
    borderColor: colors.white,
  },
});
