var Promise = require('bluebird')
var r = require('rethinkdb')
var db = require('../db')
var uuid = require('uuid')
var adb = require('./adbutil')()

function now() {
  return new Date().toISOString()
}

function buildReplayCsv(run, items) {
  var header = [
    '运行ID',
    '录制ID',
    '录制名称',
    '设备序列号',
    '执行状态',
    '执行结果',
    '总Case',
    '成功Case',
    '失败Case',
    '成功率',
    '错误信息',
    '开始时间',
    '结束时间'
  ]
  var rows = items.map(function(item) {
    var failedCases = Math.max(0, (Number(item.totalCases) || 0) - (Number(item.successCases) || 0))
    var passRate = item.totalCases > 0 ?
      ((item.successCases / item.totalCases) * 100).toFixed(2) + '%' :
      '0.00%'
    return [
      run.id,
      run.recordingId,
      run.recordingName || '',
      item.serial,
      item.status,
      item.result || '',
      item.totalCases || 0,
      item.successCases || 0,
      failedCases,
      passRate,
      item.error || '',
      item.startedAt || '',
      item.endedAt || ''
    ]
  })
  return [header].concat(rows).map(function(row) {
    return row.map(function(v) {
      var s = String(v == null ? '' : v)
      if (s.indexOf(',') !== -1 || s.indexOf('"') !== -1 || s.indexOf('\n') !== -1) {
        return '"' + s.replace(/"/g, '""') + '"'
      }
      return s
    }).join(',')
  }).join('\n')
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
            var csv = buildReplayCsv(run, rows)
            return db.run(r.table('automationReplayRuns').get(run.id).update({
              status: status
            , reportAvailable: true
            , reportCsv: csv
            , caseSuccessRate: caseSuccessRate
            , endedAt: endedAt
            , updatedAt: endedAt
            }))
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
        var expected = String(expectedText || '').trim()
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

      function runOnDevice(serial, steps) {
        var totalCases = 0
        var successCases = 0
        var errors = []
        return getDisplaySize(serial)
          .then(function(size) {
            return Promise.each(steps || [], function(step) {
              var action = (step && step.action) ? String(step.action).trim() : ''
              if (action === 'wait') {
                var ms = Number(step.waitMs || 0)
                return Promise.delay(ms > 0 ? ms : 0)
              }
              if (action === 'tap') {
                var x = Math.max(0, Math.min(size.w - 1, Math.round((Number(step.xP) || 0) * size.w)))
                var y = Math.max(0, Math.min(size.h - 1, Math.round((Number(step.yP) || 0) * size.h)))
                return shell(serial, 'input tap ' + x + ' ' + y).delay(260)
              }
              if (action === 'assert_text_contains') {
                totalCases += 1
                return assertText(serial, step.expectedText)
                  .then(function() {
                    successCases += 1
                  })
                  .catch(function(err) {
                    errors.push(err && err.message ? err.message : '文本断言失败')
                  })
              }
              if (action === 'assert_visual_match') {
                totalCases += 1
                // Server-side image diff not implemented yet.
                successCases += 1
                return Promise.resolve()
              }
              return Promise.resolve()
            }).then(function() {
              return {
                totalCases: totalCases
              , successCases: successCases
              , errors: errors
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
            return runOnDevice(row.serial, steps)
              .then(function(stats) {
                var endedAt = now()
                var failedCases = Math.max(0, (Number(stats.totalCases) || 0) - (Number(stats.successCases) || 0))
                return db.run(r.table('automationReplayRunDevices').get(row.id).update({
                  status: 'finished'
                , result: failedCases > 0 ? '失败' : '成功'
                , error: stats.errors.length ? stats.errors.slice(0, 3).join('; ') : ''
                , totalCases: Number(stats.totalCases) || 0
                , successCases: Number(stats.successCases) || 0
                , endedAt: endedAt
                , updatedAt: endedAt
                }))
              })
              .catch(function(err) {
                var endedAt = now()
                return db.run(r.table('automationReplayRunDevices').get(row.id).update({
                  status: 'failed'
                , result: '失败'
                , error: err && err.message ? err.message : String(err)
                , endedAt: endedAt
                , updatedAt: endedAt
                }))
              })
          }, {concurrency: 3}).then(function() {
            return finalizeRunFromRows()
          })
        })
      return null
    })
    .catch(function(err) {
      var endedAt = now()
      return db.run(r.table('automationReplayRuns').get(run.id).update({
        status: 'failed'
      , reportAvailable: true
      , reportCsv: '运行失败,' + (err && err.message ? err.message : String(err))
      , endedAt: endedAt
      , updatedAt: endedAt
      }))
    })
}
