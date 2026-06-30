require('./dashboard.css')

module.exports = angular.module('dashboard', [
  require('stf/device').name
, require('stf/common-ui').name
])
  .config(['$routeProvider', function($routeProvider) {
    $routeProvider
      .when('/dashboard', {
        template: require('./dashboard.pug')
      , controller: 'DashboardCtrl'
      })
  }])
  .controller('DashboardCtrl', require('./dashboard-controller'))
