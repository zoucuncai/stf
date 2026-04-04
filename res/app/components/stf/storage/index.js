require('ng-file-upload')

module.exports = angular.module('stf/storage', [
  'ngFileUpload'
])
  .factory('StorageService', require('./storage-service'))
