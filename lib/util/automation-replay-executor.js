var Promise = require('bluebird')
var r = require('rethinkdb')
var db = require('../db')
var uuid = require('uuid')
var adb = require('./adbutil')()
var automationVars = require('./automation-variables')
var expandVars = automationVars.expandAutomationVariables
var normalizeAutomationInputText = automationVars.normalizeAutomationInputText
var reportHtml = require('./automation-report-html')
var buildReplayTestReportHtml = reportHtml.buildReplayTestReportHtml
var enrichReplayDevicesWithBaselineImages = reportHtml.enrichReplayDevicesWithBaselineImages
var streamutil = require('./streamutil')
var visualCompare = require('./automation-visual-compare')

function now() {
  return new Date().toISOString()
}

function charToAdbKeyevents(ch) {
  var o = ch.charCodeAt(0)
  if (o >= 97 && o <= 122) {
    return [29 + (o - 97)]
  }
  if (o >= 48 && o <= 57) {
    return [7 + (o - 48)]
  }
  if (ch === '.') {
    return [56]
  }
  if (ch === '@') {
    return [77]
  }
  if (ch === '-') {
    return [69]
  }
  if (ch === '+') {
    return [81]
  }
  return null
}

function canSendTextViaAdbKeyevents(txt) {
  for (var i = 0; i < txt.length; i++) {
    if (charToAdbKeyevents(txt[i]) === null) {
      return false
    }
  }
  return txt.length > 0
}

function shellInputTextViaKeyevents(serial, shell, txt) {
  var codes = []
  for (var j = 0; j < txt.length; j++) {
    var ev = charToAdbKeyevents(txt[j])
    Array.prototype.push.apply(codes, ev)
  }
  return Promise.each(codes, function(code) {
    return shell(serial, 'input keyevent ' + code).delay(18)
  })
}

module.exports.runReplay = function(run, serials) {
  var CLIENT_COMPLETE_TIMEOUT_MS = 120000
  var startedAt = now()
  var deviceRows = serials.map(function(serial) {
    return {
      id: uuid.v4()
    , runId: run.id
    , serial: serial
    , status: 'running'
    , result: '执行中'
    , totalCases: 0
    , successCases: 0
    , error: null
    , startedAt: startedAt
    , endedAt: null
    , createdAt: startedAt
    , updatedAt: startedAt
    }
  })

  return db.run(r.table('automationReplayRunDevices').insert(deviceRows))
    .then(function() {
      function finalizeRunFromRows(statusOverride) {
        var endedAt = now()
        return db.run(r.table('automationReplayRunDevices').getAll(run.id, {index: 'runId'}))
          .then(function(cursor) { return cursor.toArray() })
          .then(function(rows) {
            var totalCases = rows.reduce(function(sum, d) { return sum + (Number(d.totalCases) || 0) }, 0)
            var successCases = rows.reduce(function(sum, d) { return sum + (Number(d.successCases) || 0) }, 0)
            var caseSuccessRate = totalCases > 0 ? (successCases / totalCases) * 100 : 0
            var failedRows = rows.filter(function(d) {
              return d.status === 'failed' || d.result === '失败'
            })
            var status = statusOverride || (failedRows.length ? 'failed' : 'finished')
            return db.run(r.table('automationRecordings').get(run.recordingId))
              .then(function(recording) {
                var runForReport = Object.assign({}, run, {
                  status: status
                , endedAt: endedAt
                , caseSuccessRate: caseSuccessRate
                })
                var rec = recording || {}
                return enrichReplayDevicesWithBaselineImages(rows, rec)
                  .then(function() {
                    var html = buildReplayTestReportHtml(runForReport, rows, rec)
                    return db.run(r.table('automationReplayRuns').get(run.id).update({
                      status: status
                    , reportAvailable: true
                    , reportHtml: html
                    , caseSuccessRate: caseSuccessRate
                    , endedAt: endedAt
                    , updatedAt: endedAt
                    }))
                  })
              })
          })
      }

      function scheduleClientTimeoutFallback() {
        // Wait for client-side /complete to finalize real assertion metrics.
        // If client never reports, timeout the run as failed instead of fake-finished.
        setTimeout(function() {
          db.run(r.table('automationReplayRuns').get(run.id))
            .then(function(currentRun) {
              if (!currentRun || currentRun.status !== 'running') {
                return null
              }
              var endedAt = now()
              return db.run(r.table('automationReplayRunDevices').getAll(run.id, {index: 'runId'}))
                .then(function(cursor) { return cursor.toArray() })
                .then(function(rows) {
                  return Promise.map(rows, function(row) {
                    if (row.status !== 'running') {
                      return null
                    }
                    return db.run(r.table('automationReplayRunDevices').get(row.id).update({
                      status: 'failed'
                    , result: '未执行(未收到客户端结果)'
                    , totalCases: Number(row.totalCases) || 0
                    , successCases: Number(row.successCases) || 0
                    , error: row.error || '客户端未上报回放结果'
                    , endedAt: endedAt
                    , updatedAt: endedAt
                    }))
                  }).then(function() {
                    return finalizeRunFromRows('failed')
                  })
                })
            })
            .catch(function() {})
        }, CLIENT_COMPLETE_TIMEOUT_MS)
      }

      function shell(serial, command) {
        return adb.shell(serial, command)
          .then(adb.util.readAll)
          .then(function(out) {
            return String(out || '')
          })
      }

      function shellRaw(serial, command) {
        return adb.shell(serial, command).then(adb.util.readAll)
      }

      function bufferFromAdbChunk(chunk) {
        if (chunk == null) {
          return null
        }
        if (Buffer.isBuffer(chunk)) {
          return chunk
        }
        if (chunk instanceof Uint8Array) {
          return Buffer.from(chunk)
        }
        if (typeof chunk === 'string') {
          return Buffer.from(chunk, 'binary')
        }
        return Buffer.from(chunk)
      }

      // ADB on Windows may prepend noise or corrupt line endings; PNG starts with 89 50 4E 47
      function extractPngBuffer(chunk) {
        var b = bufferFromAdbChunk(chunk)
        if (!b || b.length < 32) {
          return null
        }
        var sig = Buffer.from([0x89, 0x50, 0x4e, 0x47])
        var pos = b.indexOf(sig)
        if (pos >= 0) {
          return b.slice(pos)
        }
        return b
      }

      function pngBufferFromCapture(buf) {
        var png = extractPngBuffer(buf)
        if (!png || png.length < 64) {
          return null
        }
        return png
      }

      // Prefer screencap-to-file + adb.pull: shell stdout corrupts binary on many hosts (CRLF, UTF-8).
      function pullScreenshotPngBuffer(serial, remotePath) {
        return adb.shell(serial, 'screencap -p ' + remotePath)
          .then(adb.util.readAll)
          .delay(120)
          .then(function() {
            return adb.stat(serial, remotePath)
          })
          .then(function(stats) {
            if (!stats || Number(stats.size) < 64) {
              throw new Error('screencap file too small')
            }
            return adb.pull(serial, remotePath)
          })
          .then(function(transfer) {
            return streamutil.readAll(transfer)
          })
          .then(function(buf) {
            var png = pngBufferFromCapture(buf)
            if (!png) {
              throw new Error('invalid png buffer')
            }
            return png
          })
          .finally(function() {
            return adb.shell(serial, 'rm -f ' + remotePath)
              .then(adb.util.readAll)
              .catch(function() {})
          })
      }

      function captureScreencapPngBuffer(serial) {
        return pullScreenshotPngBuffer(serial, '/sdcard/_stf_replay_cap.png')
          .catch(function() {
            return pullScreenshotPngBuffer(serial, '/data/local/tmp/_stf_replay_cap.png')
          })
          .catch(function() {
            return shellRaw(serial, 'exec-out screencap -p')
              .then(function(buf) {
                var png = pngBufferFromCapture(buf)
                if (!png) {
                  throw new Error('exec-out screencap invalid')
                }
                return png
              })
          })
          .catch(function() {
            return null
          })
      }

      function captureScreencapDataUrl(serial) {
        return captureScreencapPngBuffer(serial).then(function(png) {
          if (!png) {
            return null
          }
          return 'data:image/png;base64,' + png.toString('base64')
        })
      }

      function getDisplaySize(serial) {
        return shell(serial, 'wm size').then(function(out) {
          var m = /Physical size:\s*(\d+)x(\d+)/i.exec(out) || /(\d+)x(\d+)/.exec(out)
          if (m) {
            return {w: Number(m[1]), h: Number(m[2])}
          }
          return {w: 1080, h: 1920}
        })
      }

      function assertText(serial, expectedText) {
        var expected = String(expandVars(expectedText) || '').trim()
        if (!expected) {
          return Promise.reject(new Error('assert_text_contains: expectedText 为空'))
        }
        return shell(serial, 'uiautomator dump /sdcard/uidump.xml >/dev/null 2>&1; cat /sdcard/uidump.xml')
          .then(function(xml) {
            var re = /(?:text|content-desc)\s*=\s*"([^"]*)"/g
            var m
            while ((m = re.exec(xml)) !== null) {
              var v = m[1] || ''
              if (v.indexOf(expected) !== -1) {
                return true
              }
            }
            throw new Error('文本断言失败：未找到 "' + expected + '"')
          })
      }

      function runOnDevice(serial, steps, recording) {
        var totalCases = 0
        var successCases = 0
        var errors = []
        var artifacts = []
        var logLines = []
        function logLine(msg) {
          logLines.push(now() + ' [INFO] ' + msg)
        }

        var DEFAULT_STEP_DELAY_MS = 500
        function shouldPreDelayAction(action) {
          var a = String(action || '').trim()
          return a === 'tap' || a === 'swipe' || a === 'input_text' ||
            a === 'assert_text_contains' || a === 'assert_visual_match'
        }
        function preDelayMsForStep(step) {
          var ms = Number(step && step.stepDelayMs)
          if (!isFinite(ms) || ms < 0) {
            ms = DEFAULT_STEP_DELAY_MS
          }
          if (ms > 120000) {
            ms = 120000
          }
          return ms
        }

        return getDisplaySize(serial)
          .then(function(size) {
            return Promise.each(steps || [], function(step, stepIndex) {
              var action = (step && step.action) ? String(step.action).trim() : ''
              logLine('步骤 ' + stepIndex + ' 开始 action=' + action)

              function afterPreDelay() {
              if (action === 'wait') {
                var ms = Number(step.waitMs || 0)
                return Promise.delay(ms > 0 ? ms : 0)
                  .then(function() {
                    logLine('步骤 ' + stepIndex + ' 等待结束 ' + ms + 'ms')
                  })
              }
              if (action === 'tap') {
                var x = Math.max(0, Math.min(size.w - 1, Math.round((Number(step.xP) || 0) * size.w)))
                var y = Math.max(0, Math.min(size.h - 1, Math.round((Number(step.yP) || 0) * size.h)))
                return shell(serial, 'input tap ' + x + ' ' + y)
                  .then(function() {
                    return Promise.delay(260)
                  })
                  .then(function() {
                    logLine('步骤 ' + stepIndex + ' tap 完成 (' + x + ',' + y + ')')
                  })
                  .catch(function(err) {
                    var msg = err && err.message ? err.message : String(err)
                    errors.push('步骤' + stepIndex + ' tap 失败: ' + msg)
                    logLine('步骤 ' + stepIndex + ' tap 失败: ' + msg)
                    return captureScreencapDataUrl(serial).then(function(dataUrl) {
                      artifacts.push({
                        title: '失败 #' + (artifacts.length + 1) + ' - 步骤' + stepIndex + ': 点击执行失败'
                      , detail: msg
                      , actualImageDataUrl: dataUrl
                      })
                    })
                  })
              }
              if (action === 'swipe') {
                var x1 = Math.max(0, Math.min(size.w - 1, Math.round((Number(step.x1P) || 0) * size.w)))
                var y1 = Math.max(0, Math.min(size.h - 1, Math.round((Number(step.y1P) || 0) * size.h)))
                var x2 = Math.max(0, Math.min(size.w - 1, Math.round((Number(step.x2P) || 0) * size.w)))
                var y2 = Math.max(0, Math.min(size.h - 1, Math.round((Number(step.y2P) || 0) * size.h)))
                var swipeDur = Math.round(Number(step.durationMs) || 300)
                if (!isFinite(swipeDur) || swipeDur < 50) {
                  swipeDur = 300
                }
                if (swipeDur > 8000) {
                  swipeDur = 8000
                }
                return shell(serial, 'input swipe ' + x1 + ' ' + y1 + ' ' + x2 + ' ' + y2 + ' ' + swipeDur)
                  .then(function() {
                    return Promise.delay(320)
                  })
                  .then(function() {
                    logLine('步骤 ' + stepIndex + ' swipe 完成 (' + x1 + ',' + y1 + ')->(' + x2 + ',' + y2 + ') ' + swipeDur + 'ms')
                  })
                  .catch(function(err) {
                    var msg = err && err.message ? err.message : String(err)
                    errors.push('步骤' + stepIndex + ' swipe 失败: ' + msg)
                    logLine('步骤 ' + stepIndex + ' swipe 失败: ' + msg)
                    return captureScreencapDataUrl(serial).then(function(dataUrl) {
                      artifacts.push({
                        title: '失败 #' + (artifacts.length + 1) + ' - 步骤' + stepIndex + ': 滑动执行失败'
                      , detail: msg
                      , actualImageDataUrl: dataUrl
                      })
                    })
                  })
              }
              if (action === 'input_text') {
                var ixt = Math.max(0, Math.min(size.w - 1, Math.round((Number(step.xP) || 0) * size.w)))
                var iyt = Math.max(0, Math.min(size.h - 1, Math.round((Number(step.yP) || 0) * size.h)))
                var txtIn = normalizeAutomationInputText(String(expandVars((step.inputText || '')) || ''))
                  .replace(/\r?\n/g, ' ')
                  .trim()
                if (!txtIn) {
                  logLine('步骤 ' + stepIndex + ' input_text 跳过（无文本）')
                  return Promise.resolve()
                }
                var forArg = txtIn.replace(/%/g, '%25').replace(/ /g, '%s')
                var quoted = '\'' + forArg.replace(/'/g, '\'\\\'\'') + '\''
                return shell(serial, 'input tap ' + ixt + ' ' + iyt)
                  .then(function() {
                    return Promise.delay(400)
                  })
                  .then(function() {
                    if (canSendTextViaAdbKeyevents(txtIn)) {
                      return shellInputTextViaKeyevents(serial, shell, txtIn)
                    }
                    return shell(serial, 'input text ' + quoted)
                  })
                  .then(function() {
                    logLine('步骤 ' + stepIndex + ' 文本输入完成')
                  })
                  .catch(function(err) {
                    var msg = err && err.message ? err.message : String(err)
                    errors.push('步骤' + stepIndex + ' 文本输入失败: ' + msg)
                    logLine('步骤 ' + stepIndex + ' 文本输入失败: ' + msg)
                    return captureScreencapDataUrl(serial).then(function(dataUrl) {
                      artifacts.push({
                        title: '失败 #' + (artifacts.length + 1) + ' - 步骤' + stepIndex + ': 文本输入失败'
                      , detail: msg
                      , actualImageDataUrl: dataUrl
                      })
                    })
                  })
              }
              if (action === 'assert_text_contains') {
                totalCases += 1
                var expectedRaw = expandVars((step.expectedText || '').trim())
                return assertText(serial, step.expectedText)
                  .then(function() {
                    successCases += 1
                    logLine('步骤 ' + stepIndex + ' 文本断言通过')
                  })
                  .catch(function(err) {
                    var msg = err && err.message ? err.message : '文本断言失败'
                    errors.push(msg)
                    logLine('步骤 ' + stepIndex + ' 文本断言失败: ' + msg)
                    return captureScreencapDataUrl(serial).then(function(dataUrl) {
                      artifacts.push({
                        title: '失败 #' + (artifacts.length + 1) + ' - 步骤' + stepIndex + ': 文字断言失败'
                      , detail: msg
                      , expectedText: expectedRaw
                      , actualImageDataUrl: dataUrl
                      })
                    })
                  })
              }
              if (action === 'assert_visual_match') {
                totalCases += 1
                var metaList = (recording && Array.isArray(recording.baselinesMeta)) ?
                  recording.baselinesMeta : []
                var bi = Number(step.baselineIndex)
                var meta = (isFinite(bi) && bi >= 0 && bi < metaList.length) ? metaList[bi] : null
                var threshold = meta && meta.threshold != null ? Number(meta.threshold) : 0.95

                function pushVisualArtifact(msg, embed) {
                  embed = embed || {}
                  errors.push('步骤' + stepIndex + ' ' + msg)
                  logLine('步骤 ' + stepIndex + ' 视觉断言失败: ' + msg)
                  return captureScreencapDataUrl(serial).then(function(dataUrl) {
                    var art = {
                      title: '失败 #' + (artifacts.length + 1) + ' - 步骤' + stepIndex + ': 视觉断言失败'
                    , detail: msg
                    , actualImageDataUrl: dataUrl
                    }
                    if (embed.expectedImageDataUrl) {
                      art.expectedImageDataUrl = embed.expectedImageDataUrl
                    }
                    if (meta && meta.href) {
                      art.expectedImageHref = meta.href
                    }
                    if (step && step.baselineIndex != null) {
                      art.baselineIndex = step.baselineIndex
                    }
                    artifacts.push(art)
                  })
                }

                function baselineBufferFromMeta(m, absUrl) {
                  if (m && m.inlineDataUrl) {
                    var inl = visualCompare.dataUrlToBuffer(m.inlineDataUrl)
                    if (inl && inl.length > 32) {
                      return Promise.resolve(inl)
                    }
                  }
                  if (!absUrl) {
                    return Promise.reject(new Error('无可用基线（href 无效且未嵌入 inlineDataUrl）'))
                  }
                  return visualCompare.fetchUrlToBuffer(absUrl)
                }

                if (!meta || (!meta.href && !meta.inlineDataUrl)) {
                  var miss = '视觉断言失败：基线不存在(baselineIndex=' + step.baselineIndex + ')'
                  return pushVisualArtifact(miss, {})
                }
                if (!isFinite(threshold) || threshold <= 0) {
                  threshold = 0.95
                }
                if (threshold > 1) {
                  threshold = 1
                }
                var absUrl = meta.href ? visualCompare.resolveBaselineAbsoluteUrl(meta.href) : null
                var hasInlineBuf = !!(meta.inlineDataUrl &&
                  visualCompare.dataUrlToBuffer(meta.inlineDataUrl))
                if (!absUrl && !hasInlineBuf) {
                  var badUrl = '视觉断言失败：基线地址无效'
                  return pushVisualArtifact(badUrl, {})
                }

                return baselineBufferFromMeta(meta, absUrl)
                  .then(function(baseBuf) {
                    var expectedDataUrl = (meta && meta.inlineDataUrl) ? meta.inlineDataUrl
                      : visualCompare.bufferToDataUrl(baseBuf)
                    return captureScreencapPngBuffer(serial)
                      .then(function(actBuf) {
                        if (!actBuf) {
                          return pushVisualArtifact('无法获取当前屏幕截图', {
                            expectedImageDataUrl: expectedDataUrl
                          })
                        }
                        return visualCompare.compareImageBuffers(baseBuf, actBuf, threshold)
                          .then(function(cmp) {
                            if (cmp.ok) {
                              successCases += 1
                              logLine('步骤 ' + stepIndex + ' 视觉断言通过 相似度=' + cmp.score.toFixed(4) +
                                ' 阈值>=' + threshold.toFixed(3))
                              return null
                            }
                            var low = '视觉断言失败：相似度 ' + cmp.score.toFixed(3) + ' < 阈值 ' + threshold.toFixed(3)
                            return pushVisualArtifact(low, {expectedImageDataUrl: expectedDataUrl})
                          })
                      })
                      .catch(function(err) {
                        var msg = visualCompare.formatCompareError(err)
                        if (msg.indexOf('相似度') === -1 && msg.indexOf('阈值') === -1) {
                          msg = '视觉断言失败：' + msg +
                            '（需已安装 GraphicsMagick；基线源: ' + (absUrl || 'inlineDataUrl') + '）'
                        }
                        return pushVisualArtifact(msg, {expectedImageDataUrl: expectedDataUrl})
                      })
                  })
                  .catch(function(err) {
                    var msg = visualCompare.formatCompareError(err)
                    msg = '视觉断言失败：拉取基线失败 ' + msg +
                      '（设置 STF_STORAGE_PLUGIN_IMAGE_URL 指向 image 插件，且 API 进程能访问该地址）'
                    return pushVisualArtifact(msg, {})
                  })
              }
              return Promise.resolve()
              }

              if (shouldPreDelayAction(action)) {
                var pd = preDelayMsForStep(step)
                if (pd <= 0) {
                  return afterPreDelay()
                }
                return Promise.delay(pd).then(function() {
                  logLine('步骤 ' + stepIndex + ' 前置延时 ' + pd + 'ms')
                  return afterPreDelay()
                })
              }
              return afterPreDelay()
            }).then(function() {
              return {
                totalCases: totalCases
              , successCases: successCases
              , errors: errors
              , artifacts: artifacts
              , logLines: logLines
              }
            })
          })
      }

      if (run.clientDriven) {
        scheduleClientTimeoutFallback()
        return null
      }

      return db.run(r.table('automationRecordings').get(run.recordingId))
        .then(function(recording) {
          if (!recording) {
            return Promise.map(deviceRows, function(row) {
              var endedAt = now()
              return db.run(r.table('automationReplayRunDevices').get(row.id).update({
                status: 'failed'
              , result: '失败'
              , error: '录制脚本不存在'
              , totalCases: 0
              , successCases: 0
              , endedAt: endedAt
              , updatedAt: endedAt
              }))
            }).then(function() {
              return finalizeRunFromRows('failed')
            })
          }
          var steps = Array.isArray(recording.stepsJson) ? recording.stepsJson : []
          return Promise.map(deviceRows, function(row) {
            return runOnDevice(row.serial, steps, recording)
              .then(function(stats) {
                var endedAt = now()
                var failedCases = Math.max(0, (Number(stats.totalCases) || 0) - (Number(stats.successCases) || 0))
                return db.run(r.table('automationReplayRunDevices').get(row.id).update({
                  status: 'finished'
                , result: failedCases > 0 ? '失败' : '成功'
                , error: stats.errors.length ? stats.errors.slice(0, 3).join('; ') : ''
                , totalCases: Number(stats.totalCases) || 0
                , successCases: Number(stats.successCases) || 0
                , reportArtifacts: stats.artifacts && stats.artifacts.length ? stats.artifacts : []
                , executionLog: stats.logLines && stats.logLines.length ? stats.logLines.join('\n') : ''
                , endedAt: endedAt
                , updatedAt: endedAt
                }))
              })
              .catch(function(err) {
                var endedAt = now()
                var errMsg = err && err.message ? err.message : String(err)
                return captureScreencapDataUrl(row.serial).then(function(dataUrl) {
                  var arts = []
                  if (dataUrl) {
                    arts.push({
                      title: '执行失败 - 设备异常'
                    , detail: errMsg
                    , actualImageDataUrl: dataUrl
                    })
                  }
                  return db.run(r.table('automationReplayRunDevices').get(row.id).update({
                    status: 'failed'
                  , result: '失败'
                  , error: errMsg
                  , reportArtifacts: arts
                  , executionLog: now() + ' [ERROR] ' + errMsg
                  , endedAt: endedAt
                  , updatedAt: endedAt
                  }))
                }).catch(function() {
                  return db.run(r.table('automationReplayRunDevices').get(row.id).update({
                    status: 'failed'
                  , result: '失败'
                  , error: errMsg
                  , endedAt: endedAt
                  , updatedAt: endedAt
                  }))
                })
              })
          }, {concurrency: 3}).then(function() {
            return finalizeRunFromRows()
          })
        })
      return null
    })
    .catch(function(err) {
      var endedAt = now()
      var failMsg = err && err.message ? err.message : String(err)
      return db.run(r.table('automationReplayRuns').get(run.id).update({
        status: 'failed'
      , reportAvailable: true
      , reportHtml: '<!DOCTYPE html><html><head><meta charset="utf-8"/><title>回放失败</title></head><body><h1>运行失败</h1><pre>' +
        String(failMsg).replace(/</g, '&lt;') + '</pre></body></html>'
      , endedAt: endedAt
      , updatedAt: endedAt
      }))
    })
}
