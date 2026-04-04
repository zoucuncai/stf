/**
* Copyright © 2019-2024 contains code contributed by Orange SA, authors: Denis Barbaron - Licensed under the Apache license 2.0
**/

module.exports = function MenuCtrl(
  $scope
, $rootScope
, UsersService
, AppState
, SettingsService
, $location
, $http
, CommonService
, LogcatService
, socket
, $cookies
, $window) {

  $window.angular.version = {}
  $window.d3.version = {}

  SettingsService.bind($scope, {
    target: 'lastUsedDevice'
  })

  SettingsService.bind($rootScope, {
    target: 'platform',
    defaultValue: 'native',
    deviceEntries: LogcatService.deviceEntries
  })

  $scope.$on('$routeChangeSuccess', function() {
    $scope.isControlRoute = $location.path().search('/control') !== -1
  })

  $scope.mailToSupport = function() {
    CommonService.url('mailto:' + $scope.contactEmail)
  }

  $http.get('/auth/contact').then(function(response) {
    $scope.contactEmail = response.data.contact.email
  })

  $scope.logout = function() {
    const cookies = $cookies.getAll()
    for (const key in cookies) {
      if (cookies.hasOwnProperty(key)) {
        $cookies.remove(key, {path: '/'})
      }
    }
    $window.location = '/'
    setTimeout(function() {
      socket.disconnect()
    }, 100)
  }

  var defaultAlertMessage = {
    activation: 'False'
  , data: ''
  , level: ''
  }

  $scope.alertMessage = angular.extend({}, defaultAlertMessage)

  if (AppState.user.privilege === 'admin') {
    var fromSettings = SettingsService.get('alertMessage')
    if (fromSettings && typeof fromSettings === 'object') {
      angular.extend($scope.alertMessage, fromSettings)
    }
  }
  else {
    UsersService.getUsersAlertMessage().then(function(response) {
      var am = response.data && response.data.alertMessage
      if (am && typeof am === 'object') {
        angular.extend($scope.alertMessage, am)
      }
    })
  }

  $scope.isAlertMessageActive = function() {
    var m = $scope.alertMessage
    return !!(m && m.activation === 'True')
  }

  $scope.isInformationAlert = function() {
    var m = $scope.alertMessage
    return !!(m && m.level === 'Information')
  }

  $scope.isWarningAlert = function() {
    var m = $scope.alertMessage
    return !!(m && m.level === 'Warning')
  }

  $scope.isCriticalAlert = function() {
    var m = $scope.alertMessage
    return !!(m && m.level === 'Critical')
  }

  $scope.$on('user.menu.users.updated', function(event, message) {
    if (message.user.privilege === 'admin') {
      var am = message.user && message.user.settings && message.user.settings.alertMessage
      if (am && typeof am === 'object') {
        angular.extend($scope.alertMessage, am)
      }
    }
  })
}
