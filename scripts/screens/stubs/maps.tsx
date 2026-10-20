/** Maps don't render on the web: a plain grey box where the map would be. */
import { forwardRef, useImperativeHandle, type ReactNode } from "react";
import { Text, View, type StyleProp, type ViewStyle } from "react-native";

const noop = () => undefined;

const MapView = forwardRef(function MapView(
  { style }: { style?: StyleProp<ViewStyle>; children?: ReactNode },
  ref,
) {
  useImperativeHandle(ref, () => ({
    animateToRegion: noop,
    animateCamera: noop,
    fitToCoordinates: noop,
    fitToSuppliedMarkers: noop,
    setCamera: noop,
    getCamera: async () => ({
      center: { latitude: 0, longitude: 0 },
      zoom: 15,
      heading: 0,
      pitch: 0,
    }),
  }));
  return (
    <View
      style={[
        { backgroundColor: "#D9DCDA", alignItems: "center", justifyContent: "center" },
        style,
      ]}
    >
      <Text style={{ color: "#7A8480", fontSize: 13 }}>Map (not shown on web)</Text>
    </View>
  );
});

export default MapView;
export const Marker = () => null;
export const Polyline = () => null;
export const Polygon = () => null;
export const Circle = () => null;
export const Callout = () => null;
export const PROVIDER_DEFAULT = undefined;
export const PROVIDER_GOOGLE = "google";
export type Region = {
  latitude: number;
  longitude: number;
  latitudeDelta: number;
  longitudeDelta: number;
};
