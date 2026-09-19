import type { GeoPoint } from "@blind-maps/contracts";

const EARTH_RADIUS_M = 6_371_008.8;

export function distanceMeters(left: GeoPoint, right: GeoPoint): number {
  const latitudeDelta = toRadians(right.latitude - left.latitude);
  const longitudeDelta = toRadians(right.longitude - left.longitude);
  const leftLatitude = toRadians(left.latitude);
  const rightLatitude = toRadians(right.latitude);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(leftLatitude) *
      Math.cos(rightLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(haversine)));
}

export function bearingDegrees(start: GeoPoint, end: GeoPoint): number {
  const startLatitude = toRadians(start.latitude);
  const endLatitude = toRadians(end.latitude);
  const longitudeDelta = toRadians(end.longitude - start.longitude);
  const y = Math.sin(longitudeDelta) * Math.cos(endLatitude);
  const x =
    Math.cos(startLatitude) * Math.sin(endLatitude) -
    Math.sin(startLatitude) *
      Math.cos(endLatitude) *
      Math.cos(longitudeDelta);
  return normalizeDegrees((Math.atan2(y, x) * 180) / Math.PI);
}

export function headingDifferenceDegrees(left: number, right: number): number {
  const difference = Math.abs(normalizeDegrees(left) - normalizeDegrees(right));
  return difference > 180 ? 360 - difference : difference;
}

export function polylineLengthMeters(polyline: GeoPoint[]): number {
  let total = 0;
  for (let index = 1; index < polyline.length; index += 1) {
    total += distanceMeters(polyline[index - 1], polyline[index]);
  }
  return total;
}

export function distanceToPolylineMeters(point: GeoPoint, polyline: GeoPoint[]): number {
  if (polyline.length === 0) return Number.POSITIVE_INFINITY;
  if (polyline.length === 1) return distanceMeters(point, polyline[0]);

  let closest = Number.POSITIVE_INFINITY;
  for (let index = 1; index < polyline.length; index += 1) {
    closest = Math.min(
      closest,
      distanceToSegmentMeters(point, polyline[index - 1], polyline[index]),
    );
  }
  return closest;
}

function distanceToSegmentMeters(point: GeoPoint, start: GeoPoint, end: GeoPoint): number {
  const latitudeScale = (Math.PI / 180) * EARTH_RADIUS_M;
  const longitudeScale =
    latitudeScale * Math.cos(toRadians((start.latitude + end.latitude + point.latitude) / 3));
  const startX = start.longitude * longitudeScale;
  const startY = start.latitude * latitudeScale;
  const endX = end.longitude * longitudeScale;
  const endY = end.latitude * latitudeScale;
  const pointX = point.longitude * longitudeScale;
  const pointY = point.latitude * latitudeScale;
  const deltaX = endX - startX;
  const deltaY = endY - startY;
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  const projection =
    lengthSquared === 0
      ? 0
      : Math.max(
          0,
          Math.min(
            1,
            ((pointX - startX) * deltaX + (pointY - startY) * deltaY) /
              lengthSquared,
          ),
        );
  return Math.hypot(
    pointX - (startX + projection * deltaX),
    pointY - (startY + projection * deltaY),
  );
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function normalizeDegrees(degrees: number): number {
  const wrapped = degrees % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}
