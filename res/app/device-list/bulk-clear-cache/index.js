require('./bulk-clear-cache.css')

module.exports = angular.module('device-list.bulk-clear-cache', [
  require('../bulk-common').name
])
  .directive('deviceListBulkClearCache', function() {
    return {
      restrict: 'E'
    , template: require('./bulk-clear-cache.pug')
    , controller: 'DeviceListBulkClearCacheCtrl'
    }
  })
  .controller('DeviceListBulkClearCacheCtrl', function($scope, BulkRunnerService) {
    $scope.bulkClearCacheResults = []
    $scope.bulkClearCacheRunning = false
    $scope.bulkClearCacheProgress = {done: 0, total: 0}

    function readShellOutput(result) {
      if (!result) {
        return ''
      }
      if (result.data && result.data.length) {
        return result.data.filter(function(x) {
          return x != null && x !== ''
        }).join('')
      }
      return ''
    }

    function parseDfLine(line) {
      var p = line.trim().split(/\s+/)
      if (p.length < 5) {
        return null
      }
      return {
        size: p[1]
      , used: p[2]
      , avail: p[3]
      }
    }

    function firstDfDataLine(text) {
      var lines = (text || '').split(/\r?\n/)
      for (var i = 0; i < lines.length; i++) {
        var l = lines[i].trim()
        if (!l || /^Filesystem/i.test(l)) {
          continue
        }
        if (l.indexOf('/') === 0 || /^\/dev\//.test(l)) {
          return parseDfLine(l)
        }
      }
      return null
    }

    function humanToBytes(s) {
      if (!s) {
        return NaN
      }
      var m = String(s).trim().match(/^([\d.]+)([KMGTP])?$/i)
      if (!m) {
        return NaN
      }
      var n = parseFloat(m[1])
      var u = (m[2] || '').toUpperCase()
      var mul = {'': 1, 'K': 1024, 'M': 1048576, 'G': 1073741824, 'T': 1099511627776}
      return n * (mul[u] || 1)
    }

    function bytesToFriendly(n) {
      if (!isFinite(n) || n <= 0) {
        return '—'
      }
      if (n < 1024) {
        return n.toFixed(0) + ' B'
      }
      if (n < 1048576) {
        return (n / 1024).toFixed(1) + ' KB'
      }
      if (n < 1073741824) {
        return (n / 1048576).toFixed(2) + ' MB'
      }
      return (n / 1073741824).toFixed(2) + ' GB'
    }

    function summarizeDf(beforeText, afterText) {
      var b = firstDfDataLine(beforeText)
      var a = firstDfDataLine(afterText)
      var availB = b ? humanToBytes(b.avail) : NaN
      var availA = a ? humanToBytes(a.avail) : NaN
      var freed = (isFinite(availB) && isFinite(availA)) ? (availA - availB) : NaN
      var freedHuman = '—'
      if (isFinite(freed) && freed > 0) {
        freedHuman = bytesToFriendly(freed)
      }
      else if (isFinite(freed) && freed >= -1024 * 1024 && freed <= 0) {
        freedHuman = '约 0'
      }
      return {
        availBefore: b ? b.avail : '—'
      , availAfter: a ? a.avail : '—'
      , freedHuman: freedHuman
      , detailNote: (b && a) ? ('可用 ' + b.avail + ' → ' + a.avail) : ''
      }
    }

    function clearWithDf(control) {
      var cmd = 'df -h /data 2>/dev/null || df -h /data/media 2>/dev/null || df -h /storage/emulated/0 2>/dev/null || df -h'
      return control.shell(cmd)
        .then(function(resBefore) {
          var before = readShellOutput(resBefore).trim()
          return control.shell('pm trim-caches 999999999999')
            .then(function() {
              return control.shell(cmd)
                .then(function(resAfter) {
                  var after = readShellOutput(resAfter).trim()
                  return summarizeDf(before, after)
                })
            })
        })
    }

    $scope.runBulkClearCache = function() {
      if ($scope.bulkClearCacheRunning) {
        return
      }
      $scope.bulkClearCacheRunning = true
      $scope.bulkClearCacheResults = []
      BulkRunnerService.run($scope.tracker, $scope.batchSelection, function(control) {
        return clearWithDf(control)
      }, function(update) {
        if (update && update.progress) {
          $scope.bulkClearCacheProgress = update.progress
        }
      }, {releaseReason: 'bulk_task_release'})
        .then(function(results) {
          $scope.bulkClearCacheResults = results
        })
        .finally(function() {
          $scope.bulkClearCacheRunning = false
        })
    }
  })
