require('./bulk-device-table.css')
require('./bulk-action-spacing.css')

module.exports = angular.module('device-list.bulk-common', [])
  .directive('deviceListBulkDeviceTable', function() {
    return {
      restrict: 'E'
    , template: require('./bulk-device-table.pug')
    }
  })
  .factory('BulkRunnerService', function($q, GroupService, ControlService) {
    function getAvailable(tracker) {
      return (tracker.devices || []).filter(function(device) {
        return device && device.present && device.ready &&
          device.state === 'available' && device.usable && !device.using
      })
    }

    function getTargets(tracker, selection) {
      var available = getAvailable(tracker)
      if (!selection || selection.mode === 'all') {
        return available
      }
      var selectedMap = selection.selected || {}
      return available.filter(function(d) {
        return !!selectedMap[d.serial]
      })
    }

    function formatShellOutput(data) {
      if (!data) {
        return ''
      }
      if (Array.isArray(data.data)) {
        return data.data.filter(function(p) {
          return p != null && p !== ''
        }).join('')
      }
      return typeof data.lastData === 'string' ? data.lastData : ''
    }

    function run(tracker, selection, handler, progressCb, opts) {
      opts = opts || {}
      var releaseReason = opts.releaseReason || null
      var devices = getTargets(tracker, selection)
      var results = []
      var progress = {total: devices.length, done: 0}

      return devices.reduce(function(prev, device) {
        return prev.then(function() {
          if (opts.shouldAbort && opts.shouldAbort()) {
            results.push({
              serial: device.serial
            , ok: false
            , error: '已取消'
            })
            progress.done += 1
            if (progressCb) {
              progressCb({
                serial: device.serial
              , status: 'done'
              , progress: progress
              })
            }
            return $q.when()
          }
          if (progressCb) {
            progressCb({
              serial: device.serial
            , status: 'running'
            , progress: progress
            })
          }
          return GroupService.invite(device, opts.usage || null)
            .then(function(joined) {
              var control = ControlService.create(joined, joined.channel)
              return $q.when(handler(control, joined))
                .then(function(data) {
                  results.push({
                    serial: joined.serial
                  , ok: true
                  , data: data || null
                  })
                })
                .catch(function(err) {
                  results.push({
                    serial: joined.serial
                  , ok: false
                  , error: err && (err.message || err.code || String(err))
                  })
                })
                .finally(function() {
                  return GroupService.kick(joined, true, releaseReason)
                    .catch(function() {})
                })
            })
            .catch(function(err) {
              results.push({
                serial: device.serial
              , ok: false
              , error: err && (err.message || err.code || String(err))
              })
            })
            .finally(function() {
              progress.done += 1
              if (progressCb) {
                progressCb({
                  serial: device.serial
                , status: 'done'
                , progress: progress
                })
              }
            })
        })
      }, $q.when()).then(function() {
        return results
      })
    }

    return {
      getTargets: getTargets
    , getAvailable: getAvailable
    , run: run
    , formatShellOutput: formatShellOutput
    }
  })

