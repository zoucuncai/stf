require('./recorder.css')

var automationVars = require('../../../../../lib/util/automation-variables')
var expandAutomationVariables = automationVars.expandAutomationVariables
var normalizeAutomationInputText = automationVars.normalizeAutomationInputText
var rgbaByteArraysSimilarity = require('../../../../../lib/util/automation-visual-similarity')
  .rgbaByteArraysSimilarity

module.exports = angular.module('stf.automation.recorder', [
  require('stf/storage').name
])
  .controller('AutomationRecorderCtrl', function($scope, $http, $timeout, $q, $window, StorageService) {
    var stepSeq = 0

    function nextStepId() {
      return 'st' + (++stepSeq)
    }

    $scope.tapOrdinalForStep = function(steps, index) {
      var n = 0
      for (var i = 0; i <= index && i < (steps || []).length; i++) {
        if (steps[i].action === 'tap') {
          n += 1
        }
      }
      return n
    }

    $scope.swipeOrdinalForStep = function(steps, index) {
      var n = 0
      for (var i = 0; i <= index && i < (steps || []).length; i++) {
        if (steps[i].action === 'swipe') {
          n += 1
        }
      }
      return n
    }

    $scope.inputTextOrdinalForStep = function(steps, index) {
      var n = 0
      for (var i = 0; i <= index && i < (steps || []).length; i++) {
        if (steps[i].action === 'input_text') {
          n += 1
        }
      }
      return n
    }

    // Must match device-side SeqQueue: seq is used as slot index and must stay in [0, 99)
    // (see lib/wire/seqqueue.js size=100). Values >= 100 are dropped — this was why replay did nothing.
    // Also mirror mouse path in screen-directive: startMousing -> gestureStop after each tap.
    function performRecordedTap(control, xP, yP) {
      var seq = -1
      var cycle = 100
      function nextSeq() {
        return ++seq >= cycle ? (seq = 0) : seq
      }
      var pressure = 0.5
      control.gestureStart(nextSeq())
      control.touchDown(nextSeq(), 0, xP, yP, pressure)
      control.touchCommit(nextSeq())
      return $timeout(function() {
        control.touchUp(nextSeq(), 0)
        control.touchCommit(nextSeq())
        control.gestureStop(nextSeq())
      }, 120)
    }

    function performRecordedSwipe(control, step) {
      var x1P = Number(step.x1P)
      var y1P = Number(step.y1P)
      var x2P = Number(step.x2P)
      var y2P = Number(step.y2P)
      if (isNaN(x1P) || isNaN(y1P) || isNaN(x2P) || isNaN(y2P)) {
        return $q.when()
      }
      var durationMs = Number(step.durationMs)
      if (!isFinite(durationMs) || durationMs < 50) {
        durationMs = 300
      }
      if (durationMs > 8000) {
        durationMs = 8000
      }
      var seq = -1
      var cycle = 100
      function nextSeq() {
        return ++seq >= cycle ? (seq = 0) : seq
      }
      var pressure = 0.5
      var n = Math.max(3, Math.min(24, Math.ceil(durationMs / 45)))
      var sliceMs = Math.max(10, Math.floor(durationMs / n))

      control.gestureStart(nextSeq())
      control.touchDown(nextSeq(), 0, x1P, y1P, pressure)
      control.touchCommit(nextSeq())

      var chain = $q.when()
      var k
      for (k = 1; k <= n; k++) {
        ;(function(j) {
          chain = chain.then(function() {
            var t = j / n
            var xP = x1P + (x2P - x1P) * t
            var yP = y1P + (y2P - y1P) * t
            control.touchMove(nextSeq(), 0, xP, yP, pressure)
            control.touchCommit(nextSeq())
            return $timeout(angular.noop, sliceMs)
          })
        })(k)
      }
      return chain.then(function() {
        control.touchUp(nextSeq(), 0)
        control.touchCommit(nextSeq())
        control.gestureStop(nextSeq())
      })
    }

    function resolveControl() {
      if ($scope.control) {
        return $scope.control
      }
      var p = $scope.$parent
      for (var i = 0; i < 16 && p; i++) {
        if (p.control) {
          return p.control
        }
        p = p.$parent
      }
      return null
    }

    function collectShellOutput(txResult) {
      if (!txResult) return ''
      var data = txResult.data
      if (Array.isArray(data)) {
        // TransactionService splits streaming output into chunks; join them.
        return data.filter(function(x) {
          return x != null
        }).join('')
      }
      if (txResult.lastData != null) {
        return String(txResult.lastData)
      }
      return ''
    }

    function dumpUiAutomatorXml(control) {
      // Dump to a known location and read back via shell.
      // Note: this is Android-dependent; failures will propagate to caller.
      var cmd = 'uiautomator dump /sdcard/uidump.xml && cat /sdcard/uidump.xml'
      return control.shell(cmd, 20000).then(function(txRes) {
        var out = collectShellOutput(txRes)
        if (!out) {
          throw new Error('uiautomator dump 输出为空')
        }
        return out
      })
    }

    function assertTextContains(control, expectedText) {
      var expected = String(expectedText || '')
      if (!expected) {
        return $q.reject(new Error('assert_text_contains: expectedText 为空'))
      }
      return dumpUiAutomatorXml(control).then(function(xml) {
        // Be strict: match only against visible text attributes, not against the whole XML blob.
        // This prevents false positives (e.g. expected="111" matching other attributes like resource-id).
        var re = /(?:text|content-desc)\s*=\s*"([^"]*)"/g
        var m
        var found = false
        while ((m = re.exec(xml)) !== null) {
          var v = m[1] || ''
          if (v.indexOf(expected) !== -1) {
            found = true
            break
          }
        }

        if (found) {
          return true
        }
        throw new Error('文本断言失败：未找到 "' + expected + '"')
      })
    }

    function withTimeout(promise, ms, label) {
      ms = Number(ms)
      if (!isFinite(ms) || ms <= 0) {
        return promise
      }
      return $q(function(resolve, reject) {
        var done = false
        var timer = $timeout(function() {
          if (done) return
          done = true
          reject(new Error((label || '操作') + ' 超时(' + ms + 'ms)'))
        }, ms)

        $q.when(promise)
          .then(function(v) {
            if (done) return
            done = true
            $timeout.cancel(timer)
            resolve(v)
          })
          .catch(function(err) {
            if (done) return
            done = true
            $timeout.cancel(timer)
            reject(err)
          })
      })
    }

    function resolveBrowserAssetUrl(href) {
      var h = String(href || '').trim()
      if (!h) {
        return ''
      }
      if (/^https?:\/\//i.test(h)) {
        return h
      }
      if (h[0] !== '/') {
        return $window.location.origin + '/' + h
      }
      return $window.location.origin + h
    }

    function loadImageFromHttpUrl(absUrl) {
      return $http.get(absUrl, {responseType: 'arraybuffer'}).then(function(res) {
        var ct = (res.headers && res.headers('content-type')) || 'image/jpeg'
        var mime = String(ct).indexOf('image/') === 0 ? ct : 'image/jpeg'
        var blob = new Blob([res.data], {type: mime})
        return $q(function(resolve, reject) {
          var o = $window.URL.createObjectURL(blob)
          var img = new $window.Image()
          img.onload = function() {
            $window.URL.revokeObjectURL(o)
            resolve(img)
          }
          img.onerror = function() {
            $window.URL.revokeObjectURL(o)
            reject(new Error('基线图加载失败'))
          }
          img.src = o
        })
      })
    }

    function loadImageFromDataUrl(dataUrl) {
      return $q(function(resolve, reject) {
        var img = new $window.Image()
        img.onload = function() {
          resolve(img)
        }
        img.onerror = function() {
          reject(new Error('当前画面图加载失败'))
        }
        img.src = dataUrl
      })
    }

    function compareReplayImagesSimilarity(imgA, imgB, grid) {
      grid = grid || 64
      var canvas = $window.document.createElement('canvas')
      canvas.width = grid
      canvas.height = grid
      var ctx = canvas.getContext('2d')
      if (!ctx) {
        return 0
      }
      ctx.drawImage(imgA, 0, 0, grid, grid)
      var d1 = ctx.getImageData(0, 0, grid, grid).data
      ctx.clearRect(0, 0, grid, grid)
      ctx.drawImage(imgB, 0, 0, grid, grid)
      var d2 = ctx.getImageData(0, 0, grid, grid).data
      return rgbaByteArraysSimilarity(d1, d2)
    }

    function replayImageToDataUrl(img) {
      if (!img) {
        return null
      }
      try {
        var c = $window.document.createElement('canvas')
        var w = img.naturalWidth || img.width || 1
        var h = img.naturalHeight || img.height || 1
        c.width = w
        c.height = h
        var ctx = c.getContext('2d')
        if (!ctx) {
          return null
        }
        ctx.drawImage(img, 0, 0)
        return c.toDataURL('image/jpeg', 0.88)
      }
      catch (e) {
        return null
      }
    }

    function formatReplayErr(err) {
      if (err == null) {
        return '未知错误'
      }
      if (typeof err === 'string') {
        return err
      }
      if (err.message) {
        return String(err.message)
      }
      if (err.data != null) {
        if (typeof err.data === 'string') {
          return err.data
        }
        if (err.data.description) {
          return String(err.data.description)
        }
        if (err.data.error) {
          return String(err.data.error)
        }
      }
      if (err.status) {
        return 'HTTP ' + err.status + (err.statusText ? ' ' + err.statusText : '')
      }
      try {
        return JSON.stringify(err)
      }
      catch (e2) {
        return String(err)
      }
    }

    function captureReplayScreenDataUrl() {
      return $q(function(resolve) {
        var canvas = document.querySelector('.remote-control canvas.screen') ||
          document.querySelector('canvas.screen')
        if (canvas && canvas.width > 2 && canvas.height > 2 && typeof canvas.toDataURL === 'function') {
          try {
            resolve(canvas.toDataURL('image/jpeg', 0.82))
            return
          }
          catch (e) {
            resolve(null)
            return
          }
        }
        var ctrl = resolveControl()
        if (!ctrl || !ctrl.screenshot) {
          resolve(null)
          return
        }
        ctrl.screenshot().then(function(result) {
          var href = result && result.body && result.body.href
          if (!href) {
            resolve(null)
            return
          }
          if (String(href).indexOf('data:') === 0) {
            resolve(href)
            return
          }
          $http.get(href, {responseType: 'arraybuffer'}).then(function(res) {
            var blob = new Blob([res.data], {type: 'image/jpeg'})
            var reader = new FileReader()
            reader.onload = function() {
              resolve(reader.result)
            }
            reader.onerror = function() {
              resolve(null)
            }
            reader.readAsDataURL(blob)
          }).catch(function() {
            resolve(null)
          })
        }).catch(function() {
          resolve(null)
        })
      })
    }

    var DEFAULT_STEP_DELAY_MS = 500

    function shouldApplyStepPreDelay(action) {
      var a = String(action || '').trim()
      return a === 'tap' || a === 'swipe' || a === 'input_text' ||
        a === 'assert_text_contains' || a === 'assert_visual_match'
    }

    function resolveStepPreDelayMs(step) {
      var ms = Number(step && step.stepDelayMs)
      if (!isFinite(ms) || ms < 0) {
        ms = DEFAULT_STEP_DELAY_MS
      }
      if (ms > 120000) {
        ms = 120000
      }
      return ms
    }

    function evaluateReplaySteps(recording) {
      var control = resolveControl()
      if (!control) {
        return $q.reject(new Error('设备控制不可用'))
      }
      var steps = (recording && recording.stepsJson) || []
      var totalCases = 0
      var successCases = 0
      var errors = []
      var logLines = []
      var reportArtifacts = []

      function log(msg) {
        logLines.push(new Date().toISOString() + ' [INFO] ' + msg)
      }

      function stepKindLabel(step, idx) {
        var a = (step && step.action) ? String(step.action).trim() : ''
        if (a === 'tap') {
          return '点击'
        }
        if (a === 'swipe') {
          return '滑动'
        }
        if (a === 'assert_text_contains') {
          return '文字断言'
        }
        if (a === 'assert_visual_match') {
          return '视觉断言'
        }
        if (a === 'wait') {
          return '等待'
        }
        if (a === 'input_text') {
          return '文本输入'
        }
        return a || ('步骤' + idx)
      }

      function pushFailureArtifact(step, idx, errMsg, extras) {
        extras = extras || {}
        var st = extras.stepTitle || stepKindLabel(step, idx)
        var title = '失败 #' + (reportArtifacts.length + 1) + ' - 步骤' + idx + ': ' + st
        return captureReplayScreenDataUrl().then(function(dataUrl) {
          var art = {
            title: title
          , detail: errMsg
          , actualImageDataUrl: dataUrl
          }
          if (extras.expectedText != null) {
            art.expectedText = extras.expectedText
          }
          if (extras.expectedImageHref != null) {
            art.expectedImageHref = extras.expectedImageHref
          }
          if (extras.expectedImageDataUrl != null) {
            art.expectedImageDataUrl = extras.expectedImageDataUrl
          }
          if (extras.baselineIndex != null) {
            art.baselineIndex = extras.baselineIndex
          }
          reportArtifacts.push(art)
        })
      }

      return steps.reduce(function(prev, step, idx) {
        return prev.then(function() {
          var action = (step && step.action) ? String(step.action).trim() : ''
          log('步骤 ' + idx + ' 开始 ' + action)

          function innerStep() {
          if (action === 'wait') {
            var waitMs = Number(step.waitMs || 0)
            if (!isFinite(waitMs) || waitMs <= 0) {
              return $timeout(angular.noop, 0)
            }
            return $timeout(angular.noop, waitMs).then(function() {
              log('步骤 ' + idx + ' 等待结束 ' + waitMs + 'ms')
            })
          }

          if (action === 'tap') {
            var xP = Number(step.xP)
            var yP = Number(step.yP)
            if (isNaN(xP) || isNaN(yP)) {
              return $timeout(angular.noop, 0)
            }
            return performRecordedTap(control, xP, yP)
              .then(function() {
                return $timeout(angular.noop, 280)
              })
              .then(function() {
                log('步骤 ' + idx + ' tap 完成')
              })
              .catch(function(err) {
                var msg = err && err.message ? err.message : String(err)
                errors.push(msg)
                log('步骤 ' + idx + ' tap 失败 ' + msg)
                return pushFailureArtifact(step, idx, msg, {stepTitle: '点击执行失败'})
              })
          }

          if (action === 'swipe') {
            return performRecordedSwipe(control, step)
              .then(function() {
                return $timeout(angular.noop, 320)
              })
              .then(function() {
                log('步骤 ' + idx + ' swipe 完成')
              })
              .catch(function(err) {
                var msg = err && err.message ? err.message : String(err)
                errors.push(msg)
                log('步骤 ' + idx + ' swipe 失败 ' + msg)
                return pushFailureArtifact(step, idx, msg, {stepTitle: '滑动执行失败'})
              })
          }

          if (action === 'input_text') {
            var ixP = Number(step.xP)
            var iyP = Number(step.yP)
            var rawIn = (step.inputText != null ? String(step.inputText) : '').trim()
            if (!rawIn) {
              log('步骤 ' + idx + ' input_text 跳过（无文本）')
              return $timeout(angular.noop, 0)
            }
            var toType = normalizeAutomationInputText(expandAutomationVariables(rawIn))
            if (isNaN(ixP) || isNaN(iyP)) {
              return $timeout(angular.noop, 0)
            }
            return performRecordedTap(control, ixP, iyP)
              .then(function() {
                return $timeout(angular.noop, 380)
              })
              .then(function() {
                // Paste avoids IME turning ASCII "." into "。" (DoType / synthetic keys).
                return control.paste(toType)
                  .then(function(res) {
                    if (res && res.success) {
                      return $timeout(angular.noop, 400)
                    }
                    control.type(toType)
                    return $timeout(angular.noop, 220)
                  })
                  .catch(function() {
                    control.type(toType)
                    return $timeout(angular.noop, 220)
                  })
              })
              .then(function() {
                log('步骤 ' + idx + ' 文本输入完成 len=' + String(toType).length)
              })
              .catch(function(err) {
                var msg = err && err.message ? err.message : String(err)
                errors.push(msg)
                log('步骤 ' + idx + ' 文本输入失败 ' + msg)
                return pushFailureArtifact(step, idx, msg, {stepTitle: '文本输入失败'})
              })
          }

          if (action === 'assert_text_contains') {
            totalCases += 1
            var expected = expandAutomationVariables((step.expectedText || '').trim())
            return withTimeout(assertTextContains(control, expected), 12000, '文本断言')
              .then(function() {
                successCases += 1
                log('步骤 ' + idx + ' 文本断言通过')
                return $timeout(angular.noop, 350)
              })
              .catch(function(err) {
                var em = err && err.message ? err.message : ('文本断言失败：' + expected)
                errors.push(em)
                log('步骤 ' + idx + ' 文本断言失败 ' + em)
                return pushFailureArtifact(step, idx, em, {
                  expectedText: expected
                , stepTitle: '文字断言失败'
                })
              })
          }

          if (action === 'assert_visual_match') {
            totalCases += 1
            var vMetaList = (recording && recording.baselinesMeta) || []
            var vBi = Number(step.baselineIndex)
            var vMeta = (isFinite(vBi) && vBi >= 0 && vBi < vMetaList.length) ? vMetaList[vBi] : null
            var vTh = vMeta && vMeta.threshold != null ? Number(vMeta.threshold) : 0.95
            if (!isFinite(vTh) || vTh <= 0) {
              vTh = 0.95
            }
            if (vTh > 1) {
              vTh = 1
            }
            if (!vMeta || (!vMeta.href && !vMeta.inlineDataUrl)) {
              var vMiss = '视觉断言失败：基线不存在(baselineIndex=' + step.baselineIndex + ')'
              errors.push(vMiss)
              log('步骤 ' + idx + ' ' + vMiss)
              return pushFailureArtifact(step, idx, vMiss, {
                stepTitle: '视觉断言失败'
              , expectedImageHref: vMeta && vMeta.href
              , baselineIndex: step.baselineIndex
              })
            }
            var vAbs = vMeta.href ? resolveBrowserAssetUrl(vMeta.href) : ''
            var vBaselineImgRef = null
            function loadBaselineForReplay() {
              if (vMeta.inlineDataUrl) {
                return loadImageFromDataUrl(vMeta.inlineDataUrl).then(function(baselineImg) {
                  vBaselineImgRef = baselineImg
                  return baselineImg
                })
              }
              return loadImageFromHttpUrl(vAbs).then(function(baselineImg) {
                vBaselineImgRef = baselineImg
                return baselineImg
              })
            }
            return withTimeout(
              loadBaselineForReplay().then(function() {
                return captureReplayScreenDataUrl().then(function(actualDataUrl) {
                  if (!actualDataUrl) {
                    throw new Error('无法捕获当前画面')
                  }
                  return loadImageFromDataUrl(actualDataUrl).then(function(actualImg) {
                    var bImg = vBaselineImgRef
                    var vScore = compareReplayImagesSimilarity(bImg, actualImg)
                    if (vScore < vTh) {
                      throw new Error('相似度 ' + vScore.toFixed(3) + ' < 阈值 ' + vTh.toFixed(3))
                    }
                    return vScore
                  })
                })
              })
            , 20000
            , '视觉断言'
            ).then(function(vScore) {
              successCases += 1
              log('步骤 ' + idx + ' 视觉断言通过 相似度=' + Number(vScore).toFixed(4) +
                ' 阈值>=' + vTh.toFixed(3))
              return $timeout(angular.noop, 200)
            }).catch(function(err) {
              var vm = formatReplayErr(err)
              if (vm.indexOf('相似度') === -1 && vm.indexOf('阈值') === -1) {
                vm = '视觉断言失败：' + vm
              }
              errors.push(vm)
              log('步骤 ' + idx + ' ' + vm)
              var embedded = vBaselineImgRef ? replayImageToDataUrl(vBaselineImgRef) : null
              if (!embedded && vMeta.inlineDataUrl) {
                embedded = vMeta.inlineDataUrl
              }
              return pushFailureArtifact(step, idx, vm, {
                stepTitle: '视觉断言失败'
              , expectedImageHref: vMeta.href
              , expectedImageDataUrl: embedded
              , baselineIndex: step.baselineIndex
              })
            })
          }

          return $timeout(angular.noop, 0)
          }

          if (shouldApplyStepPreDelay(action)) {
            var pdMs = resolveStepPreDelayMs(step)
            if (pdMs <= 0) {
              return innerStep()
            }
            return $timeout(angular.noop, pdMs).then(function() {
              log('步骤 ' + idx + ' 前置延时 ' + pdMs + 'ms')
              return innerStep()
            })
          }
          return innerStep()
        })
      }, $q.when()).then(function() {
        return {
          totalCases: totalCases
        , successCases: successCases
        , errors: errors
        , logLines: logLines
        , reportArtifacts: reportArtifacts
        }
      })
    }

    $scope.recordingForm = {name: ''}
    $scope.recordingSteps = []
    $scope.recordingActive = false
    $scope.recordingLocked = false
    $scope.recordingBaselinesMeta = []
    $scope.recordings = []
    $scope.recordingError = ''
    $scope.baselineBusy = false

    $scope.replayState = {
      running: false
    , launching: false
    , runId: null
    , progressDone: 0
    , progressTotal: 0
    , status: ''
    , passRate: 0
    , caseSuccessRate: 0
    , reportTotalCases: 0
    , startedAt: ''
    , endedAt: ''
    , error: ''
    }

    $scope.selectedRecordingId = ''
    $scope.libraryEdit = null
    $scope.recordingNameTaken = false
    // Replay runs started from this device detail (same columns as 自动化测试记录).
    $scope.detailReplayRows = []

    $scope.currentReplayRecordingId = ''
    $scope.currentReplayStepsSummary = ''

    $scope.stepEdit = null
    $scope.draggingStepIndex = null
    $scope.dropTargetStepIndex = null
    $scope.dragStepContext = null

    function reorderableRangeFor(steps) {
      steps = steps || []
      var n = steps.length
      if (n < 2) {
        return {min: 1, max: -1}
      }
      var last = steps[n - 1]
      var hasStop = last && String(last.action || '').trim() === 'stop'
      var max = hasStop ? n - 2 : n - 1
      return {min: 1, max: max}
    }

    function stepsForReorderContext(ctx) {
      ctx = ctx || 'recording'
      if (ctx === 'library') {
        return ($scope.libraryEdit && $scope.libraryEdit.steps) || []
      }
      return $scope.recordingSteps || []
    }

    $scope.canReorderStepAt = function(i, ctx) {
      var r = reorderableRangeFor(stepsForReorderContext(ctx))
      return i >= r.min && i <= r.max
    }

    $scope.onStepDragStart = function(e, index, ctx) {
      ctx = ctx || 'recording'
      if (!$scope.canReorderStepAt(index, ctx)) {
        e.preventDefault()
        return
      }
      $scope.dragStepContext = ctx
      $scope.draggingStepIndex = index
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', String(index))
    }

    $scope.onStepDragEnd = function() {
      $scope.draggingStepIndex = null
      $scope.dropTargetStepIndex = null
      $scope.dragStepContext = null
      $scope.$applyAsync(angular.noop)
    }

    $scope.onStepDragOverRow = function(e, index, ctx) {
      ctx = ctx || 'recording'
      if ($scope.draggingStepIndex == null || $scope.dragStepContext !== ctx) {
        return
      }
      if (!$scope.canReorderStepAt(index, ctx)) {
        return
      }
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      $scope.dropTargetStepIndex = index
    }

    $scope.onStepDragLeaveRow = function(e, index) {
      if ($scope.dropTargetStepIndex === index) {
        $scope.dropTargetStepIndex = null
      }
    }

    $scope.onStepDrop = function(e, dropIndex, ctx) {
      ctx = ctx || 'recording'
      e.preventDefault()
      e.stopPropagation()
      var from = $scope.draggingStepIndex
      $scope.dropTargetStepIndex = null
      $scope.draggingStepIndex = null
      var dragCtx = $scope.dragStepContext
      $scope.dragStepContext = null
      if (dragCtx !== ctx) {
        return
      }
      if (from == null || from === dropIndex) {
        return
      }
      if (!$scope.canReorderStepAt(from, ctx) || !$scope.canReorderStepAt(dropIndex, ctx)) {
        return
      }
      var steps = stepsForReorderContext(ctx)
      var item = steps.splice(from, 1)[0]
      var to = dropIndex
      if (from < to) {
        to -= 1
      }
      steps.splice(to, 0, item)
      $scope.$applyAsync(angular.noop)
    }

    $scope.stepDisplayLabel = function(s) {
      if (!s || s.stepLabel == null) {
        return ''
      }
      return String(s.stepLabel).trim()
    }

    $scope.inputTextStepPreview = function(s) {
      if (!s || String(s.action || '').trim() !== 'input_text') {
        return ''
      }
      var t = s.inputText != null ? String(s.inputText) : ''
      if (!t.trim()) {
        return '（未填文本）'
      }
      return t.length > 28 ? t.slice(0, 28) + '…' : t
    }

    $scope.baselineThresholdDisplay = function(s, metaListOverride) {
      if (!s || String(s.action || '').trim() !== 'assert_visual_match') {
        return ''
      }
      var metaArr = metaListOverride != null ? metaListOverride : $scope.recordingBaselinesMeta
      var meta = (metaArr || [])[s.baselineIndex]
      var t = meta && meta.threshold != null ? Number(meta.threshold) : 0.95
      return isFinite(t) ? t : 0.95
    }

    function editStepsArray(target) {
      if (target === 'library') {
        return ($scope.libraryEdit && $scope.libraryEdit.steps) || []
      }
      return $scope.recordingSteps
    }

    function editBaselinesArray(target) {
      if (target === 'library') {
        return ($scope.libraryEdit && $scope.libraryEdit.baselinesMeta) || []
      }
      return $scope.recordingBaselinesMeta
    }

    $scope.openStepEditor = function(index, editTarget) {
      editTarget = editTarget || 'recording'
      if (editTarget === 'library' && !$scope.libraryEdit) {
        return
      }
      var steps = editStepsArray(editTarget)
      if (index < 0 || index >= steps.length) {
        return
      }
      var step = steps[index]
      var canEdit = editTarget === 'library'
        ? $scope.canMutateLibraryStep(step)
        : $scope.canMutateStep(step)
      if (!canEdit) {
        return
      }
      var action = String(step.action || '').trim()
      var kind = null
      var draft = {}
      var actionLabel = action
      function delaySecondsFromStep(st) {
        var ms = Number(st && st.stepDelayMs)
        if (isFinite(ms) && ms >= 0) {
          return ms / 1000
        }
        return DEFAULT_STEP_DELAY_MS / 1000
      }
      if (action === 'tap') {
        kind = 'tap'
        draft = {
          stepLabel: step.stepLabel || ''
        , xP: Number(step.xP)
        , yP: Number(step.yP)
        , delaySeconds: delaySecondsFromStep(step)
        }
        actionLabel = 'tap'
      }
      else if (action === 'swipe') {
        kind = 'swipe'
        draft = {
          stepLabel: step.stepLabel || ''
        , x1P: Number(step.x1P)
        , y1P: Number(step.y1P)
        , x2P: Number(step.x2P)
        , y2P: Number(step.y2P)
        , durationMs: Number(step.durationMs) || 300
        , delaySeconds: delaySecondsFromStep(step)
        }
        actionLabel = 'swipe'
      }
      else if (action === 'wait') {
        kind = 'wait'
        draft = {
          stepLabel: step.stepLabel || ''
        , waitSeconds: (Number(step.waitMs) || 0) / 1000
        }
        actionLabel = 'wait'
      }
      else if (action === 'assert_text_contains') {
        kind = 'assert_text'
        draft = {
          stepLabel: step.stepLabel || ''
        , expectedText: step.expectedText || ''
        , delaySeconds: delaySecondsFromStep(step)
        }
        actionLabel = 'assert_text_contains'
      }
      else if (action === 'assert_visual_match') {
        kind = 'assert_visual'
        var vmeta = (editBaselinesArray(editTarget) || [])[step.baselineIndex]
        var vth = vmeta && vmeta.threshold != null ? Number(vmeta.threshold) : 0.95
        if (!isFinite(vth)) {
          vth = 0.95
        }
        draft = {
          stepLabel: step.stepLabel || ''
        , baselineIndex: Number(step.baselineIndex) || 0
        , threshold: vth
        , delaySeconds: delaySecondsFromStep(step)
        }
        actionLabel = 'assert_visual_match'
      }
      else if (action === 'input_text') {
        kind = 'input_text'
        draft = {
          stepLabel: step.stepLabel || ''
        , xP: Number(step.xP)
        , yP: Number(step.yP)
        , inputText: step.inputText != null ? String(step.inputText) : ''
        , delaySeconds: delaySecondsFromStep(step)
        }
        actionLabel = 'input_text'
      }
      else {
        return
      }
      $scope.stepEdit = {
        target: editTarget
      , index: index
      , kind: kind
      , actionLabel: actionLabel
      , draft: draft
      }
    }

    $scope.saveStepEditor = function() {
      var ed = $scope.stepEdit
      if (!ed || ed.index == null) {
        return
      }
      var target = ed.target || 'recording'
      var steps = editStepsArray(target)
      var step = steps[ed.index]
      var mutOk = target === 'library'
        ? $scope.canMutateLibraryStep(step)
        : $scope.canMutateStep(step)
      if (!step || !mutOk) {
        $scope.stepEdit = null
        return
      }
      var d = ed.draft || {}
      step.stepLabel = String(d.stepLabel || '').trim()
      if (ed.kind === 'tap') {
        var nx = Number(d.xP)
        var ny = Number(d.yP)
        if (!isNaN(nx) && !isNaN(ny)) {
          step.xP = nx
          step.yP = ny
        }
      }
      else if (ed.kind === 'swipe') {
        var x1 = Number(d.x1P)
        var y1 = Number(d.y1P)
        var x2 = Number(d.x2P)
        var y2 = Number(d.y2P)
        var dur = Number(d.durationMs)
        if (!isNaN(x1) && !isNaN(y1) && !isNaN(x2) && !isNaN(y2)) {
          step.x1P = x1
          step.y1P = y1
          step.x2P = x2
          step.y2P = y2
        }
        if (isFinite(dur) && dur >= 50 && dur <= 8000) {
          step.durationMs = Math.round(dur)
        }
      }
      else if (ed.kind === 'wait') {
        var sec = Number(d.waitSeconds)
        if (isFinite(sec) && sec >= 0) {
          step.waitMs = Math.round(sec * 1000)
        }
        delete step.stepDelayMs
      }
      else if (ed.kind === 'assert_text') {
        step.expectedText = String(d.expectedText || '').trim()
      }
      else if (ed.kind === 'input_text') {
        var ixp = Number(d.xP)
        var iyp = Number(d.yP)
        if (!isNaN(ixp) && !isNaN(iyp)) {
          step.xP = ixp
          step.yP = iyp
        }
        step.inputText = String(d.inputText != null ? d.inputText : '')
      }
      else if (ed.kind === 'assert_visual') {
        var metaList = editBaselinesArray(target) || []
        var bi0 = Number(d.baselineIndex)
        if (isFinite(bi0) && bi0 >= 0 && metaList.length) {
          var biClamped = Math.min(Math.floor(bi0), metaList.length - 1)
          step.baselineIndex = biClamped
        }
        var vmeta = metaList[step.baselineIndex]
        if (vmeta) {
          var th = Number(d.threshold)
          if (!isFinite(th) || th <= 0) {
            th = 0.95
          }
          if (th > 1) {
            th = 1
          }
          vmeta.threshold = th
        }
      }
      if (ed.kind !== 'wait') {
        var dsec = Number(d.delaySeconds)
        if (!isFinite(dsec) || dsec < 0) {
          dsec = DEFAULT_STEP_DELAY_MS / 1000
        }
        if (dsec > 120) {
          dsec = 120
        }
        step.stepDelayMs = Math.round(dsec * 1000)
      }
      step.timestamp = Date.now()
      $scope.stepEdit = null
    }

    $scope.cancelStepEditor = function() {
      $scope.stepEdit = null
    }

    $scope.insertStepAfter = function(afterIndex, kind, ctx) {
      ctx = ctx || 'recording'
      if (ctx === 'recording') {
        if (!$scope.recordingActive || $scope.recordingLocked) {
          return
        }
      }
      else if (ctx === 'library') {
        if (!$scope.libraryEdit) {
          return
        }
      }
      else {
        return
      }
      var steps = ctx === 'library' ? $scope.libraryEdit.steps : $scope.recordingSteps
      if (afterIndex < 0 || afterIndex >= steps.length) {
        return
      }
      var insertAt = afterIndex + 1
      var step = null
      if (kind === 'wait') {
        step = {
          _id: nextStepId()
        , action: 'wait'
        , waitMs: 1000
        , timestamp: Date.now()
        }
      }
      else if (kind === 'tap') {
        step = {
          _id: nextStepId()
        , action: 'tap'
        , xP: 0.5
        , yP: 0.5
        , stepDelayMs: DEFAULT_STEP_DELAY_MS
        , timestamp: Date.now()
        }
      }
      else if (kind === 'swipe') {
        step = {
          _id: nextStepId()
        , action: 'swipe'
        , x1P: 0.5
        , y1P: 0.65
        , x2P: 0.5
        , y2P: 0.35
        , durationMs: 400
        , stepDelayMs: DEFAULT_STEP_DELAY_MS
        , timestamp: Date.now()
        }
      }
      else if (kind === 'assert_text') {
        step = {
          _id: nextStepId()
        , action: 'assert_text_contains'
        , expectedText: ''
        , stepDelayMs: DEFAULT_STEP_DELAY_MS
        , timestamp: Date.now()
        }
      }
      if (!step) {
        return
      }
      steps.splice(insertAt, 0, step)
      $scope.$applyAsync(angular.noop)
    }

    $scope.insertInputTextAfter = function(afterIndex, ctx) {
      ctx = ctx || 'recording'
      if (ctx === 'recording') {
        if (!$scope.recordingActive || $scope.recordingLocked) {
          return
        }
      }
      else if (ctx === 'library') {
        if (!$scope.libraryEdit) {
          return
        }
      }
      else {
        return
      }
      var steps = ctx === 'library' ? $scope.libraryEdit.steps : $scope.recordingSteps
      if (afterIndex < 0 || afterIndex >= steps.length) {
        return
      }
      var insertAt = afterIndex + 1
      var prev = steps[afterIndex]
      var xP = 0.5
      var yP = 0.5
      if (prev && String(prev.action || '').trim() === 'tap') {
        xP = Number(prev.xP)
        yP = Number(prev.yP)
        if (isNaN(xP)) {
          xP = 0.5
        }
        if (isNaN(yP)) {
          yP = 0.5
        }
      }
      var step = {
        _id: nextStepId()
      , action: 'input_text'
      , xP: xP
      , yP: yP
      , inputText: ''
      , stepDelayMs: DEFAULT_STEP_DELAY_MS
      , timestamp: Date.now()
      }
      steps.splice(insertAt, 0, step)
      $scope.openStepEditor(insertAt, ctx)
      $scope.$applyAsync(angular.noop)
    }

    function buildStepsSummary(steps) {
      steps = Array.isArray(steps) ? steps : []
      return steps.map(function(step) {
        if (!step || !step.action) {
          return 'unknown'
        }
        var action = String(step.action).trim()
        if (action === 'tap') {
          return 'tap(' + step.xP + ',' + step.yP + ')'
        }
        if (action === 'swipe') {
          return 'swipe(' + step.x1P + ',' + step.y1P + '->' + step.x2P + ',' + step.y2P + ',' +
            (step.durationMs != null ? step.durationMs : '') + 'ms)'
        }
        if (action === 'assert_text_contains') {
          return 'assert_text_contains(' + (step.expectedText || '') + ')'
        }
        if (action === 'assert_visual_match') {
          return 'assert_visual_match(baseline=' + (step.baselineIndex != null ? step.baselineIndex : '') + ')'
        }
        if (action === 'wait') {
          return 'wait(' + (step.waitMs != null ? step.waitMs : 0) + 'ms)'
        }
        if (action === 'input_text') {
          return 'input_text(' + step.xP + ',' + step.yP + ',' + JSON.stringify(step.inputText || '') + ')'
        }
        return action
      }).join(' -> ')
    }

    $scope.recordingDropdownLabel = function(r) {
      if (!r) {
        return ''
      }
      var name = (r.name || '').trim() || '(未命名)'
      var t = r.createdAt ? String(r.createdAt).replace('T', ' ').slice(0, 19) : ''
      var idShort = (r.id || '').slice(0, 8)
      return name + (idShort ? ' · ' + idShort : '') + (t ? ' · ' + t : '')
    }

    $scope.validateRecordingName = function() {
      var n = ($scope.recordingForm.name || '').trim()
      $scope.recordingNameTaken = !!n && ($scope.recordings || []).some(function(r) {
        return (r.name || '').trim() === n
      })
    }

    function loadRecordings() {
      return $http.get('/api/v1/automation/recordings')
        .then(function(res) {
          $scope.recordings = res.data.recordings || []
          if ($scope.recordings.length) {
            // Keep selection stable across reloads by matching on id.
            if ($scope.selectedRecordingId) {
              var selectedId = String($scope.selectedRecordingId).trim()
              var exists = $scope.recordings.some(function(r) {
                return r && String(r.id || '').trim() === selectedId
              })
              if (!exists) {
                $scope.selectedRecordingId = $scope.recordings[0].id
              }
            }
            else {
              $scope.selectedRecordingId = $scope.recordings[0].id
            }
          }
          $scope.validateRecordingName()
        })
    }

    $scope.startRecording = function() {
      if (!$scope.recordingForm.name) {
        $scope.recordingError = '请填写录制名称'
        return
      }
      $scope.validateRecordingName()
      if ($scope.recordingNameTaken) {
        $scope.recordingError = '该录制名称已存在，请更换'
        return
      }
      $scope.recordingError = ''
      stepSeq = 0
      $scope.recordingActive = true
      $scope.recordingLocked = false
      $scope.stepEdit = null
      $scope.recordingSteps = [{
        _id: nextStepId()
      , action: 'start'
      , timestamp: Date.now()
      }]
      $scope.recordingBaselinesMeta = []
    }

    $scope.$on('stf.recorder.tap', function(e, data) {
      if (!$scope.recordingActive) {
        return
      }
      if (!data) {
        return
      }
      $scope.recordingSteps.push({
        _id: nextStepId()
      , action: 'tap'
      , xP: Number(data.xP)
      , yP: Number(data.yP)
      , rotation: data.rotation
      , stepDelayMs: DEFAULT_STEP_DELAY_MS
      , timestamp: data.timestamp || Date.now()
      })
      // touch handlers do not always enter an Angular digest; force table refresh.
      $scope.$applyAsync(angular.noop)
    })

    $scope.$on('stf.recorder.swipe', function(e, data) {
      if (!$scope.recordingActive) {
        return
      }
      if (!data) {
        return
      }
      var dur = Number(data.durationMs)
      if (!isFinite(dur) || dur < 50) {
        dur = 300
      }
      if (dur > 8000) {
        dur = 8000
      }
      $scope.recordingSteps.push({
        _id: nextStepId()
      , action: 'swipe'
      , x1P: Number(data.x1P)
      , y1P: Number(data.y1P)
      , x2P: Number(data.x2P)
      , y2P: Number(data.y2P)
      , rotation: data.rotation
      , durationMs: Math.round(dur)
      , stepDelayMs: DEFAULT_STEP_DELAY_MS
      , timestamp: data.timestamp || Date.now()
      })
      $scope.$applyAsync(angular.noop)
    })

    function safeGetTargetSerial() {
      if ($scope.device && $scope.device.serial) return $scope.device.serial
      return null
    }

    $scope.canMutateStep = function(step) {
      if (!step || !step.action) {
        return false
      }
      var action = String(step.action).trim()
      return !$scope.recordingLocked && action !== 'start' && action !== 'stop'
    }

    $scope.canMutateLibraryStep = function(step) {
      if (!step || !step.action) {
        return false
      }
      var action = String(step.action).trim()
      return action !== 'start' && action !== 'stop'
    }

    $scope.deleteStepAt = function(index, ctx) {
      ctx = ctx || 'recording'
      var steps = ctx === 'library' ? (($scope.libraryEdit && $scope.libraryEdit.steps) || []) : $scope.recordingSteps
      if (index < 0 || index >= steps.length) {
        return
      }
      var step = steps[index]
      var ok = ctx === 'library' ? $scope.canMutateLibraryStep(step) : $scope.canMutateStep(step)
      if (!ok) {
        return
      }
      steps.splice(index, 1)
      if ($scope.stepEdit && $scope.stepEdit.target === ctx && $scope.stepEdit.index === index) {
        $scope.stepEdit = null
      }
      else if ($scope.stepEdit && $scope.stepEdit.target === ctx && $scope.stepEdit.index > index) {
        $scope.stepEdit.index -= 1
      }
    }

    function pushVisualBaselineStepAt(href, afterIndex, threshold, ctx) {
      ctx = ctx || 'recording'
      if (!href) {
        throw new Error('基线截图无href返回')
      }
      var th = Number(threshold)
      if (!isFinite(th) || th <= 0) {
        th = 0.95
      }
      if (th > 1) {
        th = 1
      }
      var baseline = {
        type: 'visual'
      , href: href
      , threshold: th
      }
      var baselines = ctx === 'library'
        ? ($scope.libraryEdit && $scope.libraryEdit.baselinesMeta)
        : $scope.recordingBaselinesMeta
      var steps = ctx === 'library'
        ? ($scope.libraryEdit && $scope.libraryEdit.steps)
        : $scope.recordingSteps
      if (!baselines || !steps) {
        throw new Error('基线上下文无效')
      }
      baselines.push(baseline)
      var baselineIndex = baselines.length - 1
      var step = {
        _id: nextStepId()
      , action: 'assert_visual_match'
      , baselineIndex: baselineIndex
      , stepDelayMs: DEFAULT_STEP_DELAY_MS
      , timestamp: Date.now()
      }
      var insertAt = afterIndex + 1
      steps.splice(insertAt, 0, step)
    }

    function captureBaselineFromPreviewCanvas() {
      return $q(function(resolve, reject) {
        var canvas = document.querySelector('.remote-control canvas.screen') ||
          document.querySelector('canvas.screen')
        if (!canvas || canvas.width < 2 || canvas.height < 2) {
          reject(new Error('preview canvas not ready'))
          return
        }
        if (typeof canvas.toBlob !== 'function') {
          reject(new Error('canvas.toBlob missing'))
          return
        }
        canvas.toBlob(function(blob) {
          if (!blob || blob.size < 32) {
            reject(new Error('empty preview frame'))
            return
          }
          var file = new File([blob], 'baseline.jpg', {type: 'image/jpeg'})
          StorageService.storeFile('image', [file], {})
            .then(function(res) {
              var fileRes = StorageService.getFileResourceFromResponse(res)
              if (!fileRes || !fileRes.href) {
                reject(new Error('上传预览截图失败'))
                return
              }
              resolve(fileRes.href)
            })
            .catch(reject)
        }, 'image/jpeg', 0.88)
      })
    }

    $scope.insertVisualAssertionAfter = function(afterIndex, ctx) {
      ctx = ctx || 'recording'
      if (ctx === 'recording') {
        if (!$scope.recordingActive || $scope.recordingLocked) {
          return
        }
      }
      else if (ctx === 'library') {
        if (!$scope.libraryEdit) {
          return
        }
      }
      else {
        return
      }
      var steps = ctx === 'library' ? $scope.libraryEdit.steps : $scope.recordingSteps
      if (afterIndex < 0 || afterIndex >= steps.length) {
        return
      }
      if ($scope.baselineBusy) {
        return
      }
      if (ctx === 'recording') {
        $scope.recordingError = ''
      }
      else if ($scope.libraryEdit) {
        $scope.libraryEdit.captureError = ''
      }
      $scope.baselineBusy = true
      captureBaselineFromPreviewCanvas()
        .then(function(href) {
          pushVisualBaselineStepAt(href, afterIndex, 0.95, ctx)
        })
        .catch(function() {
          var ctrl = resolveControl()
          if (!ctrl || !ctrl.screenshot) {
            return $q.reject(new Error('当前画面未就绪且无法使用设备截图，请稍后再试'))
          }
          return ctrl.screenshot().then(function(result) {
            var href = result && result.body ? result.body.href : null
            pushVisualBaselineStepAt(href, afterIndex, 0.95, ctx)
          })
        })
        .catch(function(err) {
          var msg = (err && err.message) ? err.message : '拍摄基线失败'
          if (ctx === 'recording') {
            $scope.recordingError = msg
          }
          else if ($scope.libraryEdit) {
            $scope.libraryEdit.captureError = msg
          }
        })
        .finally(function() {
          $scope.baselineBusy = false
          $scope.$applyAsync(angular.noop)
        })
    }

    function buildPythonCodeFromSteps(steps) {
      function escapePyString(s) {
        return String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")
      }
      var py = []
      py.push('import uiautomator2 as u2')
      py.push('import time')
      py.push('d = u2.connect()')
      py.push('w, h = d.window_size()')
      py.push('')
      py.push('def tap(xp, yp):')
      py.push('    x = int(w * float(xp))')
      py.push('    y = int(h * float(yp))')
      py.push('    d.click(x, y)')
      py.push('')
      py.push('def swipe(x1p, y1p, x2p, y2p, duration_ms=300):')
      py.push('    x1, y1 = int(w * float(x1p)), int(h * float(y1p))')
      py.push('    x2, y2 = int(w * float(x2p)), int(h * float(y2p))')
      py.push('    d.swipe(x1, y1, x2, y2, float(duration_ms) / 1000.0)')
      py.push('')
      py.push('def type_at(xp, yp, s):')
      py.push('    tap(xp, yp)')
      py.push('    time.sleep(0.38)')
      py.push('    d.set_fastinput_ime(True)')
      py.push('    d.send_keys(str(s))')
      py.push('')
      py.push('# generated by STF recorder')
      py.push('print("replay started")')
      py.push('')
      var pyTimeImported = true
      function codegenPreDelayMs(st) {
        var a = String(st && st.action || '').trim()
        if (a !== 'tap' && a !== 'swipe' && a !== 'input_text' &&
          a !== 'assert_text_contains' && a !== 'assert_visual_match') {
          return 0
        }
        var ms = Number(st.stepDelayMs)
        if (!isFinite(ms) || ms < 0) {
          ms = DEFAULT_STEP_DELAY_MS
        }
        if (ms > 120000) {
          ms = 120000
        }
        return ms
      }
      function pushPySleep(ms) {
        if (!(ms > 0)) {
          return
        }
        if (!pyTimeImported) {
          py.push('import time')
          pyTimeImported = true
        }
        py.push('time.sleep(' + (ms / 1000).toFixed(3) + ')')
      }
      ;(steps || []).forEach(function(step) {
        if (!step || !step.action) return
        if (step.action === 'tap') {
          pushPySleep(codegenPreDelayMs(step))
          py.push('tap(' + Number(step.xP || 0).toFixed(6) + ', ' + Number(step.yP || 0).toFixed(6) + ')')
        }
        else if (step.action === 'swipe') {
          pushPySleep(codegenPreDelayMs(step))
          py.push('swipe(' +
            Number(step.x1P || 0).toFixed(6) + ', ' +
            Number(step.y1P || 0).toFixed(6) + ', ' +
            Number(step.x2P || 0).toFixed(6) + ', ' +
            Number(step.y2P || 0).toFixed(6) + ', ' +
            Math.round(Number(step.durationMs) || 300) + ')')
        }
        else if (step.action === 'input_text') {
          pushPySleep(codegenPreDelayMs(step))
          var it = escapePyString(step.inputText || '')
          py.push('type_at(' + Number(step.xP || 0).toFixed(6) + ', ' + Number(step.yP || 0).toFixed(6) +
            ', \'' + it + '\')')
        }
        else if (step.action === 'assert_text_contains') {
          pushPySleep(codegenPreDelayMs(step))
          var expected = escapePyString(step.expectedText)
          py.push('assert d(text=\'' + expected + '\').exists, ' +
            '\'text assertion failed: expected: ' + expected + '\'')
        }
        else if (step.action === 'assert_visual_match') {
          pushPySleep(codegenPreDelayMs(step))
          py.push('# visual assertion placeholder (baselineIndex=' + Number(step.baselineIndex) + ')')
        }
        else if (step.action === 'wait') {
          var wms = Number(step.waitMs || 0)
          if (!pyTimeImported) {
            py.push('import time')
            pyTimeImported = true
          }
          py.push('time.sleep(' + (wms / 1000).toFixed(3) + ')')
        }
      })
      return py.join('\n')
    }

    function stepsJsonForApi(steps) {
      return (steps || []).map(function(s) {
        var o = angular.extend({}, s)
        delete o._id
        return o
      })
    }

    $scope.closeLibraryEditor = function() {
      if ($scope.stepEdit && $scope.stepEdit.target === 'library') {
        $scope.stepEdit = null
      }
      $scope.draggingStepIndex = null
      $scope.dropTargetStepIndex = null
      $scope.dragStepContext = null
      $scope.libraryEdit = null
    }

    $scope.openSelectedRecordingForEdit = function(id) {
      id = id != null ? String(id).trim() : ''
      if (!id) {
        return
      }
      $scope.replayState.launching = true
      return $http.get('/api/v1/automation/recordings/' + encodeURIComponent(id))
        .then(function(res) {
          var rec = res.data && res.data.recording
          if (!rec || rec.id !== id) {
            throw new Error('录制不存在')
          }
          var steps = angular.copy(rec.stepsJson || [])
          angular.forEach(steps, function(s) {
            if (s && !s._id) {
              s._id = nextStepId()
            }
          })
          $scope.libraryEdit = {
            id: rec.id
          , name: (rec.name != null ? String(rec.name) : '').trim()
          , description: rec.description != null ? String(rec.description) : ''
          , steps: steps
          , baselinesMeta: angular.copy(rec.baselinesMeta || [])
          , saving: false
          , saveError: ''
          , captureError: ''
          }
          $scope.stepEdit = null
        })
        .catch(function(err) {
          $window.alert(err && err.message ? err.message : '加载失败')
        })
        .finally(function() {
          $scope.replayState.launching = false
        })
    }

    $scope.saveLibraryRecording = function() {
      var le = $scope.libraryEdit
      if (!le || !le.id) {
        return
      }
      var nm = String(le.name || '').trim()
      if (!nm) {
        le.saveError = '请填写录制名称'
        return
      }
      le.saving = true
      le.saveError = ''
      var py = buildPythonCodeFromSteps(le.steps)
      $http.put('/api/v1/automation/recordings/' + encodeURIComponent(le.id), {
        name: nm
      , description: le.description != null ? String(le.description) : ''
      , stepsJson: stepsJsonForApi(le.steps)
      , baselinesMeta: le.baselinesMeta
      , pythonCode: py
      })
        .then(function() {
          loadRecordings()
          $scope.closeLibraryEditor()
        })
        .catch(function(err) {
          var code = err && err.status
          var desc = err && err.data && err.data.description
          if (code === 409) {
            le.saveError = desc || '名称已存在'
          }
          else {
            le.saveError = desc || (err && err.message) || '保存失败'
          }
        })
        .finally(function() {
          le.saving = false
        })
    }

    $scope.stopRecording = function() {
      $scope.recordingActive = false
      $scope.recordingLocked = true
      $scope.recordingSteps.push({
        _id: nextStepId()
      , action: 'stop'
      , timestamp: Date.now()
      })
      var pythonCode = buildPythonCodeFromSteps($scope.recordingSteps)
      $http.post('/api/v1/automation/recordings', {
        name: $scope.recordingForm.name
      , stepsJson: $scope.recordingSteps
      , baselinesMeta: $scope.recordingBaselinesMeta
      , pythonCode: pythonCode
      }).then(function() {
        loadRecordings()
      }).catch(function(err) {
        var code = err && err.status
        var desc = err && err.data && err.data.description
        if (code === 409) {
          $scope.recordingError = desc || '该录制名称已存在，请更换'
        }
      })
    }

    $scope.downloadSelectedRecording = function(id) {
      id = id != null ? String(id).trim() : ''
      if (!id) {
        return
      }
      window.open('/api/v1/automation/recordings/' + encodeURIComponent(id) + '/download', '_blank')
    }

    $scope.startReplayBySelection = function(id) {
      id = id != null ? String(id).trim() : ''
      if (!id) {
        $scope.replayState.error = '请选择录制脚本'
        return
      }

      // Prevent concurrent clicks/races: lock UI during the GET loading phase.
      $scope.replayState.launching = true
      $scope.replayState.error = ''
      $scope.detailReplayRows = []
      $scope.currentReplayRecordingId = id
      $scope.replayRequestRecordingId = id
      $scope.currentReplayStepsSummary = ''

      // Always load the recording by selected id from the server.
      // This avoids any front-end cache mismatch (e.g. after renaming/reloading).
      return $http.get('/api/v1/automation/recordings/' + encodeURIComponent(id))
        .then(function(recRes) {
          var rec = recRes.data && recRes.data.recording
          if (!rec) {
            throw new Error('录制不存在')
          }
          // Safety check: if server returns an unexpected recording, stop.
          if (rec.id !== id) {
            throw new Error('录制ID不一致：选择=' + id + '，实际=' + rec.id)
          }
          $scope.startReplay(rec)
        })
        .catch(function(err) {
          $scope.replayState.error = err && err.message ? err.message : '加载录制失败'
        })
        .finally(function() {
          $scope.replayState.launching = false
        })
    }

    function statusLabelReplay(s) {
      if (s === 'finished') {
        return '已完成'
      }
      if (s === 'running') {
        return '执行中'
      }
      if (s === 'failed') {
        return '失败'
      }
      return s || ''
    }

    function upsertDetailReplayRow(run, devices, recordingName) {
      if (!run || !run.id) {
        return
      }
      var serial = safeGetTargetSerial()
      var targetTotal = (run.targets && run.targets.length) ||
        (run.totalDevices != null ? Number(run.totalDevices) : 0) ||
        ((devices && devices.length) ? devices.length : 1)
      var done = 0
      var failed = 0
      var success = 0
      var totalCasesSum = 0
      var successCasesSum = 0
      if (devices && devices.length) {
        function isPendingClientAssertion(d) {
          var r = String((d && d.result) || '').trim()
          return r === '待客户端断言'
        }
        done = devices.filter(function(d) {
          return d.status === 'finished' || d.status === 'done' || d.status === 'failed'
        }).length
        failed = devices.filter(function(d) {
          return d.status === 'failed' || d.result === '失败'
        }).length
        success = devices.filter(function(d) {
          return d.result === '成功' || (d.status === 'finished' && d.result !== '失败' && !isPendingClientAssertion(d))
        }).length
        devices.forEach(function(d) {
          totalCasesSum += Number(d.totalCases) || 0
          successCasesSum += Number(d.successCases) || 0
        })
      }
      else if (run.progressDone != null) {
        done = Number(run.progressDone)
      }
      var passRate = Number(run.passRate != null ? run.passRate : 0)
      if (!passRate && targetTotal > 0 && success) {
        passRate = Math.round((success / targetTotal) * 1000) / 10
      }
      if (totalCasesSum > 0) {
        passRate = Math.round((successCasesSum / totalCasesSum) * 1000) / 10
      }
      var title = recordingName || run.recordingName || ''
      var params = serial ? ('设备 ' + serial) : ''
      var row = {
        kindLabel: '回放'
      , _track: 'detail-replay:' + run.id
      , id: run.id
      , title: title
      , params: params
      , owner: run.createdByName || run.createdByEmail || ''
      , statusText: statusLabelReplay(run.status)
      , progressText: (function() {
          var pt = (devices && devices.length) ? devices.length : targetTotal
          var pd = (devices && devices.length) ? done : (run.progressDone != null ? Number(run.progressDone) : 0)
          if (!(devices && devices.length) && run.status === 'finished' && !pd) {
            pd = pt
          }
          return pd + ' / ' + pt
        })()
      , successCount: totalCasesSum > 0 ? successCasesSum : Number(run.successDevices != null ? run.successDevices : success)
      , failCount: totalCasesSum > 0 ? (totalCasesSum - successCasesSum) : Number(run.failDevices != null ? run.failDevices : failed)
      , passRate: passRate
      , started: run.startedAt || run.createdAt || ''
      , ended: run.endedAt || ''
      , downloadUrl: '/api/v1/automation/replay/runs/' + run.id + '/test-report'
      }
      // This is a "current session" view: keep only the latest replay row.
      $scope.detailReplayRows = [row]
    }

    $scope.startReplay = function(recording) {
      var serial = safeGetTargetSerial()
      if (!serial) {
        $scope.replayState.error = '当前设备不可用'
        return
      }
      // Keep session-only record.
      $scope.detailReplayRows = []
      $scope.currentReplayRecordingId = recording && recording.id ? String(recording.id) : ''
      $scope.currentReplayStepsSummary = ''
      $scope.replayState.running = true
      $scope.replayState.runId = null
      $scope.replayState.progressDone = 0
      $scope.replayState.progressTotal = 0
      $scope.replayState.status = ''
      $scope.replayState.passRate = 0
      $scope.replayState.caseSuccessRate = 0
      $scope.replayState.reportTotalCases = 0
      $scope.replayState.expectedCases = Array.isArray(recording && recording.stepsJson) ?
        recording.stepsJson.filter(function(step) {
          var a = (step && step.action) ? String(step.action).trim() : ''
          return a === 'assert_text_contains' || a === 'assert_visual_match'
        }).length :
        0
      $scope.replayState.startedAt = ''
      $scope.replayState.endedAt = ''
      $scope.replayState.error = ''

      $http.post('/api/v1/automation/replay/runs', {
        recordingId: recording.id
      , targets: [serial]
      , clientDriven: true
      }).then(function(res) {
        var run = res.data && res.data.run
        $scope.replayState.runId = run && run.id
        if (run && run.id) {
          upsertDetailReplayRow(run, [], recording.name || run.recordingName)
        }

        $http.get('/api/v1/automation/recordings/' + encodeURIComponent(recording.id))
          .then(function(recRes) {
            var full = recRes.data && recRes.data.recording
            if (!full || !Array.isArray(full.stepsJson)) {
              throw new Error('无法加载录制步骤')
            }

            $scope.currentReplayRecordingId = full.id || recording.id || ''
            $scope.currentReplayStepsSummary = buildStepsSummary(full.stepsJson)

            return evaluateReplaySteps(full).then(function(cases) {
              var errs = (cases && cases.errors) ? cases.errors : []
              var ok = !errs.length && (cases.successCases === cases.totalCases)
              return {
                ok: ok
              , cases: cases
              , error: errs.length ? new Error(errs[0]) : null
              }
            })
          })
          .then(function(result) {
            var runId = $scope.replayState.runId
            if (!runId) {
              return
            }
            var totalCases = result.cases && result.cases.totalCases != null ? result.cases.totalCases : 0
            var successCases = result.cases && result.cases.successCases != null ? result.cases.successCases : 0
            var deviceResult = result.ok ? '成功' : '失败'
            var errorMsg = null
            if (result.cases && Array.isArray(result.cases.errors) && result.cases.errors.length) {
              errorMsg = result.cases.errors.slice(0, 3).join('; ')
            }
            else if (result.error && result.error.message) {
              errorMsg = result.error.message
            }
            var endedAtIso = new Date().toISOString()
            // Swagger schema requires integers and error as string (not null).
            totalCases = Math.max(0, Math.floor(Number(totalCases) || 0))
            successCases = Math.max(0, Math.floor(Number(successCases) || 0))
            var errorStr = errorMsg ? String(errorMsg) : ''

            var devPayload = {
              serial: serial
            , status: 'finished'
            , result: deviceResult
            , totalCases: totalCases
            , successCases: successCases
            , error: errorStr
            , endedAt: endedAtIso
            }
            if (result.cases && result.cases.logLines && result.cases.logLines.length) {
              devPayload.executionLog = result.cases.logLines.join('\n')
            }
            if (result.cases && result.cases.reportArtifacts && result.cases.reportArtifacts.length) {
              devPayload.reportArtifacts = result.cases.reportArtifacts
            }
            return $http.post('/api/v1/automation/replay/runs/' + encodeURIComponent(runId) + '/complete', {
              devices: [devPayload]
            }, {headers: {'Content-Type': 'application/json'}})
              .catch(function() {
                // If server completion fails, still show local error.
              })
              .finally(function() {
                if (!result.ok) {
                  $scope.replayState.error = errorStr || '回放断言失败'
                }
              })
          })
          .catch(function(err) {
            $scope.replayState.error = err && err.message ? err.message : '回放执行失败'
          })
        pollReplayReport()
      }).catch(function(err) {
        $scope.replayState.running = false
        var desc = err && err.data && err.data.description
        $scope.replayState.error = desc || (err && err.message ? err.message : '回放失败')
      })
    }

    function pollReplayReport() {
      var runId = $scope.replayState.runId
      if (!runId) return

      $http.get('/api/v1/automation/replay/runs/' + runId + '/report')
        .then(function(res) {
          var data = res.data || {}
          var run = data.run || {}
          var devices = data.devices || []
          var total = devices.length
          var done = devices.filter(function(d) { return d.status === 'finished' || d.status === 'done' }).length
          var totalCases = devices.reduce(function(sum, d) { return sum + (Number(d.totalCases) || 0) }, 0)
          var successCases = devices.reduce(function(sum, d) { return sum + (Number(d.successCases) || 0) }, 0)
          var caseSuccessRate = totalCases > 0 ? (successCases / totalCases) * 100 : 0

          $scope.replayState.progressTotal = total
          $scope.replayState.progressDone = done
          $scope.replayState.status = run.status
          $scope.replayState.startedAt = run.startedAt || ''
          $scope.replayState.endedAt = run.endedAt || run.endedAt || ''
          $scope.replayState.caseSuccessRate = caseSuccessRate
          $scope.replayState.reportTotalCases = devices.reduce(function(sum, d) {
            return sum + (Number(d.totalCases) || 0)
          }, 0)
          $scope.replayState.passRate = total > 0 ? (devices.filter(function(d) { return d.result === '成功' }).length / total) * 100 : 0

          upsertDetailReplayRow(run, devices, run.recordingName)

          // Server fallback can set reportAvailable=true early with placeholder result "待客户端断言".
          // Keep polling until placeholders are replaced by client-reported assertion results.
          var hasPendingClientAssertion = devices.some(function(d) {
            return String((d && d.result) || '').trim() === '待客户端断言'
          })
          var expectedCases = Number($scope.replayState.expectedCases || 0)
          var hasCaseStats = devices.some(function(d) {
            return (Number(d.totalCases) || 0) > 0 || (Number(d.successCases) || 0) > 0
          })
          var canStopForZeroCase = expectedCases === 0

          if (run.reportAvailable && !hasPendingClientAssertion && (hasCaseStats || canStopForZeroCase)) {
            $scope.replayState.running = false
          }
          else {
            $timeout(pollReplayReport, 800)
          }
        })
        .catch(function() {
          $timeout(pollReplayReport, 1500)
        })
    }

    loadRecordings()
  })
  .directive('automationRecorder', function() {
    return {
      restrict: 'E'
    , template: require('./recorder.pug')
    , controller: 'AutomationRecorderCtrl'
    }
  })

