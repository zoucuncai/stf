require('./bulk-push.css')
require('ng-file-upload')

module.exports = angular.module('device-list.bulk-push', [
  'ngFileUpload'
, require('../bulk-common').name
])
  .directive('deviceListBulkPush', function() {
    return {
      restrict: 'E'
    , template: require('./bulk-push.pug')
    , controller: 'DeviceListBulkPushCtrl'
    }
  })
  .controller('DeviceListBulkPushCtrl', function($scope, StorageService, BulkRunnerService, $timeout) {
    $scope.bulkPushFiles = []
    $scope.bulkPushTarget = '/sdcard/Download/'
    $scope.bulkPushResults = []
    $scope.bulkPushRunning = false
    $scope.bulkPushProgress = {done: 0, total: 0}
    $scope.bulkPushUploadProgress = 0
    $scope.bulkPushLiveOutput = ''

    $scope.onBulkPushFiles = function($files) {
      $timeout(function() {
        $scope.bulkPushFiles = ($files && $files.length) ? Array.prototype.slice.call($files) : []
      })
    }

    $scope.runBulkPush = function() {
      if (!$scope.bulkPushFiles.length || !$scope.bulkPushTarget || $scope.bulkPushRunning) {
        return
      }
      $scope.bulkPushRunning = true
      $scope.bulkPushResults = []
      $scope.bulkPushUploadProgress = 0
      $scope.bulkPushLiveOutput = ''

      StorageService.storeFile('blob', $scope.bulkPushFiles, {})
        .progressed(function(e) {
          if (e.lengthComputable) {
            $scope.bulkPushUploadProgress = Math.floor((e.loaded / e.total) * 100)
          }
        })
        .then(function(res) {
          var fileRes = StorageService.getFileResourceFromResponse(res)
          if (!fileRes || !fileRes.href) {
            throw new Error('上传响应无效，缺少文件地址')
          }
          var href = fileRes.href
          var originalName = ($scope.bulkPushFiles[0] && $scope.bulkPushFiles[0].name) ?
            String($scope.bulkPushFiles[0].name) : 'stf-bulk-push.bin'
          var targetInput = String($scope.bulkPushTarget || '').trim()

          return BulkRunnerService.run($scope.tracker, $scope.batchSelection, function(control) {
            var p = control.fspush(href, targetInput, originalName)
            if (p && typeof p.progressed === 'function') {
              p.progressed(function(result) {
                if (result && (result.lastData || result.progress != null)) {
                  $timeout(function() {
                    var tag = result.lastData || 'pushing_file'
                    var pct = (result.progress != null) ? (' ' + result.progress + '%') : ''
                    $scope.bulkPushLiveOutput += (tag + pct + '\n')
                  })
                }
              })
            }
            return p
          }, function(update) {
            if (update && update.progress) {
              $scope.bulkPushProgress = update.progress
            }
          }, {releaseReason: 'bulk_task_release'})
        })
        .then(function(results) {
          $scope.bulkPushResults = (results || []).map(function(item) {
            if (item.ok && item.data && item.data.body) {
              item.commandOutput =
                '已推送到: ' + (item.data.body.path || '-') + '\n' +
                '大小: ' + Number(item.data.body.size || 0) + ' B'
            }
            else {
              item.commandOutput = item.data ? BulkRunnerService.formatShellOutput(item.data) : ''
              if (!item.commandOutput && $scope.bulkPushLiveOutput) {
                item.commandOutput = $scope.bulkPushLiveOutput
              }
            }
            return item
          })
        })
        .finally(function() {
          $scope.bulkPushRunning = false
        })
    }
  })

