require('./device-list.css')

module.exports = angular.module('device-list', [
  require('angular-xeditable').name,
  require('stf/device').name,
  require('stf/user/group').name,
  require('stf/control').name,
  require('stf/common-ui').name,
  require('stf/settings').name,
  require('./column').name,
  require('./details').name,
  require('./empty').name,
  require('./icons').name,
  require('./stats').name,
  require('./customize').name,
  require('./search').name,
  require('./bulk-common').name,
  require('./bulk-clear-cache').name,
  require('./bulk-install').name,
  require('./bulk-uninstall').name,
  require('./bulk-push').name,
  require('./bulk-reboot').name,
  require('./bulk-shell').name,
  require('./bulk-monkey').name,
  require('./bulk-replay').name,
  require('./bulk-explorer').name
, require('./automation-records').name
])
  .config(['$routeProvider', function($routeProvider) {
    $routeProvider
      .when('/devices', {
        template: require('./device-list.pug'),
        controller: 'DeviceListCtrl'
      })
      .when('/devices/automation', {
        template: require('./device-list.pug'),
        controller: 'DeviceListCtrl'
      })
  }])
  .run(function(editableOptions) {
    // bootstrap3 theme for xeditables
    editableOptions.theme = 'bs3'
  })
  .controller('DeviceListCtrl', require('./device-list-controller'))
