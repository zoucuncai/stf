require('./bulk-uninstall.css')

module.exports = angular.module('device-list.bulk-uninstall', [
  require('../bulk-common').name
])
  .directive('deviceListBulkUninstall', function() {
    return {
      restrict: 'E'
    , template: require('./bulk-uninstall.pug')
    , controller: 'DeviceListBulkUninstallCtrl'
    }
  })
  .controller('DeviceListBulkUninstallCtrl', function($scope, BulkRunnerService) {
    $scope.bulkUninstallPackage = ''
    $scope.bulkUninstallResults = []
    $scope.bulkUninstallRunning = false
    $scope.bulkUninstallProgress = {done: 0, total: 0}

    $scope.runBulkUninstall = function() {
      var pkg = ($scope.bulkUninstallPackage || '').trim()
      $scope.bulkUninstallPackage = pkg
      if (!pkg || $scope.bulkUninstallRunning) {
        return
      }
      $scope.bulkUninstallRunning = true
      $scope.bulkUninstallResults = []
      BulkRunnerService.run($scope.tracker, $scope.batchSelection, function(control) {
        return control.uninstall(pkg)
      }, function(update) {
        if (update && update.progress) {
          $scope.bulkUninstallProgress = update.progress
        }
      }, {releaseReason: 'bulk_task_release'})
        .then(function(results) {
          $scope.bulkUninstallResults = results
        })
        .finally(function() {
          $scope.bulkUninstallRunning = false
        })
    }
  })

