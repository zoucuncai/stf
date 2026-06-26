/**
 * Automation Explorer Executor.
 *
 * Drives an exploratory UI walk on one or more Android devices: launch the target
 * package, dump the UI hierarchy, pick interactable doors via DFS strategy, perform
 * the action, run 5 built-in assertions, and persist results.
 *
 * Mirrors the architecture of automation-replay-executor.js — runs inside the API
 * process and talks to devices directly through adbutil(). No new wire.proto messages.
 */

var Promise = require('bluebird')
var r = require('rethinkdb')
var uuid = require('uuid')
var db = require('../db')
var adb = require('./adbutil')()
var uiparser = require('./automation-explorer-uiparser')
var strategy = require('./automation-explorer-strategy')
var asserter = require('./automation-explorer-asserter')
var reportHtml = require('./automation-report-html')

function now() {
  return new Date().toISOString()
}

function shell(serial, command) {
  return adb.shell(serial, command)
    .then(adb.util.readAll)
    .then(function(out) { return String(out || '') })
}

function shellRaw(serial, command) {
  return adb.shell(serial, command).then(adb.util.readAll)
}

function escapeShell(s) {
  // wrap in single quotes; escape internal single quotes
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

function getDisplaySize(serial) {
  return shell(serial, 'wm size').then(function(out) {
    var m = /Physical size:\s*(\d+)x(\d+)/i.exec(out) || /(\d+)x(\d+)/.exec(out)
    if (m) {
      return { w: Number(m[1]), h: Number(m[2]) }
    }
    return { w: 1080, h: 1920 }
  }).catch(function() {
    return { w: 1080, h: 1920 }
  })
}

function getCurrentActivity(serial) {
  // Best-effort; works on most ROMs
  return shell(serial,
    'dumpsys activity activities | grep -E "mResumedActivity|topResumedActivity|ResumedActivity:" | head -n 3'
  ).then(function(out) {
    if (!out) {
      return ''
    }
    var m = /([a-zA-Z][\w\.]+)\/([\w\.\$]+)/.exec(out)
    return m ? (m[1] + '/' + m[2]) : ''
  }).catch(function() {
    return ''
  })
}

function getFocusedActivityFromWindow(serial) {
  return shell(serial, 'dumpsys window windows | grep -E "mCurrentFocus|mFocusedApp" | head -n 5')
    .catch(function() { return '' })
}

function dumpUi(serial) {
  // Some ROMs don't allow writing to /sdcard. Try fast path then fall back.
  var tryPaths = ['/sdcard/_stf_explorer_uidump.xml', '/data/local/tmp/_stf_explorer_uidump.xml']
  function tryPath(idx) {
    if (idx >= tryPaths.length) {
      return Promise.resolve('')
    }
    var p = tryPaths[idx]
    return shell(serial, 'uiautomator dump ' + p + ' >/dev/null 2>&1; cat ' + p + ' 2>/dev/null')
      .then(function(out) {
        if (out && out.indexOf('<hierarchy') !== -1) {
          return out
        }
        return tryPath(idx + 1)
      })
      .catch(function() {
        return tryPath(idx + 1)
      })
  }
  return tryPath(0)
}

function captureScreencapPngBuffer(serial) {
  // Use file-based approach to avoid binary corruption through shell transport
  var tmp = '/data/local/tmp/_stf_explore_cap.png'
  return shell(serial, 'screencap -p ' + tmp)
    .then(function() {
      return shell(serial, 'base64 ' + tmp)
    })
    .then(function(b64Text) {
      // Clean up temp file (fire and forget)
      shell(serial, 'rm -f ' + tmp).catch(function() {})
      // Remove whitespace/newlines from base64 output
      var clean = (b64Text || '').replace(/[\r\n\s]/g, '')
      if (!clean) {
        return null
      }
      return Buffer.from(clean, 'base64')
    })
    .catch(function() {
      // Fallback: try direct binary (may be corrupted on Windows)
      return shellRaw(serial, 'screencap -p')
        .then(function(buf) {
          if (!buf || buf.length < 8) return null
          return buf
        })
        .catch(function() { return null })
    })
}

function captureScreencapDataUrl(serial) {
  return captureScreencapPngBuffer(serial)
    .then(function(buf) {
      if (!buf || !buf.length) {
        return ''
      }
      return 'data:image/png;base64,' + Buffer.from(buf).toString('base64')
    })
    .catch(function() { return '' })
}

function clearLogcat(serial) {
  return shell(serial, 'logcat -c').catch(function() {})
}

function readLogcatTail(serial) {
  // Read once, non-blocking. -d dumps and exits.
  return shell(serial, 'logcat -d -v brief -t 200').catch(function() { return '' })
}

function getResumedDumpsys(serial) {
  return shell(serial,
    'dumpsys window windows 2>/dev/null | grep -E "mCurrentFocus|mFocusedApp|mResumedActivity"; ' +
    'dumpsys activity activities 2>/dev/null | grep -E "ResumedActivity|topResumedActivity" | head -n 5'
  ).catch(function() { return '' })
}

function startApp(serial, packageName) {
  // Use monkey to launch the launcher activity. Falls back to am start if main activity is known.
  var cmd = 'monkey -p ' + packageName + ' -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1; echo OK'
  return shell(serial, cmd).then(function() {
    return Promise.delay(1500)
  })
}

function pressKey(serial, code) {
  return shell(serial, 'input keyevent ' + code)
}

function tap(serial, x, y) {
  return shell(serial, 'input tap ' + Math.round(x) + ' ' + Math.round(y))
}

function longTap(serial, x, y, duration) {
  // emulate long-press as a 0-distance swipe
  var d = duration || 700
  return shell(serial, 'input swipe ' + Math.round(x) + ' ' + Math.round(y) + ' ' +
    Math.round(x) + ' ' + Math.round(y) + ' ' + d)
}

function swipe(serial, x1, y1, x2, y2, duration) {
  var d = duration || 350
  return shell(serial, 'input swipe ' + Math.round(x1) + ' ' + Math.round(y1) + ' ' +
    Math.round(x2) + ' ' + Math.round(y2) + ' ' + d)
}

function inputText(serial, txt) {
  // adb shell input text doesn't accept many special chars; whitespace -> %s
  var cleaned = String(txt || '').replace(/[`$"\\]/g, '')
  var encoded = cleaned.replace(/ /g, '%s')
  return shell(serial, 'input text ' + escapeShell(encoded))
}

/**
 * Task 4: Wait until UI stabilises (two consecutive dumps are identical)
 * instead of a fixed 700ms delay. Minimum wait 300ms, maximum maxWaitMs.
 */
function waitForUiStable(serial, maxWaitMs) {
  var max = maxWaitMs || 3000
  var start = Date.now()
  var lastXml = ''
  function check() {
    if (Date.now() - start > max) return Promise.resolve()
    return dumpUi(serial).then(function(xml) {
      if (xml && xml === lastXml) return Promise.resolve() // stable
      lastXml = xml
      return Promise.delay(400).then(check)
    }).catch(function() { return Promise.resolve() })
  }
  return Promise.delay(300).then(check)
}

function buildFailedReportHtml(message) {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"/>' +
    '<title>探索测试失败</title></head><body style="font-family:sans-serif;padding:24px;">' +
    '<h1>探索测试运行失败</h1><pre style="background:#f5f5f5;padding:12px;border-radius:6px;">' +
    String(message || '').replace(/</g, '&lt;') +
    '</pre></body></html>'
}

/**
 * Explore one device for the configured budget.
 *
 * @param {object} run     run row (already inserted)
 * @param {string} serial
 * @param {object} opts    { packageName, maxSteps, maxMinutes, maxTriesPerDoor, includeRisky,
 *                            stuckThreshold, errorKeywords, captureEverySteps }
 * @returns {Promise<{stats, artifacts, logLines, pages, errors}>}
 */
function exploreOnDevice(run, serial, opts) {
  opts = opts || {}
  var packageName = opts.packageName
  var maxSteps = Math.max(1, Number(opts.maxSteps) || 80)
  var maxMs = Math.max(30, Number(opts.maxMinutes) || 8) * 60 * 1000
  var maxTriesPerDoor = Math.max(1, Number(opts.maxTriesPerDoor) || 1)
  var includeRisky = !!opts.includeRisky
  var stuckThreshold = Math.max(2, Number(opts.stuckThreshold) || 4)
  var errorKeywords = Array.isArray(opts.errorKeywords) ? opts.errorKeywords : null
  var captureEverySteps = Math.max(1, Number(opts.captureEverySteps) || 5)
  var credentials = opts.credentials || null
  var preSteps = Array.isArray(opts.preSteps) ? opts.preSteps : []
  var skipLaunch = !!opts.skipLaunch

  var startedAt = Date.now()
  var logLines = []
  var artifacts = []
  var pageList = []
  var pageIndex = {}
  var errors = []
  var actionHistory = []
  var stats = {
    stepsExecuted: 0
  , pagesDiscovered: 0
  , doorsClicked: 0
  , crashCount: 0
  , anrCount: 0
  , errorKeywordCount: 0
  , stuckCount: 0
  , notForegroundCount: 0
  , recoveryCount: 0
  }

  // Task 5: Support initialMemory for "continue from last" exploration
  var memory
  if (opts.initialMemory && typeof opts.initialMemory === 'object') {
    memory = opts.initialMemory
    // Ensure required fields exist
    if (!memory.pages) memory.pages = {}
    if (!memory.pageStack) memory.pageStack = []
    if (!memory.inputDoorsDone) memory.inputDoorsDone = {}
    if (!memory.fuzzyPages) memory.fuzzyPages = {}
    if (!memory.activityCoverage) memory.activityCoverage = {}
    if (!memory.boundaryTestedDoors) memory.boundaryTestedDoors = {}
    memory.stuckCount = 0
    memory.lastFingerprint = ''
    memory.totalSteps = 0
  } else {
    memory = {
      pages: {}, pageStack: [], stuckCount: 0, lastFingerprint: '', totalSteps: 0,
      fuzzyPages: {}, activityCoverage: {}, inputDoorsDone: {}, boundaryTestedDoors: {}
    }
  }

  // Task 6: Crash path tracking
  var crashPaths = []
  var fatalDoors = {}  // doorKey -> crashCount, permanently skip if >= 2

  var displaySize = { w: 1080, h: 1920 }

  function log(line) {
    var entry = '[' + now() + '] ' + line
    logLines.push(entry)
    if (logLines.length > 5000) {
      logLines = logLines.slice(-3000)
    }
  }

  function recordPage(page, screenshotDataUrl) {
    if (!pageIndex[page.fingerprint]) {
      pageIndex[page.fingerprint] = pageList.length
      pageList.push({
        fingerprint: page.fingerprint
      , activity: page.activity || ''
      , doorsCount: (page.doors || []).length
      , editTextsCount: (page.editTexts || []).length
      , scrollablesCount: (page.scrollables || []).length
      , firstSeenStep: stats.stepsExecuted
      , screenshotDataUrl: screenshotDataUrl || ''
      })
      stats.pagesDiscovered = pageList.length
    }
  }

  function pushArtifact(art) {
    if (!art) {
      return
    }
    artifacts.push(art)
    if (artifacts.length > 200) {
      artifacts = artifacts.slice(-150)
    }
  }

  function syncProgress() {
    return db.run(r.table('automationExplorerRunDevices').getAll(run.id, { index: 'runId' })
      .filter({ serial: serial })
      .update({
        stepsExecuted: stats.stepsExecuted
      , pagesDiscovered: stats.pagesDiscovered
      , doorsClicked: stats.doorsClicked
      , crashCount: stats.crashCount
      , anrCount: stats.anrCount
      , errorKeywordCount: stats.errorKeywordCount
      , stuckCount: stats.stuckCount
      , notForegroundCount: stats.notForegroundCount
      , recoveryCount: stats.recoveryCount
      , currentFingerprint: memory.lastFingerprint || ''
      , currentActivity: memory.lastActivity || ''
      , executionLog: logLines.slice(-200).join('\n')
      , updatedAt: now()
      })
    ).catch(function() {})
  }

  function timeUp() {
    return (Date.now() - startedAt) >= maxMs
  }

  function snapshot() {
    // Fetch all 4 adb data sources in parallel to minimize total latency
    return Promise.join(
      dumpUi(serial)
    , getCurrentActivity(serial)
    , readLogcatTail(serial)
    , getResumedDumpsys(serial)
    , function(xml, activity, logcatText, dumpsysText) {
        return { xml: xml, activity: activity, logcatText: logcatText, dumpsysText: dumpsysText }
      }
    )
  }

  function executeAction(action) {
    if (!action) {
      return Promise.resolve()
    }
    switch (action.type) {
      case 'tap':
        return tap(serial, action.x, action.y).then(function() { stats.doorsClicked += 1 })
      case 'longTap':
        return longTap(serial, action.x, action.y, action.durationMs)
          .then(function() { stats.doorsClicked += 1 })
      case 'swipe':
        return swipe(serial, action.x1, action.y1, action.x2, action.y2, action.durationMs)
      case 'input':
        return tap(serial, action.x, action.y)
          .delay(150)
          .then(function() {
            // Select all and delete existing text first
            return shell(serial, 'input keyevent 29 29 29')
              .delay(50)
              .then(function() { return shell(serial, 'input keyevent 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67') })
          })
          .delay(100)
          .then(function() { return inputText(serial, action.text) })
          .delay(200)
          .then(function() {
            // Dismiss keyboard by pressing Back
            return pressKey(serial, 4)
          })
          .then(function() { stats.doorsClicked += 1 })
      case 'back':
        return pressKey(serial, 4)
      case 'home':
        return pressKey(serial, 3)
      case 'wait':
        return Promise.delay(action.ms || 300)
      case 'restart':
        return startApp(serial, packageName).then(function() { stats.recoveryCount += 1 })
      default:
        return Promise.resolve()
    }
  }

  function describeAction(action) {
    if (!action) {
      return '(none)'
    }
    if (action.type === 'tap' || action.type === 'longTap' || action.type === 'input') {
      var d = action.door || {}
      var label = d.text || d.contentDesc || d.resourceId || d.simpleClass || '?'
      var ext = action.type === 'input' ? (' text="' + (action.text || '') + '"') : ''
      return action.type + ' [' + label + ']@(' + action.x + ',' + action.y + ')' + ext
    }
    if (action.type === 'swipe') {
      return 'swipe (' + action.x1 + ',' + action.y1 + ')->(' + action.x2 + ',' + action.y2 + ')'
    }
    return action.type
  }

  function checkStopped() {
    return db.run(r.table('automationExplorerRuns').get(run.id).getField('status'))
      .then(function(st) { return st === 'stopping' || st === 'stopped' })
      .catch(function() { return false })
  }

  function step() {
    if (stats.stepsExecuted >= maxSteps) {
      log('达到最大步数 ' + maxSteps + '，停止')
      return Promise.resolve(false)
    }
    if (timeUp()) {
      log('达到时间预算，停止')
      return Promise.resolve(false)
    }
    // Check if user requested stop
    return checkStopped().then(function(stopped) {
      if (stopped) {
        log('用户请求停止，终止探索')
        return false
      }
      return snapshot().then(function(snap) {
      if (!snap.xml || snap.xml.indexOf('<hierarchy') === -1) {
        log('UI dump 为空，尝试重启目标应用')
        return startApp(serial, packageName).then(function() {
          stats.recoveryCount += 1
          return true
        })
      }
      var page = uiparser.parsePage(snap.xml, snap.activity || '')
      memory.lastActivity = snap.activity || ''

      // Run assertions using logcat & dumpsys already fetched in parallel with snapshot
      return Promise.join(
        snap.logcatText ? Promise.resolve(snap.logcatText) : readLogcatTail(serial)
      , snap.dumpsysText ? Promise.resolve(snap.dumpsysText) : getResumedDumpsys(serial)
      , function(logcatText, dumpsysText) {
          return asserter.runAll({
            logcatText: logcatText
          , dumpsysText: dumpsysText
          , uiXml: snap.xml
          , packageName: packageName
          , stuckCount: memory.stuckCount
          , stuckThreshold: stuckThreshold
          , errorKeywords: errorKeywords
          })
        }
      ).then(function(failures) {
        var firstSeen = !memory.pages[page.fingerprint]
        var screenshotPromise = Promise.resolve('')
        if (firstSeen || (stats.stepsExecuted % captureEverySteps === 0) || (failures && failures.length)) {
          // Always capture screenshot when assertions fail
          screenshotPromise = captureScreencapDataUrl(serial)
        }
        return screenshotPromise.then(function(shot) {
          recordPage(page, firstSeen ? shot : '')

          if (failures && failures.length) {
            failures.forEach(function(f) {
              if (f.code === 'CRASH' || f.code === 'PROCESS_DIED') { stats.crashCount += 1 }
              else if (f.code === 'ANR') { stats.anrCount += 1 }
              else if (f.code === 'ERROR_KEYWORD') { stats.errorKeywordCount += 1 }
              else if (f.code === 'STUCK') {
                stats.stuckCount += 1
                // Reset memory stuckCount after reporting, so STUCK won't spam every step
                memory.stuckCount = 0
              }
              else if (f.code === 'NOT_FOREGROUND') { stats.notForegroundCount += 1 }
              errors.push(f.code + ': ' + f.message)
              pushArtifact({
                stepIndex: stats.stepsExecuted
              , type: 'assertion'
              , code: f.code
              , title: '断言失败 - ' + f.code
              , detail: f.message + (f.detail ? (' | ' + JSON.stringify(f.detail).slice(0, 400)) : '')
              , activity: page.activity || ''
              , fingerprint: page.fingerprint
              , actualImageDataUrl: shot || ''
              })
              log('断言失败 ' + f.code + ' :: ' + f.message)
            })

            var needRecover = failures.some(function(f) {
              return f.code === 'CRASH' || f.code === 'PROCESS_DIED' || f.code === 'NOT_FOREGROUND'
            })
            if (needRecover) {
              // Task 6: Record crash path from recent action history
              var recentLen = Math.min(3, actionHistory.length)
              for (var ci = actionHistory.length - recentLen; ci < actionHistory.length; ci++) {
                var hEntry = actionHistory[ci]
                if (hEntry && hEntry.doorKey) {
                  crashPaths.push({ fingerprint: hEntry.fingerprint, doorKey: hEntry.doorKey })
                  fatalDoors[hEntry.doorKey] = (fatalDoors[hEntry.doorKey] || 0) + 1
                }
              }
              log('检测到应用脱离前台/崩溃，重启目标应用（已记录崩溃路径 ' + crashPaths.length + ' 条）')
              return clearLogcat(serial)
                .then(function() { return startApp(serial, packageName) })
                .then(function() {
                  stats.recoveryCount += 1
                  stats.stepsExecuted += 1
                  memory.totalSteps = stats.stepsExecuted
                  // Task 6: Wait 2s after crash restart for app to fully load
                  return Promise.delay(2000)
                })
                .then(function() { return syncProgress().then(function() { return true }) })
            }
          }

          memory.totalSteps = stats.stepsExecuted

          // Task 7: Determine input mode based on progress
          var inputMode = 'normal'
          if (maxSteps > 0 && stats.stepsExecuted >= maxSteps * 0.7) {
            inputMode = 'boundary'
          }

          var action = strategy.decideNextAction(page, memory, {
            maxTriesPerDoor: maxTriesPerDoor
          , includeRisky: includeRisky
          , screenW: displaySize.w
          , screenH: displaySize.h
          , credentials: credentials
          , crashPaths: crashPaths
          , inputMode: inputMode
          })
          if (!action) {
            log('已无可用动作，结束')
            return false
          }

          // Task 6: Skip fatal doors (crashed >= 2 times on same door)
          if (action.door && fatalDoors[action.door.key] >= 2) {
            log('跳过致命门 ' + (action.door.text || action.door.key) + ' (已崩溃' + fatalDoors[action.door.key] + '次)')
            stats.stepsExecuted += 1
            memory.totalSteps = stats.stepsExecuted
            return syncProgress().then(function() { return true })
          }
          log('Step #' + (stats.stepsExecuted + 1) + ' page=' + page.fingerprint.slice(0, 8) +
            ' act=' + describeAction(action))
          var histEntry = {
            step: stats.stepsExecuted
          , type: action.type
          , x: action.x || 0
          , y: action.y || 0
          , text: action.text || ''
          , durationMs: action.durationMs || 0
          , doorKey: action.door ? action.door.key : ''
          , doorLabel: action.door ? (action.door.text || action.door.contentDesc || action.door.resourceId || '') : ''
          , fingerprint: page.fingerprint
          , activity: page.activity || ''
          , timestamp: now()
          }
          if (action.type === 'swipe') {
            histEntry.x1 = action.x1 || 0
            histEntry.y1 = action.y1 || 0
            histEntry.x2 = action.x2 || 0
            histEntry.y2 = action.y2 || 0
          }
          actionHistory.push(histEntry)
          if (actionHistory.length > 500) {
            actionHistory = actionHistory.slice(-400)
          }
          return executeAction(action)
            .then(function() {
              // Fixed delay after action (uiautomator dump is too slow for dynamic stability check)
              // tap/input: 800ms for UI animation to settle
              // back/swipe: 600ms (simpler transitions)
              var waitMs = (action.type === 'back' || action.type === 'swipe') ? 600 : 800
              return Promise.delay(waitMs)
            })
            .then(function() {
              stats.stepsExecuted += 1
              return syncProgress().then(function() { return true })
            })
            .catch(function(err) {
              log('动作执行失败: ' + (err && err.message ? err.message : String(err)))
              stats.stepsExecuted += 1
              return syncProgress().then(function() { return true })
            })
        })
      })
    }).catch(function(err) {
      log('快照失败: ' + (err && err.message ? err.message : String(err)))
      stats.stepsExecuted += 1
      return Promise.delay(800).then(function() { return true })
    })
    }) // end checkStopped
  }

  function loop() {
    return step().then(function(cont) {
      if (cont) { return loop() }
      return null
    })
  }

  return getDisplaySize(serial)
    .then(function(sz) {
      displaySize = sz
      log('设备屏幕 ' + sz.w + 'x' + sz.h)
      return clearLogcat(serial)
    })
    .then(function() {
      if (skipLaunch) {
        log('跳过启动应用（已登录模式）')
        return null
      }
      if (opts.initialMemory) {
        log('从历史记忆继续探索 (已知页面: ' + Object.keys(memory.pages).length + ')')
      }
      log('启动目标应用 ' + packageName)
      return startApp(serial, packageName)
    })
    .then(function() {
      // Execute pre-login steps if provided
      if (!preSteps.length) {
        return null
      }
      log('执行预置步骤 (' + preSteps.length + ' 步)...')
      return preSteps.reduce(function(prev, ps, idx) {
        return prev.then(function() {
          var delay = Number(ps.delay) || 800
          var desc = ps.description || ps.action || ('step ' + idx)
          log('  preStep #' + (idx + 1) + ': ' + desc)
          var p
          switch (ps.action) {
            case 'tap':
              p = tap(serial, ps.x, ps.y)
              break
            case 'longTap':
              p = longTap(serial, ps.x, ps.y, ps.duration || 700)
              break
            case 'input':
              p = tap(serial, ps.x, ps.y)
                .delay(150)
                .then(function() { return shell(serial, 'input text "' + (ps.text || '') + '"') })
              break
            case 'swipe':
              p = swipe(serial, ps.x1 || ps.x, ps.y1 || ps.y, ps.x2, ps.y2, ps.duration || 350)
              break
            case 'back':
              p = pressKey(serial, 4)
              break
            case 'home':
              p = pressKey(serial, 3)
              break
            case 'wait':
              p = Promise.delay(ps.ms || 1000)
              break
            case 'clearAndInput':
              p = tap(serial, ps.x, ps.y)
                .delay(150)
                .then(function() { return shell(serial, 'input keyevent 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67 67') })
                .delay(100)
                .then(function() { return shell(serial, 'input text "' + (ps.text || '') + '"') })
              break
            default:
              p = Promise.resolve()
          }
          return p.then(function() { return Promise.delay(delay) })
        })
      }, Promise.resolve())
    })
    .then(function() {
      log('开始探索 (maxSteps=' + maxSteps + ', maxMinutes=' +
        Math.round(maxMs / 60000) + ', maxTriesPerDoor=' + maxTriesPerDoor + ')')
      return loop()
    })
    .then(function() { return syncProgress() })
    .then(function() {
      return {
        stats: stats
      , artifacts: artifacts
      , logLines: logLines
      , pages: pageList
      , errors: errors
      , actionHistory: actionHistory
      , explorerMemory: memory
      }
    })
}

/**
 * Public API: run exploration on multiple devices in parallel and persist results.
 *
 * @param {object} run     newly inserted automationExplorerRuns row
 * @param {Array}  serials list of device serials
 */
module.exports.runExplorer = function(run, serials) {
  var startedAt = now()
  var deviceRows = serials.map(function(serial) {
    return {
      id: uuid.v4()
    , runId: run.id
    , serial: serial
    , status: 'running'
    , result: '执行中'
    , stepsExecuted: 0
    , pagesDiscovered: 0
    , doorsClicked: 0
    , crashCount: 0
    , anrCount: 0
    , errorKeywordCount: 0
    , stuckCount: 0
    , notForegroundCount: 0
    , recoveryCount: 0
    , currentFingerprint: ''
    , currentActivity: ''
    , error: null
    , reportArtifacts: []
    , executionLog: ''
    , pages: []
    , startedAt: startedAt
    , endedAt: null
    , createdAt: startedAt
    , updatedAt: startedAt
    }
  })

  function finalizeRun(statusOverride) {
    var endedAt = now()
    return db.run(r.table('automationExplorerRuns').get(run.id).getField('status'))
      .then(function(currentStatus) {
        // If run was stopped/stopping, use 'stopped' as final status
        var effectiveOverride = statusOverride
        if (!effectiveOverride && (currentStatus === 'stopping' || currentStatus === 'stopped')) {
          effectiveOverride = 'stopped'
        }
        return db.run(r.table('automationExplorerRunDevices').getAll(run.id, { index: 'runId' }))
          .then(function(cursor) { return cursor.toArray() })
          .then(function(rows) {
            var failed = rows.some(function(d) {
              return d.status === 'failed' || (d.crashCount || 0) > 0 ||
                (d.anrCount || 0) > 0 || (d.errorKeywordCount || 0) > 0
            })
            var status = effectiveOverride || (failed ? 'failed' : 'finished')
            var totalPages = rows.reduce(function(s, d) { return s + (d.pagesDiscovered || 0) }, 0)
            var totalSteps = rows.reduce(function(s, d) { return s + (d.stepsExecuted || 0) }, 0)
            var totalIssues = rows.reduce(function(s, d) {
              return s + (d.crashCount || 0) + (d.anrCount || 0) + (d.errorKeywordCount || 0) + (d.stuckCount || 0)
            }, 0)
            var runForReport = Object.assign({}, run, {
              status: status
            , endedAt: endedAt
            , totalPages: totalPages
            , totalSteps: totalSteps
            , totalIssues: totalIssues
            })
            var html = reportHtml.buildExplorerTestReportHtml
              ? reportHtml.buildExplorerTestReportHtml(runForReport, rows)
              : '<html><body><pre>' + JSON.stringify({run: runForReport}).replace(/</g, '&lt;') + '</pre></body></html>'
            return db.run(r.table('automationExplorerRuns').get(run.id).update({
              status: status
            , reportAvailable: true
            , reportHtml: html
            , totalPages: totalPages
            , totalSteps: totalSteps
            , totalIssues: totalIssues
            , endedAt: endedAt
            , updatedAt: endedAt
            }))
          })
      })
  }

  return db.run(r.table('automationExplorerRunDevices').insert(deviceRows))
    .then(function() {
      return Promise.map(deviceRows, function(row) {
        return exploreOnDevice(run, row.serial, {
          packageName: run.packageName
        , maxSteps: run.maxSteps
        , maxMinutes: run.maxMinutes
        , maxTriesPerDoor: run.maxTriesPerDoor
        , includeRisky: run.includeRisky
        , stuckThreshold: run.stuckThreshold
        , errorKeywords: run.errorKeywords
        , captureEverySteps: run.captureEverySteps
        , credentials: run.credentials || null
        , preSteps: run.preSteps || []
        , skipLaunch: !!run.skipLaunch
        , initialMemory: run.initialMemory || null
        })
          .then(function(result) {
            var endedAt = now()
            var hasFailure = result.errors && result.errors.length > 0
            return db.run(r.table('automationExplorerRunDevices').get(row.id).update({
              status: 'finished'
            , result: hasFailure ? '失败' : '成功'
            , error: hasFailure ? result.errors.slice(0, 3).join('; ') : ''
            , stepsExecuted: result.stats.stepsExecuted
            , pagesDiscovered: result.stats.pagesDiscovered
            , doorsClicked: result.stats.doorsClicked
            , crashCount: result.stats.crashCount
            , anrCount: result.stats.anrCount
            , errorKeywordCount: result.stats.errorKeywordCount
            , stuckCount: result.stats.stuckCount
            , notForegroundCount: result.stats.notForegroundCount
            , recoveryCount: result.stats.recoveryCount
            , reportArtifacts: result.artifacts || []
            , executionLog: (result.logLines || []).join('\n')
            , pages: result.pages || []
            , actionHistory: result.actionHistory || []
            , explorerMemory: result.explorerMemory ? JSON.stringify(result.explorerMemory) : null
            , endedAt: endedAt
            , updatedAt: endedAt
            }))
          })
          .catch(function(err) {
            var endedAt = now()
            var msg = err && err.message ? err.message : String(err)
            return captureScreencapDataUrl(row.serial).then(function(shot) {
              var arts = []
              if (shot) {
                arts.push({
                  type: 'fatal'
                , title: '探索失败 - 设备异常'
                , detail: msg
                , actualImageDataUrl: shot
                })
              }
              return db.run(r.table('automationExplorerRunDevices').get(row.id).update({
                status: 'failed'
              , result: '失败'
              , error: msg
              , reportArtifacts: arts
              , executionLog: now() + ' [ERROR] ' + msg
              , endedAt: endedAt
              , updatedAt: endedAt
              }))
            }).catch(function() {
              return db.run(r.table('automationExplorerRunDevices').get(row.id).update({
                status: 'failed'
              , result: '失败'
              , error: msg
              , endedAt: endedAt
              , updatedAt: endedAt
              }))
            })
          })
      }, { concurrency: 3 }).then(function() {
        return finalizeRun()
      })
    })
    .catch(function(err) {
      var endedAt = now()
      var failMsg = err && err.message ? err.message : String(err)
      return db.run(r.table('automationExplorerRuns').get(run.id).update({
        status: 'failed'
      , reportAvailable: true
      , reportHtml: buildFailedReportHtml(failMsg)
      , endedAt: endedAt
      , updatedAt: endedAt
      }))
    })
}

module.exports._internals = {
  exploreOnDevice: exploreOnDevice
, dumpUi: dumpUi
, parsePage: uiparser.parsePage
}
