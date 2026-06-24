/**
 * Embed / parse full recording data (steps, baselines, etc.) in downloaded .py files for round-trip import.
 */

var MARKER_BEGIN = '# ---STF_RECORDING_BUNDLE_V1---'
var MARKER_END = '# ---STF_RECORDING_BUNDLE_END---'
var DATA_LINE = '# DATA:'

function bundlePayloadFromRecording(recording) {
  var r = recording || {}
  return {
    stepsJson: Array.isArray(r.stepsJson) ? r.stepsJson : []
  , baselinesMeta: Array.isArray(r.baselinesMeta) ? r.baselinesMeta : []
  , description: r.description != null ? String(r.description) : ''
  , recordingName: r.name != null ? String(r.name) : ''
  }
}

/**
 * @param {object} recording — DB row
 * @returns {string} .py file text (pythonCode + embedded bundle)
 */
function buildPyDownloadContent(recording) {
  var pythonPart = String((recording && recording.pythonCode) || '# STF automation recording\n').replace(/\s+$/, '')
  var payload = bundlePayloadFromRecording(recording)
  var json = JSON.stringify(payload)
  var b64 = Buffer.from(json, 'utf8').toString('base64')
  var lines = [
    ''
  , MARKER_BEGIN
  , '# Full recording bundle (steps, baselines). Keep for re-import.'
  , DATA_LINE
  ]
  var chunk = 120
  var j
  for (j = 0; j < b64.length; j += chunk) {
    lines.push('# ' + b64.slice(j, j + chunk))
  }
  lines.push(MARKER_END)
  return pythonPart + '\n' + lines.join('\n') + '\n'
}

/**
 * @param {string} text — full .py file
 * @returns {{ bundle: object|null, pythonCodeStripped: string }}
 */
function parsePyBundle(text) {
  var t = String(text || '')
  var s = t.indexOf(MARKER_BEGIN)
  if (s === -1) {
    return {bundle: null, pythonCodeStripped: t}
  }
  var e = t.indexOf(MARKER_END, s)
  if (e === -1) {
    return {bundle: null, pythonCodeStripped: t}
  }
  var head = t.slice(0, s).replace(/\s+$/, '')
  var inner = t.slice(s + MARKER_BEGIN.length, e)
  var lines = inner.split(/\r?\n/)
  var b64 = ''
  var afterData = false
  var i
  for (i = 0; i < lines.length; i++) {
    var line = lines[i]
    var trimmed = line.trim()
    if (!afterData) {
      if (trimmed === '# DATA:' || trimmed.indexOf('# DATA:') === 0) {
        afterData = true
      }
      continue
    }
    if (line.indexOf('#') === 0) {
      b64 += line.replace(/^#\s*/, '')
    }
  }
  if (!b64) {
    return {bundle: null, pythonCodeStripped: t}
  }
  try {
    var json = Buffer.from(b64, 'base64').toString('utf8')
    var bundle = JSON.parse(json)
    if (!bundle || typeof bundle !== 'object') {
      return {bundle: null, pythonCodeStripped: t}
    }
    return {bundle: bundle, pythonCodeStripped: head}
  }
  catch (err) {
    return {bundle: null, pythonCodeStripped: t}
  }
}

module.exports = {
  buildPyDownloadContent: buildPyDownloadContent
, parsePyBundle: parsePyBundle
}
