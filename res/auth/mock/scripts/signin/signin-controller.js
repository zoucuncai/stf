/**
* Copyright © 2019-2024 contains code contributed by Orange SA, authors: Denis Barbaron - Licensed under the Apache license 2.0
**/

module.exports = function SignInCtrl($window, $scope, $http, CommonService) {

  $window.angular.version = {}

  var rememberKey = 'stf.signin.mock.remember'
  var usernameKey = 'stf.signin.mock.username'
  var passwordKey = 'stf.signin.mock.password'

  $scope.error = null
  $scope.showPassword = false
  $scope.rememberPassword = false

  $scope.togglePasswordVisible = function() {
    $scope.showPassword = !$scope.showPassword
  }

  ;(function initRememberedCredentials() {
    try {
      var remember = $window.localStorage.getItem(rememberKey) === '1'
      $scope.rememberPassword = remember
      if (remember) {
        $scope.username = $window.localStorage.getItem(usernameKey) || ''
        $scope.password = $window.localStorage.getItem(passwordKey) || ''
      }
    }
    catch (e) {
      // ignore storage failures
    }
  })()

  function persistRememberCredentials(data) {
    try {
      if ($scope.rememberPassword) {
        $window.localStorage.setItem(rememberKey, '1')
        $window.localStorage.setItem(usernameKey, data.username || '')
        $window.localStorage.setItem(passwordKey, data.password || '')
      }
      else {
        $window.localStorage.removeItem(rememberKey)
        $window.localStorage.removeItem(usernameKey)
        $window.localStorage.removeItem(passwordKey)
      }
    }
    catch (e) {
      // ignore storage failures
    }
  }

  $scope.submit = function() {
    var data = {
      username: $scope.signin.username.$modelValue
    , password: $scope.signin.password.$modelValue
    }
    $scope.invalid = false
    $http.post('/auth/api/v1/mock', data)
      .then(function(response) {
        persistRememberCredentials(data)
        $scope.error = null
        location.replace(response.data.redirect)
      })
      .catch(function(response) {
        switch (response.data.error) {
          case 'ValidationError':
            $scope.error = {
              $invalid: true
            }
            break
          case 'InvalidCredentialsError':
            $scope.error = {
              $incorrect: true
            }
            break
          default:
            $scope.error = {
              $server: true
            }
            break
        }
      })
  }

  $scope.mailToSupport = function() {
    CommonService.url('mailto:' + $scope.contactEmail)
  }

  $http.get('/auth/contact').then(function(response) {
    $scope.contactEmail = response.data.contact.email
  })
}
