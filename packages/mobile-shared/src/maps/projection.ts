/**
 * Web Mercator projection helpers for placing marker overlays on top of a
 * Mapbox Static Images API tile. Pure math — matches the projection Mapbox
 * uses for `/styles/v1/{style}/static/{lon},{lat},{zoom}/{w}x{h}` images, so
 * a point's pixel offset from the image center can be computed without any
 * native map SDK.
 */

const TILE_SIZE = 256;

function lonToWorldX(longitude: number, zoom: number): number {
  return ((longitude + 180) / 360) * TILE_SIZE * 2 ** zoom;
}

function latToWorldY(latitude: number, zoom: number): number {
  const latRad = (latitude * Math.PI) / 180;
  return (
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
    TILE_SIZE *
    2 ** zoom
  );
}

export interface LatLng {
  latitude: number;
  longitude: number;
}

export interface PixelOffset {
  x: number;
  y: number;
}

/**
 * Returns the pixel position of `point` within a `width`x`height` static
 * map image centered on `center` at the given `zoom`. The origin (0,0) is
 * the top-left of the image — values outside `[0, width]`/`[0, height]`
 * are off-image.
 */
export function projectToPixel(
  center: LatLng,
  point: LatLng,
  zoom: number,
  width: number,
  height: number,
): PixelOffset {
  const centerX = lonToWorldX(center.longitude, zoom);
  const centerY = latToWorldY(center.latitude, zoom);
  const pointX = lonToWorldX(point.longitude, zoom);
  const pointY = latToWorldY(point.latitude, zoom);

  return {
    x: width / 2 + (pointX - centerX),
    y: height / 2 + (pointY - centerY),
  };
}
