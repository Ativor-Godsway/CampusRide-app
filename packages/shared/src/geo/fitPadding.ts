export interface EdgePadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * Padding (in points) for fitting a map to a route when parts of the map are
 * covered: a floating pill across the top and a bottom sheet from below.
 * The fitted pins land in the visible window between them, with `margin`
 * of breathing room on every side (room for a pin's own height at the top).
 *
 * Whole numbers, because react-native-maps reads edgePadding as integers
 * on Android. The covered areas are capped so a tall sheet on a short screen
 * still leaves `minVisible` points of map to fit into.
 */
export function mapFitPadding(input: {
  mapHeight: number;
  topOverlay: number;
  bottomOverlay: number;
  margin?: number;
  minVisible?: number;
}): EdgePadding {
  const margin = input.margin ?? 40;
  const minVisible = input.minVisible ?? 120;
  const maxCovered = Math.max(0, input.mapHeight - minVisible);

  let top = Math.max(0, input.topOverlay) + margin;
  let bottom = Math.max(0, input.bottomOverlay) + margin;
  if (top + bottom > maxCovered) {
    const scale = maxCovered / (top + bottom);
    top *= scale;
    bottom *= scale;
  }
  return {
    top: Math.round(top),
    right: Math.round(margin),
    bottom: Math.round(bottom),
    left: Math.round(margin),
  };
}
