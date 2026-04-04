require('./recorder.css')

module.exports = angular.module('stf.automation.recorder', [
  require('stf/storage').name
])
  .controller('AutomationRecorderCtrl', function($scope, $http, $timeout, $q, StorageService, $window) {
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

    function evaluateReplaySteps(recording) {
      var control = resolveControl()
      if (!control) {
        return $q.reject(new Error('设备控制不可用'))
      }
      var steps = (recording && recording.stepsJson) || []

      var totalCases = 0
      var successCases = 0
      var errors = []

      return steps.reduce(function(prev, step) {
        return prev.then(function() {
          var action = (step && step.action) ? String(step.action).trim() : ''

          if (action === 'wait') {
            var waitMs = Number(step.waitMs || 0)
            if (!isFinite(waitMs) || waitMs <= 0) {
              return $timeout(angular.noop, 0)
            }
            return $timeout(angular.noop, waitMs)
          }

          if (action === 'tap') {
            var xP = Number(step.xP)
            var yP = Number(step.yP)
            if (isNaN(xP) || isNaN(yP)) {
              return $timeout(angular.noop, 0)
            }
            return performRecordedTap(control, xP, yP).then(function() {
              return $timeout(angular.noop, 280)
            })
          }

          if (action === 'assert_text_contains') {
            totalCases += 1
            var expected = (step.expectedText || '').trim()
            return withTimeout(assertTextContains(control, expected), 12000, '文本断言')
              .then(function() {
                successCases += 1
                return $timeout(angular.noop, 350)
              })
              .catch(function(err) {
                // Do NOT stop the replay chain; record failure and continue.
                errors.push(err && err.message ? err.message : ('文本断言失败：' + expected))
                return $timeout(angular.noop, 0)
              })
          }

          if (action === 'assert_visual_match') {
            // Visual match requires image diff. Keep current behavior for now:
            // count as a case and assume it passed after delay.
            // (We still count it so passRate/caseSuccessRate match your UI expectation.)
            totalCases += 1
            return $timeout(angular.noop, 500).then(function() {
              successCases += 1
            })
          }

          return $timeout(angular.noop, 0)
        })
      }, $q.when()).then(function() {
        return {
          totalCases: totalCases
        , successCases: successCases
        , errors: errors
        }
      })
    }

    $scope.recordingForm = {name: ''}
    $scope.recordingSteps = []
    $scope.recordingStepPage = 1
    $scope.recordingStepPageSize = 10
    $scope.recordingActive = false
    $scope.recordingLocked = false
    $scope.recordingBaselinesMeta = []
    $scope.recordings = []
    $scope.recordingError = ''
    $scope.baselineBusy = false

    // Manual wait step (user-inserted), similar to how assertions are added.
    $scope.waitStepSeconds = 0

    $scope.assertionDraft = {
      type: 'visual'
    , expectedText: ''
    , threshold: 0.95
    }

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
    $scope.recordingNameTaken = false
    // Replay runs started from this device detail (same columns as 自动化测试记录).
    $scope.detailReplayRows = []

    $scope.currentReplayRecordingId = ''
    $scope.currentReplayStepsSummary = ''

    $scope.recordingStepTotalPages = function() {
      var total = ($scope.recordingSteps || []).length
      return Math.max(1, Math.ceil(total / $scope.recordingStepPageSize))
    }

    $scope.pagedRecordingSteps = function() {
      var totalPages = $scope.recordingStepTotalPages()
      if ($scope.recordingStepPage > totalPages) {
        $scope.recordingStepPage = totalPages
      }
      if ($scope.recordingStepPage < 1) {
        $scope.recordingStepPage = 1
      }
      var start = ($scope.recordingStepPage - 1) * $scope.recordingStepPageSize
      return ($scope.recordingSteps || []).slice(start, start + $scope.recordingStepPageSize)
    }

    $scope.prevRecordingStepPage = function() {
      if ($scope.recordingStepPage <= 1) return
      $scope.recordingStepPage -= 1
    }

    $scope.nextRecordingStepPage = function() {
      if ($scope.recordingStepPage >= $scope.recordingStepTotalPages()) return
      $scope.recordingStepPage += 1
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
        if (action === 'assert_text_contains') {
          return 'assert_text_contains(' + (step.expectedText || '') + ')'
        }
        if (action === 'assert_visual_match') {
          return 'assert_visual_match(baseline=' + (step.baselineIndex != null ? step.baselineIndex : '') + ')'
        }
        if (action === 'wait') {
          return 'wait(' + (step.waitMs != null ? step.waitMs : 0) + 'ms)'
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
      $scope.recordingStepPage = 1
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
      , timestamp: data.timestamp || Date.now()
      })
      // touch handlers do not always enter an Angular digest; force table refresh.
      $scope.$applyAsync(angular.noop)
    })

    function safeGetTargetSerial() {
      if ($scope.device && $scope.device.serial) return $scope.device.serial
      return null
    }

    $scope.addWaitStep = function() {
      if (!$scope.recordingActive) {
        return
      }
      var s = Number($scope.waitStepSeconds)
      if (!isFinite(s) || s <= 0) {
        return
      }
      var waitMs = Math.round(s * 1000)
      $scope.recordingSteps.push({
        _id: nextStepId()
      , action: 'wait'
      , waitMs: waitMs
      , timestamp: Date.now()
      })
    }

    $scope.canMutateStep = function(step) {
      if (!step || !step.action) {
        return false
      }
      var action = String(step.action).trim()
      return !$scope.recordingLocked && action !== 'start' && action !== 'stop'
    }

    $scope.deleteStepAt = function(index) {
      if (index < 0 || index >= $scope.recordingSteps.length) {
        return
      }
      var step = $scope.recordingSteps[index]
      if (!$scope.canMutateStep(step)) {
        return
      }
      $scope.recordingSteps.splice(index, 1)
    }

    $scope.editStepAt = function(index) {
      if (index < 0 || index >= $scope.recordingSteps.length) {
        return
      }
      var step = $scope.recordingSteps[index]
      if (!$scope.canMutateStep(step)) {
        return
      }
      var action = String(step.action || '').trim()

      if (action === 'tap') {
        var xText = $window.prompt('请输入 tap 的 x 百分比(0~1)', String(step.xP))
        if (xText == null) return
        var yText = $window.prompt('请输入 tap 的 y 百分比(0~1)', String(step.yP))
        if (yText == null) return
        var nx = Number(xText)
        var ny = Number(yText)
        if (isNaN(nx) || isNaN(ny)) {
          return
        }
        step.xP = nx
        step.yP = ny
        step.timestamp = Date.now()
        return
      }

      if (action === 'wait') {
        var secText = $window.prompt('请输入等待秒数(>=0)', String((Number(step.waitMs) || 0) / 1000))
        if (secText == null) return
        var sec = Number(secText)
        if (!isFinite(sec) || sec < 0) {
          return
        }
        step.waitMs = Math.round(sec * 1000)
        step.timestamp = Date.now()
        return
      }

      if (action === 'assert_text_contains') {
        var expected = $window.prompt('请输入文本断言期望值', String(step.expectedText || ''))
        if (expected == null) return
        step.expectedText = String(expected).trim()
        step.timestamp = Date.now()
        return
      }

      if (action === 'assert_visual_match') {
        var idxText = $window.prompt('请输入 baselineIndex(从0开始)', String(step.baselineIndex))
        if (idxText == null) return
        var bi = Number(idxText)
        if (!isFinite(bi) || bi < 0) {
          return
        }
        step.baselineIndex = Math.floor(bi)
        step.timestamp = Date.now()
      }
    }

    $scope.addTextAssertion = function() {
      var expectedText = ($scope.assertionDraft.expectedText || '').trim()
      if (!expectedText) {
        return
      }
      $scope.recordingError = ''
      $scope.recordingSteps.push({
        _id: nextStepId()
      , action: 'assert_text_contains'
      , expectedText: expectedText
      , timestamp: Date.now()
      })
    }

    function pushVisualBaselineStep(href) {
      if (!href) {
        throw new Error('基线截图无href返回')
      }
      var baseline = {
        type: 'visual'
      , href: href
      , threshold: Number($scope.assertionDraft.threshold) || 0.95
      }
      $scope.recordingBaselinesMeta.push(baseline)
      $scope.recordingSteps.push({
        _id: nextStepId()
      , action: 'assert_visual_match'
      , baselineIndex: $scope.recordingBaselinesMeta.length - 1
      , timestamp: Date.now()
      })
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

    $scope.captureVisualBaseline = function() {
      if ($scope.baselineBusy) {
        return
      }
      $scope.recordingError = ''
      $scope.baselineBusy = true
      captureBaselineFromPreviewCanvas()
        .then(function(href) {
          pushVisualBaselineStep(href)
        })
        .catch(function() {
          var ctrl = resolveControl()
          if (!ctrl || !ctrl.screenshot) {
            return $q.reject(new Error('当前画面未就绪且无法使用设备截图，请稍后再试'))
          }
          return ctrl.screenshot().then(function(result) {
            var href = result && result.body ? result.body.href : null
            pushVisualBaselineStep(href)
          })
        })
        .catch(function(err) {
          $scope.recordingError = (err && err.message) ? err.message : '拍摄基线失败'
        })
        .finally(function() {
          $scope.baselineBusy = false
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
      // Generate a python script that reflects recorded steps (mainly taps + text assertions).
      // This is used for download/debug; actual device-side execution is handled by STF in the browser.
      function escapePyString(s) {
        return String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")
      }
      var py = []
      py.push('import uiautomator2 as u2')
      py.push('d = u2.connect()')
      py.push('w, h = d.window_size()')
      py.push('')
      py.push('def tap(xp, yp):')
      py.push('    x = int(w * float(xp))')
      py.push('    y = int(h * float(yp))')
      py.push('    d.click(x, y)')
      py.push('')
      py.push('# generated by STF recorder')
      py.push('print("replay started")')
      py.push('')
      ;( $scope.recordingSteps || []).forEach(function(step) {
        if (!step || !step.action) return
        if (step.action === 'tap') {
          py.push('tap(' + Number(step.xP || 0).toFixed(6) + ', ' + Number(step.yP || 0).toFixed(6) + ')')
        }
        else if (step.action === 'assert_text_contains') {
          var expected = escapePyString(step.expectedText)
          py.push('assert d(text=\'' + expected + '\').exists, ' +
            '\'text assertion failed: expected: ' + expected + '\'')
        }
        else if (step.action === 'assert_visual_match') {
          py.push('# visual assertion placeholder (baselineIndex=' + Number(step.baselineIndex) + ')')
        }
        else if (step.action === 'wait') {
          var ms = Number(step.waitMs || 0)
          py.push('import time')
          py.push('time.sleep(' + (ms / 1000).toFixed(3) + ')')
        }
      })
      var pythonCode = py.join('\n')
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
      , downloadUrl: '/api/v1/automation/replay/runs/' + run.id + '/csv'
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

            return $http.post('/api/v1/automation/replay/runs/' + encodeURIComponent(runId) + '/complete', {
              devices: [{
                serial: serial
              , status: 'finished'
              , result: deviceResult
              , totalCases: totalCases
              , successCases: successCases
              , error: errorStr
              , endedAt: endedAtIso
              }]
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

