/** expo-image's Image as react-native's, with contentFit as resizeMode. */
import { Image as RNImage, type ImageProps } from "react-native";

type Props = Omit<ImageProps, "source"> & {
  source?: unknown;
  contentFit?: string;
  transition?: number;
};

export function Image({ contentFit, transition: _t, source, ...rest }: Props) {
  const resizeMode =
    contentFit === "fill" ? "stretch" : ((contentFit as ImageProps["resizeMode"]) ?? "cover");
  return <RNImage source={source as ImageProps["source"]} resizeMode={resizeMode} {...rest} />;
}
