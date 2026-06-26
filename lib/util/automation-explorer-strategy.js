/**
 * Door-picking strategy for automation explorer.
 *
 * Given the latest page snapshot (from uiparser) and a visit memory,
 * decide the next action to perform on the device.
 *
 * Action shape:
 *   { type: 'tap',     x, y, door }
 *   { type: 'longTap', x, y, door, durationMs }
 *   { type: 'input',   x, y, door, text }            (tap edit + send text)
 *   { type: 'swipe',   x1, y1, x2, y2, durationMs }  (scroll)
 *   { type: 'back' }                                  (KEYCODE_BACK)
 *   { type: 'home' }                                  (KEYCODE_HOME — only used to recover)
 *   { type: 'wait',    ms }
 *   { type: 'restart' }                               (re-launch target package)
 *
 * Memory shape (managed by executor, passed in/out here for purity):
 *   memory = {
 *     pages: { [fingerprint]: { activity, doorsTried: { [doorKey]: tries }, exhausted: bool } },
 *     pageStack: [fingerprint, ...]    // DFS stack
 *     stuckCount: number,
 *     lastFingerprint: string,
 *     totalSteps: number
 *   }
 *
 * Pure module — no side effects.
 */

var DEFAULT_INPUT_POOL = [
  'test'
, 'qoder123'
, '13800138000'
, 'admin@example.com'
, '123456'
, 'hello world'
, 'STF_Explorer'
]

/* Task 7: Boundary value test inputs by category */
var BOUNDARY_INPUTS = {
  text: ['', ' ', new Array(257).join('a'), '<script>alert(1)</script>', '!@#$%^&*()', '中文测试emoji']
, number: ['0', '-1', '999999999', '0.001', 'abc', '1e10']
, phone: ['', '1', '138001380001388', 'abc', '+8613800138000']
, email: ['', '@', 'a@', 'test@.com', new Array(101).join('a') + '@b.com']
}

/* Task 3: Navigation semantic keywords — doors with these get a score boost */
var NAV_KEYWORDS = [
  '设置', '个人中心', '首页', '消息', '更多', '我的', '发现'
, 'home', 'settings', 'profile', 'message', 'more', 'discover'
, '账户', '工作台', '导航', '分类', '订单', '通讯录'
]

/**
 * Pick boundary-mode input text based on door hint keywords.
 * Cycles through the appropriate category pool.
 */
function pickBoundaryInput(door) {
  var hint = ((door.resourceId || '') + ' ' + (door.contentDesc || '') + ' ' + (door.text || '')).toLowerCase()
  var category = 'text'
  if (hint.indexOf('phone') !== -1 || hint.indexOf('mobile') !== -1 || hint.indexOf('手机') !== -1 || hint.indexOf('tel') !== -1) {
    category = 'phone'
  } else if (hint.indexOf('email') !== -1 || hint.indexOf('邮箱') !== -1) {
    category = 'email'
  } else if (hint.indexOf('age') !== -1 || hint.indexOf('num') !== -1 || hint.indexOf('amount') !== -1 ||
             hint.indexOf('数量') !== -1 || hint.indexOf('金额') !== -1 || hint.indexOf('年龄') !== -1) {
    category = 'number'
  }
  var pool = BOUNDARY_INPUTS[category]
  var sum = 0
  var k = String(door.key || '')
  for (var i = 0; i < k.length; i++) {
    sum = (sum + k.charCodeAt(i)) | 0
  }
  return pool[Math.abs(sum) % pool.length]
}

/**
 * Heuristic: pick a meaningful string to type into an EditText
 * based on hints in resourceId / contentDesc / hint-like text.
 *
 * If credentials are provided (e.g. {account:'admin', password:'123'}),
 * match by hint keywords first.
 *
 * @param {object} door
 * @param {Array}  customPool
 * @param {object} credentials
 * @param {string} mode  'normal' (default) or 'boundary'
 */
function pickInputText(door, customPool, credentials, mode) {
  // Task 7: boundary mode returns edge-case values
  if (mode === 'boundary') {
    return pickBoundaryInput(door)
  }

  var pool = (customPool && customPool.length) ? customPool : DEFAULT_INPUT_POOL
  var hint = ((door.resourceId || '') + ' ' + (door.contentDesc || '') + ' ' + (door.text || '')).toLowerCase()

  // --- Credential matching: if user provided login credentials, use them ---
  if (credentials && typeof credentials === 'object') {
    var ACCOUNT_HINTS = ['user', 'account', 'login', '用户', '账号', '工号', 'username', 'phone', 'mobile', '手机', 'email', '邮箱', '警号']
    var PASSWORD_HINTS = ['password', '密码', 'pwd', 'pass', 'secret']
    var VCODE_HINTS = ['code', '验证码', 'captcha', 'verify', 'sms']
    var DOMAIN_HINTS = ['domain', '域名', '域', '服务器地址', 'host', 'server']
    var IP_HINTS = ['ip', '服务器ip', '主服务器', '备服务器', 'server ip', 'address']
    var PORT_HINTS = ['port', '端口', '服务器端口']

    if (credentials.password && PASSWORD_HINTS.some(function(k) { return hint.indexOf(k) !== -1 })) {
      return credentials.password
    }
    if (credentials.verifyCode && VCODE_HINTS.some(function(k) { return hint.indexOf(k) !== -1 })) {
      return credentials.verifyCode
    }
    if (credentials.domain && DOMAIN_HINTS.some(function(k) { return hint.indexOf(k) !== -1 })) {
      return credentials.domain
    }
    if (credentials.serverIp && IP_HINTS.some(function(k) { return hint.indexOf(k) !== -1 })) {
      return credentials.serverIp
    }
    if (credentials.serverPort && PORT_HINTS.some(function(k) { return hint.indexOf(k) !== -1 })) {
      return credentials.serverPort
    }
    if (credentials.account && ACCOUNT_HINTS.some(function(k) { return hint.indexOf(k) !== -1 })) {
      return credentials.account
    }
  }

  if (door.password || hint.indexOf('password') !== -1 || hint.indexOf('密码') !== -1) {
    return (credentials && credentials.password) ? credentials.password : 'Qoder@2024'
  }
  if (hint.indexOf('phone') !== -1 || hint.indexOf('mobile') !== -1 || hint.indexOf('手机') !== -1) {
    return '13800138000'
  }
  if (hint.indexOf('email') !== -1 || hint.indexOf('邮箱') !== -1) {
    return 'qoder@example.com'
  }
  if (hint.indexOf('search') !== -1 || hint.indexOf('搜索') !== -1 || hint.indexOf('query') !== -1) {
    return 'qoder'
  }
  if (hint.indexOf('url') !== -1 || hint.indexOf('link') !== -1) {
    return 'https://example.com'
  }
  if (hint.indexOf('age') !== -1 || hint.indexOf('num') !== -1 || hint.indexOf('amount') !== -1) {
    return '18'
  }
  if (hint.indexOf('name') !== -1 || hint.indexOf('用户') !== -1 || hint.indexOf('账号') !== -1 ||
      hint.indexOf('account') !== -1) {
    return (credentials && credentials.account) ? credentials.account : 'qoder_user'
  }
  // fallback — round-robin from pool by hashing the door key
  var sum = 0
  var k = String(door.key || door.resourceId || door.text || 'x')
  for (var i = 0; i < k.length; i++) {
    sum = (sum + k.charCodeAt(i)) | 0
  }
  return pool[Math.abs(sum) % pool.length]
}

/**
 * Score a candidate door — higher = more attractive.
 * Prefer:  unvisited > less-visited; with text/contentDesc > without; meaningful resourceId > none.
 * Avoid:   doors that look risky (logout/退出/卸载/clear) get a heavy penalty.
 */
var RISKY_KEYWORDS = [
  'logout', '退出', '注销', 'sign out'
, 'uninstall', '卸载'
, 'clear', '清除', '清空数据', '清除缓存'
, 'delete account', '删除账号', '注销账号'
, 'reset', '恢复出厂', '恢复默认'
, 'shutdown', '关机', '重启'
]

function isRiskyDoor(door) {
  var hay = ((door.text || '') + ' ' + (door.contentDesc || '') + ' ' + (door.resourceId || '')).toLowerCase()
  for (var i = 0; i < RISKY_KEYWORDS.length; i++) {
    if (hay.indexOf(RISKY_KEYWORDS[i]) !== -1) {
      return true
    }
  }
  return false
}

/**
 * Score a candidate door — higher = more attractive.
 * Prefer:  unvisited > less-visited; with text/contentDesc > without; meaningful resourceId > none.
 * Avoid:   doors that look risky (logout/退出/卸载/clear) get a heavy penalty.
 *
 * @param {object} door
 * @param {number} tries
 * @param {object} memory           visit memory (for activityCoverage)
 * @param {string} currentActivity  current page activity
 * @param {Array}  crashPaths       [{fingerprint, doorKey}] crash history
 * @param {string} currentFingerprint  current page fingerprint
 */
function scoreDoor(door, tries, memory, currentActivity, crashPaths, currentFingerprint) {
  var s = 100
  s -= (tries || 0) * 50
  if (door.text && door.text.length) {
    s += 8
  }
  if (door.contentDesc && door.contentDesc.length) {
    s += 4
  }
  if (door.resourceId && door.resourceId.length) {
    s += 3
  }
  if (door.isEditText) {
    s += 6
  }

  // Task 3: Navigation keywords bonus
  var hay = ((door.text || '') + ' ' + (door.contentDesc || '')).toLowerCase()
  for (var ni = 0; ni < NAV_KEYWORDS.length; ni++) {
    if (hay.indexOf(NAV_KEYWORDS[ni]) !== -1) {
      s += 15
      break
    }
  }

  // Task 3: Navigation Tab/BottomNav class bonus
  var dp = (door.depthPath || '').toLowerCase()
  if (dp.indexOf('bottomnavigation') !== -1 || dp.indexOf('tablayout') !== -1) {
    s += 20
  }

  // Task 3: If current activity visited many times, penalize to encourage leaving
  if (memory && memory.activityCoverage && currentActivity) {
    var stepsOnAct = memory.activityCoverage[currentActivity] || 0
    if (stepsOnAct > 5) {
      s -= 10
    }
  }

  // Task 6: Crash path penalty
  if (crashPaths && crashPaths.length && currentFingerprint) {
    for (var ci = 0; ci < crashPaths.length; ci++) {
      if (crashPaths[ci].fingerprint === currentFingerprint && crashPaths[ci].doorKey === door.key) {
        s -= 500
        break
      }
    }
  }

  if (isRiskyDoor(door)) {
    s -= 1000
  }
  return s
}

/**
 * Decide next action. Returns null if explorer should terminate.
 *
 * @param {object} page    parsed page from uiparser.parsePage
 * @param {object} memory  visit memory (mutated)
 * @param {object} opts    { maxTriesPerDoor, includeRisky, inputPool, screenW, screenH,
 *                            credentials, crashPaths, inputMode }
 */
function decideNextAction(page, memory, opts) {
  opts = opts || {}
  var maxTries = opts.maxTriesPerDoor || 1
  var includeRisky = !!opts.includeRisky
  var pool = opts.inputPool || null
  var credentials = opts.credentials || null
  var crashPaths = opts.crashPaths || []
  var inputMode = opts.inputMode || 'normal'

  if (!memory.pages) {
    memory.pages = {}
  }
  if (!memory.pageStack) {
    memory.pageStack = []
  }
  if (!memory.inputDoorsDone) {
    memory.inputDoorsDone = {}
  }
  if (!memory.fuzzyPages) {
    memory.fuzzyPages = {}
  }
  if (!memory.activityCoverage) {
    memory.activityCoverage = {}
  }
  if (!memory.boundaryTestedDoors) {
    memory.boundaryTestedDoors = {}
  }

  var fp = page.fingerprint
  var ffp = page.fuzzyFingerprint || ''

  // ----- Task 1: Popup handling — prioritise dismissing popups -----
  if (page.isPopup) {
    var popupEntry = memory.pages[fp] || { activity: page.activity || '', doorsTried: {}, exhausted: false }
    memory.pages[fp] = popupEntry
    // Don’t push popup pages to DFS pageStack
    var dismissDoors = page.popupDismissDoors || []
    for (var pi = 0; pi < dismissDoors.length; pi++) {
      var dd = dismissDoors[pi]
      if (!popupEntry.doorsTried[dd.key]) {
        popupEntry.doorsTried[dd.key] = 1
        return { type: 'tap', x: dd.center.x, y: dd.center.y, door: dd }
      }
    }
    // All dismiss doors tried → press back
    return { type: 'back' }
  }

  // ----- Task 3: Track activity coverage -----
  if (page.activity) {
    memory.activityCoverage[page.activity] = (memory.activityCoverage[page.activity] || 0) + 1
  }

  // ----- Task 2: Fuzzy page tracking -----
  var effectiveMaxTries = maxTries
  var skipScroll = false
  if (ffp) {
    if (!memory.fuzzyPages[ffp]) {
      memory.fuzzyPages[ffp] = { count: 0, totalDoorsExplored: 0 }
    }
    memory.fuzzyPages[ffp].count += 1
    if (memory.fuzzyPages[ffp].count >= 3) {
      effectiveMaxTries = 1
      skipScroll = true
    }
  }

  var entry = memory.pages[fp]
  if (!entry) {
    entry = { activity: page.activity || '', doorsTried: {}, exhausted: false, firstSeenStep: memory.totalSteps || 0 }
    memory.pages[fp] = entry
  }

  // stuck detection: only increment if SAME page AND no new doors found
  // (will be finalized below after door selection)
  var samePage = (memory.lastFingerprint === fp)
  memory.lastFingerprint = fp

  if (memory.pageStack[memory.pageStack.length - 1] !== fp) {
    memory.pageStack.push(fp)
  }

  // Pick best unvisited (or least-visited under maxTries) door on this page.
  var doors = page.doors || []
  var best = null
  var bestScore = -Infinity
  for (var i = 0; i < doors.length; i++) {
    var d = doors[i]
    if (!includeRisky && isRiskyDoor(d)) {
      continue
    }
    // Skip input doors that have been typed into globally (prevents re-input after fingerprint change)
    if (d.isEditText && memory.inputDoorsDone[d.key]) {
      continue
    }
    // Task 7: Skip boundary-tested doors in boundary mode
    if (inputMode === 'boundary' && d.isEditText && memory.boundaryTestedDoors[d.key]) {
      continue
    }
    var tries = entry.doorsTried[d.key] || 0
    if (tries >= effectiveMaxTries) {
      continue
    }
    var sc = scoreDoor(d, tries, memory, page.activity, crashPaths, fp)
    if (sc > bestScore) {
      bestScore = sc
      best = d
    }
  }

  // ----- Discovery scrolling: proactively scroll to reveal hidden UI elements -----
  // Every DISCOVERY_INTERVAL doors tried on this page, do a scroll to discover more content
  var DISCOVERY_INTERVAL = 3
  var MAX_DISCOVERY_SCROLLS = 6  // 3 vertical + 3 horizontal
  var totalDoorsTried = Object.keys(entry.doorsTried).length
  if (!entry.discoveryScrollsDone) { entry.discoveryScrollsDone = 0 }
  if (!entry.horizontalSwipesDone) { entry.horizontalSwipesDone = 0 }

  if (best && !skipScroll && totalDoorsTried > 0 &&
      totalDoorsTried % DISCOVERY_INTERVAL === 0 &&
      entry.discoveryScrollsDone < MAX_DISCOVERY_SCROLLS) {
    var screenW = opts.screenW || 1080
    var screenH = opts.screenH || 1920
    entry.discoveryScrollsDone += 1
    var scrollNum = entry.discoveryScrollsDone

    // Alternate between vertical scroll down, horizontal swipe left, vertical scroll up
    if (scrollNum % 3 === 1) {
      // Vertical scroll down (reveal content below)
      if (page.scrollables && page.scrollables.length) {
        var sv = page.scrollables[0]
        var bv = sv.bounds
        return { type: 'swipe', x1: bv.centerX, y1: Math.round(bv.y1 + bv.height * 0.75),
                 x2: bv.centerX, y2: Math.round(bv.y1 + bv.height * 0.25), durationMs: 400 }
      }
      // No explicit scrollable — swipe on screen center
      return { type: 'swipe', x1: Math.round(screenW / 2), y1: Math.round(screenH * 0.75),
               x2: Math.round(screenW / 2), y2: Math.round(screenH * 0.25), durationMs: 400 }
    } else if (scrollNum % 3 === 2) {
      // Horizontal swipe left (reveal tabs/pages to the right)
      entry.horizontalSwipesDone += 1
      return { type: 'swipe', x1: Math.round(screenW * 0.8), y1: Math.round(screenH * 0.5),
               x2: Math.round(screenW * 0.2), y2: Math.round(screenH * 0.5), durationMs: 350 }
    } else {
      // Vertical scroll up (go back to reveal top content if any)
      if (page.scrollables && page.scrollables.length) {
        var su = page.scrollables[0]
        var bu = su.bounds
        return { type: 'swipe', x1: bu.centerX, y1: Math.round(bu.y1 + bu.height * 0.25),
                 x2: bu.centerX, y2: Math.round(bu.y1 + bu.height * 0.75), durationMs: 400 }
      }
      return { type: 'swipe', x1: Math.round(screenW / 2), y1: Math.round(screenH * 0.25),
               x2: Math.round(screenW / 2), y2: Math.round(screenH * 0.75), durationMs: 400 }
    }
  }

  // No fresh door on this page — try exhaustion scrolling, then back.
  if (!best) {
    // Finalize stuck detection: same page AND no new doors → truly stuck
    if (samePage) {
      memory.stuckCount = (memory.stuckCount || 0) + 1
    } else {
      memory.stuckCount = 0
    }
    entry.exhausted = true
    // Exhaustion scroll: try more times (up to 5 vertical + 2 horizontal)
    if (!skipScroll && (entry.scrollTries || 0) < 7) {
      entry.scrollTries = (entry.scrollTries || 0) + 1
      var scrollIdx = entry.scrollTries
      var screenW2 = opts.screenW || 1080
      var screenH2 = opts.screenH || 1920

      if (scrollIdx <= 5) {
        // Vertical scroll down
        if (page.scrollables && page.scrollables.length) {
          var se = page.scrollables[0]
          var be = se.bounds
          return { type: 'swipe', x1: be.centerX, y1: Math.round(be.y1 + be.height * 0.75),
                   x2: be.centerX, y2: Math.round(be.y1 + be.height * 0.25), durationMs: 400 }
        }
        return { type: 'swipe', x1: Math.round(screenW2 / 2), y1: Math.round(screenH2 * 0.75),
                 x2: Math.round(screenW2 / 2), y2: Math.round(screenH2 * 0.25), durationMs: 400 }
      } else {
        // Horizontal swipe (try to discover hidden tabs)
        return { type: 'swipe', x1: Math.round(screenW2 * 0.8), y1: Math.round(screenH2 * 0.5),
                 x2: Math.round(screenW2 * 0.2), y2: Math.round(screenH2 * 0.5), durationMs: 350 }
      }
    }
    // retreat
    return { type: 'back' }
  }

  // Found a fresh door — explorer is making progress, not stuck
  if (samePage && best) {
    // Still on same page but found untried door → not stuck
    memory.stuckCount = 0
  } else if (!samePage) {
    memory.stuckCount = 0
  }

  // Mark door tried (we count attempts up-front; the executor records actual outcome).
  entry.doorsTried[best.key] = (entry.doorsTried[best.key] || 0) + 1

  // Update fuzzy page stats
  if (ffp && memory.fuzzyPages[ffp]) {
    memory.fuzzyPages[ffp].totalDoorsExplored += 1
  }

  if (best.isEditText) {
    // Mark globally so this input door won’t be typed into again even after fingerprint changes
    memory.inputDoorsDone[best.key] = true
    if (inputMode === 'boundary') {
      memory.boundaryTestedDoors[best.key] = true
    }
    return {
      type: 'input'
    , x: best.center.x
    , y: best.center.y
    , door: best
    , text: pickInputText(best, pool, credentials, inputMode)
    }
  }

  if (best.longClickable && !best.clickable) {
    return {
      type: 'longTap'
    , x: best.center.x
    , y: best.center.y
    , door: best
    , durationMs: 700
    }
  }

  return {
    type: 'tap'
  , x: best.center.x
  , y: best.center.y
  , door: best
  }
}

/**
 * Should the explorer terminate? Caller usually checks budgets on its own,
 * but this gives a graceful "nothing left" signal.
 */
function isExhausted(memory) {
  if (!memory || !memory.pages) {
    return false
  }
  var keys = Object.keys(memory.pages)
  if (!keys.length) {
    return false
  }
  for (var i = 0; i < keys.length; i++) {
    if (!memory.pages[keys[i]].exhausted) {
      return false
    }
  }
  return true
}

module.exports = {
  DEFAULT_INPUT_POOL: DEFAULT_INPUT_POOL
, RISKY_KEYWORDS: RISKY_KEYWORDS
, BOUNDARY_INPUTS: BOUNDARY_INPUTS
, NAV_KEYWORDS: NAV_KEYWORDS
, pickInputText: pickInputText
, pickBoundaryInput: pickBoundaryInput
, isRiskyDoor: isRiskyDoor
, scoreDoor: scoreDoor
, decideNextAction: decideNextAction
, isExhausted: isExhausted
}
