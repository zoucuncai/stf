require('./bulk-reboot.css')

module.exports = angular.module('device-list.bulk-reboot', [
  require('../bulk-common').name
])
  .directive('deviceListBulkReboot', function() {
    return {
      restrict: 'E'
    , template: require('./bulk-reboot.pug')
    , controller: 'DeviceListBulkRebootCtrl'
    }
  })
  .controller('DeviceListBulkRebootCtrl', function($scope, BulkRunnerService) {
    $scope.bulkRebootResults = []
    $scope.bulkRebootRunning = false
    $scope.bulkRebootProgress = {done: 0, total: 0}

    $scope.runBulkReboot = function() {
      if ($scope.bulkRebootRunning) {
        return
      }
      $scope.bulkRebootRunning = true
      $scope.bulkRebootResults = []
      BulkRunnerService.run($scope.tracker, $scope.batchSelection, function(control) {
        return control.reboot()
      }, function(update) {
        if (update && update.progress) {
          $scope.bulkRebootProgress = update.progress
        }
      }, {releaseReason: 'bulk_task_release'})
        .then(function(results) {
          $scope.bulkRebootResults = results
        })
        .finally(function() {
          $scope.bulkRebootRunning = false
        })
    }
  })

