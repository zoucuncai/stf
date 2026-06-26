/**
 * UI tree parser & page fingerprint for automation explorer.
 *
 * Input : raw XML produced by `uiautomator dump /sdcard/uidump.xml; cat /sdcard/uidump.xml`.
 * Output:
 *   {
 *     activity:      string  ('' if unknown — caller should also pass an Activity hint),
 *     fingerprint:   string  (stable hash of page structure),
 *     doors:         Array<{ bounds, center, text, contentDesc, resourceId, className,
 *                            clickable, longClickable, scrollable, focusable, password,
 *                            isEditText, depthPath }>,
 *     editTexts:     Array<...>  (subset of doors whose className contains EditText),
 *     scrollables:   Array<...>  (subset of doors whose scrollable=true)
 *   }
 *
 * Pure function. No I/O. Safe to unit-test.
 */

var crypto = require('crypto')

/**
 * Parse <node ... /> attribute string into a plain object.
 * The XML produced by uiautomator is well-formed enough to use a regex.
 */
function parseAttrs(attrChunk) {
  var attrs = {}
  // attribute pattern: name="value"
  var re = /([a-zA-Z][a-zA-Z0-9_-]*)\s*=\s*"([^"]*)"/g
  var m
  while ((m = re.exec(attrChunk)) != null) {
    attrs[m[1]] = m[2]
  }
  return attrs
}

function parseBounds(boundsStr) {
  if (!boundsStr) {
    return null
  }
  // format: [x1,y1][x2,y2]
  var m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(boundsStr)
  if (!m) {
    return null
  }
  var x1 = Number(m[1])
  var y1 = Number(m[2])
  var x2 = Number(m[3])
  var y2 = Number(m[4])
  return {
    x1: x1
  , y1: y1
  , x2: x2
  , y2: y2
  , width: x2 - x1
  , height: y2 - y1
  , centerX: Math.round((x1 + x2) / 2)
  , centerY: Math.round((y1 + y2) / 2)
  }
}

function isTrue(v) {
  return v === 'true' || v === true
}

/**
 * Walk all <node> elements as a flat ordered list with their depth and ancestor path.
 * Returns Array<{ depth, attrs, ancestorClassPath }>.
 */
function walkNodes(xml) {
  var out = []
  if (!xml || typeof xml !== 'string') {
    return out
  }
  // Stream-tokenize <node ... />, <node ...>, </node>
  var tokenRe = /<node\b([^>]*?)(\/?)>|<\/node>/g
  var stack = []
  var token
  while ((token = tokenRe.exec(xml)) != null) {
    var full = token[0]
    if (full === '</node>') {
      stack.pop()
      continue
    }
    var attrChunk = token[1] || ''
    var selfClose = token[2] === '/'
    var attrs = parseAttrs(attrChunk)
    var depth = stack.length
    var ancestorClassPath = stack.slice()
    out.push({
      depth: depth
    , attrs: attrs
    , ancestorClassPath: ancestorClassPath
    })
    if (!selfClose) {
      stack.push(simplifyClass(attrs['class'] || ''))
    }
  }
  return out
}

function simplifyClass(cls) {
  if (!cls) {
    return ''
  }
  // android.widget.TextView -> TextView
  var idx = cls.lastIndexOf('.')
  return idx >= 0 ? cls.slice(idx + 1) : cls
}

function isClassEditText(cls) {
  if (!cls) {
    return false
  }
  var lc = String(cls).toLowerCase()
  return lc.indexOf('edittext') !== -1 || lc.indexOf('autocompletetextview') !== -1
}

/**
 * Popup dismiss keywords — used to identify "close" buttons on popups.
 */
var POPUP_DISMISS_KEYWORDS = [
  '关闭', '取消', '确定', 'ok', 'cancel', 'close', 'got it', '我知道了',
  '不再提示', '跳过', 'dismiss', '确认', '知道了', 'skip', '好的', '好',
  '稍后', '暂不', '不了', '下次', '以后再说'
]

/**
 * Detect whether the current page looks like a popup/dialog overlay.
 * Heuristics:
 *  1. A node class contains Dialog / PopupWindow / BottomSheet / AlertDialog
 *  2. Root has ≥2 top-level containers (overlay)
 */
function detectPopup(nodes) {
  var hasDialog = false
  var topContainerCount = 0
  for (var i = 0; i < nodes.length; i++) {
    var cls = (nodes[i].attrs['class'] || '').toLowerCase()
    if (cls.indexOf('dialog') !== -1 || cls.indexOf('popupwindow') !== -1 ||
        cls.indexOf('bottomsheet') !== -1 || cls.indexOf('alertdialog') !== -1) {
      hasDialog = true
    }
    if (nodes[i].depth === 1 && (cls.indexOf('framelayout') !== -1 ||
        cls.indexOf('linearlayout') !== -1 || cls.indexOf('relativelayout') !== -1 ||
        cls.indexOf('constraintlayout') !== -1)) {
      topContainerCount++
    }
  }
  return hasDialog || topContainerCount >= 2
}

/**
 * Among the given doors find those that look like dismiss/close buttons.
 */
function findPopupDismissDoors(doors) {
  var result = []
  for (var i = 0; i < doors.length; i++) {
    var d = doors[i]
    var hay = ((d.text || '') + ' ' + (d.contentDesc || '') + ' ' + (d.resourceId || '')).toLowerCase()
    for (var j = 0; j < POPUP_DISMISS_KEYWORDS.length; j++) {
      if (hay.indexOf(POPUP_DISMISS_KEYWORDS[j]) !== -1) {
        result.push(d)
        break
      }
    }
  }
  return result
}

/**
 * Build a stable fingerprint of the page from the visible structural skeleton.
 * Strategy: only include nodes that are interactable OR have a non-empty resource-id /
 * non-empty text. This keeps the print stable when list contents shift but layout stays.
 */
function computeFingerprint(activity, nodes) {
  var parts = []
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i]
    var a = n.attrs
    var rid = a['resource-id'] || ''
    var cls = simplifyClass(a['class'] || '')
    var clickable = isTrue(a.clickable) || isTrue(a['long-clickable'])
    var scrollable = isTrue(a.scrollable)
    var keep = false
    if (rid) {
      keep = true
    }
    else if (clickable || scrollable) {
      keep = true
    }
    if (!keep) {
      continue
    }
    parts.push(n.depth + ':' + cls + '#' + rid + (clickable ? '!c' : '') + (scrollable ? '!s' : ''))
  }
  var skeleton = parts.join('|')
  var h = crypto.createHash('sha1').update(activity + '||' + skeleton).digest('hex').slice(0, 16)
  return h
}

/**
 * Fuzzy fingerprint: ignores text content and specific resource-id instances.
 * Only based on Activity + class hierarchy structure + bucketed node count.
 * Used for detecting structurally similar pages (e.g. different list items).
 */
function computeFuzzyFingerprint(activity, nodes) {
  var parts = []
  for (var i = 0; i < nodes.length; i++) {
    var cls = simplifyClass(nodes[i].attrs['class'] || '')
    if (cls) {
      parts.push(nodes[i].depth + ':' + cls)
    }
  }
  var nodeBucket = Math.round(nodes.length / 10) * 10
  var skeleton = (activity || '') + '||' + nodeBucket + '||' + parts.join('|')
  return crypto.createHash('sha1').update(skeleton).digest('hex').slice(0, 16)
}

/**
 * Pick interactable doors from the node list.
 * @param {Array} nodes
 * @returns {{doors:Array, editTexts:Array, scrollables:Array}}
 */
function extractDoors(nodes) {
  var doors = []
  var editTexts = []
  var scrollables = []
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i]
    var a = n.attrs
    if (isTrue(a.enabled) === false) {
      // explicit enabled="false" — skip; if attr missing default true
      if (a.enabled === 'false') {
        continue
      }
    }
    var bounds = parseBounds(a.bounds || '')
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
      continue
    }
    var cls = a['class'] || ''
    var simpleCls = simplifyClass(cls)
    var clickable = isTrue(a.clickable)
    var longClickable = isTrue(a['long-clickable'])
    var scrollable = isTrue(a.scrollable)
    var focusable = isTrue(a.focusable)
    var pwd = isTrue(a.password)
    var isEdit = isClassEditText(cls)

    var door = {
      index: i
    , depth: n.depth
    , bounds: bounds
    , center: { x: bounds.centerX, y: bounds.centerY }
    , text: a.text || ''
    , contentDesc: a['content-desc'] || ''
    , resourceId: a['resource-id'] || ''
    , className: cls
    , simpleClass: simpleCls
    , clickable: clickable
    , longClickable: longClickable
    , scrollable: scrollable
    , focusable: focusable
    , password: pwd
    , isEditText: isEdit
    , depthPath: n.ancestorClassPath.concat([simpleCls]).join('/')
    }

    if (clickable || longClickable || isEdit) {
      doors.push(door)
    }
    if (isEdit) {
      editTexts.push(door)
    }
    if (scrollable) {
      scrollables.push(door)
    }
  }
  return { doors: doors, editTexts: editTexts, scrollables: scrollables }
}

/**
 * Compute a per-door stable id used for "visited door" bookkeeping inside one page.
 * Combines (resourceId | text | contentDesc) + simpleClass + bucketed bounds.
 */
function computeDoorKey(door) {
  var rid = door.resourceId || ''
  var txt = door.text || ''
  var cd = door.contentDesc || ''
  var cls = door.simpleClass || ''
  var b = door.bounds
  // bucket bounds to 16-px grid so a slightly shifted same button stays equal.
  var bx = b ? Math.round(b.centerX / 16) : 0
  var by = b ? Math.round(b.centerY / 16) : 0
  var raw = cls + '|' + rid + '|' + txt + '|' + cd + '|' + bx + ',' + by
  return crypto.createHash('md5').update(raw).digest('hex').slice(0, 12)
}

/**
 * Top-level: parse XML and produce a structured page snapshot.
 * @param {string} xml          uiautomator dump xml content
 * @param {string} [activity]   optional activity hint (caller usually has it from dumpsys)
 */
function parsePage(xml, activity) {
  var nodes = walkNodes(xml)
  var ext = extractDoors(nodes)
  // attach door keys
  ext.doors.forEach(function(d) {
    d.key = computeDoorKey(d)
  })
  ext.editTexts.forEach(function(d) {
    d.key = computeDoorKey(d)
  })
  ext.scrollables.forEach(function(d) {
    d.key = computeDoorKey(d)
  })
  var act = activity || ''
  var fp = computeFingerprint(act, nodes)
  var ffp = computeFuzzyFingerprint(act, nodes)
  var isPopup = detectPopup(nodes)
  var popupDismissDoors = isPopup ? findPopupDismissDoors(ext.doors) : []
  return {
    activity: act
  , fingerprint: fp
  , fuzzyFingerprint: ffp
  , isPopup: isPopup
  , popupDismissDoors: popupDismissDoors
  , nodeCount: nodes.length
  , doors: ext.doors
  , editTexts: ext.editTexts
  , scrollables: ext.scrollables
  }
}

module.exports = {
  parseAttrs: parseAttrs
, parseBounds: parseBounds
, walkNodes: walkNodes
, computeFingerprint: computeFingerprint
, computeFuzzyFingerprint: computeFuzzyFingerprint
, computeDoorKey: computeDoorKey
, detectPopup: detectPopup
, parsePage: parsePage
}
