/**
 * Expand {{...}} placeholders in automation step strings (e.g. expected text).
 * Kept dependency-free for use in Node (bulk replay) and browser (webpack).
 */

function clampInt(n, min, max) {
  n = Math.floor(Number(n))
  if (!isFinite(n)) return min
  return Math.max(min, Math.min(max, n))
}

function randomChars(len, mode) {
  len = clampInt(len, 1, 256)
  var chars
  if (mode === 'numeric') {
    chars = '0123456789'
  }
  else if (mode === 'alpha') {
    chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
  }
  else {
    chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  }
  var out = ''
  for (var i = 0; i < len; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return out
}

function simpleUuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random() * 16 | 0
    var v = c === 'x' ? r : (r & 0x3 | 0x8)
    return v.toString(16)
  })
}

/**
 * @param {string|null|undefined} input
 * @returns {string}
 */
function expandAutomationVariables(input) {
  if (input == null) {
    return ''
  }
  var s = String(input)
  // {{random:N}} or {{random:N:numeric|alpha|alnum}}
  s = s.replace(
    /\{\{\s*random\s*:\s*(\d+)\s*(?::\s*(numeric|alpha|alnum)\s*)?\}\}/gi,
    function(_, n, mode) {
      var m = (mode || 'alnum').toLowerCase()
      if (m === 'alnum') {
        m = null
      }
      return randomChars(Number(n), m)
    }
  )
  s = s.replace(/\{\{\s*timestamp\s*\}\}/gi, function() {
    return String(Date.now())
  })
  s = s.replace(/\{\{\s*uuid\s*\}\}/gi, function() {
    return simpleUuid()
  })
  s = s.replace(/\{\{\s*isoTime\s*\}\}/gi, function() {
    return new Date().toISOString()
  })
  return s
}

/**
 * Map fullwidth / CJK punctuation that often appears in URLs or forms to ASCII.
 * Does not fix IME behavior at injection time; use paste-based input for that.
 */
function normalizeAutomationInputText(s) {
  return String(s || '')
    .replace(/\uFF0E/g, '.')
    .replace(/\u3002/g, '.')
    .replace(/\uFF0C/g, ',')
}

module.exports = {
  expandAutomationVariables: expandAutomationVariables
, normalizeAutomationInputText: normalizeAutomationInputText
}
