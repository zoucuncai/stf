/**
 * Normalized similarity in [0,1] for paired RGB or RGBA buffers of equal pixel count.
 * threshold in UI means: pass if similarity >= threshold (higher threshold = stricter).
 */

function rgbaByteArraysSimilarity(a, b) {
  if (!a || !b || a.length !== b.length || a.length < 4) {
    return 0
  }
  if (a.length % 4 !== 0) {
    return 0
  }
  var sum = 0
  var pixels = a.length / 4
  var i
  for (i = 0; i < a.length; i += 4) {
    sum += Math.abs(a[i] - b[i]) +
      Math.abs(a[i + 1] - b[i + 1]) +
      Math.abs(a[i + 2] - b[i + 2])
  }
  var denom = pixels * 3 * 255
  return denom > 0 ? 1 - sum / denom : 0
}

function rgbByteArraysSimilarity(a, b) {
  if (!a || !b || a.length !== b.length || a.length < 3) {
    return 0
  }
  if (a.length % 3 !== 0) {
    return 0
  }
  var sum = 0
  var i
  for (i = 0; i < a.length; i++) {
    sum += Math.abs(a[i] - b[i])
  }
  return 1 - sum / (a.length * 255)
}

module.exports = {
  rgbaByteArraysSimilarity: rgbaByteArraysSimilarity
, rgbByteArraysSimilarity: rgbByteArraysSimilarity
}
