/**
 * Five built-in assertions for automation explorer.
 *
 *  1. assertNoCrash       — detect FATAL EXCEPTION / Process crashed in logcat
 *  2. assertNoAnr         — detect "ANR in <pkg>" in logcat
 *  3. assertForeground    — target package must remain in foreground
 *  4. assertNotStuck      — fingerprint identical for N steps in a row
 *  5. assertNoErrorKeyword— configurable keyword scan over the latest UI dump
 *
 * Each assertion takes already-collected evidence (logcat tail / dumpsys output / ui xml)
 * and returns { ok: bool, code, message, detail? }. The executor is responsible for
 * obtaining the evidence (so we don't make I/O here and keep this unit testable).
 */

var DEFAULT_ERROR_KEYWORDS = [
  '网络异常'
, '服务器错误'
, '加载失败'
, '操作失败'
, '请稍后重试'
, '系统错误'
, 'Error'
, 'Exception'
, 'Failed'
, 'Crash'
, 'Unable to'
]

function ok(code) {
  return { ok: true, code: code || 'OK', message: '' }
}

function fail(code, message, detail) {
  return { ok: false, code: code, message: message, detail: detail || null }
}

function pickRecentLines(text, n) {
  if (!text) {
    return ''
  }
  var arr = String(text).split(/\r?\n/)
  if (arr.length <= n) {
    return arr.join('\n')
  }
  return arr.slice(arr.length - n).join('\n')
}

/* -------------------------------------------------------------------------- */
/* 1. crash                                                                   */
/* -------------------------------------------------------------------------- */
function assertNoCrash(logcatText, packageName) {
  var t = String(logcatText || '')
  if (!t) {
    return ok('NO_CRASH')
  }
  // Common patterns:
  //   FATAL EXCEPTION: main
  //     Process: <pkg>, PID: 12345
  if (/\bFATAL EXCEPTION\b/.test(t)) {
    var pkgRe = packageName
      ? new RegExp('Process:\\s*' + escapeRe(packageName))
      : null
    if (!pkgRe || pkgRe.test(t)) {
      return fail('CRASH', '检测到 FATAL EXCEPTION（应用崩溃）', {
        snippet: pickRecentLines(t.substring(t.indexOf('FATAL EXCEPTION')), 20)
      })
    }
  }
  if (/\bProcess\s+.+\s+has died\b/.test(t)) {
    return fail('PROCESS_DIED', '检测到进程被杀（Process has died）', { snippet: pickRecentLines(t, 20) })
  }
  if (packageName) {
    var pkgEsc = escapeRe(packageName)
    var crashRe = new RegExp('Process\\s+' + pkgEsc + '\\s+\\(pid\\s+\\d+\\)\\s+has died|am_crash.*' + pkgEsc)
    if (crashRe.test(t)) {
      return fail('CRASH', '检测到目标应用崩溃', { snippet: pickRecentLines(t, 20) })
    }
  }
  return ok('NO_CRASH')
}

/* -------------------------------------------------------------------------- */
/* 2. ANR                                                                     */
/* -------------------------------------------------------------------------- */
function assertNoAnr(logcatText, packageName) {
  var t = String(logcatText || '')
  if (!t) {
    return ok('NO_ANR')
  }
  if (/\bANR in\b/i.test(t)) {
    if (packageName && t.indexOf(packageName) === -1) {
      // ANR but not our package
      return ok('NO_ANR')
    }
    return fail('ANR', '检测到 ANR（应用无响应）', { snippet: pickRecentLines(t.substring(t.search(/ANR in/i)), 20) })
  }
  if (/Input event dispatching timed out/i.test(t)) {
    return fail('ANR', '检测到输入事件分发超时（疑似 ANR）', { snippet: pickRecentLines(t, 10) })
  }
  return ok('NO_ANR')
}

/* -------------------------------------------------------------------------- */
/* 3. foreground                                                              */
/* -------------------------------------------------------------------------- */
function assertForeground(dumpsysText, expectedPackage) {
  if (!expectedPackage) {
    return ok('FOREGROUND_SKIPPED')
  }
  var t = String(dumpsysText || '')
  if (!t) {
    return fail('NO_DUMPSYS', '无 dumpsys 输出可校验前台应用')
  }
  // Look for "mCurrentFocus" / "mResumedActivity" / "topResumedActivity"
  // formatted like:  mCurrentFocus=Window{... u0 com.foo.bar/com.foo.bar.MainActivity}
  var lines = t.split(/\r?\n/)
  var focusLines = []
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i]
    if (/mCurrentFocus|mResumedActivity|mFocusedApp|topResumedActivity/i.test(ln)) {
      focusLines.push(ln.trim())
    }
  }
  var blob = focusLines.join('\n')
  if (!blob) {
    // not fatal — sometimes dumpsys output style varies
    return ok('FOREGROUND_UNKNOWN')
  }
  if (blob.indexOf(expectedPackage) !== -1) {
    return ok('FOREGROUND_OK')
  }
  // try to identify what is currently foreground
  var fgPkg = ''
  var m = /[\s=]([a-zA-Z][\w\.]+)\/[\w\.\$]+/.exec(blob)
  if (m) {
    fgPkg = m[1]
  }
  return fail('NOT_FOREGROUND', '目标应用已不在前台', {
    expected: expectedPackage
  , current: fgPkg
  , focusLines: focusLines
  })
}

/* -------------------------------------------------------------------------- */
/* 4. stuck                                                                   */
/* -------------------------------------------------------------------------- */
function assertNotStuck(stuckCount, threshold) {
  var th = threshold || 4
  if ((stuckCount || 0) >= th) {
    return fail('STUCK', '页面连续 ' + th + ' 步无变化（疑似卡死或弹窗循环）', { stuckCount: stuckCount })
  }
  return ok('NOT_STUCK')
}

/* -------------------------------------------------------------------------- */
/* 5. error keyword                                                           */
/* -------------------------------------------------------------------------- */
function assertNoErrorKeyword(uiXml, customKeywords) {
  var t = String(uiXml || '')
  if (!t) {
    return ok('NO_ERROR_KEYWORD')
  }
  var kws = (customKeywords && customKeywords.length) ? customKeywords : DEFAULT_ERROR_KEYWORDS
  // collect text="" / content-desc="" values, then keyword-match
  var visibleTexts = []
  var re = /(?:text|content-desc)\s*=\s*"([^"]+)"/g
  var m
  while ((m = re.exec(t)) != null) {
    visibleTexts.push(m[1])
  }
  for (var i = 0; i < visibleTexts.length; i++) {
    var v = visibleTexts[i]
    for (var j = 0; j < kws.length; j++) {
      var k = kws[j]
      if (!k) {
        continue
      }
      if (v.indexOf(k) !== -1) {
        return fail('ERROR_KEYWORD', '页面出现报错关键字：' + k, { hit: k, sample: v })
      }
    }
  }
  return ok('NO_ERROR_KEYWORD')
}

/* -------------------------------------------------------------------------- */
/* aggregate runner                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Run all assertions on a single step's evidence and return list of failures.
 * @param {object} ev  { logcatText, dumpsysText, uiXml, packageName, stuckCount, errorKeywords, stuckThreshold }
 * @returns {Array<{code,message,detail}>}  empty if everything passed
 */
function runAll(ev) {
  ev = ev || {}
  var results = []
  var checks = [
    assertNoCrash(ev.logcatText, ev.packageName)
  , assertNoAnr(ev.logcatText, ev.packageName)
  , assertForeground(ev.dumpsysText, ev.packageName)
  , assertNotStuck(ev.stuckCount, ev.stuckThreshold)
  , assertNoErrorKeyword(ev.uiXml, ev.errorKeywords)
  ]
  for (var i = 0; i < checks.length; i++) {
    var c = checks[i]
    if (c && !c.ok) {
      results.push({ code: c.code, message: c.message, detail: c.detail })
    }
  }
  return results
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

module.exports = {
  DEFAULT_ERROR_KEYWORDS: DEFAULT_ERROR_KEYWORDS
, assertNoCrash: assertNoCrash
, assertNoAnr: assertNoAnr
, assertForeground: assertForeground
, assertNotStuck: assertNotStuck
, assertNoErrorKeyword: assertNoErrorKeyword
, runAll: runAll
}
