/**
 * lottie-react-native's LottieView as an empty box of its size. The harness
 * runs with Reduce Motion on, so screens show their still image instead.
 */
import { View, type StyleProp, type ViewStyle } from "react-native";

export default function LottieView({ style }: { style?: StyleProp<ViewStyle> }) {
  return <View style={style} />;
}
