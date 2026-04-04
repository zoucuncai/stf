require('./bulk-shell.css')

module.exports = angular.module('device-list.bulk-shell', [
  require('../bulk-common').name
])
  .directive('deviceListBulkShell', function() {
    return {
      restrict: 'E'
    , template: require('./bulk-shell.pug')
    , controller: 'DeviceListBulkShellCtrl'
    }
  })
  .controller('DeviceListBulkShellCtrl', function($scope, BulkRunnerService, $interval) {
    $scope.bulkShellCommand = ''
    $scope.bulkShellTimeoutMs = 120000
    $scope.bulkShellRunning = false
    $scope.bulkShellAbort = false
    $scope.bulkShellLiveText = ''
    $scope.bulkShellLiveSerial = ''
    $scope.bulkShellActiveControl = null
    $scope.bulkShellKeepaliveTimer = null
    $scope.bulkShellResults = []
    $scope.bulkShellProgress = {done: 0, total: 0}

    $scope.startBulkShell = function() {
      if (!$scope.bulkShellCommand || $scope.bulkShellRunning) {
        return
      }
      $scope.bulkShellRunning = true
      $scope.bulkShellAbort = false
      $scope.bulkShellResults = []
      $scope.bulkShellLiveText = ''
      $scope.bulkShellLiveSerial = ''
      $scope.bulkShellActiveControl = null
      if ($scope.bulkShellKeepaliveTimer) {
        $interval.cancel($scope.bulkShellKeepaliveTimer)
        $scope.bulkShellKeepaliveTimer = null
      }
      var timeoutMs = Math.max(5000, Number($scope.bulkShellTimeoutMs || 120000))
      BulkRunnerService.run($scope.tracker, $scope.batchSelection, function(control) {
        $scope.bulkShellActiveControl = control
        var p = control.shell($scope.bulkShellCommand, timeoutMs)
        if (typeof control.shellKeepalive === 'function') {
          $scope.bulkShellKeepaliveTimer = $interval(function() {
            if ($scope.bulkShellRunning && !$scope.bulkShellAbort) {
              control.shellKeepalive(timeoutMs)
            }
          }, 3000)
        }
        if (p && typeof p.progressed === 'function') {
          p.progressed(function(result) {
            if (result && typeof result.lastData === 'string') {
              $scope.bulkShellLiveSerial = result.source || $scope.bulkShellLiveSerial
              $scope.bulkShellLiveText += result.lastData
            }
          })
        }
        return p.finally(function() {
          if ($scope.bulkShellActiveControl === control) {
            $scope.bulkShellActiveControl = null
          }
          if ($scope.bulkShellKeepaliveTimer) {
            $interval.cancel($scope.bulkShellKeepaliveTimer)
            $scope.bulkShellKeepaliveTimer = null
          }
        })
      }, function(update) {
        if (update && update.progress) {
          $scope.bulkShellProgress = update.progress
        }
      }, {
        releaseReason: 'bulk_task_release'
      , shouldAbort: function() {
          return $scope.bulkShellAbort
        }
      }).then(function(results) {
        $scope.bulkShellResults = (results || []).map(function(item) {
          if (item.ok && item.data) {
            item.commandOutput = BulkRunnerService.formatShellOutput(item.data)
          }
          return item
        })
      }).finally(function() {
        $scope.bulkShellRunning = false
        $scope.bulkShellAbort = false
        $scope.bulkShellActiveControl = null
        if ($scope.bulkShellKeepaliveTimer) {
          $interval.cancel($scope.bulkShellKeepaliveTimer)
          $scope.bulkShellKeepaliveTimer = null
        }
      })
    }

    $scope.stopBulkShell = function() {
      if (!$scope.bulkShellRunning) {
        return
      }
      $scope.bulkShellAbort = true
      // Ask device to stop the current stream quickly.
      if ($scope.bulkShellActiveControl && typeof $scope.bulkShellActiveControl.shellKeepalive === 'function') {
        try {
          $scope.bulkShellActiveControl.shellKeepalive(1)
        }
        catch (e) {
        }
      }
    }

    $scope.clearBulkShellOutput = function() {
      $scope.bulkShellLiveText = ''
      $scope.bulkShellResults = []
    }

    $scope.$on('$destroy', function() {
      if ($scope.bulkShellKeepaliveTimer) {
        $interval.cancel($scope.bulkShellKeepaliveTimer)
        $scope.bulkShellKeepaliveTimer = null
      }
    })
  })

