module.exports = angular.module('stf.automation', [
  require('./store-account').name,
  require('./device-settings').name,
  require('./recorder').name
])
  .run(['$templateCache', function($templateCache) {
    $templateCache.put(
      'control-panes/automation/automation.pug'
      , require('./automation.pug')
    )
  }])
